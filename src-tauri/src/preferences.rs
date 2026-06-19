use crate::models::Preferences;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("preferences.json"))
}

#[tauri::command]
pub fn get_preferences(app: AppHandle) -> Result<Preferences, String> {
    let path = preferences_path(&app)?;
    if !path.exists() {
        return Ok(Preferences::default());
    }

    let data = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_preferences(app: AppHandle, preferences: Preferences) -> Result<Preferences, String> {
    let path = preferences_path(&app)?;
    let data = serde_json::to_string_pretty(&preferences).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())?;
    Ok(preferences)
}

