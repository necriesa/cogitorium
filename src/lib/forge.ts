import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitApp } from "./events";
import { today } from "./vaultLog";

/**
 * The Flesh-Forge: workouts kept as Markdown notes in the vault
 * (`<log dir>/Flesh-Forge/<date> <title>.md`, templates in `Templates/`).
 * The Rust backend (src-tauri/src/forge.rs) reads and writes the notes and
 * counts the dashboard numbers. In a plain browser (`npm run dev`) workouts
 * live in localStorage, seeded with a few sample sessions.
 */

export type WorkoutSet = {
  done: boolean;
  /** Kilograms; null for a bodyweight set. */
  weight: number | null;
  reps: number | null;
  minutes: number | null;
  km: number | null;
};
export type ExerciseKind = "lift" | "cardio";
export type Exercise = { name: string; kind: ExerciseKind; notes: string; sets: WorkoutSet[] };
export type WorkoutStatus = "planned" | "active" | "done";
export type Workout = {
  /** File name in the vault; empty until first saved. */
  file: string;
  date: string;
  title: string;
  status: WorkoutStatus;
  started: string | null;
  finished: string | null;
  notes: string;
  exercises: Exercise[];
};

export type WeekStat = { start: string; visits: number; volume: number; cardioMinutes: number; cardioKm: number };
export type ExercisePoint = {
  date: string;
  topWeight: number | null;
  bestE1rm: number | null;
  volume: number;
  minutes: number;
  km: number;
  summary: string;
};
export type ExerciseStat = {
  name: string;
  kind: ExerciseKind;
  points: ExercisePoint[];
  bestWeight: number | null;
  bestE1rm: number | null;
};
export type ForgeRecord = { exercise: string; date: string; weight: number; reps: number; e1rm: number };
export type ForgeStats = {
  totalVisits: number;
  lastVisit: string | null;
  visitsThisWeek: number;
  weekStreak: number;
  weeks: WeekStat[];
  visitDays: string[];
  exercises: ExerciseStat[];
  records: ForgeRecord[];
  titles: { title: string; date: string; file: string }[];
};

export const emptySet = (kind: ExerciseKind): WorkoutSet =>
  kind === "cardio"
    ? { done: false, weight: null, reps: null, minutes: 20, km: null }
    : { done: false, weight: null, reps: 8, minutes: null, km: null };

export function newWorkout(date: string, title: string): Workout {
  return { file: "", date, title, status: "planned", started: null, finished: null, notes: "", exercises: [] };
}

/** A fresh copy of `source` for `date`: same exercises and weights, nothing ticked. */
export function planFrom(source: Workout, date: string, title = source.title): Workout {
  return {
    ...newWorkout(date, title),
    exercises: source.exercises.map((e) => ({ ...e, notes: "", sets: e.sets.map((s) => ({ ...s, done: false })) })),
  };
}

/** Kilograms lifted over ticked sets. */
export function volumeOf(w: Workout): number {
  return w.exercises
    .filter((e) => e.kind === "lift")
    .flatMap((e) => e.sets)
    .filter((s) => s.done && s.weight != null && s.reps != null)
    .reduce((a, s) => a + s.weight! * s.reps!, 0);
}

export function setCount(w: Workout): { done: number; total: number } {
  const sets = w.exercises.flatMap((e) => e.sets);
  return { done: sets.filter((s) => s.done).length, total: sets.length };
}

/** "62.5", "60": at most two decimals. */
export function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** "5,320". */
export function kg(n: number): string {
  return Math.round(n).toLocaleString("en-AU");
}

