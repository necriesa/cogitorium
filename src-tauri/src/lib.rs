//! Rust side of Cogitorium.
//!
//! The frontend (React, running in the system webview) cannot touch the disk
//! on its own. It calls the commands below through Tauri's IPC with
//! `invoke("append_log", { ... })`, and Rust does the file work.
//!
//! The vault folder is remembered in `settings.json` in the app's config
//! folder (on Windows `%APPDATA%\com.necriesa.cogitorium\`). On first run it
//! is carried over from the pre-0.4 app ID, read from `DARK_CELLS_VAULT` (dev
//! `.env`), or detected from Obsidian's open vault; the folder picker is the
//! last resort.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Folder inside the vault where widget logs land, unless `DARK_CELLS_LOG_DIR` overrides it.
const DEFAULT_LOG_DIR: &str = "Sources/Journal/Widgets";

/// Daily focus goal until one is chosen on the dashboard.
const DEFAULT_GOAL_MINUTES: u32 = 120;
/// Longest daily goal that can be set (12 hours).
const MAX_GOAL_MINUTES: u32 = 720;

fn default_goal() -> u32 {
    DEFAULT_GOAL_MINUTES
}

/// What is saved in `settings.json`.
#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    vault: Option<PathBuf>,
    /// Widgets popped out of the main window; reopened on the next launch.
    #[serde(default)]
    open_widgets: Vec<String>,
    /// Focus minutes per day the dashboard measures against; 0 turns the goal off.
    #[serde(default = "default_goal")]
    daily_goal: u32,
    /// The Data Stylus scroll that was open (a file name in `Scrolls/`), so it
    /// reopens after a restart. Kept here rather than in the webview's storage,
    /// which can lose its last writes when the app quits.
    #[serde(default)]
    open_scroll: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { vault: None, open_widgets: Vec::new(), daily_goal: DEFAULT_GOAL_MINUTES, open_scroll: None }
    }
}

/// Shared app state.
struct AppState {
    settings_file: PathBuf,
    settings: Mutex<Settings>,
    /// The Chrono-Siphon timer. It lives here rather than in a window, so the
    /// main app and a popped-out widget always show the same timer.
    timer: Mutex<Timer>,
    /// Set while the app shuts down, so closing its windows doesn't forget
    /// which widgets were popped out.
    quitting: AtomicBool,
}

fn load_settings(settings_file: &Path) -> Settings {
    fs::read_to_string(settings_file)
        .ok()
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default()
}

/// The saved vault, if the settings file names a folder that still exists.
fn saved_vault(settings_file: &Path) -> Option<PathBuf> {
    load_settings(settings_file).vault.filter(|p| p.is_dir())
}

/// Saves `vault` into the settings file, keeping everything else in it.
fn save_vault(settings_file: &Path, vault: &Path) -> Result<(), String> {
    let mut settings = load_settings(settings_file);
    settings.vault = Some(vault.to_path_buf());
    save_settings(settings_file, &settings)
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

/// The app ID used before the Cogitorium rename (v0.4); its saved vault is carried over.
const LEGACY_APP_ID: &str = "com.necriesa.darkcellswidgets";

/// Where the vault comes from on start-up, in order:
/// 1. the folder saved in settings.json (chosen earlier or auto-detected),
/// 2. the folder saved under the old app ID, copied into the new settings,
/// 3. `DARK_CELLS_VAULT` (dev `.env`),
/// 4. Obsidian's open vault, read from `obsidian.json`; this one is saved so it sticks.
fn initial_vault(settings_file: &Path, legacy_settings: Option<&Path>, obsidian_list: Option<&Path>) -> Option<PathBuf> {
    if let Some(saved) = saved_vault(settings_file) {
        return Some(saved);
    }
    if let Some(old) = legacy_settings.and_then(saved_vault) {
        let _ = save_vault(settings_file, &old);
        return Some(old);
    }
    if let Some(env) = std::env::var_os("DARK_CELLS_VAULT").map(PathBuf::from).filter(|p| p.is_dir()) {
        return Some(env);
    }
    let detected = obsidian_list
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|text| vault_from_obsidian_list(&text))?;
    let _ = save_vault(settings_file, &detected);
    Some(detected)
}

fn save_settings(settings_file: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = settings_file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(settings_file, json).map_err(|e| e.to_string())
}

fn settings_lock(state: &AppState) -> Result<std::sync::MutexGuard<'_, Settings>, String> {
    state.settings.lock().map_err(|_| "Settings are unavailable".to_string())
}

