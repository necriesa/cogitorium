//! Rust side of Dark Cells Widgets.
//!
//! The frontend (React, running in the system webview) cannot touch the disk
//! on its own. It calls the commands below through Tauri's IPC with
//! `invoke("append_log", { ... })`, and Rust does the file work.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// Folder inside the vault where widget logs land, unless `DARK_CELLS_LOG_DIR` overrides it.
const DEFAULT_LOG_DIR: &str = "Sources/Journal/Widgets";

/// The vault root, from `DARK_CELLS_VAULT` (set in `.env`, see `.env.example`).
fn vault_root() -> Result<PathBuf, String> {
    let raw = std::env::var("DARK_CELLS_VAULT")
        .map_err(|_| "DARK_CELLS_VAULT is not set. Copy .env.example to .env and set it.".to_string())?;
    let path = PathBuf::from(raw);
    if !path.is_dir() {
        return Err(format!("Vault folder not found: {}", path.display()));
    }
    Ok(path)
}

/// The log folder, which must stay inside the vault.
fn log_dir() -> Result<PathBuf, String> {
    let rel = std::env::var("DARK_CELLS_LOG_DIR").unwrap_or_else(|_| DEFAULT_LOG_DIR.into());
    let rel = Path::new(&rel);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("DARK_CELLS_LOG_DIR must be a relative path inside the vault".into());
    }
    Ok(vault_root()?.join(rel))
}

/// A date in `YYYY-MM-DD` form, so it is safe to use as a file name.
fn is_iso_date(date: &str) -> bool {
    date.len() == 10
        && date.chars().enumerate().all(|(i, c)| match i {
            4 | 7 => c == '-',
            _ => c.is_ascii_digit(),
        })
}

/// Appends one Markdown line to the day's log: `<vault>/<log dir>/<date>.md`.
/// Creates the folder and the file (with frontmatter) the first time.
/// Returns the file path so the UI can show where it went.
#[tauri::command]
fn append_log(date: String, entry: String) -> Result<String, String> {
    if !is_iso_date(&date) {
        return Err(format!("Bad date: {date}"));
    }
    let dir = log_dir()?;
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

/// Auto Quill scrolls live in `<log dir>/Scrolls/`, one Markdown checklist per task.
fn scroll_dir() -> Result<PathBuf, String> {
    Ok(log_dir()?.join("Scrolls"))
}

/// A plain `.md` file name with no path parts, so it can't escape the scroll folder.
fn is_safe_note_name(name: &str) -> bool {
    name.ends_with(".md")
        && name.len() <= 100
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        && Path::new(name).components().count() == 1
}

/// Writes (replaces) a scroll note. Returns its path.
#[tauri::command]
fn write_scroll(file_name: String, content: String) -> Result<String, String> {
    if !is_safe_note_name(&file_name) {
        return Err(format!("Bad scroll name: {file_name}"));
    }
    let dir = scroll_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(&file_name);
    fs::write(&file, content).map_err(|e| e.to_string())?;
    Ok(file.display().to_string())
}

/// Reads a scroll note, or `None` if it no longer exists.
#[tauri::command]
fn read_scroll(file_name: String) -> Result<Option<String>, String> {
    if !is_safe_note_name(&file_name) {
        return Err(format!("Bad scroll name: {file_name}"));
    }
    let file = scroll_dir()?.join(&file_name);
    match fs::read_to_string(&file) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Scroll file names, most recently changed first.
#[tauri::command]
fn list_scrolls() -> Result<Vec<String>, String> {
    let dir = scroll_dir()?;
    let Ok(entries) = fs::read_dir(&dir) else {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // In dev, load `.env` from the repo root (dotenvy searches parent folders).
    let _ = dotenvy::dotenv();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![append_log, write_scroll, read_scroll, list_scrolls])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{append_log, is_iso_date, is_safe_note_name, list_scrolls, read_scroll, write_scroll};

    #[test]
    fn note_names_cannot_escape_the_folder() {
        assert!(is_safe_note_name("UE5 C++ refresh.md"));
        assert!(!is_safe_note_name("../TASKS.md"));
        assert!(!is_safe_note_name("C:\\x.md"));
        assert!(!is_safe_note_name("notes.txt"));
        assert!(!is_safe_note_name(".obsidian.md"));
    }

    #[test]
    fn appends_to_daily_log_inside_vault() {
        let vault = std::env::temp_dir().join(format!("dcw-test-{}", std::process::id()));
        std::fs::create_dir_all(&vault).unwrap();
        // Safety: this is the only test that touches these env vars.
        unsafe {
            std::env::set_var("DARK_CELLS_VAULT", &vault);
            std::env::remove_var("DARK_CELLS_LOG_DIR");
        }

        let path = append_log("2026-11-12".into(), "- 14:32 · Tempormortis · 25 min · test".into()).unwrap();
        append_log("2026-11-12".into(), "- 14:40 · Auto Quill · completed · test".into()).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(path.ends_with("2026-11-12.md"));
        assert!(path.contains("Widgets"));
        assert_eq!(text.matches("type: widget-log").count(), 1, "frontmatter written once");
        assert!(text.contains("Tempormortis · 25 min") && text.contains("Auto Quill · completed"));
        assert!(append_log("../escape".into(), "x".into()).is_err());

        // Scroll notes: write, read back, list, and refuse names outside the folder.
        let note = "# Task\n\n- [ ] one\n- [x] two\n";
        let written = write_scroll("Task.md".into(), note.into()).unwrap();
        assert!(written.contains("Scrolls"));
        assert_eq!(read_scroll("Task.md".into()).unwrap().as_deref(), Some(note));
        assert_eq!(read_scroll("Missing.md".into()).unwrap(), None);
        assert_eq!(list_scrolls().unwrap(), vec!["Task.md".to_string()]);
        assert!(write_scroll("../Task.md".into(), "x".into()).is_err());

        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn accepts_iso_dates_only() {
        assert!(is_iso_date("2026-11-12"));
        assert!(!is_iso_date("2026-1-12"));
        assert!(!is_iso_date("../../etc"));
        assert!(!is_iso_date("2026/11/12"));
    }
}
