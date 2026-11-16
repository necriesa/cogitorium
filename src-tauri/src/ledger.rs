//! The Tithe-Ledger: a budget tracker, kept as Markdown notes in the vault.
//!
//! Everything lives in `<log dir>/Tithe-Ledger/`:
//! - `<YYYY-MM>.md`, one note per month, a table of what came in and went out:
//!   `| Date | Kind | Category | Amount | Note | Bill |` (Kind is `out` or `in`).
//! - `Budgets.md`, the categories: `| Category | Kind | Monthly |`, with a
//!   monthly budget (AUD) for spending categories, blank for none.
//! - `Bills.md`, recurring bills (and recurring income such as pay):
//!   `| Bill | Amount | Category | Every | Next due |`.
//!
//! Amounts are whole cents here and plain `1234.50` in the notes (no `$`, no
//! sign: the kind says which way the money went). Rows added in Obsidian are
//! read too. The frontend counts the totals; this module owns the notes.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::{civil_from_days, days_from_civil, format_day, log_dir, parse_day, vault_root, AppState};

const LEDGER_DIR: &str = "Tithe-Ledger";
const MONTH_TYPE: &str = "tithe-ledger-month";
const BUDGETS_FILE: &str = "Budgets.md";
const BUDGETS_TYPE: &str = "tithe-ledger-budgets";
const BILLS_FILE: &str = "Bills.md";
const BILLS_TYPE: &str = "tithe-ledger-bills";
/// The largest amount accepted: $10 million, in cents.
const MAX_CENTS: i64 = 1_000_000_000;

/// One line of the ledger: money in or out on a day.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
    pub date: String,
    /// "out" (spent) or "in" (income).
    pub kind: String,
    pub category: String,
    /// Whole cents, always positive.
    pub cents: i64,
    pub note: String,
    /// The bill this pays, if it was logged from `Bills.md`; empty otherwise.
    pub bill: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Category {
    pub name: String,
    /// "out" or "in".
    pub kind: String,
    /// Monthly budget in cents (spending categories only).
    pub budget: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Bill {
    pub name: String,
    pub cents: i64,
    pub category: String,
    /// week, fortnight, month, quarter or year.
    pub every: String,
    /// The next due date, YYYY-MM-DD.
    pub next: String,
}

/// Categories offered before `Budgets.md` exists.
const DEFAULT_OUT: [&str; 14] = [
    "Rent",
    "Groceries",
    "Eating out",
    "Transport",
    "Utilities",
    "Phone and internet",
    "Health",
    "Fitness",
    "Subscriptions",
    "Shopping",
    "Entertainment",
    "Gifts",
    "Travel",
    "Other",
];
const DEFAULT_IN: [&str; 2] = ["Pay", "Other income"];

pub fn default_categories() -> Vec<Category> {
    let out = DEFAULT_OUT.iter().map(|n| Category { name: n.to_string(), kind: "out".into(), budget: None });
    let inc = DEFAULT_IN.iter().map(|n| Category { name: n.to_string(), kind: "in".into(), budget: None });
    out.chain(inc).collect()
}

// ---------------------------------------------------------------- money and text

/// "42.5", "$1,234.50", "AUD 12" -> cents. Signs are ignored (the kind gives the direction).
pub fn parse_cents(text: &str) -> Option<i64> {
    let t: String = text
        .trim()
        .trim_start_matches("AUD")
        .trim_end_matches("AUD")
        .chars()
        .filter(|c| !matches!(c, '$' | ',' | ' ' | '+' | '-' | '−'))
        .collect();
    if t.is_empty() || !t.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let n: f64 = t.parse().ok()?;
    let cents = (n * 100.0).round();
    (cents.is_finite() && cents > 0.0 && cents <= MAX_CENTS as f64).then_some(cents as i64)
}

/// Cents as a plain amount: 4250 -> "42.50".
pub fn money(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

fn kind_from_word(word: &str) -> &'static str {
    match word.trim().to_lowercase().as_str() {
        "in" | "income" | "+" | "earned" | "received" => "in",
        _ => "out",
    }
}

fn every_from_word(word: &str) -> Option<&'static str> {
    let w = word.trim().to_lowercase();
    let w = w.trim_end_matches('s').trim_end_matches("ly");
    Some(match w {
        "week" | "weekly" => "week",
        "fortnight" | "fortnightly" | "2 week" => "fortnight",
        "month" | "monthly" => "month",
        "quarter" | "quarterly" | "3 month" => "quarter",
        "year" | "yearly" | "annual" | "annually" => "year",
        _ => return None,
    })
}

