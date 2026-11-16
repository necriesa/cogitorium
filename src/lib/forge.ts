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
  /** Lift reps; null = as many as you can (max). */
  reps: number | null;
  minutes: number | null;
  km: number | null;
  /** Hold time; null = as long as you can (max). */
  seconds: number | null;
  /** Carry distance. */
  metres: number | null;
};
/** How a set is measured: kg × reps, a timed hold, a loaded carry, or cardio time and distance. */
export type ExerciseKind = "lift" | "hold" | "carry" | "cardio";
export const KINDS: ExerciseKind[] = ["lift", "hold", "carry", "cardio"];
export const KIND_LABEL: Record<ExerciseKind, string> = { lift: "Sets & reps", hold: "Hold", carry: "Carry", cardio: "Cardio" };

/** One exercise in the library note (`Flesh-Forge/Exercise Library.md`). */
export type LibraryEntry = {
  name: string;
  kind: ExerciseKind;
  group: string;
  /** The usual prescription: "4 × 6-8", "3 × 45s", "3 × 30-40m", "35-45 min". */
  target: string;
  rest: string;
  notes: string;
};
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
  seconds: number;
  metres: number;
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

const blankSet: WorkoutSet = { done: false, weight: null, reps: null, minutes: null, km: null, seconds: null, metres: null };

export function emptySet(kind: ExerciseKind): WorkoutSet {
  if (kind === "cardio") return { ...blankSet, minutes: 20 };
  if (kind === "hold") return { ...blankSet, seconds: 30 };
  if (kind === "carry") return { ...blankSet, metres: 30 };
  return { ...blankSet, reps: 8 };
}

/**
 * Starting sets from a library target, taking the low end of a range so
 * there's room to progress: "4 × 6-8" → four sets of 6, "3 × max" → three
 * max sets, "3 × 30-45s" → three 30 s holds, "3 × 30-40m" → three 30 m
 * carries, "35-45 min" → one 35 min session. Anything unreadable gives one
 * default set.
 */
export function setsFromTarget(kind: ExerciseKind, target: string): WorkoutSet[] {
  const t = target.toLowerCase().replace(/[×*]/g, "x");
  const m = t.match(/^\s*(\d+)\s*x\s*(.*)$/);
  const count = m ? Math.min(12, Math.max(1, Number(m[1]))) : 1;
  const rest = m ? m[2] : t;
  const first = rest.match(/(\d+(?:[.,]\d+)?)/);
  const n = first ? Number(first[1].replace(",", ".")) : null;
  const max = /max|amrap/.test(rest);
  let set: WorkoutSet;
  if (kind === "cardio") {
    const km = rest.match(/(\d+(?:[.,]\d+)?)\s*km/);
    set = { ...blankSet, minutes: /min/.test(rest) ? n : km ? null : n, km: km ? Number(km[1].replace(",", ".")) : null };
    if (set.minutes == null && set.km == null) set = emptySet("cardio");
  } else if (kind === "hold") {
    set = { ...blankSet, seconds: max ? null : (n ?? 30) };
  } else if (kind === "carry") {
    set = { ...blankSet, metres: n ?? 30 };
  } else {
    set = { ...blankSet, reps: max ? null : n != null ? Math.round(n) : 8 };
  }
  return Array.from({ length: count }, () => ({ ...set }));
}

export function newWorkout(date: string, title: string): Workout {
  return { file: "", date, title, status: "planned", started: null, finished: null, notes: "", exercises: [] };
}

/** A fresh copy of `source` for `date`: same exercises and weights, nothing ticked. */
/**
 * `keepNotes` carries the notes over: wanted from a template (round and rest
 * instructions), not when repeating a past workout ("shoulder tight").
 */
