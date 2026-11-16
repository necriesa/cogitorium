import { useMemo, useState } from "react";
import { daysBetween, fmt, kg, setCount, volumeOf, type ExerciseStat, type ForgeStats, type Workout } from "../lib/forge";
import { today } from "../lib/vaultLog";

type Props = { stats: ForgeStats; workouts: Workout[]; onOpenDay: (date: string) => void };

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (date: string) => `${Number(date.slice(8, 10))} ${MONTH[Number(date.slice(5, 7)) - 1]}`;

function ago(date: string | null): string {
  if (!date) return "never";
  const n = daysBetween(date, today());
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
}

/** Twelve weeks of gym days: one column per week (Monday on top), lit on a visit. */
function VisitStrip({ stats }: { stats: ForgeStats }) {
  const visited = new Set(stats.visitDays);
  const t = today();
  return (
    <div className="forge-strip" role="img" aria-label={`${stats.visitDays.length} gym days in the last 12 weeks`}>
      {stats.weeks.map((w) => (
        <div key={w.start} className="forge-strip-week">
          {Array.from({ length: 7 }, (_, i) => {
            const d = new Date(`${w.start}T00:00:00Z`);
            d.setUTCDate(d.getUTCDate() + i);
            const date = d.toISOString().slice(0, 10);
            const cls = ["forge-cell", visited.has(date) && "lit", date === t && "today", date > t && "future"].filter(Boolean).join(" ");
            return <span key={date} className={cls} title={`${short(date)}${visited.has(date) ? " · gym" : ""}`} />;
          })}
        </div>
      ))}
    </div>
  );
}