/// One table cell: a single line with no pipes.
fn cell(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").replace('|', "/")
}

/// The cells of a Markdown table row, or `None` for anything else (including dividers).
fn row_cells(line: &str) -> Option<Vec<String>> {
    let row = line.trim().strip_prefix('|')?;
    let cells: Vec<String> = row.trim_end_matches('|').split('|').map(|c| c.trim().to_string()).collect();
    let first = cells.first()?;
    if first.is_empty() || first.chars().all(|c| c == '-' || c == ':') {
        return None;
    }
    Some(cells)
}

fn frontmatter(kind: &str, extra: &[String]) -> Vec<String> {
    let mut out = vec!["---".to_string(), format!("type: {kind}")];
    out.extend(extra.iter().cloned());
    out.push("---".into());
    out
}

// ---------------------------------------------------------------- months

const MONTH_NAMES: [&str; 12] =
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// A real calendar date in YYYY-MM-DD (not 2026-11-31).
fn real_date(date: &str) -> bool {
    parse_day(date).is_some_and(|d| format_day(d) == date)
}

fn is_month(m: &str) -> bool {
    m.len() == 7 && real_date(&format!("{m}-01"))
}

/// The ledger rows in a month note (or any note with the same table).
pub fn parse_entries(text: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Some(cells) = row_cells(line) else { continue };
        let at = |i: usize| cells.get(i).cloned().unwrap_or_default();
        let date = at(0);
        if !real_date(&date) {
            continue;
        }
        let Some(cents) = parse_cents(&at(3)) else { continue };
        let kind = if at(1).is_empty() && at(3).trim_start().starts_with('+') { "in" } else { kind_from_word(&at(1)) };
        out.push(Entry { date, kind: kind.into(), category: at(2), cents, note: at(4), bill: at(5) });
    }
    out
}

pub fn month_markdown(month: &str, entries: &[Entry]) -> String {
    let title = match month[5..7].parse::<usize>() {
        Ok(m @ 1..=12) => format!("{} {}", MONTH_NAMES[m - 1], &month[..4]),
        _ => month.to_string(),
    };
    let mut out = frontmatter(MONTH_TYPE, &[format!("month: {month}")]);
    out.push(format!("# Tithe-Ledger · {title}"));
    out.push(String::new());
    out.push("Money in and out this month, in AUD. Kind is `out` (spent) or `in` (income). Add rows here too.".into());
    out.push(String::new());
    out.push("| Date | Kind | Category | Amount | Note | Bill |".into());
    out.push("| --- | --- | --- | --- | --- | --- |".into());
    let mut sorted: Vec<&Entry> = entries.iter().collect();
    sorted.sort_by(|a, b| a.date.cmp(&b.date));
    for e in sorted {
        out.push(format!(
            "| {} | {} | {} | {} | {} | {} |",
            e.date,
            kind_from_word(&e.kind),
            cell(&e.category),
            money(e.cents),
            cell(&e.note),
            cell(&e.bill)
        ));
    }
    out.push(String::new());
    out.join("\n")
}

fn ledger_dir(vault: &Path) -> Result<PathBuf, String> {
    Ok(log_dir(vault)?.join(LEDGER_DIR))
}