/** min/km for a cardio set, as "5:40". */
export function pace(minutes: number | null, km: number | null): string | null {
  if (!minutes || !km) return null;
  const per = minutes / km;
  const m = Math.floor(per);
  const s = Math.round((per - m) * 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- storage

export async function listWorkouts(): Promise<Workout[]> {
  if (isTauri()) return invoke<Workout[]>("forge_list");
  return demo.list();
}

export async function saveWorkout(workout: Workout): Promise<Workout> {
  if (isTauri()) return invoke<Workout>("forge_save", { workout });
  return demo.save(workout);
}

export async function deleteWorkout(file: string): Promise<void> {
  if (isTauri()) return invoke("forge_delete", { file });
  return demo.remove(file);
}

export async function listTemplates(): Promise<Workout[]> {
  if (isTauri()) return invoke<Workout[]>("forge_templates");
  return demo.templates();
}

export async function saveTemplate(workout: Workout): Promise<Workout> {
  if (isTauri()) return invoke<Workout>("forge_save_template", { workout });
  return demo.saveTemplate(workout);
}

export async function deleteTemplate(file: string): Promise<void> {
  if (isTauri()) return invoke("forge_delete_template", { file });
  return demo.removeTemplate(file);
}

export async function getForgeStats(): Promise<ForgeStats> {
  if (isTauri()) return invoke<ForgeStats>("forge_stats", { today: today() });
  return demoStats(await demo.list());
}

// ---------------------------------------------------------------- browser fallback

const WORKOUTS_KEY = "flesh-forge.demo.workouts";
const TEMPLATES_KEY = "flesh-forge.demo.templates";

function read(key: string): Workout[] | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Workout[]) : null;
  } catch {
    return null;
  }
}

function write(key: string, list: Workout[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage blocked: changes last until reload */
  }
}

const lifts = (name: string, sets: [number | null, number][], done = true): Exercise => ({
  name,
  kind: "lift",
  notes: "",
  sets: sets.map(([weight, reps]) => ({ done, weight, reps, minutes: null, km: null })),
});

function samples(): Workout[] {
  const t = today();
  const session = (ago: number, title: string, exercises: Exercise[]): Workout => ({
    ...newWorkout(shiftDate(t, -ago), title),
    file: `${shiftDate(t, -ago)} ${title}.md`,
    status: "done",
    started: "18:00",
    finished: "19:05",
    exercises,
  });
  const push = (bench: number, ago: number) =>
    session(ago, "Push", [
      lifts("Bench press", [[bench - 10, 8], [bench, 6], [bench, 6]]),
      lifts("Overhead press", [[30, 8], [32.5, 6]]),
      lifts("Dips", [[null, 12], [null, 10]]),
    ]);
  const legs = (squat: number, ago: number) =>
    session(ago, "Legs", [
      lifts("Squat", [[squat - 20, 8], [squat, 5], [squat, 5]]),
      { name: "Treadmill", kind: "cardio", notes: "", sets: [{ done: true, weight: null, reps: null, minutes: 20, km: 3.2 }] },
    ]);
  return [
    push(70, 40), legs(80, 38), push(70, 33), legs(85, 31), push(72.5, 26), legs(85, 24),
    push(72.5, 19), legs(90, 17), push(75, 12), legs(90, 10), push(75, 5), legs(95, 3),
  ];
}

const demo = {
  list(): Workout[] {
    let list = read(WORKOUTS_KEY);
    if (!list) {
      list = samples();
      write(WORKOUTS_KEY, list);
    }
    return [...list].sort((a, b) => b.date.localeCompare(a.date));
  },
  save(w: Workout): Workout {
    const list = demo.list();
    const saved = { ...w, file: w.file || `${w.date} ${w.title} ${Date.now()}.md` };
    write(WORKOUTS_KEY, [...list.filter((x) => x.file !== saved.file), saved]);
    void emitApp("forge-changed");
    return saved;
  },
  remove(file: string) {
    write(WORKOUTS_KEY, demo.list().filter((x) => x.file !== file));
    void emitApp("forge-changed");
  },
  templates(): Workout[] {
    return read(TEMPLATES_KEY) ?? [];
  },
  saveTemplate(w: Workout): Workout {
    const t = { ...planFrom(w, ""), file: `${w.title}.md` };
    write(TEMPLATES_KEY, [...demo.templates().filter((x) => x.file !== t.file), t]);
    void emitApp("forge-changed");
    return t;
  },
  removeTemplate(file: string) {
    write(TEMPLATES_KEY, demo.templates().filter((x) => x.file !== file));
    void emitApp("forge-changed");
  },
};