/// The current vault, or an error telling the UI to ask for one.
fn vault_root(state: &AppState) -> Result<PathBuf, String> {
    let vault = settings_lock(state)?.vault.clone();
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
    let closed_scroll = {
        let mut settings = settings_lock(&state)?;
        // The open scroll belongs to the old vault.
        let closed = settings.vault.as_ref() != Some(&path) && settings.open_scroll.take().is_some();
        settings.vault = Some(path.clone());
        save_settings(&state.settings_file, &settings)?;
        closed
    };
    let shown = path.display().to_string();
    if closed_scroll {
        let _ = app.emit("scroll-changed", Option::<()>::None);
    }
    let _ = app.emit("vault-changed", &shown);
    Ok(shown)
}

/// Sets the daily focus goal in minutes (0 turns it off), saves it, and tells every window.
#[tauri::command]
fn set_goal(app: AppHandle, state: State<AppState>, minutes: u32) -> Result<u32, String> {
    let minutes = minutes.min(MAX_GOAL_MINUTES);
    {
        let mut settings = settings_lock(&state)?;
        settings.daily_goal = minutes;
        save_settings(&state.settings_file, &settings)?;
    }
    let _ = app.emit("goal-changed", minutes);
    Ok(minutes)
}

/// Project notes in the vault (`Projects/*.md`), by name, for tagging timer sessions.
fn list_projects_in(vault: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(vault.join("Projects")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".md").map(str::to_string))
        .filter(|n| !n.is_empty() && !n.starts_with('.'))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names
}

#[tauri::command]
fn list_projects(state: State<AppState>) -> Result<Vec<String>, String> {
    Ok(list_projects_in(&vault_root(&state)?))
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

/// Appends a log line and tells every window (the dashboard refreshes on it).
#[tauri::command]
fn append_log(app: AppHandle, state: State<AppState>, date: String, entry: String) -> Result<String, String> {
    let path = append_log_in(&vault_root(&state)?, &date, &entry)?;
    let _ = app.emit("log-changed", &date);
    Ok(path)
}

/// Data Stylus scrolls live in `<log dir>/Scrolls/`, one Markdown checklist per task.
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

/// Every scroll in the vault with its progress, for the Data Stylus library.
/// `today` is the user's local date (YYYY-MM-DD), for the idle days.
#[tauri::command]
fn scroll_library(state: State<AppState>, today: String) -> Result<Vec<ScrollStat>, String> {
    let today = parse_day(&today).ok_or_else(|| format!("Bad date: {today}"))?;
    Ok(read_scroll_stats(&log_dir(&vault_root(&state)?)?, today))
}

/// The scroll that was open last, if any.
#[tauri::command]
fn get_open_scroll(state: State<AppState>) -> Result<Option<String>, String> {
    Ok(settings_lock(&state)?.open_scroll.clone())
}

/// Remembers which scroll is open (`None` when the slate is cleared).
#[tauri::command]
fn set_open_scroll(state: State<AppState>, file_name: Option<String>) -> Result<(), String> {
    if let Some(name) = &file_name {
        if !is_safe_note_name(name) {
            return Err(format!("Bad scroll name: {name}"));
        }
    }
    let mut settings = settings_lock(&state)?;
    if settings.open_scroll == file_name {
        return Ok(());
    }
    settings.open_scroll = file_name;
    save_settings(&state.settings_file, &settings)
}

// =====================================================================
// Shared Chrono-Siphon timer
// =====================================================================

/// The timer every window displays. Times are Unix milliseconds.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Timer {
    /// idle | running | paused | finished
    phase: &'static str,
    task: String,
    /// Project note the session is tagged with (empty for none).
    project: String,
    minutes: u32,
    /// When a running timer ends.
    end_at: Option<u64>,
    /// Time left while paused.
    remaining_ms: Option<u64>,
}

impl Default for Timer {
    fn default() -> Self {
        Timer { phase: "idle", task: String::new(), project: String::new(), minutes: 25, end_at: None, remaining_ms: None }
    }
}