fn read_or_empty(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn read_month(dir: &Path, month: &str) -> Result<Vec<Entry>, String> {
    Ok(read_or_empty(&dir.join(format!("{month}.md")))?.map(|t| parse_entries(&t)).unwrap_or_default())
}

fn write_month(dir: &Path, month: &str, entries: &[Entry]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{month}.md")), month_markdown(month, entries)).map_err(|e| e.to_string())
}

/// Every entry in every month note, oldest first.
pub fn read_entries_in(dir: &Path) -> Vec<Entry> {
    let Ok(files) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<Entry> = files
        .filter_map(Result::ok)
        .filter(|f| f.path().is_file())
        .filter_map(|f| {
            let name = f.file_name().to_string_lossy().into_owned();
            let month = name.strip_suffix(".md")?;
            if !is_month(month) {
                return None;
            }
            fs::read_to_string(f.path()).ok().map(|t| parse_entries(&t))
        })
        .flatten()
        .collect();
    out.sort_by(|a, b| a.date.cmp(&b.date));
    out
}

/// Tidies an entry from the frontend, or says what is wrong with it.
fn clean_entry(mut e: Entry) -> Result<Entry, String> {
    if !real_date(&e.date) {
        return Err(format!("Bad date: {}", e.date));
    }
    if e.cents <= 0 || e.cents > MAX_CENTS {
        return Err("The amount must be more than $0".into());
    }
    e.kind = kind_from_word(&e.kind).into();
    e.category = cell(&e.category);
    if e.category.is_empty() {
        e.category = if e.kind == "in" { "Other income".into() } else { "Other".into() };
    }
    e.note = cell(&e.note);
    e.bill = cell(&e.bill);
    Ok(e)
}

fn add_in(dir: &Path, entry: Entry) -> Result<Entry, String> {
    let entry = clean_entry(entry)?;
    let month = &entry.date[..7];
    let mut list = read_month(dir, month)?;
    list.push(entry.clone());
    write_month(dir, month, &list)?;
    Ok(entry)
}

/// Removes the first row equal to `entry` from its month's note.
fn remove_in(dir: &Path, entry: &Entry) -> Result<(), String> {
    if entry.date.len() < 7 || !is_month(&entry.date[..7]) {
        return Err(format!("Bad date: {}", entry.date));
    }
    let month = &entry.date[..7];
    let mut list = read_month(dir, month)?;
    let Some(i) = list.iter().position(|e| e == entry) else {
        return Err("That entry has changed in the vault since it was loaded. Reload and try again.".into());
    };
    list.remove(i);
    write_month(dir, month, &list)
}

fn update_in(dir: &Path, original: &Entry, entry: Entry) -> Result<Entry, String> {
    let entry = clean_entry(entry)?;
    remove_in(dir, original)?;
    add_in(dir, entry)
}

// ---------------------------------------------------------------- budgets

pub fn parse_categories(text: &str) -> Vec<Category> {
    let mut out: Vec<Category> = Vec::new();
    for line in text.lines() {
        let Some(cells) = row_cells(line) else { continue };
        let name = cells[0].clone();
        if name.eq_ignore_ascii_case("category") || out.iter().any(|c| c.name.eq_ignore_ascii_case(&name)) {
            continue;
        }
        let kind = kind_from_word(cells.get(1).map(String::as_str).unwrap_or(""));
        let budget = if kind == "out" { cells.get(2).and_then(|b| parse_cents(b)) } else { None };
        out.push(Category { name, kind: kind.into(), budget });
    }
    out
}

pub fn categories_markdown(list: &[Category]) -> String {
    let mut out = frontmatter(BUDGETS_TYPE, &[]);
    out.push("# Budgets".into());
    out.push(String::new());
    out.push("The Tithe-Ledger's categories. Kind is `out` (spending) or `in` (income); Monthly is the budget for a spending category in AUD (blank for none).".into());
    out.push(String::new());
    out.push("| Category | Kind | Monthly |".into());
    out.push("| --- | --- | --- |".into());
    for c in list {
        let budget = if c.kind == "out" { c.budget.map(money).unwrap_or_default() } else { String::new() };
        out.push(format!("| {} | {} | {} |", cell(&c.name), kind_from_word(&c.kind), budget));
    }
    out.push(String::new());
    out.join("\n")
}

fn read_categories(dir: &Path) -> Result<Vec<Category>, String> {
    Ok(read_or_empty(&dir.join(BUDGETS_FILE))?.map(|t| parse_categories(&t)).unwrap_or_else(default_categories))
}

/// Writes the categories, dropping nameless ones and repeats (the first wins).
fn write_categories(dir: &Path, list: Vec<Category>) -> Result<Vec<Category>, String> {
    let mut clean: Vec<Category> = Vec::new();
    for mut c in list {
        c.name = cell(&c.name);
        if c.name.is_empty() || clean.iter().any(|x| x.name.eq_ignore_ascii_case(&c.name)) {
            continue;
        }
        c.kind = kind_from_word(&c.kind).into();
        c.budget = c.budget.filter(|b| c.kind == "out" && *b > 0 && *b <= MAX_CENTS);
        clean.push(c);
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(BUDGETS_FILE), categories_markdown(&clean)).map_err(|e| e.to_string())?;
    Ok(clean)
}

// ---------------------------------------------------------------- bills

pub fn parse_bills(text: &str) -> Vec<Bill> {
    let mut out: Vec<Bill> = Vec::new();
    for line in text.lines() {
        let Some(cells) = row_cells(line) else { continue };
        let at = |i: usize| cells.get(i).cloned().unwrap_or_default();
        let name = at(0);
        if name.eq_ignore_ascii_case("bill") || out.iter().any(|b| b.name.eq_ignore_ascii_case(&name)) {
            continue;
        }
        let (Some(cents), Some(every)) = (parse_cents(&at(1)), every_from_word(&at(3))) else { continue };
        let next = at(4);
        if !real_date(&next) {
            continue;
        }
        out.push(Bill { name, cents, category: at(2), every: every.into(), next });
    }
    out
}

pub fn bills_markdown(list: &[Bill]) -> String {
    let mut out = frontmatter(BILLS_TYPE, &[]);
    out.push("# Bills".into());
    out.push(String::new());
    out.push("Recurring bills (and recurring income) for the Tithe-Ledger, in AUD. Every is `week`, `fortnight`, `month`, `quarter` or `year`; logging one moves Next due on by that much.".into());
    out.push(String::new());
    out.push("| Bill | Amount | Category | Every | Next due |".into());
    out.push("| --- | --- | --- | --- | --- |".into());
    let mut sorted: Vec<&Bill> = list.iter().collect();
    sorted.sort_by(|a, b| a.next.cmp(&b.next).then(a.name.cmp(&b.name)));
    for b in sorted {
        out.push(format!("| {} | {} | {} | {} | {} |", cell(&b.name), money(b.cents), cell(&b.category), b.every, b.next));
    }
    out.push(String::new());
    out.join("\n")
}

fn read_bills(dir: &Path) -> Result<Vec<Bill>, String> {
    Ok(read_or_empty(&dir.join(BILLS_FILE))?.map(|t| parse_bills(&t)).unwrap_or_default())
}

fn write_bills(dir: &Path, list: Vec<Bill>) -> Result<Vec<Bill>, String> {
    let mut clean: Vec<Bill> = Vec::new();
    for mut b in list {
        b.name = cell(&b.name);
        b.category = cell(&b.category);
        if b.name.is_empty() || clean.iter().any(|x| x.name.eq_ignore_ascii_case(&b.name)) {
            continue;
        }
        if b.cents <= 0 || b.cents > MAX_CENTS {
            return Err(format!("{}: the amount must be more than $0", b.name));
        }
        b.every = every_from_word(&b.every).ok_or_else(|| format!("{}: unknown repeat \"{}\"", b.name, b.every))?.into();
        if !real_date(&b.next) {
            return Err(format!("{}: bad due date \"{}\"", b.name, b.next));
        }
        clean.push(b);
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(BILLS_FILE), bills_markdown(&clean)).map_err(|e| e.to_string())?;
    Ok(parse_bills(&bills_markdown(&clean)))
}

/// `date` plus `months` calendar months, keeping the day where the month allows
/// (31 Jan + 1 month is 28 or 29 Feb).
fn add_months(date: &str, months: i64) -> Option<String> {
    let (y, m, d) = civil_from_days(parse_day(date)?);
    let total = y * 12 + (m - 1) + months;
    let (ny, nm) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    let next_first = if nm == 12 { days_from_civil(ny + 1, 1, 1) } else { days_from_civil(ny, nm + 1, 1) };
    let last = next_first - days_from_civil(ny, nm, 1);
    Some(format_day(days_from_civil(ny, nm, d.min(last))))
}

/// The due date after `date` for a bill that repeats `every`.
pub fn next_due(date: &str, every: &str) -> Option<String> {
    match every {
        "week" => parse_day(date).map(|d| format_day(d + 7)),
        "fortnight" => parse_day(date).map(|d| format_day(d + 14)),
        "month" => add_months(date, 1),
        "quarter" => add_months(date, 3),
        "year" => add_months(date, 12),
        _ => None,
    }
}

/// Settles the bill named `name`: logs it on `date` (unless `date` is `None`,
/// which skips this one) and moves its due date on by one period.
fn settle_in(dir: &Path, name: &str, date: Option<&str>) -> Result<Vec<Bill>, String> {
    let mut bills = read_bills(dir)?;
    let Some(bill) = bills.iter_mut().find(|b| b.name == name) else {
        return Err(format!("No bill called {name}"));
    };
    if let Some(date) = date {
        let kind = read_categories(dir)?
            .into_iter()
            .find(|c| c.name.eq_ignore_ascii_case(&bill.category))
            .map(|c| c.kind)
            .unwrap_or_else(|| "out".into());
        add_in(
            dir,
            Entry {
                date: date.to_string(),
                kind,
                category: bill.category.clone(),
                cents: bill.cents,
                note: bill.name.clone(),
                bill: bill.name.clone(),
            },
        )?;
    }
    bill.next = next_due(&bill.next, &bill.every).ok_or_else(|| format!("{name}: bad due date"))?;
    write_bills(dir, bills)
}

/// Adds many entries at once (from a bank CSV), writing each month's note once,
/// then moves on each bill named in `bills_paid` by one period per mention.
/// Nothing is written if any entry is bad.
fn import_in(dir: &Path, entries: Vec<Entry>, bills_paid: &[String]) -> Result<usize, String> {
    let clean = entries.into_iter().map(clean_entry).collect::<Result<Vec<_>, _>>()?;
    let mut months: Vec<String> = clean.iter().map(|e| e.date[..7].to_string()).collect();
    months.sort();
    months.dedup();
    for month in &months {
        let mut list = read_month(dir, month)?;
        list.extend(clean.iter().filter(|e| &e.date[..7] == month).cloned());
        write_month(dir, month, &list)?;
    }
    if !bills_paid.is_empty() {
        let mut bills = read_bills(dir)?;
        for name in bills_paid {
            if let Some(bill) = bills.iter_mut().find(|b| &b.name == name) {
                bill.next = next_due(&bill.next, &bill.every).ok_or_else(|| format!("{name}: bad due date"))?;
            }
        }
        write_bills(dir, bills)?;
    }
    Ok(clean.len())
}

/// The largest bank file read: 5 MB is years of transactions.
const MAX_CSV_BYTES: u64 = 5 * 1024 * 1024;

fn read_csv_file(path: &Path) -> Result<String, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if ext != "csv" && ext != "txt" {
        return Err("That isn't a CSV file. Export your transactions as CSV and try again.".into());
    }
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_CSV_BYTES {
        return Err("That file is over 5 MB. Export a shorter date range.".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ---------------------------------------------------------------- commands

fn changed(app: &AppHandle) {
    let _ = app.emit("ledger-changed", ());
}

fn dir_of(state: &State<AppState>) -> Result<PathBuf, String> {
    ledger_dir(&vault_root(state)?)
}

/// Every ledger entry in the vault, oldest first.
#[tauri::command]
pub fn ledger_entries(state: State<AppState>) -> Result<Vec<Entry>, String> {
    Ok(read_entries_in(&dir_of(&state)?))
}

#[tauri::command]
pub fn ledger_add(app: AppHandle, state: State<AppState>, entry: Entry) -> Result<Entry, String> {
    let saved = add_in(&dir_of(&state)?, entry)?;
    changed(&app);
    Ok(saved)
}

/// Replaces `original` (as it was loaded) with `entry`, moving it to another month's note if its date changed.
#[tauri::command]
pub fn ledger_update(app: AppHandle, state: State<AppState>, original: Entry, entry: Entry) -> Result<Entry, String> {
    let saved = update_in(&dir_of(&state)?, &original, entry)?;
    changed(&app);
    Ok(saved)
}

#[tauri::command]
pub fn ledger_delete(app: AppHandle, state: State<AppState>, entry: Entry) -> Result<(), String> {
    remove_in(&dir_of(&state)?, &entry)?;
    changed(&app);
    Ok(())
}

/// The categories and their budgets (a starter set until `Budgets.md` exists).
#[tauri::command]
pub fn ledger_categories(state: State<AppState>) -> Result<Vec<Category>, String> {
    read_categories(&dir_of(&state)?)
}

#[tauri::command]
pub fn ledger_save_categories(app: AppHandle, state: State<AppState>, categories: Vec<Category>) -> Result<Vec<Category>, String> {
    let saved = write_categories(&dir_of(&state)?, categories)?;
    changed(&app);
    Ok(saved)
}

/// Recurring bills, soonest due first.
#[tauri::command]
pub fn ledger_bills(state: State<AppState>) -> Result<Vec<Bill>, String> {
    let mut list = read_bills(&dir_of(&state)?)?;
    list.sort_by(|a, b| a.next.cmp(&b.next).then(a.name.cmp(&b.name)));
    Ok(list)
}

#[tauri::command]
pub fn ledger_save_bills(app: AppHandle, state: State<AppState>, bills: Vec<Bill>) -> Result<Vec<Bill>, String> {
    let saved = write_bills(&dir_of(&state)?, bills)?;
    changed(&app);
    Ok(saved)
}

/// Logs a bill on `date` (null skips it this time) and moves it to its next due date.
#[tauri::command]
pub fn ledger_settle_bill(app: AppHandle, state: State<AppState>, name: String, date: Option<String>) -> Result<Vec<Bill>, String> {
    let saved = settle_in(&dir_of(&state)?, &name, date.as_deref())?;
    changed(&app);
    Ok(saved)
}

/// Adds the entries from a bank import and moves on the bills they paid.
#[tauri::command]
pub fn ledger_import(app: AppHandle, state: State<AppState>, entries: Vec<Entry>, bills_paid: Vec<String>) -> Result<usize, String> {
    let n = import_in(&dir_of(&state)?, entries, &bills_paid)?;
    changed(&app);
    Ok(n)
}

/// The text of a bank CSV dropped on the window (the webview gets a path, not the file).
#[tauri::command]
pub fn ledger_read_csv(path: String) -> Result<String, String> {
    read_csv_file(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cogitorium-ledger-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn spend(date: &str, category: &str, cents: i64, note: &str) -> Entry {
        Entry { date: date.into(), kind: "out".into(), category: category.into(), cents, note: note.into(), bill: String::new() }
    }

    #[test]
    fn parses_amounts_to_cents() {
        assert_eq!(parse_cents("42.5"), Some(4250));
        assert_eq!(parse_cents("$1,234.56"), Some(123_456));
        assert_eq!(parse_cents("AUD 12"), Some(1200));
        assert_eq!(parse_cents("+3,100"), Some(310_000));
        assert_eq!(parse_cents("0.10"), Some(10));
        assert_eq!(parse_cents("0"), None);
        assert_eq!(parse_cents("twelve"), None);
        assert_eq!(parse_cents(""), None);
        assert_eq!(money(4250), "42.50");
        assert_eq!(money(5), "0.05");
    }

    #[test]
    fn month_note_round_trips() {
        let entries = vec![
            spend("2026-11-03", "Groceries", 4250, "Weekly shop"),
            Entry { date: "2026-11-01".into(), kind: "in".into(), category: "Pay".into(), cents: 210_000, note: "".into(), bill: "Pay".into() },
            spend("2026-11-03", "Eating out", 1890, "Ramen | gyoza"),
        ];
        let md = month_markdown("2026-11", &entries);
        assert!(md.contains("# Tithe-Ledger · November 2026"));
        assert!(md.contains("| 2026-11-03 | out | Eating out | 18.90 | Ramen / gyoza |  |"));
        let back = parse_entries(&md);
        assert_eq!(back.len(), 3);
        // Sorted by date; same-day rows keep their order.
        assert_eq!(back[0].kind, "in");
        assert_eq!(back[0].bill, "Pay");
        assert_eq!(back[1].note, "Weekly shop");
        assert_eq!(back[2].note, "Ramen / gyoza");
    }

    #[test]
    fn reads_rows_written_by_hand() {
        let text = "| Date | Kind | Category | Amount | Note |\n|---|---|---|---|---|\n| 2026-11-04 | | Transport | $8.40 | Opal |\n| 2026-11-05 | income | Other income | 50 | eBay |\n| 2026-11-06 |  | Gifts | +20 | refund? |\n| soon | out | Rent | 500 | |\n| 2026-11-07 | out | Rent | free | |\n";
        let e = parse_entries(text);
        assert_eq!(e.len(), 3);
        assert_eq!((e[0].kind.as_str(), e[0].cents, e[0].bill.as_str()), ("out", 840, ""));
        assert_eq!(e[1].kind, "in");
        assert_eq!(e[2].kind, "in", "a + amount with no kind is income");
    }

    #[test]
    fn adds_updates_and_deletes_entries() {
        let dir = temp_dir("entries");
        let a = add_in(&dir, spend("2026-11-03", "Groceries", 4250, "  Weekly   shop ")).unwrap();
        assert_eq!(a.note, "Weekly shop");
        let b = add_in(&dir, spend("2026-11-03", "Groceries", 4250, "Weekly shop")).unwrap();
        assert_eq!(read_entries_in(&dir).len(), 2);
        // Moving one into December moves it to that month's note.
        let moved = update_in(&dir, &b, spend("2026-12-01", "Gifts", 3000, "")).unwrap();
        assert!(dir.join("2026-12.md").exists());
        assert_eq!(read_month(&dir, "2026-11").unwrap(), vec![a.clone()]);
        remove_in(&dir, &moved).unwrap();
        remove_in(&dir, &a).unwrap();
        assert!(read_entries_in(&dir).is_empty());
        // A row that changed in Obsidian is not guessed at.
        assert!(remove_in(&dir, &a).is_err());
        assert!(add_in(&dir, spend("2026-11-31", "Rent", 100, "")).is_err());
        assert!(add_in(&dir, spend("2026-11-30", "Rent", 0, "")).is_err());
        let blank = add_in(&dir, Entry { kind: "in".into(), ..spend("2026-11-30", " ", 100, "") }).unwrap();
        assert_eq!(blank.category, "Other income");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn categories_round_trip_and_default() {
        let dir = temp_dir("categories");
        assert_eq!(read_categories(&dir).unwrap(), default_categories());
        let saved = write_categories(
            &dir,
            vec![
                Category { name: "Groceries".into(), kind: "out".into(), budget: Some(60_000) },
                Category { name: "groceries".into(), kind: "out".into(), budget: None },
                Category { name: "Pay".into(), kind: "in".into(), budget: Some(5) },
                Category { name: "  ".into(), kind: "out".into(), budget: None },
            ],
        )
        .unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[1].budget, None, "income has no budget");
        assert_eq!(read_categories(&dir).unwrap(), saved);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn due_dates_move_on() {
        assert_eq!(next_due("2026-11-20", "week").as_deref(), Some("2026-11-27"));
        assert_eq!(next_due("2026-11-20", "fortnight").as_deref(), Some("2026-12-04"));
        assert_eq!(next_due("2026-01-31", "month").as_deref(), Some("2026-02-28"));
        assert_eq!(next_due("2028-01-31", "month").as_deref(), Some("2028-02-29"));
        assert_eq!(next_due("2026-12-15", "month").as_deref(), Some("2027-01-15"));
        assert_eq!(next_due("2026-11-30", "quarter").as_deref(), Some("2027-02-28"));
        assert_eq!(next_due("2026-11-16", "year").as_deref(), Some("2027-11-16"));
        assert_eq!(every_from_word("Monthly"), Some("month"));
        assert_eq!(every_from_word("fortnightly"), Some("fortnight"));
        assert_eq!(every_from_word("weeks"), Some("week"));
        assert_eq!(every_from_word("sometimes"), None);
    }

    #[test]
    fn bills_log_and_skip() {
        let dir = temp_dir("bills");
        write_categories(&dir, default_categories()).unwrap();
        let bills = write_bills(
            &dir,
            vec![
                Bill { name: "Phone".into(), cents: 3500, category: "Phone and internet".into(), every: "monthly".into(), next: "2026-11-20".into() },
                Bill { name: "Pay".into(), cents: 210_000, category: "Pay".into(), every: "fortnight".into(), next: "2026-11-13".into() },
            ],
        )
        .unwrap();
        assert_eq!(bills[0].name, "Pay", "soonest first");
        assert_eq!(bills[1].every, "month");
        assert_eq!(parse_bills(&fs::read_to_string(dir.join(BILLS_FILE)).unwrap()), bills);

        let after = settle_in(&dir, "Pay", Some("2026-11-13")).unwrap();
        assert_eq!(after.iter().find(|b| b.name == "Pay").unwrap().next, "2026-11-27");
        let logged = read_entries_in(&dir);
        assert_eq!(logged.len(), 1);
        assert_eq!((logged[0].kind.as_str(), logged[0].bill.as_str(), logged[0].cents), ("in", "Pay", 210_000));

        let after = settle_in(&dir, "Phone", None).unwrap();
        assert_eq!(after.iter().find(|b| b.name == "Phone").unwrap().next, "2026-12-20");
        assert_eq!(read_entries_in(&dir).len(), 1, "skipping logs nothing");
        assert!(settle_in(&dir, "Gas", None).is_err());
        assert!(write_bills(&dir, vec![Bill { name: "X".into(), cents: 100, category: "".into(), every: "daily".into(), next: "2026-11-20".into() }]).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_many_entries_and_moves_bills_on() {
        let dir = temp_dir("import");
        write_categories(&dir, default_categories()).unwrap();
        write_bills(&dir, vec![Bill { name: "Rent".into(), cents: 45_000, category: "Rent".into(), every: "week".into(), next: "2026-11-02".into() }]).unwrap();
        add_in(&dir, spend("2026-11-01", "Groceries", 1000, "Kept")).unwrap();
        let rent = |d: &str| Entry { bill: "Rent".into(), ..spend(d, "Rent", 45_000, "Rent") };
        let n = import_in(&dir, vec![spend("2026-10-30", "Transport", 840, "Opal"), rent("2026-11-02"), rent("2026-11-09")], &["Rent".into(), "Rent".into(), "Gas".into()]).unwrap();
        assert_eq!(n, 3);
        assert_eq!(read_month(&dir, "2026-11").unwrap().len(), 3, "added to what was there");
        assert_eq!(read_month(&dir, "2026-10").unwrap().len(), 1);
        assert_eq!(read_bills(&dir).unwrap()[0].next, "2026-11-16");
        // One bad row and nothing is written.
        assert!(import_in(&dir, vec![spend("2026-12-01", "Gifts", 500, ""), spend("2026-12-32", "Gifts", 500, "")], &[]).is_err());
        assert!(!dir.join("2026-12.md").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