export function planFrom(source: Workout, date: string, title = source.title, keepNotes = false): Workout {
  return {
    ...newWorkout(date, title),
    notes: keepNotes ? source.notes : "",
    exercises: source.exercises.map((e) => ({ ...e, notes: keepNotes ? e.notes : "", sets: e.sets.map((s) => ({ ...s, done: false })) })),
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

/** One set as text: "60 kg × 8", "bw × max", "45 s", "24 kg · 40 m", "20 min · 3 km". */
export function setText(kind: ExerciseKind, s: WorkoutSet): string {
  const kgPart = s.weight != null ? `${fmt(s.weight)} kg` : null;
  if (kind === "cardio") return [s.minutes != null && `${fmt(s.minutes)} min`, s.km != null && `${fmt(s.km)} km`].filter(Boolean).join(" · ") || "–";
  if (kind === "hold") return [kgPart, s.seconds != null ? `${fmt(s.seconds)} s` : "max hold"].filter(Boolean).join(" · ");
  if (kind === "carry") return [kgPart, `${fmt(s.metres ?? 0)} m`].filter(Boolean).join(" · ");
  return `${kgPart ?? "bw"} × ${s.reps ?? "max"}`;
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

export async function getLibrary(): Promise<LibraryEntry[]> {
  if (isTauri()) return invoke<LibraryEntry[]>("forge_library");
  return demo.library();
}

/** Replaces the whole library (the backend drops blank and repeated names). */
export async function saveLibrary(entries: LibraryEntry[]): Promise<LibraryEntry[]> {
  if (isTauri()) return invoke<LibraryEntry[]>("forge_save_library", { entries });
  return demo.saveLibrary(entries);
}

/** Groups in the order they first appear, each with its entries. */
export function libraryGroups(entries: LibraryEntry[]): { group: string; entries: LibraryEntry[] }[] {
  const out: { group: string; entries: LibraryEntry[] }[] = [];
  for (const e of entries) {
    const g = e.group.trim() || "Other";
    let bucket = out.find((x) => x.group === g);
    if (!bucket) out.push((bucket = { group: g, entries: [] }));
    bucket.entries.push(e);
  }
  return out;
}

export async function getForgeStats(): Promise<ForgeStats> {
  if (isTauri()) return invoke<ForgeStats>("forge_stats", { today: today() });
  return demoStats(await demo.list());
}

// ---------------------------------------------------------------- browser fallback

const WORKOUTS_KEY = "flesh-forge.demo.workouts";
const TEMPLATES_KEY = "flesh-forge.demo.templates";
const LIBRARY_KEY = "flesh-forge.demo.library";

const SAMPLE_LIBRARY: LibraryEntry[] = [
  { name: "Back squat", kind: "lift", group: "Lower body", target: "4 × 6-8", rest: "2 min", notes: "Or leg press" },
  { name: "Wall sit", kind: "hold", group: "Lower body", target: "4 × 30s", rest: "30 s", notes: "" },
  { name: "Bench press", kind: "lift", group: "Push", target: "4 × 6-8", rest: "2 min", notes: "Barbell or dumbbell" },
  { name: "Archer push-ups", kind: "lift", group: "Push", target: "3 × max", rest: "90 s", notes: "Stop 2 reps short of failure" },
  { name: "Farmer's carries", kind: "carry", group: "Grip and hangs", target: "3 × 30-40m", rest: "90 s", notes: "" },
  { name: "Dead hangs", kind: "hold", group: "Grip and hangs", target: "2 × max", rest: "90 s", notes: "" },
  { name: "Plank", kind: "hold", group: "Core", target: "3 × 45s", rest: "45 s", notes: "" },
  { name: "Zone 2 row", kind: "cardio", group: "Cardio and conditioning", target: "35-45 min", rest: "", notes: "Conversational pace" },
];

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
  sets: sets.map(([weight, reps]) => ({ ...blankSet, done, weight, reps })),
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
      { name: "Treadmill", kind: "cardio", notes: "", sets: [{ ...blankSet, done: true, minutes: 20, km: 3.2 }] },
      { name: "Plank", kind: "hold", notes: "", sets: [{ ...blankSet, done: true, seconds: 45 }, { ...blankSet, done: true, seconds: 40 }] },
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
    const t = { ...planFrom(w, "", w.title, true), file: `${w.title}.md` };
    write(TEMPLATES_KEY, [...demo.templates().filter((x) => x.file !== t.file), t]);
    void emitApp("forge-changed");
    return t;
  },
  removeTemplate(file: string) {
    write(TEMPLATES_KEY, demo.templates().filter((x) => x.file !== file));
    void emitApp("forge-changed");
  },
  library(): LibraryEntry[] {
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      return raw ? (JSON.parse(raw) as LibraryEntry[]) : SAMPLE_LIBRARY;
    } catch {
      return SAMPLE_LIBRARY;
    }
  },
  saveLibrary(entries: LibraryEntry[]): LibraryEntry[] {
    const seen = new Set<string>();
    const clean = entries
      .map((e) => ({ ...e, name: e.name.trim().replace(/\|/g, "/") }))
      .filter((e) => e.name && !seen.has(e.name.toLowerCase()) && seen.add(e.name.toLowerCase()));
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(clean));
    } catch {
      /* ignore */
    }
    void emitApp("forge-changed");
    return clean;
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
      const weighted = e.kind === "lift" ? done.filter((s) => s.weight != null && s.reps) : [];
      const loaded = e.kind === "cardio" ? [] : done.filter((s) => s.weight != null);
      const top = loaded.length ? Math.max(...loaded.map((s) => s.weight!)) : null;
      const best = weighted.length ? weighted.reduce((a, b) => (est(b) > est(a) ? b : a)) : null;
      const point: ExercisePoint = {
        date: w.date,
        topWeight: top,
        bestE1rm: best ? est(best) : null,
        volume: weighted.reduce((a, s) => a + s.weight! * s.reps!, 0),
        minutes: e.kind === "cardio" ? done.reduce((a, s) => a + (s.minutes ?? 0), 0) : 0,
        km: e.kind === "cardio" ? done.reduce((a, s) => a + (s.km ?? 0), 0) : 0,
        seconds: e.kind === "hold" ? Math.max(0, ...done.map((s) => s.seconds ?? 0)) : 0,
        metres: e.kind === "carry" ? done.reduce((a, s) => a + (s.metres ?? 0), 0) : 0,
        summary: done.map((s) => setText(e.kind, s)).join(", "),
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