impl Timer {
    fn start(&mut self, task: String, project: String, minutes: u32, now: u64) {
        let minutes = minutes.clamp(1, 180);
        *self = Timer { phase: "running", task, project, minutes, end_at: Some(now + u64::from(minutes) * 60_000), remaining_ms: None };
    }
    fn pause(&mut self, now: u64) {
        if let ("running", Some(end)) = (self.phase, self.end_at) {
            self.phase = "paused";
            self.remaining_ms = Some(end.saturating_sub(now));
            self.end_at = None;
        }
    }
    fn resume(&mut self, now: u64) {
        if let ("paused", Some(left)) = (self.phase, self.remaining_ms) {
            self.phase = "running";
            self.end_at = Some(now + left);
            self.remaining_ms = None;
        }
    }
    fn reset(&mut self) {
        self.phase = "idle";
        self.end_at = None;
        self.remaining_ms = None;
    }
    /// Marks a running timer finished once its time is up. Returns true only
    /// for the call that actually finishes it, so only one window tolls.
    fn finish(&mut self, now: u64) -> bool {
        match (self.phase, self.end_at) {
            ("running", Some(end)) if now + 1_000 >= end => {
                self.phase = "finished";
                self.end_at = None;
                self.remaining_ms = Some(0);
                true
            }
            _ => false,
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Applies `change` to the shared timer and tells every window.
fn update_timer(app: &AppHandle, state: &AppState, change: impl FnOnce(&mut Timer) -> bool) -> Result<(Timer, bool), String> {
    let (snapshot, result) = {
        let mut timer = state.timer.lock().map_err(|_| "Timer is unavailable".to_string())?;
        let result = change(&mut timer);
        (timer.clone(), result)
    };
    let _ = app.emit("timer-changed", &snapshot);
    Ok((snapshot, result))
}

#[tauri::command]
fn timer_get(state: State<AppState>) -> Result<Timer, String> {
    Ok(state.timer.lock().map_err(|_| "Timer is unavailable".to_string())?.clone())
}

#[tauri::command]
fn timer_start(app: AppHandle, state: State<AppState>, task: String, project: Option<String>, minutes: u32) -> Result<Timer, String> {
    let project = project.unwrap_or_default().trim().to_string();
    Ok(update_timer(&app, &state, |t| {
        t.start(task, project, minutes, now_ms());
        true
    })?
    .0)
}

#[tauri::command]
fn timer_pause(app: AppHandle, state: State<AppState>) -> Result<Timer, String> {
    Ok(update_timer(&app, &state, |t| {
        t.pause(now_ms());
        true
    })?
    .0)
}

#[tauri::command]
fn timer_resume(app: AppHandle, state: State<AppState>) -> Result<Timer, String> {
    Ok(update_timer(&app, &state, |t| {
        t.resume(now_ms());
        true
    })?
    .0)
}

#[tauri::command]
fn timer_reset(app: AppHandle, state: State<AppState>) -> Result<Timer, String> {
    Ok(update_timer(&app, &state, |t| {
        t.reset();
        true
    })?
    .0)
}

/// Returns true if this call finished the timer (the caller plays the toll).
#[tauri::command]
fn timer_finish(app: AppHandle, state: State<AppState>) -> Result<bool, String> {
    Ok(update_timer(&app, &state, |t| t.finish(now_ms()))?.1)
}

// =====================================================================
// Pop-out widgets (desktop only)
// =====================================================================

/// The widgets that can be popped out of the main window: label, title, size, resizable.
const WIDGETS: [(&str, &str, f64, f64, bool); 2] = [
    ("data-stylus", "Data Stylus", 380.0, 620.0, true),
    ("chrono-siphon", "Chrono-Siphon", 300.0, 660.0, false),
];

fn is_widget(label: &str) -> bool {
    WIDGETS.iter().any(|w| w.0 == label)
}

/// Opens a widget window, or focuses it if it's already open.
#[cfg(desktop)]
fn create_widget(app: &AppHandle, label: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let (_, title, width, height, resizable) = WIDGETS
        .iter()
        .find(|w| w.0 == label)
        .copied()
        .ok_or_else(|| format!("Unknown widget: {label}"))?;
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(width, height)
        .resizable(resizable)
        .decorations(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn set_widget_open(app: &AppHandle, state: &AppState, label: &str, open: bool) -> Result<(), String> {
    let list = {
        let mut settings = settings_lock(state)?;
        settings.open_widgets.retain(|l| l != label);
        if open {
            settings.open_widgets.push(label.to_string());
        }
        save_settings(&state.settings_file, &settings)?;
        settings.open_widgets.clone()
    };
    let _ = app.emit("widgets-changed", &list);
    Ok(())
}

/// Pops a section out of the main window as its own widget, and remembers it.
///
/// Must be `async`: a plain (sync) command runs on the main thread, and on
/// Windows building a webview window there deadlocks (the new window waits for
/// the main thread, which is waiting for the command). That froze the app with
/// a blank widget in v0.5.0. Async commands run on a worker thread instead.
#[tauri::command]
async fn open_widget(app: AppHandle, state: State<'_, AppState>, label: String) -> Result<(), String> {
    if !is_widget(&label) {
        return Err(format!("Unknown widget: {label}"));
    }
    #[cfg(desktop)]
    {
        create_widget(&app, &label)?;
        set_widget_open(&app, &state, &label, true)
    }
    #[cfg(not(desktop))]
    {
        let _ = (&app, &state);
        Err("Widgets are only available on desktop".into())
    }
}

/// Which widgets are popped out right now.
#[tauri::command]
fn open_widgets(state: State<AppState>) -> Result<Vec<String>, String> {
    Ok(settings_lock(&state)?.open_widgets.clone())
}

/// True on Windows, macOS and Linux; false on phones, where there are no pop-outs.
#[tauri::command]
fn is_desktop() -> bool {
    cfg!(desktop)
}

// =====================================================================
// Cogitator stats (the dashboard). Same rules as scripts/cogitator_stats.py.
// =====================================================================

/// Log names for the timer and the task widget, current first; older logs use the earlier names.
const TIMER_NAMES: [&str; 3] = ["Chrono-Siphon", "Chronoglass", "Tempormortis"];
const STYLUS_NAMES: [&str; 2] = ["Data Stylus", "Auto Quill"];
const STALLED_AFTER_DAYS: i64 = 7;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DayStat {
    date: String,
    minutes: u32,
    sessions: u32,
    subtasks_done: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskStat {
    task: String,
    minutes: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScrollStat {
    title: String,
    file: String,
    done: u32,
    total: u32,
    idle_days: Option<i64>,
    /// complete | stalled | active
    status: &'static str,
    next_item: Option<String>,
    /// When it was last changed: the note's `updated:` field, or the file date
    /// for notes written by hand in Obsidian.
    updated: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    today: DayStat,
    /// Consecutive days with focus, ending today (or yesterday, if today has none yet).
    streak: u32,
    /// Oldest first, ending today.
    days: Vec<DayStat>,
    by_task: Vec<TaskStat>,
    /// Focus per project tag over the range; untagged sessions are left out.
    by_project: Vec<TaskStat>,
    /// Minutes in untagged sessions over the range.
    untagged_minutes: u32,
    /// Daily focus goal in minutes (0 = off).
    goal_minutes: u32,
    /// Days in the range that reached the goal.
    goal_days_met: u32,
    scrolls: Vec<ScrollStat>,
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, m, d)
}

fn parse_day(date: &str) -> Option<i64> {
    if !is_iso_date(date) {
        return None;
    }
    let n = |r: std::ops::Range<usize>| date[r].parse::<i64>().ok();
    Some(days_from_civil(n(0..4)?, n(5..7)?, n(8..10)?))
}

fn format_day(day: i64) -> String {
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}

/// One recorded Chrono-Siphon session.
struct Session {
    day: i64,
    task: String,
    project: Option<String>,
    minutes: u32,
}

/// The project in a session's tag field, written as an Obsidian link: `[[Cogitorium]]`
/// (an alias, `[[Cogitorium|Cog]]`, is ignored).
fn project_tag(field: &str) -> Option<String> {
    let inner = field.trim().strip_prefix("[[")?.strip_suffix("]]")?;
    let name = inner.split('|').next()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

#[derive(Default)]
struct DayTotals {
    minutes: u32,
    sessions: u32,
    subtasks_done: u32,
}

/// Reads every daily log: totals per day, and every focus session.
/// A session line is `- HH:MM · Chrono-Siphon · 25 min · <task> · [[<project>]]`; the project is optional.
fn read_day_totals(folder: &Path) -> (std::collections::HashMap<i64, DayTotals>, Vec<Session>) {
    let mut days = std::collections::HashMap::<i64, DayTotals>::new();
    let mut sessions = Vec::new();
    let Ok(entries) = fs::read_dir(folder) else {
        return (days, sessions);
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(day) = name.strip_suffix(".md").and_then(parse_day) else {
            continue;
        };
        let Ok(text) = fs::read_to_string(entry.path()) else {
            continue;
        };
        for line in text.lines() {
            let Some(rest) = line.trim().strip_prefix("- ") else {
                continue;
            };
            let fields: Vec<&str> = rest.split(" · ").map(str::trim).collect();
            if fields.len() < 3 {
                continue;
            }
            let widget = fields[1];
            if TIMER_NAMES.contains(&widget) {
                let Some(minutes) = fields[2].split_whitespace().next().and_then(|m| m.parse::<u32>().ok()) else {
                    continue;
                };
                let totals = days.entry(day).or_default();
                totals.minutes += minutes;
                totals.sessions += 1;
                let task = fields.get(3).copied().unwrap_or("untitled").to_string();
                let project = fields.get(4).and_then(|f| project_tag(f));
                sessions.push(Session { day, task, project, minutes });
            } else if STYLUS_NAMES.contains(&widget) && fields[2] == "completed" {
                days.entry(day).or_default().subtasks_done += 1;
            }
        }
    }
    (days, sessions)
}

/// Progress of one scroll note. `file_day` is the file's modified date, used
/// when the note has no `updated:` field (one written by hand in Obsidian).
fn scroll_stat(file: String, text: &str, file_day: Option<i64>, today: i64) -> ScrollStat {
    let title = text
        .lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(|t| t.trim().to_string())
        .unwrap_or_else(|| file.trim_end_matches(".md").to_string());
    let mut done = 0;
    let mut total = 0;
    let mut next_item = None;
    for line in text.lines() {
        let l = line.trim_start();
        for (prefix, ticked) in [("- [x] ", true), ("- [X] ", true), ("- [ ] ", false)] {
            if let Some(item) = l.strip_prefix(prefix) {
                total += 1;
                if ticked {
                    done += 1;
                } else if next_item.is_none() {
                    next_item = Some(item.trim().to_string());
                }
            }
        }
    }
    let stamped = text
        .lines()
        .find_map(|l| l.strip_prefix("updated:"))
        .map(|v| v.trim().to_string())
        .filter(|v| v.get(0..10).and_then(parse_day).is_some());
    let updated_day = stamped.as_deref().and_then(|v| parse_day(&v[0..10])).or(file_day);
    let updated = stamped.or_else(|| file_day.map(format_day));
    let idle_days = updated_day.map(|d| (today - d).max(0));
    let status = if total > 0 && done == total {
        "complete"
    } else if idle_days.is_some_and(|d| d >= STALLED_AFTER_DAYS) {
        "stalled"
    } else {
        "active"
    };
    ScrollStat { title, file, done, total, idle_days, status, next_item, updated }
}

fn read_scroll_stats(folder: &Path, today: i64) -> Vec<ScrollStat> {
    let Ok(entries) = fs::read_dir(folder.join("Scrolls")) else {
        return Vec::new();
    };
    let mut out: Vec<ScrollStat> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            if !is_safe_note_name(&file) {
                return None;
            }
            let text = fs::read_to_string(e.path()).ok()?;
            // The file date in UTC days; close enough for notes that carry no date of their own.
            let file_day = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| (d.as_secs() / 86_400) as i64);
            Some(scroll_stat(file, &text, file_day, today))
        })
        .collect();
    // stalled first, then active, then complete; most recently touched first within each
    let rank = |s: &ScrollStat| match s.status {
        "stalled" => 0,
        "active" => 1,
        _ => 2,
    };
    out.sort_by(|a, b| rank(a).cmp(&rank(b)).then(a.idle_days.cmp(&b.idle_days)));
    out
}

/// Builds the dashboard numbers for the `days` days ending `today` (YYYY-MM-DD, the user's local date).
fn compute_stats(vault: &Path, today: &str, days: u32, goal_minutes: u32) -> Result<Stats, String> {
    let today_n = parse_day(today).ok_or_else(|| format!("Bad date: {today}"))?;
    let days = days.clamp(1, 366) as i64;
    let folder = log_dir(vault)?;
    let (totals, sessions) = read_day_totals(&folder);

    let day_stat = |d: i64| {
        let t = totals.get(&d);
        DayStat {
            date: format_day(d),
            minutes: t.map_or(0, |t| t.minutes),
            sessions: t.map_or(0, |t| t.sessions),
            subtasks_done: t.map_or(0, |t| t.subtasks_done),
        }
    };
    let focused = |d: i64| totals.get(&d).is_some_and(|t| t.minutes > 0);

    // A streak isn't broken just because today hasn't had a session yet.
    let mut cursor = if focused(today_n) { today_n } else { today_n - 1 };
    let mut streak = 0;
    while focused(cursor) {
        streak += 1;
        cursor -= 1;
    }

    let start = today_n - days + 1;
    let mut by_task = std::collections::HashMap::<String, u32>::new();
    let mut by_project = std::collections::HashMap::<String, u32>::new();
    let mut untagged_minutes = 0;
    for s in sessions.iter().filter(|s| (start..=today_n).contains(&s.day)) {
        *by_task.entry(s.task.clone()).or_default() += s.minutes;
        match &s.project {
            Some(p) => *by_project.entry(p.clone()).or_default() += s.minutes,
            None => untagged_minutes += s.minutes,
        }
    }
    let ranked = |map: std::collections::HashMap<String, u32>| {
        let mut list: Vec<TaskStat> = map.into_iter().map(|(task, minutes)| TaskStat { task, minutes }).collect();
        list.sort_by(|a, b| b.minutes.cmp(&a.minutes).then(a.task.cmp(&b.task)));
        list.truncate(6);
        list
    };

    let days: Vec<DayStat> = (start..=today_n).map(day_stat).collect();
    let goal_days_met = if goal_minutes == 0 { 0 } else { days.iter().filter(|d| d.minutes >= goal_minutes).count() as u32 };

    Ok(Stats {
        today: day_stat(today_n),
        streak,
        days,
        by_task: ranked(by_task),
        by_project: ranked(by_project),
        untagged_minutes,
        goal_minutes,
        goal_days_met,
        scrolls: read_scroll_stats(&folder, today_n),
    })
}

#[tauri::command]
fn cogitator_stats(state: State<AppState>, today: String, days: u32) -> Result<Stats, String> {
    let goal = settings_lock(&state)?.daily_goal;
    compute_stats(&vault_root(&state)?, &today, days, goal)
}

// =====================================================================

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
            let legacy_settings = app.path().config_dir().ok().map(|d| d.join(LEGACY_APP_ID).join("settings.json"));
            let vault = initial_vault(&settings_file, legacy_settings.as_deref(), obsidian_list.as_deref());
            let mut settings = load_settings(&settings_file);
            settings.vault = vault;
            settings.open_widgets.retain(|l| is_widget(l));
            let reopen = settings.open_widgets.clone();
            app.manage(AppState {
                settings_file,
                settings: Mutex::new(settings),
                timer: Mutex::new(Timer::default()),
                quitting: AtomicBool::new(false),
            });
            // Reopen the widgets that were popped out last time.
            #[cfg(desktop)]
            for label in reopen {
                let _ = create_widget(app.handle(), &label);
            }
            #[cfg(not(desktop))]
            let _ = reopen;
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let state = app.state::<AppState>();
            match event {
                // Closing the main window quits the whole app; the pop-out list is kept for next time.
                tauri::WindowEvent::CloseRequested { .. } if window.label() == "main" => {
                    state.quitting.store(true, Ordering::SeqCst);
                    app.exit(0);
                }
                // Closing a widget on its own forgets it.
                tauri::WindowEvent::Destroyed if is_widget(window.label()) && !state.quitting.load(Ordering::SeqCst) => {
                    let _ = set_widget_open(app, &state, window.label(), false);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_vault,
            set_vault,
            append_log,
            write_scroll,
            read_scroll,
            list_scrolls,
            scroll_library,
            get_open_scroll,
            set_open_scroll,
            timer_get,
            timer_start,
            timer_pause,
            timer_resume,
            timer_reset,
            timer_finish,
            open_widget,
            open_widgets,
            is_desktop,
            cogitator_stats,
            set_goal,
            list_projects
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
        let path = append_log_in(&vault, "2026-11-12", "- 14:32 · Chrono-Siphon · 25 min · test").unwrap();
        append_log_in(&vault, "2026-11-12", "- 14:40 · Data Stylus · completed · test").unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(path.ends_with("2026-11-12.md"));
        assert!(path.contains("Widgets"));
        assert_eq!(text.matches("type: widget-log").count(), 1, "frontmatter written once");
        assert!(text.contains("Chrono-Siphon · 25 min") && text.contains("Data Stylus · completed"));
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
        save_settings(&settings_file, &Settings { vault: Some(dir.join("gone")), ..Default::default() }).unwrap();
        assert_eq!(saved_vault(&settings_file), None);

        // A saved, existing folder is read back on the next start.
        save_settings(&settings_file, &Settings { vault: Some(vault.clone()), ..Default::default() }).unwrap();
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
            assert_eq!(initial_vault(&settings_file, None, Some(&list)), Some(b.clone()));
            assert_eq!(saved_vault(&settings_file), Some(b.clone()));
        }

        // A vault saved under the old app ID wins over detection and is copied across.
        let new_settings = a.join("new").join("settings.json");
        let old_settings = a.join("old").join("settings.json");
        save_settings(&old_settings, &Settings { vault: Some(a.clone()), ..Default::default() }).unwrap();
        assert_eq!(initial_vault(&new_settings, Some(&old_settings), Some(&list)), Some(a.clone()));
        assert_eq!(saved_vault(&new_settings), Some(a.clone()));

        fs::remove_dir_all(&a).unwrap();
        fs::remove_dir_all(&b).unwrap();
    }

    #[test]
    fn saving_the_vault_keeps_open_widgets() {
        let dir = temp_dir("keep");
        let file = dir.join("settings.json");
        let settings = Settings {
            vault: None,
            open_widgets: vec!["chrono-siphon".into()],
            daily_goal: 90,
            open_scroll: Some("UE5 HUD.md".into()),
        };
        save_settings(&file, &settings).unwrap();
        save_vault(&file, &dir).unwrap();
        let back = load_settings(&file);
        assert_eq!(back.vault, Some(dir.clone()));
        assert_eq!(back.open_widgets, vec!["chrono-siphon".to_string()]);
        assert_eq!(back.daily_goal, 90);
        assert_eq!(back.open_scroll.as_deref(), Some("UE5 HUD.md"), "the open scroll survives a restart");
        // Older settings files without open_widgets, a goal or an open scroll still load, with the default goal.
        fs::write(&file, r#"{"vault": null}"#).unwrap();
        let old = load_settings(&file);
        assert!(old.open_widgets.is_empty());
        assert_eq!(old.daily_goal, DEFAULT_GOAL_MINUTES);
        assert_eq!(old.open_scroll, None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn timer_pauses_and_resumes_where_it_left_off() {
        let mut t = Timer::default();
        t.start("quarry".into(), "Cogitorium".into(), 25, 1_000);
        assert_eq!((t.phase, t.end_at), ("running", Some(1_000 + 25 * 60_000)));
        t.pause(61_000); // a minute in
        assert_eq!((t.phase, t.remaining_ms), ("paused", Some(24 * 60_000)));
        t.resume(500_000);
        assert_eq!((t.phase, t.end_at), ("running", Some(500_000 + 24 * 60_000)));
        // Too early to finish; then only the first finish call wins.
        assert!(!t.finish(600_000));
        let end = t.end_at.unwrap();
        assert!(t.finish(end));
        assert!(!t.finish(end + 5));
        assert_eq!(t.phase, "finished");
        t.reset();
        assert_eq!((t.phase, t.task.as_str(), t.project.as_str(), t.minutes), ("idle", "quarry", "Cogitorium", 25));
        // Minutes are clamped.
        t.start(String::new(), String::new(), 999, 0);
        assert_eq!(t.minutes, 180);
    }

    #[test]
    fn project_tags_are_obsidian_links() {
        assert_eq!(project_tag("[[Cogitorium]]").as_deref(), Some("Cogitorium"));
        assert_eq!(project_tag(" [[Job Applications|Jobs]] ").as_deref(), Some("Job Applications"));
        assert_eq!(project_tag("Cogitorium"), None);
        assert_eq!(project_tag("[[]]"), None);
        let vault = temp_dir("projects");
        fs::create_dir_all(vault.join("Projects")).unwrap();
        for f in ["Zeta.md", "cogitorium.md", "notes.txt", ".hidden.md"] {
            fs::write(vault.join("Projects").join(f), "").unwrap();
        }
        assert_eq!(list_projects_in(&vault), vec!["cogitorium".to_string(), "Zeta".to_string()]);
        fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn dates_round_trip() {
        for d in ["1970-01-01", "2000-02-29", "2026-11-12", "2026-12-31", "2027-01-01"] {
            assert_eq!(format_day(parse_day(d).unwrap()), d);
        }
        assert_eq!(parse_day("2027-01-01").unwrap() - parse_day("2026-12-31").unwrap(), 1);
        assert_eq!(parse_day("nope"), None);
    }

    #[test]
    fn stats_count_focus_streaks_and_stalls() {
        let vault = temp_dir("stats");
        let w = vault.join(DEFAULT_LOG_DIR);
        fs::create_dir_all(w.join("Scrolls")).unwrap();
        let log = |day: &str, lines: &[&str]| fs::write(w.join(format!("{day}.md")), format!("---\ntype: widget-log\n---\n# {day}\n\n{}\n", lines.join("\n"))).unwrap();
        log("2026-11-09", &["- 09:10 · Tempormortis · 45 min · UE5 C++ refresh"]);
        log("2026-11-10", &["- 09:30 · Chronoglass · 25 min · UE5 HUD", "- 10:00 · Auto Quill · completed · a · UE5 HUD"]);
        log("2026-11-11", &["- 08:45 · Chrono-Siphon · 60 min · UE5 HUD", "- 19:00 · Data Stylus · completed · b · Reset", "- 19:01 · Data Stylus · reopened · b · Reset", "junk"]);
        log("2026-11-12", &["- 09:15 · Chrono-Siphon · 25 min · UE5 HUD · [[Cogitorium]]", "- 09:50 · Chrono-Siphon · 20 min · Job apps · [[Job Applications|Jobs]]", "- 10:20 · Chrono-Siphon · 15 min · UE5 HUD · [[Cogitorium]]"]);
        log("2026-10-01", &["- 09:00 · Chrono-Siphon · 25 min · old"]);
        fs::write(w.join("Scrolls/HUD.md"), "---\nupdated: 2026-11-02 10:00\n---\n# UE5 HUD\n\n- [x] a\n- [ ] build the bar\n  - [ ] bind it\n").unwrap();
        fs::write(w.join("Scrolls/Reset.md"), "---\nupdated: 2026-11-12 16:00\n---\n# Reset\n\n- [x] a\n- [x] b\n").unwrap();

        let s = compute_stats(&vault, "2026-11-12", 7, 60).unwrap();
        assert_eq!((s.today.minutes, s.today.sessions), (60, 3));
        assert_eq!(s.streak, 4);
        assert_eq!(s.days.len(), 7);
        assert_eq!(s.days.first().unwrap().date, "2026-11-06");
        assert_eq!(s.days.iter().map(|d| d.minutes).sum::<u32>(), 190, "old log is outside the week");
        assert_eq!(s.days.iter().map(|d| d.subtasks_done).sum::<u32>(), 2);
        assert_eq!((s.by_task[0].task.as_str(), s.by_task[0].minutes), ("UE5 HUD", 125));
        // Project tags: aliases are dropped, untagged (older) sessions are counted apart.
        let projects: Vec<(&str, u32)> = s.by_project.iter().map(|p| (p.task.as_str(), p.minutes)).collect();
        assert_eq!(projects, vec![("Cogitorium", 40), ("Job Applications", 20)]);
        assert_eq!(s.untagged_minutes, 130);
        // Goal of 60 minutes: met on the 11th (60) and the 12th (60), not the 9th (45) or 10th (25).
        assert_eq!((s.goal_minutes, s.goal_days_met), (60, 2));
        assert_eq!(compute_stats(&vault, "2026-11-12", 7, 0).unwrap().goal_days_met, 0, "a goal of 0 is off");
        let hud = s.scrolls.iter().find(|x| x.title == "UE5 HUD").unwrap();
        assert_eq!((hud.done, hud.total, hud.status, hud.idle_days), (1, 3, "stalled", Some(10)));
        assert_eq!(hud.next_item.as_deref(), Some("build the bar"));
        assert_eq!(s.scrolls[0].status, "stalled", "stalled scrolls come first");
        assert_eq!(s.scrolls.iter().find(|x| x.title == "Reset").unwrap().status, "complete");

        // No session yet today: yesterday's streak still counts.
        let s = compute_stats(&vault, "2026-11-13", 7, 60).unwrap();
        assert_eq!((s.today.minutes, s.streak), (0, 4));
        // A missed day breaks it.
        assert_eq!(compute_stats(&vault, "2026-11-14", 7, 60).unwrap().streak, 0);
        fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn scroll_library_reads_hand_written_notes() {
        let today = parse_day("2026-11-14").unwrap();
        // Written by the Data Stylus: the `updated:` field wins over the file date.
        let slate = "---
type: data-stylus-scroll
created: 2026-11-01
updated: 2026-11-10 09:30
progress: 1/2
---
# UE5 HUD

- [x] Mock it up
  - [ ] Health bar
";
        let s = scroll_stat("UE5 HUD.md".into(), slate, Some(today), today);
        assert_eq!((s.done, s.total, s.idle_days), (1, 2, Some(4)));
        assert_eq!(s.updated.as_deref(), Some("2026-11-10 09:30"));
        assert_eq!(s.next_item.as_deref(), Some("Health bar"));
        // Written by hand in Obsidian: no frontmatter, so the title is the file name and the file date counts.
        let by_hand = "- [ ] Pack
- [ ] Book flights
";
        let s = scroll_stat("Trip.md".into(), by_hand, Some(today - 8), today);
        assert_eq!(s.title, "Trip");
        assert_eq!((s.idle_days, s.status), (Some(8), "stalled"));
        assert_eq!(s.updated.as_deref(), Some("2026-11-06"));
        // Only safe note names are listed, so every entry can be opened.
        let vault = temp_dir("library");
        let folder = log_dir(&vault).unwrap();
        fs::create_dir_all(folder.join("Scrolls")).unwrap();
        fs::write(folder.join("Scrolls").join("Trip.md"), by_hand).unwrap();
        fs::write(folder.join("Scrolls").join(".hidden.md"), by_hand).unwrap();
        fs::write(folder.join("Scrolls").join("notes.txt"), by_hand).unwrap();
        let listed: Vec<String> = read_scroll_stats(&folder, today).into_iter().map(|s| s.file).collect();
        assert_eq!(listed, vec!["Trip.md".to_string()]);
        fs::remove_dir_all(&vault).unwrap();
    }
}
