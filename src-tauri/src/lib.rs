//! Rust side of Dark Cells Widgets.
//!
//! The frontend (React, running in the system webview) cannot touch the disk
//! on its own. It calls the commands below through Tauri's IPC with
//! `invoke("append_log", { ... })`, and Rust does the file work.
//!
//! The vault folder is remembered in `settings.json` in the app's config
//! folder (on Windows `%APPDATA%\com.necriesa.darkcellswidgets\`). It is
//! chosen on first run with a folder picker; `DARK_CELLS_VAULT` (e.g. from the
//! repo's `.env` in dev) is only a fallback when nothing has been saved.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Folder inside the vault where widget logs land, unless `DARK_CELLS_LOG_DIR` overrides it.
const DEFAULT_LOG_DIR: &str = "Sources/Journal/Widgets";

/// What is saved in `settings.json`.
#[derive(Default, Serialize, Deserialize)]
struct Settings {
    vault: Option<PathBuf>,
}

/// Shared app state: where settings live and the current vault.
struct AppState {
    settings_file: PathBuf,
    vault: Mutex<Option<PathBuf>>,
}

/// The saved vault, if the settings file names a folder that still exists.
fn saved_vault(settings_file: &Path) -> Option<PathBuf> {
    fs::read_to_string(settings_file)
        .ok()
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .and_then(|s| s.vault)
        .filter(|p| p.is_dir())
}

/// Picks a vault from Obsidian's own vault list (`obsidian.json`, in Obsidian's
/// config folder). Prefers the vault marked open (the most recent if several);
/// otherwise uses the only vault if there is exactly one. Returns `None` when
/// it can't tell, so the app asks instead of guessing.
fn vault_from_obsidian_list(json: &str) -> Option<PathBuf> {
    let parsed: serde_json::Value = serde_json::from_str(json).ok()?;
    let mut vaults: Vec<(PathBuf, bool, u64)> = parsed
        .get("vaults")?
        .as_object()?
        .values()
        .filter_map(|v| {
            let path = PathBuf::from(v.get("path")?.as_str()?);
            let open = v.get("open").and_then(|o| o.as_bool()).unwrap_or(false);
            let ts = v.get("ts").and_then(|t| t.as_u64()).unwrap_or(0);
            path.is_dir().then_some((path, open, ts))
        })
        .collect();
    vaults.sort_by(|a, b| b.2.cmp(&a.2));
    if let Some((path, _, _)) = vaults.iter().find(|(_, open, _)| *open) {
        return Some(path.clone());
    }
    (vaults.len() == 1).then(|| vaults.remove(0).0)
}

/// Where the vault comes from on start-up, in order:
/// 1. the folder saved in settings.json (chosen earlier or auto-detected),
/// 2. `DARK_CELLS_VAULT` (dev `.env`),
/// 3. Obsidian's open vault, read from `obsidian.json`; this one is saved so it sticks.
fn initial_vault(settings_file: &Path, obsidian_list: Option<&Path>) -> Option<PathBuf> {
    if let Some(saved) = saved_vault(settings_file) {
        return Some(saved);
    }
    if let Some(env) = std::env::var_os("DARK_CELLS_VAULT").map(PathBuf::from).filter(|p| p.is_dir()) {
        return Some(env);
    }
    let detected = obsidian_list
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|text| vault_from_obsidian_list(&text))?;
    let _ = save_settings(settings_file, &Settings { vault: Some(detected.clone()) });
    Some(detected)
}

fn save_settings(settings_file: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = settings_file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(settings_file, json).map_err(|e| e.to_string())
}

/// The current vault, or an error telling the UI to ask for one.
fn vault_root(state: &AppState) -> Result<PathBuf, String> {
    let vault = state.vault.lock().map_err(|_| "Vault setting is unavailable".to_string())?.clone();
    match vault {
        Some(p) if p.is_dir() => Ok(p),
        Some(p) => Err(format!("Vault folder not found: {}", p.display())),
        None => Err("No vault chosen yet".into()),
    }
}

/// The current vault path, if one is set and still exists.
#[tauri::command]
fn get_vault(state: State<AppState>) -> Option<String> {
    vault_root(&state).ok().map(|p| p.display().to_string())
}

/// Remembers `path` as the vault, saves it, and tells every window.
#[tauri::command]
fn set_vault(app: AppHandle, state: State<AppState>, path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(format!("Not a folder: {}", path.display()));
    }
    save_settings(&state.settings_file, &Settings { vault: Some(path.clone()) })?;
    *state.vault.lock().map_err(|_| "Vault setting is unavailable".to_string())? = Some(path.clone());
    let shown = path.display().to_string();
    let _ = app.emit("vault-changed", &shown);
    Ok(shown)
}