/** A simple version of the backend's numbers, for the browser preview only. */
function demoStats(workouts: Workout[]): ForgeStats {
  const t = today();
  const monday = (d: string) => shiftDate(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
  const thisWeek = monday(t);
  const visits = workouts
    .filter((w) => w.date <= t && (w.status === "done" || setCount(w).done > 0))
    .sort((a, b) => a.date.localeCompare(b.date));
  const days = [...new Set(visits.map((w) => w.date))];
  const weeks: WeekStat[] = Array.from({ length: 12 }, (_, i) => ({
    start: shiftDate(thisWeek, -7 * (11 - i)),
    visits: 0,
    volume: 0,
    cardioMinutes: 0,
    cardioKm: 0,
  }));
  const ex = new Map<string, ExerciseStat>();
  const records: ForgeRecord[] = [];
  for (const w of visits) {
    const week = weeks.find((x) => x.start === monday(w.date));
    for (const e of w.exercises) {
      const done = e.sets.filter((s) => s.done);
      if (!done.length) continue;
      const stat = ex.get(e.name.toLowerCase()) ?? { name: e.name, kind: e.kind, points: [], bestWeight: null, bestE1rm: null };
      const est = (s: WorkoutSet) => (s.weight ?? 0) * (1 + ((s.reps ?? 0) > 1 ? (s.reps ?? 0) / 30 : 0));
      const weighted = done.filter((s) => s.weight != null && s.reps);
      const top = weighted.length ? Math.max(...weighted.map((s) => s.weight!)) : null;
      const best = weighted.length ? weighted.reduce((a, b) => (est(b) > est(a) ? b : a)) : null;
      const point: ExercisePoint = {
        date: w.date,
        topWeight: top,
        bestE1rm: best ? est(best) : null,
        volume: weighted.reduce((a, s) => a + s.weight! * s.reps!, 0),
        minutes: done.reduce((a, s) => a + (s.minutes ?? 0), 0),
        km: done.reduce((a, s) => a + (s.km ?? 0), 0),
        summary:
          e.kind === "cardio"
            ? done.map((s) => `${fmt(s.minutes ?? 0)} min${s.km ? ` · ${fmt(s.km)} km` : ""}`).join(", ")
            : done.map((s) => `${s.weight == null ? "bw" : `${fmt(s.weight)} kg`} × ${s.reps ?? 0}`).join(", "),
      };
      if (best && point.bestE1rm != null && stat.bestE1rm != null && point.bestE1rm > stat.bestE1rm)
        records.push({ exercise: e.name, date: w.date, weight: best.weight!, reps: best.reps!, e1rm: point.bestE1rm });
      if (point.bestE1rm != null) stat.bestE1rm = Math.max(stat.bestE1rm ?? 0, point.bestE1rm);
      if (top != null) stat.bestWeight = Math.max(stat.bestWeight ?? 0, top);
      stat.points.push(point);
      ex.set(e.name.toLowerCase(), stat);
      if (week) {
        week.volume += point.volume;
        week.cardioMinutes += point.minutes;
        week.cardioKm += point.km;
      }
    }
  }
  for (const d of days) {
    const week = weeks.find((x) => x.start === monday(d));
    if (week) week.visits += 1;
  }
  let streak = 0;
  let cursor = days.some((d) => monday(d) === thisWeek) ? thisWeek : shiftDate(thisWeek, -7);
  while (days.some((d) => monday(d) === cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -7);
  }
  const titles = new Map<string, { title: string; date: string; file: string }>();
  for (const w of visits) titles.set(w.title.toLowerCase(), { title: w.title, date: w.date, file: w.file });
  return {
    totalVisits: days.length,
    lastVisit: days[days.length - 1] ?? null,
    visitsThisWeek: days.filter((d) => monday(d) === thisWeek).length,
    weekStreak: streak,
    weeks,
    visitDays: days.filter((d) => d >= weeks[0].start),
    exercises: [...ex.values()].sort((a, b) =>
      (b.points[b.points.length - 1]?.date ?? "").localeCompare(a.points[a.points.length - 1]?.date ?? ""),
    ),
    records: records.reverse().slice(0, 8),
    titles: [...titles.values()].sort((a, b) => b.date.localeCompare(a.date)),
  };
}
