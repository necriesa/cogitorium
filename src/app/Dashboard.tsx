import { useCallback, useEffect, useState } from "react";
import { GOAL_PRESETS, getStats, hm, setGoal, type Stats } from "../lib/stats";
import { onApp } from "../lib/events";
import { remainingMs, useSharedTimer } from "../lib/timer";
import type { Scroll } from "../lib/scroll";

type Props = { onOpen: (page: "data-stylus" | "chrono-siphon") => void };

const ACTIVE_KEY = "auto-quill.active"; // same key the Data Stylus uses
const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

function readActive(): Scroll | null {
  try {
    const saved = localStorage.getItem(ACTIVE_KEY);
    return saved ? (JSON.parse(saved) as Scroll) : null;
  } catch {
    return null;
  }
}

/** Short goal label: 90 → "1½h", 120 → "2h", 45 → "45m". */
function goalLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes % 30 === 0) return `${Math.floor(minutes / 60) || ""}½h`;
  return hm(minutes);
}

/** Inline editor for the daily focus goal. */
function GoalEditor({ current, onPick }: { current: number; onPick: (minutes: number) => void }) {
  const [custom, setCustom] = useState(GOAL_PRESETS.includes(current) || !current ? "" : String(current));
  return (
    <div className="goal-editor" role="group" aria-label="Daily focus goal">
      <span className="term-label">Daily goal</span>
      <div className="chips">
        {GOAL_PRESETS.map((m) => (
          <button key={m} className={m === current ? "chip on" : "chip"} aria-pressed={m === current} onClick={() => onPick(m)}>
            {goalLabel(m)}
          </button>
        ))}
        <input
          className="input chip-input"
          type="number"
          min={5}
          max={720}
          step={5}
          value={custom}
          placeholder="min"
          aria-label="Custom goal in minutes"
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            const n = Math.round(Number(custom));
            if (e.key === "Enter" && n > 0) onPick(Math.min(720, n));
          }}
        />
        <button className={current === 0 ? "chip on" : "chip"} aria-pressed={current === 0} onClick={() => onPick(0)}>
          Off
        </button>
      </div>
    </div>
  );
}

function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The Cogitator: the main app's home screen. Today's focus, streak, the week,
 * where the time went, the live timer, the open scroll, and stalled scrolls.
 * Numbers come from the backend (lib/stats.ts) and refresh whenever a session
 * or tick is logged, a scroll changes, or the window gains focus.
 */