/// The log folder inside `vault`, which must stay inside it.
fn log_dir(vault: &Path) -> Result<PathBuf, String> {
    let rel = std::env::var("DARK_CELLS_LOG_DIR").unwrap_or_else(|_| DEFAULT_LOG_DIR.into());
    let rel = Path::new(&rel);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("DARK_CELLS_LOG_DIR must be a relative path inside the vault".into());
    }
    Ok(vault.join(rel))
}

/// A date in `YYYY-MM-DD` form, so it is safe to use as a file name.
fn is_iso_date(date: &str) -> bool {
    date.len() == 10
        && date.chars().enumerate().all(|(i, c)| match i {
            4 | 7 => c == '-',
            _ => c.is_ascii_digit(),
        })
}

/// Appends one Markdown line to `<vault>/<log dir>/<date>.md`, creating the
/// folder and the file (with frontmatter) the first time. Returns the file path.
fn append_log_in(vault: &Path, date: &str, entry: &str) -> Result<String, String> {
    if !is_iso_date(date) {
        return Err(format!("Bad date: {date}"));
    }
    let dir = log_dir(vault)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let file = dir.join(format!("{date}.md"));
    let is_new = !file.exists();
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| e.to_string())?;
    if is_new {
        writeln!(f, "---\ntype: widget-log\ndate: {date}\n---\n# {date}\n").map_err(|e| e.to_string())?;
    }
    writeln!(f, "{}", entry.trim_end()).map_err(|e| e.to_string())?;
    Ok(file.display().to_string())
}

#[tauri::command]
fn append_log(state: State<AppState>, date: String, entry: String) -> Result<String, String> {
    append_log_in(&vault_root(&state)?, &date, &entry)
}

/// Auto Quill scrolls live in `<log dir>/Scrolls/`, one Markdown checklist per task.
fn scroll_dir(vault: &Path) -> Result<PathBuf, String> {
    Ok(log_dir(vault)?.join("Scrolls"))
}

/// A plain `.md` file name with no path parts, so it can't escape the scroll folder.
fn is_safe_note_name(name: &str) -> bool {
    name.ends_with(".md")
        && name.len() <= 100
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        && Path::new(name).components().count() == 1
}

fn write_scroll_in(vault: &Path, file_name: &str, content: &str) -> Result<String, String> {
    if !is_safe_note_name(file_name) {
        return Err(format!("Bad scroll name: {file_name}"));
    }
    let dir = scroll_dir(vault)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(file_name);
    fs::write(&file, content).map_err(|e| e.to_string())?;
    Ok(file.display().to_string())
}