/** Bars for one weekly measure, with a hover readout (one series, so no legend). */
function WeekBars({
  stats,
  value,
  unit,
  empty,
}: {
  stats: ForgeStats;
  value: (w: ForgeStats["weeks"][number]) => number;
  unit: string;
  /** Shown instead of the chart when every week is zero. */
  empty: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const values = stats.weeks.map(value);
  // With nothing to draw, the bars would be bare hover areas that only flip through dates.
  if (values.every((v) => v <= 0)) return <p className="dash-empty">{empty}</p>;
  const peak = Math.max(1, ...values);
  const shown = hover ?? values.length - 1;
  const amount = (v: number) => `${unit === "kg" ? kg(v) : fmt(v)} ${unit}`;
  return (
    <>
      <p className="forge-readout">
        <span>{shown === values.length - 1 ? "this week" : `week of ${short(stats.weeks[shown].start)}`}</span>
        <span className="strong">{amount(values[shown])}</span>
      </p>
      <div className="forge-bars" onMouseLeave={() => setHover(null)}>
        {values.map((v, i) => (
          <button
            key={stats.weeks[i].start}
            className={i === shown ? "forge-bar-hit on" : "forge-bar-hit"}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            aria-label={`Week of ${short(stats.weeks[i].start)}: ${amount(v)}`}
          >
            {/* A zero week is a flat stub on the baseline, so it reads as zero rather than missing. */}
            <span className={v > 0 ? "forge-bar" : "forge-bar zero"} style={v > 0 ? { height: `${Math.max(4, (v / peak) * 100)}%` } : undefined} />
          </button>
        ))}
      </div>
      <p className="forge-axis-row">
        <span>{short(stats.weeks[0].start)}</span>
        <span>peak {amount(Math.max(...values))}</span>
        <span>this week</span>
      </p>
    </>
  );
}

type Metric = "top" | "heaviest" | "e1rm" | "minutes" | "km" | "seconds" | "metres";
const METRIC_LABEL: Record<Metric, string> = {
  top: "Top set",
  heaviest: "Heaviest",
  e1rm: "Est. 1RM",
  minutes: "Minutes",
  km: "Distance",
  seconds: "Longest hold",
  metres: "Distance",
};
const METRIC_UNIT: Record<Metric, string> = { top: "kg", heaviest: "kg", e1rm: "kg", minutes: "min", km: "km", seconds: "s", metres: "m" };
/** What each kind of exercise can be charted by; the first is the default. */
const METRICS: Record<ExerciseStat["kind"], Metric[]> = {
  lift: ["top", "e1rm"],
  hold: ["seconds"],
  carry: ["heaviest", "metres"],
  cardio: ["minutes", "km"],
};

/** One exercise over time, as a line with a marker per session. */
function Progression({ exercise }: { exercise: ExerciseStat }) {
  const options = METRICS[exercise.kind] ?? METRICS.lift;
  const [metric, setMetric] = useState<Metric>(options[0]);
  const m: Metric = options.includes(metric) ? metric : options[0];
  const pick = (p: ExerciseStat["points"][number]) =>
    ({
      top: p.topWeight,
      heaviest: p.topWeight,
      e1rm: p.bestE1rm,
      minutes: p.minutes || null,
      km: p.km || null,
      seconds: p.seconds || null,
      metres: p.metres || null,
    })[m];
  const points = exercise.points.map((p) => ({ p, v: pick(p) })).filter((x): x is { p: typeof x.p; v: number } => x.v != null);
  const [hover, setHover] = useState<number | null>(null);

  const W = 320;
  const H = 130;
  const padX = 12;
  const padTop = 14;
  const padBottom = 18;
  const values = points.map((x) => x.v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // A flat series sits in the middle of the chart.
  const span = hi - lo || Math.max(1, hi * 0.1);
  const base = hi === lo ? lo - span / 2 : lo;
  const y = (v: number) => padTop + (1 - (v - base) / span) * (H - padTop - padBottom);
  const x = (i: number) => (points.length === 1 ? W / 2 : padX + (i / (points.length - 1)) * (W - 2 * padX));
  const shown = hover ?? points.length - 1;
  const cur = points[shown];

  return (
    <div className="forge-prog">
      <div className="chips" role="group" aria-label="Measure">
        {options.map((k) => (
          <button key={k} className={k === m ? "chip on" : "chip"} aria-pressed={k === m} onClick={() => setMetric(k)}>
            {METRIC_LABEL[k]}
          </button>
        ))}
      </div>
      {points.length === 0 ? (
        <p className="dash-empty">Nothing recorded for this measure yet.</p>
      ) : (
        <>
          <p className="forge-readout">
            <span>{short(cur.p.date)}</span>
            <span className="strong">
              {fmt(cur.v)} {METRIC_UNIT[m]}
            </span>
          </p>
          <svg
            className="forge-line-chart"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${exercise.name}, ${METRIC_LABEL[m]}: ${fmt(points[0].v)} to ${fmt(points[points.length - 1].v)} ${METRIC_UNIT[m]}`}
            onMouseLeave={() => setHover(null)}
          >
            <line className="forge-grid" x1={padX} x2={W - padX} y1={y(hi)} y2={y(hi)} />
            <line className="forge-grid" x1={padX} x2={W - padX} y1={y(lo)} y2={y(lo)} />
            <text className="forge-axis" x={padX} y={y(hi) - 4}>
              {fmt(hi)}
            </text>
            {hi !== lo && (
              <text className="forge-axis" x={padX} y={y(lo) + 12}>
                {fmt(lo)}
              </text>
            )}
            {points.length > 1 && (
              <polyline className="forge-path" points={points.map((pt, i) => `${x(i)},${y(pt.v)}`).join(" ")} />
            )}
            {hover != null && <line className="forge-cross" x1={x(shown)} x2={x(shown)} y1={padTop - 6} y2={H - padBottom + 4} />}
            {points.map((pt, i) => (
              <g key={pt.p.date}>
                <circle className={i === shown ? "forge-dot on" : "forge-dot"} cx={x(i)} cy={y(pt.v)} r={4} />
                <rect
                  className="forge-hit"
                  x={x(i) - (W - 2 * padX) / Math.max(2, points.length) / 2}
                  y={0}
                  width={(W - 2 * padX) / Math.max(2, points.length)}
                  height={H}
                  onMouseEnter={() => setHover(i)}
                />
              </g>
            ))}
            <text className="forge-axis" x={padX} y={H - 4}>
              {short(points[0].p.date)}
            </text>
            {points.length > 1 && (
              <text className="forge-axis" x={W - padX} y={H - 4} textAnchor="end">
                {short(points[points.length - 1].p.date)}
              </text>
            )}
          </svg>
          <p className="forge-line">{cur.p.summary}</p>
        </>
      )}
    </div>
  );
}

/**
 * The Flesh-Forge record: gym visits, weekly volume and cardio, how each
 * exercise is progressing, and recent personal bests.
 */
export default function ForgeRecord({ stats, workouts, onOpenDay }: Props) {
  const [chosen, setChosen] = useState<string | null>(null);
  const exercise = stats.exercises.find((e) => e.name === chosen) ?? stats.exercises[0] ?? null;
  const recent = useMemo(() => workouts.filter((w) => w.date <= today()).slice(0, 6), [workouts]);
  const hasCardio = stats.weeks.some((w) => w.cardioMinutes > 0);

  return (
    <div className="dash forge-dash">
      <section className="cogitator dash-card kpis" aria-label="Visits">
        <div className="kpi">
          <span className="term-label">This week</span>
          <span className="kpi-value">{stats.visitsThisWeek}</span>
          <span className="kpi-sub">gym {stats.visitsThisWeek === 1 ? "visit" : "visits"}</span>
        </div>
        <div className="kpi">
          <span className="term-label">Streak</span>
          <span className="kpi-value">{stats.weekStreak}w</span>
          <span className="kpi-sub">weeks in a row</span>
        </div>
        <div className="kpi">
          <span className="term-label">All time</span>
          <span className="kpi-value">{stats.totalVisits}</span>
          <span className="kpi-sub">visits</span>
        </div>
        <div className="kpi">
          <span className="term-label">Last visit</span>
          <span className="kpi-value kpi-text">{ago(stats.lastVisit)}</span>
          <span className="kpi-sub">{stats.lastVisit ? short(stats.lastVisit) : "–"}</span>
        </div>
      </section>

      <section className="cogitator dash-card" aria-label="Gym days">
        <p className="term-label">Gym days · 12 weeks</p>
        <VisitStrip stats={stats} />
        <p className="dash-empty">
          {stats.weeks.reduce((a, w) => a + w.visits, 0)} visits · columns are weeks, Monday on top
        </p>
      </section>

      <section className="cogitator dash-card" aria-label="Volume per week">
        <p className="term-label">Volume per week</p>
        <WeekBars stats={stats} value={(w) => w.volume} unit="kg" empty="No weight lifted in the last 12 weeks. Ticked sets with a weight add up here." />
      </section>

      {hasCardio && (
        <section className="cogitator dash-card" aria-label="Cardio per week">
          <p className="term-label">Cardio per week</p>
          <WeekBars stats={stats} value={(w) => w.cardioMinutes} unit="min" empty="No cardio in the last 12 weeks." />
        </section>
      )}

      <section className="cogitator dash-card forge-wide" aria-label="Progression">
        <p className="term-label">Progression</p>
        {!exercise ? (
          <p className="dash-empty">Tick some sets and your progress shows here.</p>
        ) : (
          <>
            <label className="forge-select">
              <span className="sr-only">Exercise</span>
              <select className="term-input" value={exercise.name} onChange={(e) => setChosen(e.target.value)}>
                {stats.exercises.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="forge-line">
              {exercise.points.length} sessions
              {exercise.bestWeight != null && ` · heaviest ${fmt(exercise.bestWeight)} kg`}
              {exercise.kind === "hold" && ` · longest ${fmt(Math.max(0, ...exercise.points.map((p) => p.seconds)))} s`}
              {exercise.bestE1rm != null && ` · best est. 1RM ${fmt(Math.round(exercise.bestE1rm * 10) / 10)} kg`}
            </p>
            <Progression key={exercise.name} exercise={exercise} />
          </>
        )}
      </section>

      <section className="cogitator dash-card" aria-label="Personal bests">
        <p className="term-label">Personal bests</p>
        {stats.records.length === 0 ? (
          <p className="dash-empty">Beat an earlier session and it's recorded here.</p>
        ) : (
          <ul className="scroll-list">
            {stats.records.map((r) => (
              <li key={`${r.exercise}-${r.date}`}>
                <span className="scroll-row forge-static">
                  <span className="scroll-title">{r.exercise}</span>
                  <span className="scroll-meta">
                    {fmt(r.weight)} kg × {r.reps} · {short(r.date)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="cogitator dash-card" aria-label="Recent workouts">
        <p className="term-label">Recent workouts</p>
        {recent.length === 0 ? (
          <p className="dash-empty">No workouts yet.</p>
        ) : (
          <ul className="scroll-list">
            {recent.map((w) => {
              const c = setCount(w);
              const v = volumeOf(w);
              return (
                <li key={w.file} className={w.status === "done" ? "" : "scroll-active"}>
                  <button className="scroll-row" onClick={() => onOpenDay(w.date)} title="Open in the planner">
                    <span className="scroll-title">{w.title}</span>
                    <span className="scroll-meta">
                      {short(w.date)} · {c.done}/{c.total} sets{v > 0 ? ` · ${kg(v)} kg` : ""}
                      {w.status !== "done" ? ` · ${w.status}` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
