//! The Flesh-Forge: workouts, kept as Markdown notes in the vault.
//!
//! Each workout is one note in `<log dir>/Flesh-Forge/`, named
//! `<YYYY-MM-DD> <Title>.md`; templates live in `Flesh-Forge/Templates/`.
//! This module owns the note format (reading and writing it) and counts the
//! dashboard numbers, so the frontend only ever sees structured workouts.
//!
//! ```markdown
//! ---
//! type: flesh-forge-workout
//! date: 2026-11-16
//! title: Push
//! status: done
//! started: 18:05
//! finished: 19:10
//! ---
//! # Push · 2026-11-16
//!
//! Session notes.
//!
//! ## Bench press
//! - [x] 60 kg × 8
//! - [ ] bodyweight × 12
//! Notes: left shoulder tight
//!
//! ## Treadmill · cardio
//! - [x] 20 min · 3 km
//! ```

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::{format_day, is_iso_date, is_safe_note_name, log_dir, parse_day, vault_root, AppState};

const FORGE_DIR: &str = "Flesh-Forge";
const TEMPLATE_DIR: &str = "Templates";
const WORKOUT_TYPE: &str = "flesh-forge-workout";
const TEMPLATE_TYPE: &str = "flesh-forge-template";
/// Weeks shown on the dashboard.
const WEEKS: i64 = 12;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Set {
    pub done: bool,
    /// Kilograms; `None` for a bodyweight set.
    pub weight: Option<f64>,
    /// Lift reps; `None` means "as many as you can" (max).
    pub reps: Option<u32>,
    /// Cardio: time and distance.
    pub minutes: Option<f64>,
    pub km: Option<f64>,
    /// Hold: seconds; `None` means "as long as you can" (max).
    pub seconds: Option<f64>,
    /// Carry: distance in metres.
    pub metres: Option<f64>,
    /// Rate of perceived exertion, 1-10 (halves allowed); written as "@ RPE 8".
    pub rpe: Option<f64>,
}

/// Exercise kinds, by how a set is measured.
pub const KINDS: [&str; 4] = ["lift", "hold", "carry", "cardio"];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Exercise {
    pub name: String,
    /// "lift" (kg × reps), "hold" (seconds), "carry" (kg + metres) or "cardio" (minutes, km).
    pub kind: String,
    pub notes: String,
    pub sets: Vec<Set>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workout {
    /// File name in `Flesh-Forge/` (or `Templates/`); empty until first saved.
    pub file: String,
    /// YYYY-MM-DD; empty for a template.
    pub date: String,
    pub title: String,
    /// "planned", "active" or "done".
    pub status: String,
    pub started: Option<String>,
    pub finished: Option<String>,
    pub notes: String,
    pub exercises: Vec<Exercise>,
}

impl Exercise {
    fn is_cardio(&self) -> bool {
        self.kind == "cardio"
    }
}

impl Workout {
    /// Whether this was a gym visit: finished, or at least one set ticked.
    fn is_visit(&self) -> bool {
        self.status == "done" || self.exercises.iter().any(|e| e.sets.iter().any(|s| s.done))
    }
}

// ---------------------------------------------------------------- numbers

/// "60", "62.5", "3.25": at most two decimals, no trailing zeros.
fn num(n: f64) -> String {
    let s = format!("{:.2}", n);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn parse_num(s: &str) -> Option<f64> {
    let n: f64 = s.trim().replace(',', ".").parse().ok()?;
    (n.is_finite() && n >= 0.0).then_some(n)
}

const MINUTES: [&str; 4] = ["min", "mins", "minute", "minutes"];
const KM: [&str; 2] = ["km", "kms"];
const SECONDS: [&str; 5] = ["s", "sec", "secs", "second", "seconds"];
const METRES: [&str; 5] = ["m", "metre", "metres", "meter", "meters"];
const KG: [&str; 2] = ["kg", "kgs"];

/// The number given in one of `units`: "20 min", "20min" and "20 minutes" all give 20.
fn number_with(text: &str, units: &[&str]) -> Option<f64> {
    let tokens: Vec<&str> = text
        .split(|c: char| c.is_whitespace() || c == '·' || c == ',' || c == '(' || c == ')')
        .filter(|t| !t.is_empty())
        .collect();
    for (i, t) in tokens.iter().enumerate() {
        if units.contains(t) {
            if let Some(n) = i.checked_sub(1).and_then(|j| parse_num(tokens[j])) {
                return Some(n);
            }
        } else if let Some(n) = units.iter().find_map(|u| t.strip_suffix(u).and_then(parse_num)) {
            return Some(n);
        }
    }
    None
}

/// Estimated one-rep max (Epley).
fn e1rm(weight: f64, reps: u32) -> f64 {
    if reps <= 1 {
        weight
    } else {
        weight * (1.0 + reps as f64 / 30.0)
    }
}

// ---------------------------------------------------------------- reading

/// A set line's text (after the checkbox), or `None` if it isn't one.
///
/// - cardio: `20 min · 3 km`
/// - hold: `45 s`, `10 kg · 30 s`, `max hold`
/// - carry: `24 kg · 40 m`
/// - lift: `60 kg × 8`, `bodyweight × 12`, `bodyweight × max`
fn parse_set(text: &str, done: bool) -> Option<Set> {
    let t = text.trim().to_lowercase().replace(['×', '*'], "x");
    let (t, rpe) = split_rpe(&t);
    let set = parse_set_body(t.trim(), done)?;
    Some(Set { rpe, ..set })
}

/// Splits "60 kg x 8 @ rpe 8.5" into ("60 kg x 8", Some(8.5)). Also takes "@8" and "rpe 8".
fn split_rpe(t: &str) -> (String, Option<f64>) {
    let cut = t.find("@").or_else(|| t.find("rpe"));
    let Some(at) = cut else {
        return (t.to_string(), None);
    };
    let tail = t[at..].trim_start_matches('@').trim().trim_start_matches("rpe").trim();
    let rpe = tail
        .split_whitespace()
        .next()
        .and_then(parse_num)
        .filter(|n| (1.0..=10.0).contains(n));
    match rpe {
        Some(r) => (t[..at].trim_end().to_string(), Some(r)),
        None => (t.to_string(), None),
    }
}

fn parse_set_body(t: &str, done: bool) -> Option<Set> {
    let t = t.to_string();
    if t.is_empty() {
        return None;
    }
    let minutes = number_with(&t, &MINUTES);
    let km = number_with(&t, &KM);
    if minutes.is_some() || km.is_some() {
        return Some(Set { done, minutes, km, ..Set::default() });
    }
    let weight = number_with(&t, &KG);
    if let Some(metres) = number_with(&t, &METRES) {
        return Some(Set { done, weight, metres: Some(metres), ..Set::default() });
    }
    let seconds = number_with(&t, &SECONDS);
    if seconds.is_some() || t.contains("hold") {
        return Some(Set { done, weight, seconds, ..Set::default() });
    }
    // Lift: "<weight> x <reps>". Prefer " x " so "max" (which has an x in it) survives.
    let (left, right) = match t.split_once(" x ") {
        Some(pair) => pair,
        None => t.rsplit_once('x').filter(|(_, r)| r.trim_start().starts_with(|c: char| c.is_ascii_digit()))?,
    };
    let right = right.split_whitespace().next().unwrap_or("");
    let reps = match right {
        "max" | "amrap" => None,
        r => Some(r.parse::<u32>().ok()?),
    };
    let left = left.trim();
    let weight = match left {
        "" | "bw" | "bodyweight" | "body weight" => None,
        _ => Some(parse_num(left.trim_end_matches("kgs").trim_end_matches("kg"))?),
    };
    Some(Set { done, weight, reps, ..Set::default() })
}

/// The kind a list of sets implies, when the heading doesn't say.
fn kind_of(sets: &[Set]) -> &'static str {
    if sets.iter().any(|s| s.minutes.is_some() || s.km.is_some()) {
        "cardio"
    } else if sets.iter().any(|s| s.metres.is_some()) {
        "carry"
    } else if sets.iter().any(|s| s.seconds.is_some()) {
        "hold"
    } else {
        "lift"
    }
}

/// `- [x] text`, `- [ ] text` or `- text`: (done, text).
fn list_item(line: &str) -> Option<(bool, &str)> {
    let rest = line.trim_start().strip_prefix("- ").or_else(|| line.trim_start().strip_prefix("* "))?;
    if let Some(r) = rest.strip_prefix("[x] ").or_else(|| rest.strip_prefix("[X] ")) {
        Some((true, r))
    } else if let Some(r) = rest.strip_prefix("[ ] ") {
        Some((false, r))
    } else {
        Some((false, rest))
    }
}

/// Reads a workout or template note. `file` is its file name.
pub fn parse_workout(text: &str, file: &str) -> Workout {
    let mut w = Workout { file: file.to_string(), status: "planned".into(), ..Workout::default() };
    let mut body = text;
    // frontmatter
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                let Some((key, value)) = line.split_once(':') else { continue };
                let value = value.trim().to_string();
                match key.trim() {
                    "date" if is_iso_date(&value) => w.date = value,
                    "title" => w.title = value,
                    "status" if ["planned", "active", "done"].contains(&value.as_str()) => w.status = value,
                    "started" if !value.is_empty() => w.started = Some(value),
                    "finished" if !value.is_empty() => w.finished = Some(value),
                    _ => {}
                }
            }
            body = rest[end + 4..].trim_start_matches(['-', '\r', '\n']);
        }
    }

    let mut session_notes: Vec<&str> = Vec::new();
    let mut ex_notes: Vec<String> = Vec::new();
    let mut current: Option<Exercise> = None;
    let finish = |current: &mut Option<Exercise>, notes: &mut Vec<String>, list: &mut Vec<Exercise>| {
        if let Some(mut e) = current.take() {
            e.notes = notes.join("\n").trim().to_string();
            if e.kind.is_empty() {
                e.kind = kind_of(&e.sets).into();
            }
            list.push(e);
        }
        notes.clear();
    };
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(h) = trimmed.strip_prefix("# ") {
            if w.title.is_empty() {
                w.title = h.split(" · ").next().unwrap_or(h).trim().to_string();
            }
        } else if let Some(h) = trimmed.strip_prefix("## ") {
            finish(&mut current, &mut ex_notes, &mut w.exercises);
            // "## Plank · hold": the kind is named after the exercise (lifts have none).
            let (name, kind) = KINDS
                .iter()
                .find_map(|k| h.trim().strip_suffix(&format!("· {k}")).map(|n| (n.trim().to_string(), k.to_string())))
                .unwrap_or_else(|| (h.trim().to_string(), String::new()));
            current = Some(Exercise { name, kind, ..Exercise::default() });
        } else if let Some(ex) = current.as_mut() {
            match list_item(line).and_then(|(done, t)| parse_set(t, done)) {
                Some(set) => ex.sets.push(set),
                None if !trimmed.is_empty() => {
                    let note = trimmed.strip_prefix("Notes:").map(str::trim).unwrap_or(trimmed);
                    ex_notes.push(note.to_string());
                }
                None => {}
            }
        } else if !trimmed.is_empty() {
            session_notes.push(trimmed);
        }
    }
    finish(&mut current, &mut ex_notes, &mut w.exercises);
    w.notes = session_notes.join("\n");
    if w.date.is_empty() {
        if let Some(d) = file.get(0..10).filter(|d| is_iso_date(d)) {
            w.date = d.to_string();
        }
    }
    if w.title.is_empty() {
        let stem = file.trim_end_matches(".md");
        w.title = stem.strip_prefix(&format!("{} ", w.date)).unwrap_or(stem).to_string();
    }
    w
}

