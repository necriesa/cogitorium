"""Cogitator stats: counts what the Cogitorium widgets logged into the vault.

Reads, inside the vault's widget folder (default `Sources/Journal/Widgets`):
  - daily logs `<YYYY-MM-DD>.md`, one line per action:
        - 14:32 · Chrono-Siphon · 25 min · film demo
        - 14:40 · Data Stylus · completed · <subtask> · <task>
        - 14:41 · Data Stylus · task begun · <task> · 4 subtasks
    Older logs use earlier widget names (Tempormortis / Chronoglass for the
    timer, Auto Quill for the stylus); all of them are read.
  - Data Stylus scrolls `Scrolls/<Task>.md` (Markdown checklists with
    `updated:` and `progress:` frontmatter).

Prints a Markdown report (or JSON with --json) for a date range: focus
minutes per day, task and hour, streaks, subtask completions, and every
scroll's progress and idle days. The `/cogitator` skill in the vault runs
this for the numbers and does the interpreting itself.

Usage:
    python cogitator_stats.py                 # last 7 days, vault from the app's settings
    python cogitator_stats.py --days 30
    python cogitator_stats.py --from 2026-11-01 --to 2026-11-30
    python cogitator_stats.py --vault "D:/path/to/vault" --json

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

DEFAULT_LOG_DIR = "Sources/Journal/Widgets"
SEP = " · "
LINE = re.compile(r"^- (\d{1,2}):(\d{2}) · (.+)$")
DATE_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.md$")
STALLED_AFTER_DAYS = 7
# Log names for each widget, current first. Earlier versions used the older names.
TIMER_NAMES = {"Chrono-Siphon", "Chronoglass", "Tempormortis"}
STYLUS_NAMES = {"Data Stylus", "Auto Quill"}


# ---------------------------------------------------------------- locating

def settings_vault() -> Path | None:
    """The vault the widgets app saved (Windows: %APPDATA%; macOS/Linux: config dir)."""
    candidates = []
    if os.environ.get("APPDATA"):
        candidates.append(Path(os.environ["APPDATA"]))
    candidates += [Path.home() / "Library" / "Application Support", Path.home() / ".config"]
    for base in candidates:
        # current app ID first, then the pre-0.4 one
        for app_id in ("com.necriesa.cogitorium", "com.necriesa.darkcellswidgets"):
            f = base / app_id / "settings.json"
            try:
                vault = json.loads(f.read_text(encoding="utf-8")).get("vault")
            except (OSError, ValueError):
                continue
            if vault and Path(vault).is_dir():
                return Path(vault)
    return None


def widget_dir(vault: Path) -> Path:
    rel = os.environ.get("DARK_CELLS_LOG_DIR", DEFAULT_LOG_DIR)
    return vault / rel


# ---------------------------------------------------------------- parsing

@dataclass
class Session:
    day: date
    hour: int
    minutes: int
    task: str


@dataclass
class Tick:
    day: date
    hour: int
    action: str          # completed | reopened | task begun
    item: str
    task: str


@dataclass
class ScrollInfo:
    file: str
    title: str
    done: int
    total: int
    created: str
    updated: str
    idle_days: int | None
    open_items: list[str] = field(default_factory=list)

    @property
    def status(self) -> str:
        if self.total and self.done == self.total:
            return "complete"
        if self.idle_days is not None and self.idle_days >= STALLED_AFTER_DAYS:
            return "stalled"
        return "active"


def parse_minutes(text: str) -> int | None:
    m = re.match(r"^(\d+)\s*min", text.strip())
    return int(m.group(1)) if m else None


def read_logs(folder: Path, start: date, end: date):
    sessions: list[Session] = []
    ticks: list[Tick] = []
    unparsed = 0
    days_with_logs: set[date] = set()
    if not folder.is_dir():
        return sessions, ticks, unparsed, days_with_logs
    for f in folder.iterdir():
        m = DATE_FILE.match(f.name)
        if not m:
            continue
        day = date.fromisoformat(m.group(1))
        if not (start <= day <= end):
            continue
        for raw in f.read_text(encoding="utf-8").splitlines():
            lm = LINE.match(raw.strip())
            if not lm:
                continue
            hour = int(lm.group(1))
            fields = [p.strip() for p in lm.group(3).split(SEP)]
            widget = fields[0] if fields else ""
            days_with_logs.add(day)
            if widget in TIMER_NAMES and len(fields) >= 2:
                mins = parse_minutes(fields[1])
                if mins is None:
                    unparsed += 1
                    continue
                task = fields[2] if len(fields) > 2 else "untitled"
                sessions.append(Session(day, hour, mins, task))
            elif widget in STYLUS_NAMES and len(fields) >= 3:
                action = fields[1]
                if action in ("completed", "reopened"):
                    ticks.append(Tick(day, hour, action, fields[2], fields[3] if len(fields) > 3 else ""))
                elif action in ("task begun", "plan begun"):
                    ticks.append(Tick(day, hour, "task begun", "", fields[2]))
                else:
                    unparsed += 1
            else:
                unparsed += 1
    return sessions, ticks, unparsed, days_with_logs


def read_scrolls(folder: Path, today: date) -> list[ScrollInfo]:
    out: list[ScrollInfo] = []
    sdir = folder / "Scrolls"
    if not sdir.is_dir():
        return out
    for f in sorted(sdir.glob("*.md")):
        text = f.read_text(encoding="utf-8")
        fm = {}
        fmm = re.match(r"^---\r?\n(.*?)\r?\n---", text, re.S)
        if fmm:
            for line in fmm.group(1).splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    fm[k.strip()] = v.strip()
        title_m = re.search(r"^#\s+(.+)$", text, re.M)
        boxes = re.findall(r"^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$", text, re.M)
        done = sum(1 for b, _ in boxes if b.lower() == "x")
        updated = fm.get("updated", "")
        idle = None
        try:
            idle = (today - date.fromisoformat(updated[:10])).days
        except ValueError:
            try:
                idle = (today - datetime.fromtimestamp(f.stat().st_mtime).date()).days
            except OSError:
                pass
        out.append(
            ScrollInfo(
                file=f.name,
                title=title_m.group(1).strip() if title_m else f.stem,
                done=done,
                total=len(boxes),
                created=fm.get("created", ""),
                updated=updated,
                idle_days=idle,
                open_items=[t.strip() for b, t in boxes if b == " "],
            )
        )
    return out


# ---------------------------------------------------------------- stats

def streaks(active_days: set[date], start: date, end: date) -> tuple[int, int]:
    """(current streak ending at `end`, longest streak in range)."""
    longest = run = 0
    d = start
    while d <= end:
        run = run + 1 if d in active_days else 0
        longest = max(longest, run)
        d += timedelta(days=1)
    current = 0
    d = end
    while d >= start and d in active_days:
        current += 1
        d -= timedelta(days=1)
    return current, longest


def build(vault: Path, start: date, end: date, today: date) -> dict:
    folder = widget_dir(vault)
    sessions, ticks, unparsed, days_with_logs = read_logs(folder, start, end)
    scrolls = read_scrolls(folder, today)

    by_day_min: dict[date, int] = defaultdict(int)
    by_day_n: dict[date, int] = defaultdict(int)
    for s in sessions:
        by_day_min[s.day] += s.minutes
        by_day_n[s.day] += 1
    by_task = Counter()
    for s in sessions:
        by_task[s.task] += s.minutes
    by_hour = Counter()
    for s in sessions:
        by_hour[s.hour] += s.minutes

    focus_days = {d for d, m in by_day_min.items() if m > 0}
    cur, longest = streaks(focus_days, start, end)
    total_min = sum(s.minutes for s in sessions)
    span = (end - start).days + 1

    completed = [t for t in ticks if t.action == "completed"]
    reopened = [t for t in ticks if t.action == "reopened"]
    begun = [t for t in ticks if t.action == "task begun"]
    by_scroll = Counter(t.task for t in completed)
    done_by_day = Counter(t.day for t in completed)

    return {
        "vault": str(vault),
        "folder": str(folder),
        "range": {"from": start.isoformat(), "to": end.isoformat(), "days": span},
        "focus": {
            "sessions": len(sessions),
            "minutes": total_min,
            "active_days": len(focus_days),
            "avg_minutes_per_active_day": round(total_min / len(focus_days)) if focus_days else 0,
            "current_streak_days": cur,
            "longest_streak_days": longest,
            "by_day": [
                {"date": (start + timedelta(days=i)).isoformat(),
                 "sessions": by_day_n.get(start + timedelta(days=i), 0),
                 "minutes": by_day_min.get(start + timedelta(days=i), 0),
                 "subtasks_completed": done_by_day.get(start + timedelta(days=i), 0)}
                for i in range(span)
            ],
            "by_task": [{"task": t, "minutes": m} for t, m in by_task.most_common()],
            "by_hour": [{"hour": h, "minutes": by_hour[h]} for h in sorted(by_hour)],
        },
        "tasks": {
            "subtasks_completed": len(completed),
            "subtasks_reopened": len(reopened),
            "tasks_begun": [t.task for t in begun],
            "completions_by_task": [{"task": t, "completed": n} for t, n in by_scroll.most_common()],
        },
        "scrolls": [
            {"title": s.title, "file": s.file, "done": s.done, "total": s.total, "status": s.status,
             "created": s.created, "updated": s.updated, "idle_days": s.idle_days, "open_items": s.open_items}
            for s in sorted(scrolls, key=lambda s: (s.status != "stalled", s.status == "complete", s.title))
        ],
        "data_notes": {
            "days_with_any_log": len(days_with_logs),
            "unparsed_lines": unparsed,
            "log_folder_exists": folder.is_dir(),
        },
    }


# ---------------------------------------------------------------- output

def hm(minutes: int) -> str:
    h, m = divmod(minutes, 60)
    return f"{h}h {m:02d}m" if h else f"{m}m"


def bar(value: int, peak: int, width: int = 20) -> str:
    return "█" * round(width * value / peak) if peak else ""


def to_markdown(r: dict) -> str:
    f, t = r["focus"], r["tasks"]
    out = [f"# Cogitator report: {r['range']['from']} to {r['range']['to']} ({r['range']['days']} days)", ""]
    if not r["data_notes"]["log_folder_exists"]:
        out += [f"No widget logs yet: `{r['folder']}` does not exist.", ""]
    out += [
        "## Focus (Chrono-Siphon)",
        f"- Sessions: {f['sessions']} · total {hm(f['minutes'])} · active days {f['active_days']}/{r['range']['days']}"
        f" · average {hm(f['avg_minutes_per_active_day'])} per active day",
        f"- Streak: current {f['current_streak_days']} day(s), longest in range {f['longest_streak_days']}",
        "",
        "| Date | Sessions | Focus | Subtasks done | |",
        "|---|---|---|---|---|",
    ]
    peak = max((d["minutes"] for d in f["by_day"]), default=0)
    for d in f["by_day"]:
        wd = date.fromisoformat(d["date"]).strftime("%a")
        out.append(f"| {d['date']} {wd} | {d['sessions']} | {hm(d['minutes'])} | {d['subtasks_completed']} | {bar(d['minutes'], peak)} |")
    if f["by_task"]:
        out += ["", "### Focus by task"] + [f"- {x['task']}: {hm(x['minutes'])}" for x in f["by_task"][:12]]
    if f["by_hour"]:
        out += ["", "### Focus by hour started"] + [f"- {x['hour']:02d}:00 {bar(x['minutes'], max(y['minutes'] for y in f['by_hour']), 12)} {hm(x['minutes'])}" for x in f["by_hour"]]
    out += [
        "",
        "## Tasks (Data Stylus)",
        f"- Subtasks completed: {t['subtasks_completed']} · reopened: {t['subtasks_reopened']} · tasks begun: {len(t['tasks_begun'])}",
    ]
    if t["tasks_begun"]:
        out.append("- Begun: " + "; ".join(t["tasks_begun"]))
    if t["completions_by_task"]:
        out += [f"- {x['task']}: {x['completed']} completed" for x in t["completions_by_task"]]
    out += ["", f"## Scrolls (all, as of today; stalled = idle {STALLED_AFTER_DAYS}+ days)"]
    if r["scrolls"]:
        out += ["| Scroll | Progress | Status | Last updated | Idle days |", "|---|---|---|---|---|"]
        for s in r["scrolls"]:
            out.append(f"| {s['title']} | {s['done']}/{s['total']} | {s['status']} | {s['updated'] or '?'} | {s['idle_days'] if s['idle_days'] is not None else '?'} |")
        stalled = [s for s in r["scrolls"] if s["status"] == "stalled"]
        for s in stalled:
            out.append(f"- Stalled, next open item for {s['title']}: {s['open_items'][0] if s['open_items'] else '?'}")
    else:
        out.append("- No scrolls yet.")
    n = r["data_notes"]
    out += ["", "## Data notes",
            f"- Days with any widget log: {n['days_with_any_log']} · unparsed lines: {n['unparsed_lines']}",
            "- Only sessions that were recorded (\"Record the verdict\") are counted; abandoned timers leave no trace.",
            f"- Source folder: `{r['folder']}`"]
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--vault", help="vault folder (default: the one the widgets app saved)")
    ap.add_argument("--days", type=int, default=7, help="last N days including today (default 7)")
    ap.add_argument("--from", dest="start", help="start date YYYY-MM-DD")
    ap.add_argument("--to", dest="end", help="end date YYYY-MM-DD (default today)")
    ap.add_argument("--today", help=argparse.SUPPRESS)  # for tests
    ap.add_argument("--json", action="store_true", help="print JSON instead of Markdown")
    a = ap.parse_args(argv)

    vault = Path(a.vault) if a.vault else settings_vault()
    if not vault or not vault.is_dir():
        print("Vault not found. Pass --vault, or open the widgets app once so it saves one.", file=sys.stderr)
        return 2
    today = date.fromisoformat(a.today) if a.today else date.today()
    end = date.fromisoformat(a.end) if a.end else today
    start = date.fromisoformat(a.start) if a.start else end - timedelta(days=max(1, a.days) - 1)
    if start > end:
        print("--from is after --to", file=sys.stderr)
        return 2

    report = build(vault, start, end, today)
    if a.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(to_markdown(report), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