export default function Dashboard({ onOpen }: Props) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState<Scroll | null>(readActive);
  const [editingGoal, setEditingGoal] = useState(false);
  const { timer, now } = useSharedTimer();

  const load = useCallback(() => {
    getStats(7)
      .then((s) => {
        setStats(s);
        setError("");
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    const offLog = onApp("log-changed", load);
    const offScroll = onApp<Scroll | null>("scroll-changed", (s) => {
      setActive(s ?? null);
      load();
    });
    const offTimer = onApp("timer-changed", load);
    const offGoal = onApp("goal-changed", load);
    window.addEventListener("focus", load);
    return () => {
      offLog();
      offScroll();
      offTimer();
      offGoal();
      window.removeEventListener("focus", load);
    };
  }, [load]);

  if (error) return <p className="footnote error dash-error">The cogitator could not read your records: {error}</p>;
  if (!stats) return <p className="footnote dash-error">Consulting the cogitator…</p>;

  const weekMinutes = stats.days.reduce((a, d) => a + d.minutes, 0);
  const weekDone = stats.days.reduce((a, d) => a + d.subtasksDone, 0);
  const goal = stats.goalMinutes;
  // The chart's top is the busiest day or the goal, whichever is higher, so the goal line always shows.
  const peak = Math.max(1, goal, ...stats.days.map((d) => d.minutes));
  const peakTask = Math.max(1, ...stats.byTask.map((t) => t.minutes));
  const peakProject = Math.max(1, ...stats.byProject.map((p) => p.minutes));
  const todayMet = goal > 0 && stats.today.minutes >= goal;

  function pickGoal(minutes: number) {
    setEditingGoal(false);
    setGoal(minutes).then(load).catch((e) => setError(String(e)));
  }
  const stalled = stats.scrolls.filter((s) => s.status === "stalled");
  const activeDone = active?.items.filter((i) => i.done).length ?? 0;
  const activeTotal = active?.items.length ?? 0;
  const timerLabel = { idle: "Awaiting judgement", running: "Time is slowed", paused: "Stasis held", finished: "The sands have run" };

  return (
    <div className="dash">
      <section className="cogitator dash-card kpis" aria-label="Today">
        <div className={todayMet ? "kpi goal-met" : "kpi"}>
          <span className="term-label">Today</span>
          <span className="kpi-value">{hm(stats.today.minutes)}</span>
          {goal > 0 ? (
            <>
              <div className="meter kpi-meter" role="progressbar" aria-label="Today's goal" aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.min(goal, stats.today.minutes)}>
                <span style={{ width: `${Math.min(100, (stats.today.minutes / goal) * 100)}%` }} />
              </div>
              <span className="kpi-sub">
                {todayMet ? "goal met" : `${hm(goal - stats.today.minutes)} to the ${goalLabel(goal)} goal`} · {stats.today.sessions} sessions
              </span>
            </>
          ) : (
            <span className="kpi-sub">{stats.today.sessions} sessions</span>
          )}
          <button className="goal-toggle" aria-expanded={editingGoal} onClick={() => setEditingGoal((v) => !v)}>
            {goal > 0 ? "Change goal" : "Set a goal"}
          </button>
        </div>
        <div className="kpi">
          <span className="term-label">Streak</span>
          <span className="kpi-value">{stats.streak}d</span>
          <span className="kpi-sub">days with focus</span>
        </div>
        <div className="kpi">
          <span className="term-label">This week</span>
          <span className="kpi-value">{hm(weekMinutes)}</span>
          <span className="kpi-sub">
            {weekDone} rites done{goal > 0 && ` · goal ${stats.goalDaysMet}/${stats.days.length} days`}
          </span>
        </div>
        {editingGoal && <GoalEditor current={goal} onPick={pickGoal} />}
      </section>

      <section className="cogitator dash-card" aria-label="Focus per day">
        <p className="term-label">
          Focus per day{goal > 0 && <span className="label-aside"> · goal {goalLabel(goal)}</span>}
        </p>
        <div className="week">
          {stats.days.map((d, i) => {
            const isToday = i === stats.days.length - 1;
            const met = goal > 0 && d.minutes >= goal;
            const cls = ["week-bar", isToday && "today", goal > 0 && (met ? "met" : "under")].filter(Boolean).join(" ");
            return (
              <div key={d.date} className="week-col" title={`${d.date}: ${hm(d.minutes)}${met ? " (goal met)" : ""}, ${d.subtasksDone} rites`}>
                <div className="week-bar-wrap">
                  <div className={cls} style={{ height: `${Math.max(d.minutes ? 4 : 0, (d.minutes / peak) * 100)}%` }} />
                  {goal > 0 && <div className="goal-mark" style={{ bottom: `${(goal / peak) * 100}%` }} aria-hidden="true" />}
                </div>
                <span className={isToday ? "week-day today" : "week-day"}>{WEEKDAY[new Date(`${d.date}T12:00`).getDay()]}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="cogitator dash-card" aria-label="Where the time went">
        <p className="term-label">Where the time went · 7 days</p>
        {stats.byTask.length === 0 ? (
          <p className="dash-empty">No sessions recorded yet. Invoke the Chrono-Siphon to begin.</p>
        ) : (
          <ul className="task-bars">
            {stats.byTask.map((t) => (
              <li key={t.task}>
                <span className="task-name">{t.task}</span>
                <span className="task-time">{hm(t.minutes)}</span>
                <span className="task-bar">
                  <span style={{ width: `${(t.minutes / peakTask) * 100}%` }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="cogitator dash-card" aria-label="Time by project">
        <p className="term-label">By project · 7 days</p>
        {stats.byProject.length === 0 ? (
          <p className="dash-empty">No project-tagged sessions yet. Pick a project when you invoke the Chrono-Siphon.</p>
        ) : (
          <ul className="task-bars">
            {stats.byProject.map((p) => (
              <li key={p.task}>
                <span className="task-name">{p.task}</span>
                <span className="task-time">{hm(p.minutes)}</span>
                <span className="task-bar">
                  <span style={{ width: `${(p.minutes / peakProject) * 100}%` }} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {stats.byProject.length > 0 && stats.untaggedMinutes > 0 && <p className="dash-empty">Untagged: {hm(stats.untaggedMinutes)}</p>}
      </section>

      <section className="cogitator dash-card" aria-label="Chrono-Siphon">
        <p className="term-label">Chrono-Siphon</p>
        {timer && timer.phase !== "idle" ? (
          <>
            <p className={`dash-timer phase-${timer.phase}`}>{clock(remainingMs(timer, now))}</p>
            <p className="dash-line">
              {timerLabel[timer.phase]} · {timer.task || "unnamed quarry"}
              {timer.project && ` · ${timer.project}`}
            </p>
          </>
        ) : (
          <p className="dash-empty">No stasis invoked.</p>
        )}
        <button className="dash-link" onClick={() => onOpen("chrono-siphon")}>
          Open the Chrono-Siphon
        </button>
      </section>

      <section className="cogitator dash-card" aria-label="Open scroll">
        <p className="term-label">Open scroll</p>
        {active ? (
          <>
            <p className="dash-line strong">{active.title}</p>
            <div className="meter">
              <span style={{ width: `${activeTotal ? (activeDone / activeTotal) * 100 : 0}%` }} />
            </div>
            <p className="dash-line">
              {activeDone}/{activeTotal} rites
              {active.items.find((i) => !i.done) ? ` · next: ${active.items.find((i) => !i.done)!.text}` : " · complete"}
            </p>
          </>
        ) : (
          <p className="dash-empty">No scroll open.</p>
        )}
        <button className="dash-link" onClick={() => onOpen("data-stylus")}>
          Open the Data Stylus
        </button>
      </section>

      <section className="cogitator dash-card" aria-label="Scrolls">
        <p className="term-label">
          Scrolls{stalled.length > 0 && <span className="alarm"> · {stalled.length} stalled</span>}
        </p>
        {stats.scrolls.length === 0 ? (
          <p className="dash-empty">No scrolls yet.</p>
        ) : (
          <ul className="scroll-list">
            {stats.scrolls.slice(0, 6).map((s) => (
              <li key={s.file} className={`scroll-${s.status}`}>
                <span className="scroll-title">{s.title}</span>
                <span className="scroll-meta">
                  {s.done}/{s.total}
                  {s.status === "complete" ? " · complete" : s.idleDays != null ? ` · idle ${s.idleDays}d` : ""}
                </span>
                {s.status === "stalled" && s.nextItem && <span className="scroll-next">next: {s.nextItem}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
