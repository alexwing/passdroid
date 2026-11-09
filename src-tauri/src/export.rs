use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Wry;

use crate::{
    crypto::VAULT_MAGIC,
    models::VaultEnvelope,
};

#[cfg(target_os = "android")]
struct AndroidExport(tauri::plugin::PluginHandle<Wry>);

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportKind {
    Vault,
    Xml,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedExport {
    pub name: String,
    pub path: String,
}

/// Registers the app-level Android plugin (MediaStore export, no document picker).
/// On other platforms it is an empty plugin.
pub fn init() -> TauriPlugin<Wry> {
    Builder::new("export")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("com.passdroid.next", "ExportPlugin")?;
                _app.manage(AndroidExport(handle));
            }
            Ok(())
        })
        .build()
}

/// Check that an export written to disk is what we meant to write: a vault
/// envelope with the right magic, or a non-empty legacy XML document.
pub fn verify(kind: ExportKind, contents: &str) -> Result<(), String> {
    if contents.trim().is_empty() {
        return Err("export_verify_failed".to_string());
    }
    match kind {
        ExportKind::Vault => {
            let envelope: VaultEnvelope = serde_json::from_str(contents)
                .map_err(|_| "export_verify_failed".to_string())?;
            if envelope.header.magic != VAULT_MAGIC || envelope.payload.is_empty() {
                return Err("export_verify_failed".to_string());
            }
        }
        ExportKind::Xml => {
            let doc = roxmltree::Document::parse(contents)
                .map_err(|_| "export_verify_failed".to_string())?;
            if doc.root_element().tag_name().name() != "passdroid" {
                return Err("export_verify_failed".to_string());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn verify_export(kind: ExportKind, contents: String) -> Result<(), String> {
    verify(kind, &contents)
}

/// Android export without a picker: the file goes to the public Download/Passdroid
/// folder through MediaStore. The Kotlin side reads it back and the result is
/// verified here before reporting where it ended up.
#[tauri::command]
pub async fn export_save_android(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: tauri::AppHandle,
    kind: ExportKind,
    contents: String,
) -> Result<SavedExport, String> {
    verify(kind, &contents)?;

    #[cfg(target_os = "android")]
    {
        use tauri::Manager;

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            file_name: String,
            mime_type: &'a str,
            contents: &'a str,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Response {
            name: String,
            path: String,
            read_back: String,
        }

        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let (file_name, mime_type) = match kind {
            ExportKind::Vault => (format!("passdroid-copy-{stamp}.pdvault"), "application/octet-stream"),
            ExportKind::Xml => (format!("passdroid-export-{stamp}.xml"), "text/xml"),
        };

        let handle = app.state::<AndroidExport>();
        let response: Response = handle
            .0
            .run_mobile_plugin_async(
                "saveExport",
                Payload {
                    file_name,
                    mime_type,
                    contents: &contents,
                },
            )
            .await
            .map_err(|e| {
                if e.to_string().contains("export_unsupported") {
                    "export_unsupported".to_string()
                } else {
                    "export_write_failed".to_string()
                }
            })?;

        if response.read_back != contents {
            return Err("export_verify_failed".to_string());
        }
        verify(kind, &response.read_back)?;
        Ok(SavedExport {
            name: response.name,
            path: response.path,
        })
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("export_unsupported".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        crypto::{default_cipher_info, default_kdf_params, now_iso},
        models::VaultHeader,
    };

    fn envelope(magic: &str, payload: &str) -> String {
        let now = now_iso();
        let envelope = VaultEnvelope {
            header: VaultHeader {
                magic: magic.to_string(),
                version: 1,
                vault_id: "test".to_string(),
                kdf: default_kdf_params(),
                cipher: default_cipher_info(),
                nonce: String::new(),
                created_at: now.clone(),
                updated_at: now,
            },
            payload: payload.to_string(),
        };
        serde_json::to_string(&envelope).unwrap()
    }

    #[test]
    fn verify_accepts_a_vault_envelope() {
        assert!(verify(ExportKind::Vault, &envelope(VAULT_MAGIC, "abc")).is_ok());
    }

    #[test]
    fn verify_rejects_empty_and_garbage_vaults() {
        assert!(verify(ExportKind::Vault, "").is_err());
        assert!(verify(ExportKind::Vault, "  \n").is_err());
        assert!(verify(ExportKind::Vault, "not json").is_err());
        assert!(verify(ExportKind::Vault, &envelope("other-magic", "abc")).is_err());
        assert!(verify(ExportKind::Vault, &envelope(VAULT_MAGIC, "")).is_err());
    }

    #[test]
    fn verify_xml_requires_the_passdroid_root() {
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<passdroid version=\"1\">\n</passdroid>\n";
        assert!(verify(ExportKind::Xml, xml).is_ok());
        assert!(verify(ExportKind::Xml, "").is_err());
        assert!(verify(ExportKind::Xml, "<other/>").is_err());
        assert!(verify(ExportKind::Xml, "<passdroid>").is_err());
    }

    #[test]
    fn xml_export_survives_characters_invalid_in_xml() {
        let entry = crate::models::VaultEntry::imported(
            "Ti\u{1}tle".to_string(),
            "user".to_string(),
            "pa\u{1B}ss\u{0}\u{FFFE}word".to_string(),
            "line\u{B}break".to_string(),
            String::new(),
        );
        let xml = crate::legacy::entries_to_legacy_xml(&[entry], "1.0");
        assert!(verify(ExportKind::Xml, &xml).is_ok());
        assert!(xml.contains("<![CDATA[password]]>"));
        assert!(xml.contains("<![CDATA[linebreak]]>"));
        assert!(xml.contains("name=\"Title\""));
    }
}
