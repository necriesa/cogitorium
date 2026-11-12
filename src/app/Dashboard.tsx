import { useCallback, useEffect, useState } from "react";
import { getStats, hm, type Stats } from "../lib/stats";
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
    window.addEventListener("focus", load);
    return () => {
      offLog();
      offScroll();
      offTimer();
      window.removeEventListener("focus", load);
    };
  }, [load]);

  if (error) return <p className="footnote error dash-error">The cogitator could not read your records: {error}</p>;
  if (!stats) return <p className="footnote dash-error">Consulting the cogitator…</p>;

  const weekMinutes = stats.days.reduce((a, d) => a + d.minutes, 0);
  const weekDone = stats.days.reduce((a, d) => a + d.subtasksDone, 0);
  const peak = Math.max(1, ...stats.days.map((d) => d.minutes));
  const peakTask = Math.max(1, ...stats.byTask.map((t) => t.minutes));
  const stalled = stats.scrolls.filter((s) => s.status === "stalled");
  const activeDone = active?.items.filter((i) => i.done).length ?? 0;
  const activeTotal = active?.items.length ?? 0;
  const timerLabel = { idle: "Awaiting judgement", running: "Time is slowed", paused: "Stasis held", finished: "The sands have run" };

  return (
    <div className="dash">
      <section className="cogitator dash-card kpis" aria-label="Today">
        <div className="kpi">
          <span className="term-label">Today</span>
          <span className="kpi-value">{hm(stats.today.minutes)}</span>
          <span className="kpi-sub">{stats.today.sessions} sessions</span>
        </div>
        <div className="kpi">
          <span className="term-label">Streak</span>
          <span className="kpi-value">{stats.streak}d</span>
          <span className="kpi-sub">days with focus</span>
        </div>
        <div className="kpi">
          <span className="term-label">This week</span>
          <span className="kpi-value">{hm(weekMinutes)}</span>
          <span className="kpi-sub">{weekDone} rites done</span>
        </div>
      </section>

      <section className="cogitator dash-card" aria-label="Focus per day">
        <p className="term-label">Focus per day</p>
        <div className="week">
          {stats.days.map((d, i) => {
            const isToday = i === stats.days.length - 1;
            return (
              <div key={d.date} className="week-col" title={`${d.date}: ${hm(d.minutes)}, ${d.subtasksDone} rites`}>
                <div className="week-bar-wrap">
                  <div className={isToday ? "week-bar today" : "week-bar"} style={{ height: `${Math.max(d.minutes ? 4 : 0, (d.minutes / peak) * 100)}%` }} />
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

      <section className="cogitator dash-card" aria-label="Chrono-Siphon">
        <p className="term-label">Chrono-Siphon</p>
        {timer && timer.phase !== "idle" ? (
          <>
            <p className={`dash-timer phase-${timer.phase}`}>{clock(remainingMs(timer, now))}</p>
            <p className="dash-line">
              {timerLabel[timer.phase]} · {timer.task || "unnamed quarry"}
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