fn read_scroll_in(vault: &Path, file_name: &str) -> Result<Option<String>, String> {
    if !is_safe_note_name(file_name) {
        return Err(format!("Bad scroll name: {file_name}"));
    }
    match fs::read_to_string(scroll_dir(vault)?.join(file_name)) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn list_scrolls_in(vault: &Path) -> Result<Vec<String>, String> {
    let Ok(entries) = fs::read_dir(scroll_dir(vault)?) else {
        return Ok(Vec::new());
    };
    let mut files: Vec<(std::time::SystemTime, String)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let modified = e.metadata().ok()?.modified().ok()?;
            is_safe_note_name(&name).then_some((modified, name))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(files.into_iter().map(|(_, n)| n).collect())
}

/// Writes (replaces) a scroll note. Returns its path.
#[tauri::command]
fn write_scroll(state: State<AppState>, file_name: String, content: String) -> Result<String, String> {
    write_scroll_in(&vault_root(&state)?, &file_name, &content)
}

/// Reads a scroll note, or `None` if it no longer exists.
#[tauri::command]
fn read_scroll(state: State<AppState>, file_name: String) -> Result<Option<String>, String> {
    read_scroll_in(&vault_root(&state)?, &file_name)
}

/// Scroll file names, most recently changed first.
#[tauri::command]
fn list_scrolls(state: State<AppState>) -> Result<Vec<String>, String> {
    list_scrolls_in(&vault_root(&state)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // In dev, load `.env` from the repo root (dotenvy searches parent folders).
    let _ = dotenvy::dotenv();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let settings_file = app.path().app_config_dir()?.join("settings.json");
            // Obsidian keeps its vault list in its own config folder
            // (%APPDATA%\obsidian on Windows, ~/Library/Application Support/obsidian on macOS).
            let obsidian_list = app.path().config_dir().ok().map(|d| d.join("obsidian").join("obsidian.json"));
            let vault = initial_vault(&settings_file, obsidian_list.as_deref());
            app.manage(AppState { settings_file, vault: Mutex::new(vault) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_vault,
            set_vault,
            append_log,
            write_scroll,
            read_scroll,
            list_scrolls
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dcw-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn note_names_cannot_escape_the_folder() {
        assert!(is_safe_note_name("UE5 C++ refresh.md"));
        assert!(!is_safe_note_name("../TASKS.md"));
        assert!(!is_safe_note_name("C:\\x.md"));
        assert!(!is_safe_note_name("notes.txt"));
        assert!(!is_safe_note_name(".obsidian.md"));
    }

    #[test]
    fn accepts_iso_dates_only() {
        assert!(is_iso_date("2026-11-12"));
        assert!(!is_iso_date("2026-1-12"));
        assert!(!is_iso_date("../../etc"));
        assert!(!is_iso_date("2026/11/12"));
    }

    #[test]
    fn appends_to_daily_log_inside_vault() {
        let vault = temp_dir("log");
        let path = append_log_in(&vault, "2026-11-12", "- 14:32 · Tempormortis · 25 min · test").unwrap();
        append_log_in(&vault, "2026-11-12", "- 14:40 · Auto Quill · completed · test").unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(path.ends_with("2026-11-12.md"));
        assert!(path.contains("Widgets"));
        assert_eq!(text.matches("type: widget-log").count(), 1, "frontmatter written once");
        assert!(text.contains("Tempormortis · 25 min") && text.contains("Auto Quill · completed"));
        assert!(append_log_in(&vault, "../escape", "x").is_err());
        fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn scroll_notes_round_trip() {
        let vault = temp_dir("scroll");
        let note = "# Task\n\n- [ ] one\n- [x] two\n";
        assert!(write_scroll_in(&vault, "Task.md", note).unwrap().contains("Scrolls"));
        assert_eq!(read_scroll_in(&vault, "Task.md").unwrap().as_deref(), Some(note));
        assert_eq!(read_scroll_in(&vault, "Missing.md").unwrap(), None);
        assert_eq!(list_scrolls_in(&vault).unwrap(), vec!["Task.md".to_string()]);
        assert!(write_scroll_in(&vault, "../Task.md", "x").is_err());
        fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn saved_vault_is_remembered() {
        let dir = temp_dir("settings");
        let vault = temp_dir("vault");
        let settings_file = dir.join("nested").join("settings.json");

        // A saved folder that no longer exists is ignored.
        save_settings(&settings_file, &Settings { vault: Some(dir.join("gone")) }).unwrap();
        assert_eq!(saved_vault(&settings_file), None);

        // A saved, existing folder is read back on the next start.
        save_settings(&settings_file, &Settings { vault: Some(vault.clone()) }).unwrap();
        assert_eq!(saved_vault(&settings_file), Some(vault.clone()));

        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&vault).unwrap();
    }

    fn obsidian_json(entries: &[(&Path, bool, u64)]) -> String {
        let vaults: serde_json::Map<String, serde_json::Value> = entries
            .iter()
            .enumerate()
            .map(|(i, (p, open, ts))| {
                let mut v = serde_json::json!({ "path": p.display().to_string(), "ts": ts });
                if *open {
                    v["open"] = true.into();
                }
                (format!("id{i}"), v)
            })
            .collect();
        serde_json::json!({ "vaults": vaults }).to_string()
    }

    #[test]
    fn detects_obsidians_open_vault() {
        let a = temp_dir("obs-a");
        let b = temp_dir("obs-b");
        let gone = a.join("missing");

        // The open vault wins over newer closed ones.
        assert_eq!(vault_from_obsidian_list(&obsidian_json(&[(&a, false, 9), (&b, true, 1)])), Some(b.clone()));
        // A single vault is used even if not marked open.
        assert_eq!(vault_from_obsidian_list(&obsidian_json(&[(&a, false, 1)])), Some(a.clone()));
        // Several closed vaults: don't guess.
        assert_eq!(vault_from_obsidian_list(&obsidian_json(&[(&a, false, 1), (&b, false, 2)])), None);
        // Missing folders and junk are ignored.
        assert_eq!(vault_from_obsidian_list(&obsidian_json(&[(&gone, true, 5)])), None);
        assert_eq!(vault_from_obsidian_list("not json"), None);

        // On a first run, a detected vault is saved so it sticks.
        let settings_file = a.join("cfg").join("settings.json");
        let list = a.join("obsidian.json");
        fs::write(&list, obsidian_json(&[(&b, true, 1)])).unwrap();
        if std::env::var_os("DARK_CELLS_VAULT").is_none() {
            assert_eq!(initial_vault(&settings_file, Some(&list)), Some(b.clone()));
            assert_eq!(saved_vault(&settings_file), Some(b.clone()));
        }

        fs::remove_dir_all(&a).unwrap();
        fs::remove_dir_all(&b).unwrap();
    }
}