// ---------------------------------------------------------------- writing

fn set_line(set: &Set, kind: &str) -> String {
    let tick = if set.done { "x" } else { " " };
    let kg = set.weight.map(|w| format!("{} kg", num(w)));
    let text = match kind {
        "cardio" => {
            let mut parts = Vec::new();
            if let Some(m) = set.minutes {
                parts.push(format!("{} min", num(m)));
            }
            if let Some(k) = set.km {
                parts.push(format!("{} km", num(k)));
            }
            if parts.is_empty() {
                parts.push("0 min".into());
            }
            parts.join(" · ")
        }
        "hold" => {
            let time = set.seconds.map_or("max hold".to_string(), |s| format!("{} s", num(s)));
            kg.map_or(time.clone(), |kg| format!("{kg} · {time}"))
        }
        "carry" => {
            let distance = format!("{} m", num(set.metres.unwrap_or(0.0)));
            kg.map_or(distance.clone(), |kg| format!("{kg} · {distance}"))
        }
        _ => {
            let reps = set.reps.map_or("max".to_string(), |r| r.to_string());
            format!("{} × {reps}", kg.unwrap_or_else(|| "bodyweight".into()))
        }
    };
    let rpe = set.rpe.map(|r| format!(" @ RPE {}", num(r))).unwrap_or_default();
    format!("- [{tick}] {text}{rpe}")
}

/// One line of text, for frontmatter and headings.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The note for a workout (or a template, when `template` is set).
pub fn to_markdown(w: &Workout, template: bool) -> String {
    let title = one_line(&w.title);
    let mut out = vec!["---".to_string()];
    out.push(format!("type: {}", if template { TEMPLATE_TYPE } else { WORKOUT_TYPE }));
    if !template {
        out.push(format!("date: {}", w.date));
    }
    out.push(format!("title: {title}"));
    if !template {
        out.push(format!("status: {}", w.status));
        if let Some(s) = &w.started {
            out.push(format!("started: {s}"));
        }
        if let Some(f) = &w.finished {
            out.push(format!("finished: {f}"));
        }
    }
    out.push("---".into());
    out.push(if template { format!("# {title}") } else { format!("# {title} · {}", w.date) });
    out.push(String::new());
    if !w.notes.trim().is_empty() {
        out.push(w.notes.trim().to_string());
        out.push(String::new());
    }
    for e in &w.exercises {
        let kind = if KINDS.contains(&e.kind.as_str()) { e.kind.as_str() } else { "lift" };
        let suffix = if kind == "lift" { String::new() } else { format!(" · {kind}") };
        out.push(format!("## {}{suffix}", one_line(&e.name)));
        for s in &e.sets {
            let s = if template { Set { done: false, ..s.clone() } } else { s.clone() };
            out.push(set_line(&s, kind));
        }
        let notes: Vec<&str> = e.notes.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        for (i, n) in notes.iter().enumerate() {
            out.push(if i == 0 { format!("Notes: {n}") } else { n.to_string() });
        }
        out.push(String::new());
    }
    out.join("\n")
}

