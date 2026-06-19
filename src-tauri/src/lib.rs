mod crypto;
mod legacy;
mod models;
mod preferences;
mod sync;
mod vault;

use std::sync::Mutex;

use vault::VaultManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(VaultManager::default()))
        .invoke_handler(tauri::generate_handler![
            vault::create_vault,
            vault::unlock_vault,
            vault::lock_vault,
            vault::list_entries,
            vault::upsert_entry,
            vault::delete_entry,
            vault::change_master_password,
            vault::generate_password,
            vault::import_legacy_preview,
            vault::import_legacy_commit,
            vault::save_vault,
            vault::export_vault_copy,
            vault::export_legacy_xml,
            vault::set_vault_icon,
            vault::get_sync_config,
            vault::set_sync_config,
            vault::test_sync,
            vault::sync_now,
            preferences::get_preferences,
            preferences::save_preferences
        ])
        .run(tauri::generate_context!())
        .expect("error while running Passdroid Next");
}

