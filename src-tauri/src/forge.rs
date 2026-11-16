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
    pub reps: Option<u32>,
    /// Cardio: time and distance.
    pub minutes: Option<f64>,
    pub km: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Exercise {
    pub name: String,
    /// "lift" or "cardio".
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

/// The number just before `unit` in `text`: "20 min", "20min" and "20 mins" all give 20.
fn number_before(text: &str, unit: &str) -> Option<f64> {
    let tokens: Vec<&str> = text.split(|c: char| c.is_whitespace() || c == '·' || c == ',').filter(|t| !t.is_empty()).collect();
    for (i, t) in tokens.iter().enumerate() {
        let word = t.trim_end_matches('s');
        if word == unit {
            if let Some(n) = i.checked_sub(1).and_then(|j| parse_num(tokens[j])) {
                return Some(n);
            }
        } else if let Some(n) = word.strip_suffix(unit).and_then(parse_num) {
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
fn parse_set(text: &str, done: bool) -> Option<Set> {
    let t = text.trim().to_lowercase();
    if t.is_empty() {
        return None;
    }
    if t.contains("min") || t.contains("km") {
        let minutes = number_before(&t, "min");
        let km = number_before(&t, "km");
        return (minutes.is_some() || km.is_some()).then_some(Set { done, minutes, km, ..Set::default() });
    }
    let t = t.replace(['×', '*'], "x");
    let (left, right) = t.rsplit_once('x')?;
    let reps = right.split_whitespace().next().and_then(|r| r.parse::<u32>().ok())?;
    let left = left.trim();
    let weight = match left {
        "" | "bw" | "bodyweight" | "body weight" => None,
        _ => Some(parse_num(left.trim_end_matches("kg").trim_end_matches("kgs"))?),
    };
    Some(Set { done, weight, reps: Some(reps), ..Set::default() })
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
                e.kind = if e.sets.iter().any(|s| s.minutes.is_some() || s.km.is_some()) { "cardio" } else { "lift" }.into();
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
            let (name, kind) = match h.trim().strip_suffix("· cardio") {
                Some(n) => (n.trim().to_string(), "cardio".to_string()),
                None => (h.trim().to_string(), String::new()),
            };
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

fn set_line(set: &Set, cardio: bool) -> String {
    let tick = if set.done { "x" } else { " " };
    let text = if cardio {
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
    } else {
        let weight = set.weight.map_or("bodyweight".to_string(), |w| format!("{} kg", num(w)));
        format!("{weight} × {}", set.reps.unwrap_or(0))
    };
    format!("- [{tick}] {text}")
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
        let cardio = e.is_cardio();
        out.push(format!("## {}{}", one_line(&e.name), if cardio { " · cardio" } else { "" }));
        for s in &e.sets {
            let s = if template { Set { done: false, ..s.clone() } } else { s.clone() };
            out.push(set_line(&s, cardio));
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
    /// "60 kg × 8, 70 kg × 6" or "20 min · 3 km".
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
}

/// Monday on or before `day` (day 0, 1970-01-01, was a Thursday).
fn week_start(day: i64) -> i64 {
    day - (day + 3).rem_euclid(7)
}

pub fn compute_forge_stats(workouts: &[Workout], today: i64) -> ForgeStats {
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
                summary: String::new(),
            };
            let mut parts = Vec::new();
            for s in &done {
                if e.is_cardio() {
                    point.minutes += s.minutes.unwrap_or(0.0);
                    point.km += s.km.unwrap_or(0.0);
                } else {
                    let reps = s.reps.unwrap_or(0);
                    let weight = s.weight;
                    parts.push(format!("{} × {reps}", weight.map_or("bw".to_string(), |w| format!("{} kg", num(w)))));
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

/// Dashboard numbers. `today` is the user's local date (YYYY-MM-DD).
#[tauri::command]
pub fn forge_stats(state: State<AppState>, today: String) -> Result<ForgeStats, String> {
    let today = parse_day(&today).ok_or_else(|| format!("Bad date: {today}"))?;
    Ok(compute_forge_stats(&list_workouts_in(&vault_root(&state)?)?, today))
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
        let s = compute_forge_stats(&workouts, today);
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
    fn weeks_start_on_monday() {
        assert_eq!(format_day(week_start(parse_day("2026-11-16").unwrap())), "2026-11-16");
        assert_eq!(format_day(week_start(parse_day("2026-11-22").unwrap())), "2026-11-16");
        assert_eq!(format_day(week_start(parse_day("2026-11-23").unwrap())), "2026-11-23");
    }
}