/// A safe file name for a workout: "2026-11-16 Push.md" (or "Push.md" for a template).
fn file_name_for(date: &str, title: &str) -> String {
    let clean: String = title
        .chars()
        .map(|c| if "\\/:*?\"<>|#^[]".contains(c) { ' ' } else { c })
        .collect();
    let mut base = one_line(&clean).chars().take(70).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    if base.is_empty() {
        base = "Workout".into();
    }
    if date.is_empty() {
        format!("{base}.md")
    } else {
        format!("{date} {base}.md")
    }
}

// ---------------------------------------------------------------- files

fn forge_dir(vault: &Path) -> Result<PathBuf, String> {
    Ok(log_dir(vault)?.join(FORGE_DIR))
}

fn template_dir(vault: &Path) -> Result<PathBuf, String> {
    Ok(forge_dir(vault)?.join(TEMPLATE_DIR))
}

/// Every note in `dir`, parsed.
fn read_all(dir: &Path) -> Vec<Workout> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !is_safe_note_name(&name) {
                return None;
            }
            let text = fs::read_to_string(e.path()).ok()?;
            Some(parse_workout(&text, &name))
        })
        .collect()
}

/// Every workout, newest first.
pub fn list_workouts_in(vault: &Path) -> Result<Vec<Workout>, String> {
    let mut list: Vec<Workout> = read_all(&forge_dir(vault)?).into_iter().filter(|w| is_iso_date(&w.date)).collect();
    list.sort_by(|a, b| b.date.cmp(&a.date).then(b.started.cmp(&a.started)).then(a.title.cmp(&b.title)));
    Ok(list)
}

/// Saves a workout (or template) into `dir`, naming the file after its date and
/// title. A renamed workout moves to its new file name. Returns it with `file` set.
fn save_in(dir: &Path, mut w: Workout, template: bool) -> Result<Workout, String> {
    if !template && !is_iso_date(&w.date) {
        return Err(format!("Bad date: {}", w.date));
    }
    if w.title.trim().is_empty() {
        return Err("A workout needs a name".into());
    }
    if !w.file.is_empty() && !is_safe_note_name(&w.file) {
        return Err(format!("Bad workout name: {}", w.file));
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let date = if template { "" } else { w.date.as_str() };
    let wanted = file_name_for(date, &w.title);
    let file = if w.file == wanted || (template && !w.file.is_empty() && w.file.eq_ignore_ascii_case(&wanted)) {
        w.file.clone()
    } else if template {
        // Saving a template under an existing name replaces it.
        wanted
    } else {
        let stem = wanted.trim_end_matches(".md").to_string();
        let mut name = wanted;
        let mut n = 2;
        while dir.join(&name).exists() {
            name = format!("{stem} {n}.md");
            n += 1;
        }
        name
    };
    fs::write(dir.join(&file), to_markdown(&w, template)).map_err(|e| e.to_string())?;
    if !w.file.is_empty() && w.file != file {
        let _ = fs::remove_file(dir.join(&w.file));
    }
    w.file = file;
    Ok(w)
}

fn remove_in(dir: &Path, file: &str) -> Result<(), String> {
    if !is_safe_note_name(file) {
        return Err(format!("Bad workout name: {file}"));
    }
    match fs::remove_file(dir.join(file)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------- exercise library

/// The library note: every exercise you can pick from, grouped, one table row each.
const LIBRARY_FILE: &str = "Exercise Library.md";
const LIBRARY_TYPE: &str = "flesh-forge-library";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryEntry {
    pub name: String,
    /// "lift", "hold", "carry" or "cardio".
    pub kind: String,
    /// The heading it sits under: "Lower body", "Core", …
    pub group: String,
    /// The usual prescription, e.g. "4 × 6-8", "3 × 45s", "35-45 min".
    pub target: String,
    /// Rest between sets, e.g. "2 min".
    pub rest: String,
    pub notes: String,
}

/// The word the library table uses for a kind ("reps" reads better than "lift").
fn kind_word(kind: &str) -> &'static str {
    match kind {
        "hold" => "hold",
        "carry" => "carry",
        "cardio" => "cardio",
        _ => "reps",
    }
}

fn kind_from_word(word: &str) -> &'static str {
    match word.trim().to_lowercase().as_str() {
        "hold" | "time" | "timed" => "hold",
        "carry" | "distance" => "carry",
        "cardio" | "session" => "cardio",
        _ => "lift",
    }
}

/// Reads the library note: `## Group` headings, each followed by a table of
/// `| Exercise | Type | Target | Rest | Notes |` rows.
pub fn parse_library(text: &str) -> Vec<LibraryEntry> {
    let mut group = "Other".to_string();
    let mut out: Vec<LibraryEntry> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some(h) = t.strip_prefix("## ") {
            group = h.trim().to_string();
            continue;
        }
        let Some(row) = t.strip_prefix('|') else { continue };
        let cells: Vec<String> = row.trim_end_matches('|').split('|').map(|c| c.trim().to_string()).collect();
        let name = cells.first().cloned().unwrap_or_default();
        let divider = name.chars().all(|c| c == '-' || c == ':');
        if name.is_empty() || divider || name.eq_ignore_ascii_case("exercise") {
            continue;
        }
        if out.iter().any(|e| e.name.eq_ignore_ascii_case(&name)) {
            continue;
        }
        let cell = |i: usize| cells.get(i).cloned().unwrap_or_default();
        out.push(LibraryEntry {
            name,
            kind: kind_from_word(&cell(1)).into(),
            group: group.clone(),
            target: cell(2),
            rest: cell(3),
            notes: cell(4),
        });
    }
    out
}

/// One table cell: a single line with no pipes.
fn cell(s: &str) -> String {
    one_line(s).replace('|', "/")
}

/// The library note, groups in the order they first appear.
pub fn library_markdown(entries: &[LibraryEntry]) -> String {
    let mut out = vec![
        "---".to_string(),
        format!("type: {LIBRARY_TYPE}"),
        "---".into(),
        "# Exercise Library".into(),
        String::new(),
        "Every exercise the Flesh-Forge offers when you build a workout or a template. Type is `reps` (kg × reps), `hold` (seconds), `carry` (kg and metres) or `cardio` (minutes, km). Edit it here or in the Library tab.".into(),
    ];
    let mut groups: Vec<String> = Vec::new();
    for e in entries {
        let g = if e.group.trim().is_empty() { "Other".to_string() } else { one_line(&e.group) };
        if !groups.contains(&g) {
            groups.push(g);
        }
    }
    for g in groups {
        out.push(String::new());
        out.push(format!("## {g}"));
        out.push(String::new());
        out.push("| Exercise | Type | Target | Rest | Notes |".into());
        out.push("| --- | --- | --- | --- | --- |".into());
        for e in entries.iter().filter(|e| (if e.group.trim().is_empty() { "Other".to_string() } else { one_line(&e.group) }) == g) {
            out.push(format!(
                "| {} | {} | {} | {} | {} |",
                cell(&e.name),
                kind_word(&e.kind),
                cell(&e.target),
                cell(&e.rest),
                cell(&e.notes)
            ));
        }
    }
    out.push(String::new());
    out.join("\n")
}

fn read_library(vault: &Path) -> Result<Vec<LibraryEntry>, String> {
    match fs::read_to_string(forge_dir(vault)?.join(LIBRARY_FILE)) {
        Ok(text) => Ok(parse_library(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes the library, dropping nameless rows and repeated names (the first wins).
fn write_library(vault: &Path, entries: Vec<LibraryEntry>) -> Result<Vec<LibraryEntry>, String> {
    let mut clean: Vec<LibraryEntry> = Vec::new();
    for mut e in entries {
        e.name = one_line(&e.name).replace('|', "/");
        if e.name.is_empty() || clean.iter().any(|c| c.name.eq_ignore_ascii_case(&e.name)) {
            continue;
        }
        e.kind = kind_from_word(kind_word(&e.kind)).into();
        clean.push(e);
    }
    let dir = forge_dir(vault)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(LIBRARY_FILE), library_markdown(&clean)).map_err(|e| e.to_string())?;
    Ok(parse_library(&library_markdown(&clean)))
}

// ---------------------------------------------------------------- bodyweight

/// The weigh-in log: one row per day, any day (not just gym days).
const BODYWEIGHT_FILE: &str = "Bodyweight.md";
const BODYWEIGHT_TYPE: &str = "flesh-forge-bodyweight";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeighIn {
    pub date: String,
    pub kg: f64,
}

/// Reads weigh-ins from the log: any line with a date and a number after it
/// (`| 2026-11-16 | 72.5 |`, `- 2026-11-16 · 72.5 kg`). One per day, the last
/// line for a day wins; oldest first.
pub fn parse_bodyweight(text: &str) -> Vec<WeighIn> {
    let mut by_day: BTreeMap<String, f64> = BTreeMap::new();
    for line in text.lines() {
        let tokens: Vec<&str> = line
            .split(|c: char| c.is_whitespace() || c == '|' || c == '·')
            .filter(|t| !t.is_empty())
            .collect();
        let Some(i) = tokens.iter().position(|t| is_iso_date(t)) else { continue };
        let kg = tokens[i + 1..]
            .iter()
            .find_map(|t| parse_num(t.trim_end_matches("kgs").trim_end_matches("kg")))
            .filter(|n| (20.0..=400.0).contains(n));
        if let Some(kg) = kg {
            by_day.insert(tokens[i].to_string(), kg);
        }
    }
    by_day.into_iter().map(|(date, kg)| WeighIn { date, kg }).collect()
}

pub fn bodyweight_markdown(list: &[WeighIn]) -> String {
    let mut out = vec![
        "---".to_string(),
        format!("type: {BODYWEIGHT_TYPE}"),
        "---".into(),
        "# Bodyweight".into(),
        String::new(),
        "Weigh-ins logged in the Flesh-Forge, in kg. One row per day; add rows here too.".into(),
        String::new(),
        "| Date | kg |".into(),
        "| --- | --- |".into(),
    ];
    out.extend(list.iter().map(|w| format!("| {} | {} |", w.date, num(w.kg))));
    out.push(String::new());
    out.join("\n")
}

fn read_bodyweight(vault: &Path) -> Result<Vec<WeighIn>, String> {
    match fs::read_to_string(forge_dir(vault)?.join(BODYWEIGHT_FILE)) {
        Ok(text) => Ok(parse_bodyweight(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Logs (or with `None`, removes) the weigh-in for `date`. Returns the whole log.
fn set_bodyweight_in(vault: &Path, date: &str, kg: Option<f64>) -> Result<Vec<WeighIn>, String> {
    if !is_iso_date(date) {
        return Err(format!("Bad date: {date}"));
    }
    if let Some(k) = kg {
        if !(20.0..=400.0).contains(&k) {
            return Err(format!("Bodyweight out of range: {k} kg"));
        }
    }
    let mut list: Vec<WeighIn> = read_bodyweight(vault)?.into_iter().filter(|w| w.date != date).collect();
    if let Some(kg) = kg {
        list.push(WeighIn { date: date.to_string(), kg: (kg * 100.0).round() / 100.0 });
    }
    list.sort_by(|a, b| a.date.cmp(&b.date));
    let dir = forge_dir(vault)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(BODYWEIGHT_FILE), bodyweight_markdown(&list)).map_err(|e| e.to_string())?;
    Ok(list)
}

// ---------------------------------------------------------------- stats

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WeekStat {
    /// Monday of the week.
    pub start: String,
    pub visits: u32,
    /// Kilograms lifted (weight × reps over ticked sets).
    pub volume: f64,
    pub cardio_minutes: f64,
    pub cardio_km: f64,
}

/// One session of an exercise.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExercisePoint {
    pub date: String,
    /// Heaviest ticked set (kg).
    pub top_weight: Option<f64>,
    pub best_e1rm: Option<f64>,
    pub volume: f64,
    pub minutes: f64,
    pub km: f64,
    /// Longest ticked hold (seconds).
    pub seconds: f64,
    /// Carry distance (metres).
    pub metres: f64,
    /// Average RPE over the ticked sets that have one.
    pub rpe: Option<f64>,
    /// "60 kg × 8 @8, 70 kg × 6 @9", "45 s, 40 s", "24 kg · 40 m" or "20 min · 3 km".
    pub summary: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseStat {
    pub name: String,
    pub kind: String,
    /// Oldest first.
    pub points: Vec<ExercisePoint>,
    pub best_weight: Option<f64>,
    pub best_e1rm: Option<f64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub exercise: String,
    pub date: String,
    pub weight: f64,
    pub reps: u32,
    pub e1rm: f64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TitleStat {
    pub title: String,
    pub date: String,
    pub file: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ForgeStats {
    pub total_visits: u32,
    pub last_visit: Option<String>,
    pub visits_this_week: u32,
    /// Weeks in a row with a visit, ending this week (or last week, if this week has none yet).
    pub week_streak: u32,
    /// Oldest first, ending this week.
    pub weeks: Vec<WeekStat>,
    /// Days with a visit in the dashboard's range.
    pub visit_days: Vec<String>,
    /// Most recently trained first.
    pub exercises: Vec<ExerciseStat>,
    /// New personal bests (estimated 1RM), newest first.
    pub records: Vec<Record>,
    /// Workout names, most recent first, for "repeat last".
    pub titles: Vec<TitleStat>,
    /// Every weigh-in up to today, oldest first.
    pub bodyweight: Vec<WeighIn>,
}

/// Monday on or before `day` (day 0, 1970-01-01, was a Thursday).
fn week_start(day: i64) -> i64 {
    day - (day + 3).rem_euclid(7)
}

pub fn compute_forge_stats(workouts: &[Workout], weigh_ins: &[WeighIn], today: i64) -> ForgeStats {
    let this_week = week_start(today);
    let first_week = this_week - 7 * (WEEKS - 1);
    let mut weeks: BTreeMap<i64, WeekStat> = (0..WEEKS)
        .map(|i| {
            let start = first_week + 7 * i;
            (start, WeekStat { start: format_day(start), visits: 0, volume: 0.0, cardio_minutes: 0.0, cardio_km: 0.0 })
        })
        .collect();

    let mut visit_days: std::collections::BTreeSet<i64> = Default::default();
    let mut by_exercise: HashMap<String, ExerciseStat> = HashMap::new();
    let mut titles: Vec<TitleStat> = Vec::new();

    // Oldest first, so records are found in order.
    let mut ordered: Vec<&Workout> = workouts.iter().filter(|w| parse_day(&w.date).is_some()).collect();
    ordered.sort_by(|a, b| a.date.cmp(&b.date).then(a.started.cmp(&b.started)));

    let mut records: Vec<Record> = Vec::new();
    for w in &ordered {
        let day = parse_day(&w.date).unwrap_or_default();
        if day > today || !w.is_visit() {
            continue;
        }
        visit_days.insert(day);
        if !titles.iter().any(|t| t.title.eq_ignore_ascii_case(&w.title)) {
            titles.push(TitleStat { title: w.title.clone(), date: w.date.clone(), file: w.file.clone() });
        } else if let Some(t) = titles.iter_mut().find(|t| t.title.eq_ignore_ascii_case(&w.title)) {
            *t = TitleStat { title: w.title.clone(), date: w.date.clone(), file: w.file.clone() };
        }
        let week = weeks.get_mut(&week_start(day));
        let mut week_volume = 0.0;
        let mut week_minutes = 0.0;
        let mut week_km = 0.0;

        for e in &w.exercises {
            let done: Vec<&Set> = e.sets.iter().filter(|s| s.done).collect();
            if done.is_empty() || e.name.trim().is_empty() {
                continue;
            }
            let key = e.name.trim().to_lowercase();
            let stat = by_exercise.entry(key).or_insert_with(|| ExerciseStat {
                name: e.name.trim().to_string(),
                kind: e.kind.clone(),
                points: Vec::new(),
                best_weight: None,
                best_e1rm: None,
            });
            stat.name = e.name.trim().to_string();
            stat.kind = e.kind.clone();
            let mut point = ExercisePoint {
                date: w.date.clone(),
                top_weight: None,
                best_e1rm: None,
                volume: 0.0,
                minutes: 0.0,
                km: 0.0,
                seconds: 0.0,
                metres: 0.0,
                rpe: None,
                summary: String::new(),
            };
            let rated: Vec<f64> = done.iter().filter_map(|s| s.rpe).collect();
            if !rated.is_empty() {
                point.rpe = Some(rated.iter().sum::<f64>() / rated.len() as f64);
            }
            let at = |s: &Set| s.rpe.map(|r| format!(" @{}", num(r))).unwrap_or_default();
            let mut parts = Vec::new();
            let kg = |w: Option<f64>| w.map(|w| format!("{} kg · ", num(w))).unwrap_or_default();
            let heavier = |top: Option<f64>, w: Option<f64>| match (top, w) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
            for s in &done {
                if e.is_cardio() {
                    point.minutes += s.minutes.unwrap_or(0.0);
                    point.km += s.km.unwrap_or(0.0);
                } else if e.kind == "hold" {
                    let secs = s.seconds.unwrap_or(0.0);
                    point.seconds = point.seconds.max(secs);
                    point.top_weight = heavier(point.top_weight, s.weight);
                    parts.push(format!("{}{} s{}", kg(s.weight), num(secs), at(s)));
                } else if e.kind == "carry" {
                    point.metres += s.metres.unwrap_or(0.0);
                    point.top_weight = heavier(point.top_weight, s.weight);
                    parts.push(format!("{}{} m{}", kg(s.weight), num(s.metres.unwrap_or(0.0)), at(s)));
                } else {
                    let reps = s.reps.unwrap_or(0);
                    let weight = s.weight;
                    let shown = s.reps.map_or("max".to_string(), |r| r.to_string());
                    parts.push(format!("{} × {shown}{}", weight.map_or("bw".to_string(), |w| format!("{} kg", num(w))), at(s)));
                    if let Some(wt) = weight.filter(|_| reps > 0) {
                        point.volume += wt * reps as f64;
                        point.top_weight = Some(point.top_weight.map_or(wt, |t: f64| t.max(wt)));
                        let est = e1rm(wt, reps);
                        if point.best_e1rm.is_none_or(|b| est > b) {
                            point.best_e1rm = Some(est);
                        }
                    }
                }
            }
            point.summary = if e.is_cardio() {
                let mut c = vec![format!("{} min", num(point.minutes))];
                if point.km > 0.0 {
                    c.push(format!("{} km", num(point.km)));
                }
                if let Some(r) = point.rpe {
                    c.push(format!("RPE {}", num(r)));
                }
                c.join(" · ")
            } else {
                parts.join(", ")
            };
            // A personal best: beats every earlier session of this exercise (the first session sets the bar).
            if let (Some(est), Some(prev)) = (point.best_e1rm, stat.best_e1rm) {
                if est > prev + 1e-9 {
                    if let Some(best) = done
                        .iter()
                        .filter_map(|s| Some((s.weight?, s.reps?)))
                        .filter(|(_, r)| *r > 0)
                        .max_by(|a, b| e1rm(a.0, a.1).total_cmp(&e1rm(b.0, b.1)))
                    {
                        records.push(Record { exercise: stat.name.clone(), date: w.date.clone(), weight: best.0, reps: best.1, e1rm: est });
                    }
                }
            }
            if let Some(est) = point.best_e1rm {
                stat.best_e1rm = Some(stat.best_e1rm.map_or(est, |b| b.max(est)));
            }
            if let Some(top) = point.top_weight {
                stat.best_weight = Some(stat.best_weight.map_or(top, |b| b.max(top)));
            }
            week_volume += point.volume;
            week_minutes += point.minutes;
            week_km += point.km;
            // Two workouts with the same exercise on one day count as one session.
            match stat.points.last_mut() {
                Some(last) if last.date == point.date => {
                    last.volume += point.volume;
                    last.minutes += point.minutes;
                    last.km += point.km;
                    last.seconds = last.seconds.max(point.seconds);
                    last.metres += point.metres;
                    last.rpe = match (last.rpe, point.rpe) {
                        (Some(a), Some(b)) => Some((a + b) / 2.0),
                        (a, b) => a.or(b),
                    };
                    last.top_weight = match (last.top_weight, point.top_weight) {
                        (Some(a), Some(b)) => Some(a.max(b)),
                        (a, b) => a.or(b),
                    };
                    last.best_e1rm = match (last.best_e1rm, point.best_e1rm) {
                        (Some(a), Some(b)) => Some(a.max(b)),
                        (a, b) => a.or(b),
                    };
                    last.summary = format!("{}; {}", last.summary, point.summary);
                }
                _ => stat.points.push(point),
            }
        }
        if let Some(week) = week {
            week.volume += week_volume;
            week.cardio_minutes += week_minutes;
            week.cardio_km += week_km;
        }
    }
    for day in &visit_days {
        if let Some(week) = weeks.get_mut(&week_start(*day)) {
            week.visits += 1;
        }
    }

    let visited_week = |start: i64| visit_days.iter().any(|d| week_start(*d) == start);
    let mut cursor = if visited_week(this_week) { this_week } else { this_week - 7 };
    let mut week_streak = 0;
    while visited_week(cursor) {
        week_streak += 1;
        cursor -= 7;
    }

    let mut exercises: Vec<ExerciseStat> = by_exercise.into_values().collect();
    exercises.sort_by(|a, b| {
        let last = |e: &ExerciseStat| e.points.last().map(|p| p.date.clone()).unwrap_or_default();
        last(b).cmp(&last(a)).then(a.name.cmp(&b.name))
    });
    records.reverse();
    records.truncate(8);
    titles.sort_by(|a, b| b.date.cmp(&a.date));

    ForgeStats {
        total_visits: visit_days.len() as u32,
        last_visit: visit_days.iter().next_back().map(|d| format_day(*d)),
        visits_this_week: visit_days.iter().filter(|d| week_start(**d) == this_week).count() as u32,
        week_streak,
        weeks: weeks.into_values().collect(),
        visit_days: visit_days.iter().filter(|d| **d >= first_week).map(|d| format_day(*d)).collect(),
        exercises,
        records,
        titles,
        bodyweight: weigh_ins.iter().filter(|w| parse_day(&w.date).is_some_and(|d| d <= today)).cloned().collect(),
    }
}

// ---------------------------------------------------------------- commands

fn changed(app: &AppHandle) {
    let _ = app.emit("forge-changed", ());
}

/// Every workout in the vault, newest first.
#[tauri::command]
pub fn forge_list(state: State<AppState>) -> Result<Vec<Workout>, String> {
    list_workouts_in(&vault_root(&state)?)
}

/// Saves a workout and tells every window. Returns it with its file name.
#[tauri::command]
pub fn forge_save(app: AppHandle, state: State<AppState>, workout: Workout) -> Result<Workout, String> {
    let saved = save_in(&forge_dir(&vault_root(&state)?)?, workout, false)?;
    changed(&app);
    Ok(saved)
}

#[tauri::command]
pub fn forge_delete(app: AppHandle, state: State<AppState>, file: String) -> Result<(), String> {
    remove_in(&forge_dir(&vault_root(&state)?)?, &file)?;
    changed(&app);
    Ok(())
}

/// Saved templates, by name.
#[tauri::command]
pub fn forge_templates(state: State<AppState>) -> Result<Vec<Workout>, String> {
    let mut list = read_all(&template_dir(&vault_root(&state)?)?);
    for t in &mut list {
        t.date.clear();
    }
    list.sort_by_key(|t| t.title.to_lowercase());
    Ok(list)
}

/// Saves a workout's exercises as a template (replacing one with the same name).
#[tauri::command]
pub fn forge_save_template(app: AppHandle, state: State<AppState>, workout: Workout) -> Result<Workout, String> {
    let template = Workout { file: String::new(), date: String::new(), status: "planned".into(), started: None, finished: None, ..workout };
    let saved = save_in(&template_dir(&vault_root(&state)?)?, template, true)?;
    changed(&app);
    Ok(saved)
}

#[tauri::command]
pub fn forge_delete_template(app: AppHandle, state: State<AppState>, file: String) -> Result<(), String> {
    remove_in(&template_dir(&vault_root(&state)?)?, &file)?;
    changed(&app);
    Ok(())
}

/// The exercise library, in the note's order.
#[tauri::command]
pub fn forge_library(state: State<AppState>) -> Result<Vec<LibraryEntry>, String> {
    read_library(&vault_root(&state)?)
}

/// Replaces the exercise library and tells every window. Returns it as saved.
#[tauri::command]
pub fn forge_save_library(app: AppHandle, state: State<AppState>, entries: Vec<LibraryEntry>) -> Result<Vec<LibraryEntry>, String> {
    let saved = write_library(&vault_root(&state)?, entries)?;
    changed(&app);
    Ok(saved)
}

/// The weigh-in log, oldest first.
#[tauri::command]
pub fn forge_bodyweight(state: State<AppState>) -> Result<Vec<WeighIn>, String> {
    read_bodyweight(&vault_root(&state)?)
}

/// Logs the weigh-in for `date` (`kg` null removes it) and tells every window.
#[tauri::command]
pub fn forge_set_bodyweight(app: AppHandle, state: State<AppState>, date: String, kg: Option<f64>) -> Result<Vec<WeighIn>, String> {
    let list = set_bodyweight_in(&vault_root(&state)?, &date, kg)?;
    changed(&app);
    Ok(list)
}

/// Dashboard numbers. `today` is the user's local date (YYYY-MM-DD).
#[tauri::command]
pub fn forge_stats(state: State<AppState>, today: String) -> Result<ForgeStats, String> {
    let today = parse_day(&today).ok_or_else(|| format!("Bad date: {today}"))?;
    let vault = vault_root(&state)?;
    Ok(compute_forge_stats(&list_workouts_in(&vault)?, &read_bodyweight(&vault)?, today))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUSH: &str = "---\ntype: flesh-forge-workout\ndate: 2026-11-16\ntitle: Push\nstatus: done\nstarted: 18:05\nfinished: 19:10\n---\n# Push · 2026-11-16\n\nFelt strong.\n\n## Bench press\n- [x] 60 kg × 8\n- [x] 62.5 kg × 6\n- [ ] bodyweight × 12\nNotes: left shoulder tight\n\n## Treadmill · cardio\n- [x] 20 min · 3 km\n";

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cogitorium-forge-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn lift(weight: Option<f64>, reps: u32, done: bool) -> Set {
        Set { done, weight, reps: Some(reps), ..Set::default() }
    }

    #[test]
    fn reads_a_workout_note() {
        let w = parse_workout(PUSH, "2026-11-16 Push.md");
        assert_eq!((w.date.as_str(), w.title.as_str(), w.status.as_str()), ("2026-11-16", "Push", "done"));
        assert_eq!(w.started.as_deref(), Some("18:05"));
        assert_eq!(w.notes, "Felt strong.");
        assert_eq!(w.exercises.len(), 2);
        let bench = &w.exercises[0];
        assert_eq!((bench.name.as_str(), bench.kind.as_str()), ("Bench press", "lift"));
        assert_eq!(bench.sets, vec![lift(Some(60.0), 8, true), lift(Some(62.5), 6, true), lift(None, 12, false)]);
        assert_eq!(bench.notes, "left shoulder tight");
        let tread = &w.exercises[1];
        assert_eq!(tread.kind, "cardio");
        assert_eq!(tread.sets[0], Set { done: true, minutes: Some(20.0), km: Some(3.0), ..Set::default() });
    }

    #[test]
    fn notes_round_trip() {
        let w = parse_workout(PUSH, "2026-11-16 Push.md");
        let again = parse_workout(&to_markdown(&w, false), "2026-11-16 Push.md");
        assert_eq!(w, again);
        // A template keeps the plan but not the ticks or the date.
        let t = parse_workout(&to_markdown(&w, true), "Push.md");
        assert!(t.date.is_empty());
        assert!(t.exercises.iter().all(|e| e.sets.iter().all(|s| !s.done)));
        assert_eq!(t.exercises[0].sets[1].weight, Some(62.5));
        // An empty cardio exercise keeps its kind.
        let empty = Workout {
            date: "2026-11-17".into(),
            title: "Run".into(),
            status: "planned".into(),
            exercises: vec![Exercise { name: "Rower".into(), kind: "cardio".into(), ..Exercise::default() }],
            ..Workout::default()
        };
        assert_eq!(parse_workout(&to_markdown(&empty, false), "x.md").exercises[0].kind, "cardio");
    }

    #[test]
    fn reads_loosely_written_sets() {
        assert_eq!(parse_set("60kg x 8", true), Some(lift(Some(60.0), 8, true)));
        assert_eq!(parse_set("BW x 15", false), Some(lift(None, 15, false)));
        assert_eq!(parse_set("62,5 kg × 5 (paused)", false), Some(lift(Some(62.5), 5, false)));
        assert_eq!(parse_set("30 mins", true).and_then(|s| s.minutes), Some(30.0));
        assert_eq!(parse_set("5.2km", true).and_then(|s| s.km), Some(5.2));
        assert_eq!(parse_set("felt heavy", false), None);
        // A note without a heading or frontmatter: the title and date come from the file name.
        let w = parse_workout("## Squat\n- 100 kg × 5\n", "2026-11-10 Legs.md");
        assert_eq!((w.title.as_str(), w.date.as_str()), ("Legs", "2026-11-10"));
        assert_eq!(w.exercises[0].sets.len(), 1);
    }

    #[test]
    fn saves_renames_and_deletes() {
        let dir = temp_dir("save");
        let w = parse_workout(PUSH, "");
        let saved = save_in(&dir, Workout { file: String::new(), ..w.clone() }, false).unwrap();
        assert_eq!(saved.file, "2026-11-16 Push.md");
        // A second workout with the same name that day gets its own file.
        let second = save_in(&dir, Workout { file: String::new(), ..w.clone() }, false).unwrap();
        assert_eq!(second.file, "2026-11-16 Push 2.md");
        // Renaming moves the note.
        let renamed = save_in(&dir, Workout { title: "Push: heavy".into(), ..saved }, false).unwrap();
        assert_eq!(renamed.file, "2026-11-16 Push heavy.md", "unsafe characters are dropped");
        assert!(!dir.join("2026-11-16 Push.md").exists());
        assert!(save_in(&dir, Workout { file: "../x.md".into(), ..w.clone() }, false).is_err());
        assert!(save_in(&dir, Workout { title: " ".into(), ..w }, false).is_err());
        remove_in(&dir, &renamed.file).unwrap();
        assert!(!dir.join(&renamed.file).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    fn day(n: i64, title: &str, bench: &[(f64, u32)]) -> Workout {
        Workout {
            file: format!("{n}.md"),
            date: format_day(n),
            title: title.into(),
            status: "done".into(),
            exercises: vec![Exercise {
                name: "Bench press".into(),
                kind: "lift".into(),
                sets: bench.iter().map(|(w, r)| lift(Some(*w), *r, true)).collect(),
                ..Exercise::default()
            }],
            ..Workout::default()
        }
    }

    #[test]
    fn stats_count_visits_volume_and_records() {
        let today = parse_day("2026-11-18").unwrap(); // a Wednesday
        let mon = parse_day("2026-11-16").unwrap();
        let mut planned = day(today + 2, "Push", &[(80.0, 5)]);
        planned.status = "planned".into();
        planned.exercises[0].sets[0].done = false;
        let workouts = vec![
            day(mon - 14, "Push", &[(60.0, 8)]),
            day(mon - 7, "Push", &[(60.0, 8), (65.0, 6)]),
            day(mon, "Push", &[(70.0, 5)]),
            day(today, "Pull", &[]),
            planned,
        ];
        let s = compute_forge_stats(&workouts, &[], today);
        // The empty "Pull" workout is still a visit (marked done); the planned one in the future isn't.
        assert_eq!(s.total_visits, 4);
        assert_eq!(s.visits_this_week, 2);
        assert_eq!(s.week_streak, 3);
        assert_eq!(s.last_visit.as_deref(), Some("2026-11-18"));
        assert_eq!(s.weeks.len(), WEEKS as usize);
        let now = s.weeks.last().unwrap();
        assert_eq!((now.start.as_str(), now.visits, now.volume), ("2026-11-16", 2, 350.0));
        let bench = &s.exercises[0];
        assert_eq!(bench.points.len(), 3);
        assert_eq!(bench.best_weight, Some(70.0));
        assert_eq!(bench.points[1].summary, "60 kg × 8, 65 kg × 6");
        // 65×6 (e1RM 78) beat 60×8 (76); 70×5 (81.7) beat that. The first session only sets the bar.
        let found: Vec<(String, f64)> = s.records.iter().map(|r| (r.date.clone(), r.weight)).collect();
        assert_eq!(found, vec![("2026-11-16".to_string(), 70.0), ("2026-11-09".to_string(), 65.0)]);
        assert_eq!(s.titles[0].title, "Pull");
        assert_eq!(s.titles[1].date, "2026-11-16", "repeat-last points at the latest Push");
    }

    #[test]
    fn holds_carries_and_max_sets() {
        let hold = |s: Option<f64>, w: Option<f64>| Set { seconds: s, weight: w, ..Set::default() };
        assert_eq!(parse_set("45 s", false), Some(hold(Some(45.0), None)));
        assert_eq!(parse_set("30s", false), Some(hold(Some(30.0), None)));
        assert_eq!(parse_set("10 kg · 30 s", false), Some(hold(Some(30.0), Some(10.0))));
        assert_eq!(parse_set("max hold", false), Some(hold(None, None)));
        assert_eq!(parse_set("24 kg · 40 m", true), Some(Set { done: true, weight: Some(24.0), metres: Some(40.0), ..Set::default() }));
        assert_eq!(parse_set("bodyweight × max", false), Some(Set { reps: None, ..Set::default() }));
        assert_eq!(parse_set("60kgx8", false), Some(lift(Some(60.0), 8, false)));

        let w = Workout {
            date: "2026-11-20".into(),
            title: "Pull".into(),
            status: "planned".into(),
            exercises: vec![
                Exercise { name: "Dead hangs".into(), kind: "hold".into(), sets: vec![hold(None, None), hold(Some(40.0), None)], ..Exercise::default() },
                Exercise {
                    name: "Farmer's carries".into(),
                    kind: "carry".into(),
                    sets: vec![Set { weight: Some(24.0), metres: Some(40.0), ..Set::default() }],
                    ..Exercise::default()
                },
                Exercise { name: "Archer push-ups".into(), kind: "lift".into(), sets: vec![Set::default()], ..Exercise::default() },
                // An empty hold keeps its kind through the heading.
                Exercise { name: "Plank".into(), kind: "hold".into(), ..Exercise::default() },
            ],
            ..Workout::default()
        };
        let md = to_markdown(&w, false);
        assert!(md.contains("## Dead hangs · hold\n- [ ] max hold\n- [ ] 40 s"));
        assert!(md.contains("## Farmer's carries · carry\n- [ ] 24 kg · 40 m"));
        assert!(md.contains("## Archer push-ups\n- [ ] bodyweight × max"));
        let back = parse_workout(&md, "2026-11-20 Pull.md");
        assert_eq!(back.exercises, Workout { file: "2026-11-20 Pull.md".into(), ..w.clone() }.exercises);

        // Stats: the longest hold and the carry distance are tracked per session.
        let mut done = w;
        for e in &mut done.exercises {
            for s in &mut e.sets {
                s.done = true;
            }
        }
        done.exercises[0].sets[0].seconds = Some(55.0);
        done.status = "done".into();
        let s = compute_forge_stats(&[done], &[], parse_day("2026-11-20").unwrap());
        let hang = s.exercises.iter().find(|e| e.name == "Dead hangs").unwrap();
        assert_eq!((hang.points[0].seconds, hang.points[0].summary.as_str()), (55.0, "55 s, 40 s"));
        let carry = s.exercises.iter().find(|e| e.name == "Farmer's carries").unwrap();
        assert_eq!((carry.points[0].metres, carry.best_weight), (40.0, Some(24.0)));
        assert_eq!(s.weeks.last().unwrap().volume, 0.0, "holds and carries aren't lifting volume");
    }

    #[test]
    fn library_round_trip() {
        let text = "# Exercise Library\n\n## Lower body\n\n| Exercise | Type | Target | Rest | Notes |\n| --- | --- | --- | --- | --- |\n| Back squat | reps | 4 × 6-8 | 2 min | or leg press |\n| Wall sit | hold | 4 × 30s | 30 s | |\n\n## Grip\n\n| Exercise | Type | Target | Rest | Notes |\n|---|---|---|---|---|\n| Farmer's carries | carry | 3 × 30-40m | 90 s | |\n| Back squat | reps | dup | | |\n";
        let lib = parse_library(text);
        assert_eq!(lib.len(), 3, "the repeated name is dropped");
        assert_eq!(lib[0], LibraryEntry {
            name: "Back squat".into(),
            kind: "lift".into(),
            group: "Lower body".into(),
            target: "4 × 6-8".into(),
            rest: "2 min".into(),
            notes: "or leg press".into(),
        });
        assert_eq!((lib[1].kind.as_str(), lib[2].kind.as_str(), lib[2].group.as_str()), ("hold", "carry", "Grip"));
        assert_eq!(parse_library(&library_markdown(&lib)), lib);

        let vault = temp_dir("library");
        assert!(read_library(&vault).unwrap().is_empty());
        let mut edited = lib.clone();
        edited.push(LibraryEntry { name: "  pipe | name ".into(), kind: "cardio".into(), ..LibraryEntry::default() });
        edited.push(LibraryEntry { name: "".into(), ..LibraryEntry::default() });
        let saved = write_library(&vault, edited).unwrap();
        assert_eq!(saved.len(), 4);
        assert_eq!((saved[3].name.as_str(), saved[3].group.as_str()), ("pipe / name", "Other"));
        assert_eq!(read_library(&vault).unwrap(), saved);
        // The library note isn't mistaken for a workout.
        assert!(list_workouts_in(&vault).unwrap().is_empty());
        fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn rpe_rides_on_any_set() {
        let rated = |text: &str| parse_set(text, true).and_then(|s| s.rpe);
        assert_eq!(rated("60 kg × 8 @ RPE 8"), Some(8.0));
        assert_eq!(rated("bodyweight × max @ rpe 9.5"), Some(9.5));
        assert_eq!(rated("45 s @8"), Some(8.0));
        assert_eq!(rated("24 kg · 40 m RPE 7"), Some(7.0));
        assert_eq!(rated("20 min · 3 km @ RPE 6"), Some(6.0));
        assert_eq!(rated("60 kg × 8"), None);
        assert_eq!(rated("60 kg × 8 @ RPE 14"), None, "out of range is ignored");
        assert_eq!(parse_set("60 kg × 8 @ RPE 8", true).map(|s| (s.weight, s.reps)), Some((Some(60.0), Some(8))));

        let set = Set { done: true, weight: Some(60.0), reps: Some(8), rpe: Some(8.5), ..Set::default() };
        assert_eq!(set_line(&set, "lift"), "- [x] 60 kg × 8 @ RPE 8.5");
        let hold = Set { done: false, seconds: Some(45.0), rpe: Some(7.0), ..Set::default() };
        assert_eq!(set_line(&hold, "hold"), "- [ ] 45 s @ RPE 7");

        let mut w = day(parse_day("2026-11-16").unwrap(), "Push", &[(60.0, 8), (65.0, 6)]);
        w.exercises[0].sets[0].rpe = Some(7.0);
        w.exercises[0].sets[1].rpe = Some(9.0);
        assert_eq!(parse_workout(&to_markdown(&w, false), &w.file).exercises, w.exercises);
        let s = compute_forge_stats(&[w], &[], parse_day("2026-11-16").unwrap());
        let p = &s.exercises[0].points[0];
        assert_eq!((p.rpe, p.summary.as_str()), (Some(8.0), "60 kg × 8 @7, 65 kg × 6 @9"));
    }

    #[test]
    fn bodyweight_log() {
        let text = "# Bodyweight\n\n| Date | kg |\n| --- | --- |\n| 2026-11-10 | 73.4 |\n| 2026-11-16 | 72.5 |\n- 2026-11-12 · 73 kg\n| 2026-11-16 | 72.4 |\nnot a row 2026-11-01\n";
        let list = parse_bodyweight(text);
        let pairs: Vec<(&str, f64)> = list.iter().map(|w| (w.date.as_str(), w.kg)).collect();
        assert_eq!(pairs, vec![("2026-11-10", 73.4), ("2026-11-12", 73.0), ("2026-11-16", 72.4)]);
        assert_eq!(parse_bodyweight(&bodyweight_markdown(&list)), list);

        let vault = temp_dir("bodyweight");
        assert!(read_bodyweight(&vault).unwrap().is_empty());
        set_bodyweight_in(&vault, "2026-11-16", Some(72.5)).unwrap();
        set_bodyweight_in(&vault, "2026-11-14", Some(73.1)).unwrap();
        let list = set_bodyweight_in(&vault, "2026-11-16", Some(72.25)).unwrap();
        assert_eq!(list.iter().map(|w| w.kg).collect::<Vec<_>>(), vec![73.1, 72.25], "one per day, oldest first");
        assert_eq!(set_bodyweight_in(&vault, "2026-11-14", None).unwrap().len(), 1);
        assert!(set_bodyweight_in(&vault, "2026-11-15", Some(5.0)).is_err());
        assert!(set_bodyweight_in(&vault, "16/11/2026", Some(72.0)).is_err());
        // The log isn't mistaken for a workout.
        assert!(list_workouts_in(&vault).unwrap().is_empty());
        // Stats carry weigh-ins up to today only.
        let ins = vec![WeighIn { date: "2026-11-16".into(), kg: 72.5 }, WeighIn { date: "2026-11-30".into(), kg: 70.0 }];
        assert_eq!(compute_forge_stats(&[], &ins, parse_day("2026-11-20").unwrap()).bodyweight.len(), 1);
        fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn weeks_start_on_monday() {
        assert_eq!(format_day(week_start(parse_day("2026-11-16").unwrap())), "2026-11-16");
        assert_eq!(format_day(week_start(parse_day("2026-11-22").unwrap())), "2026-11-16");
        assert_eq!(format_day(week_start(parse_day("2026-11-23").unwrap())), "2026-11-23");
    }
}
