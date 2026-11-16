import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteWorkout,
  emptySet,
  fmt,
  kg,
  newWorkout,
  pace,
  planFrom,
  saveTemplate,
  saveWorkout,
  setCount,
  shiftDate,
  volumeOf,
  type Exercise,
  type ExerciseKind,
  type ForgeStats,
  type Workout,
  type WorkoutSet,
} from "../lib/forge";
import { logToVault, nowTime, today } from "../lib/vaultLog";

type Props = {
  workouts: Workout[];
  templates: Workout[];
  stats: ForgeStats | null;
  date: string;
  onDate: (date: string) => void;
  /** Asks the parent to re-read the vault (after a delete, say). */
  onRefresh: () => void;
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Mon 16 Nov", plus "today" / "tomorrow" / "yesterday". */
function dayLabel(date: string): { main: string; rel: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const main = `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
  const t = today();
  const rel = date === t ? "today" : date === shiftDate(t, 1) ? "tomorrow" : date === shiftDate(t, -1) ? "yesterday" : "";
  return { main, rel };
}

function parseNum(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** A number box that lets you type "62." on the way to "62.5". */
function NumField({
  value,
  onChange,
  label,
  placeholder,
  integer,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  label: string;
  placeholder?: string;
  integer?: boolean;
}) {
  const [text, setText] = useState(value == null ? "" : fmt(value));
  useEffect(() => {
    if (parseNum(text) !== value) setText(value == null ? "" : fmt(value));
    // Only react to outside changes of the value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      className="term-input forge-num"
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseNum(e.target.value);
        onChange(n == null ? null : integer ? Math.round(n) : n);
      }}
    />
  );
}

/**
 * The Flesh-Forge planner: pick a day, start a workout (blank, from a
 * template, or by repeating the last one with that name), then add exercises
 * and sets. Every change is saved to the workout's note in the vault after a
 * short pause; ticks and status changes are saved at once.
 */
export default function Planner({ workouts, templates, stats, date, onDate, onRefresh }: Props) {
  const onDay = useMemo(() => workouts.filter((w) => w.date === date), [workouts, date]);
  const [file, setFile] = useState<string | null>(null);
  const [draft, setDraft] = useState<Workout | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [exName, setExName] = useState("");
  const [status, setStatus] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const latest = useRef<Workout | null>(null);
  const dirty = useRef(false);
  const saving = useRef(false);
  const timer = useRef(0);

  // ------------------------------------------------------------ saving
  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (saving.current) return;
    saving.current = true;
    try {
      while (dirty.current && latest.current) {
        dirty.current = false;
        const sent = latest.current;
        const saved = await saveWorkout(sent);
        // The backend names (and on a rename, moves) the file.
        if (latest.current && latest.current.file === sent.file) latest.current = { ...latest.current, file: saved.file };
        setDraft((prev) => (prev && prev.file === sent.file ? { ...prev, file: saved.file } : prev));
        setFile(saved.file);
        setStatus(`Inscribed · ${saved.file}`);
      }
    } catch (err) {
      setStatus(`The forge faltered: ${String(err)}`);
    } finally {
      saving.current = false;
    }
  }, []);

  /** Changes the open workout. `now` saves at once instead of after a pause. */
  function edit(change: (w: Workout) => Workout, now = false) {
    const current = latest.current;
    if (!current) return;
    const next = change(current);
    latest.current = next;
    setDraft(next);
    dirty.current = true;
    window.clearTimeout(timer.current);
    if (now) void flush();
    else timer.current = window.setTimeout(() => void flush(), 700);
  }

  // Save anything pending when leaving the day or the page.
  useEffect(
    () => () => {
      if (dirty.current) void flush();
    },
    [date, flush],
  );

  // A new day starts with its first workout.
  useEffect(() => setFile(null), [date]);

  // Pick which workout is open: `file` null = the day's first, "" = none (plan a
  // new one). The open workout follows the vault (another window may change it),
  // except while it has unsaved edits or was just created and isn't listed yet.
  useEffect(() => {
    const current = latest.current;
    if (current && current.date === date && (file == null || current.file === file)) {
      const busy = dirty.current || saving.current;
      const unlisted = !!current.file && !onDay.some((w) => w.file === current.file);
      if (busy || unlisted) return;
    }
    const chosen = file === "" ? null : (onDay.find((w) => w.file === file) ?? onDay[0] ?? null);
    latest.current = chosen;
    setDraft(chosen);
    if (chosen && chosen.file !== file) setFile(chosen.file);
  }, [onDay, file, date]);

  useEffect(() => {
    setConfirmDelete(false);
    setStatus("");
  }, [date, file]);

  /** Opens another workout (or the new-plan panel), saving the open one first. */
  function open(next: string) {
    if (dirty.current) void flush();
    setFile(next);
  }

  // ------------------------------------------------------------ starting a workout
  async function begin(w: Workout) {
    if (dirty.current) await flush();
    latest.current = w;
    setDraft(w);
    setFile(null);
    dirty.current = true;
    await flush();
    setNewTitle("");
  }

  /** The most recent workout called `title`, before this day. */
  function lastTitled(title: string): Workout | undefined {
    return workouts
      .filter((w) => w.title.toLowerCase() === title.toLowerCase() && w.date < date)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
  }

  const repeatable = (stats?.titles ?? []).filter((t) => t.date < date).slice(0, 6);
  const knownNames = useMemo(() => (stats?.exercises ?? []).map((e) => e.name), [stats]);

  // ------------------------------------------------------------ exercises
  /** The last time an exercise was trained before this workout's day. */
  function lastTime(name: string) {
    const stat = stats?.exercises.find((e) => e.name.toLowerCase() === name.trim().toLowerCase());
    return stat?.points.filter((p) => p.date < date).pop() ?? null;
  }

  /** Sets from the last workout with this exercise, unticked, to start from. */
  function lastSets(name: string): Exercise | null {
    for (const w of [...workouts].sort((a, b) => b.date.localeCompare(a.date))) {
      if (w.date >= date) continue;
      const e = w.exercises.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.sets.length);
      if (e) return e;
    }
    return null;
  }

  function addExercise(kind: ExerciseKind) {
    const name = exName.trim();
    if (!name) return;
    const known = stats?.exercises.find((e) => e.name.toLowerCase() === name.toLowerCase());
    const before = lastSets(name);
    const useKind = known?.kind ?? kind;
    const sets = before && before.kind === useKind ? before.sets.map((s) => ({ ...s, done: false })) : [emptySet(useKind)];
    edit((w) => ({ ...w, exercises: [...w.exercises, { name: known?.name ?? name, kind: useKind, notes: "", sets }] }));
    setExName("");
  }

  const editExercise = (i: number, change: (e: Exercise) => Exercise, now = false) =>
    edit((w) => ({ ...w, exercises: w.exercises.map((e, j) => (j === i ? change(e) : e)) }), now);

  const editSet = (i: number, k: number, change: Partial<WorkoutSet>, now = false) =>
    editExercise(i, (e) => ({ ...e, sets: e.sets.map((s, j) => (j === k ? { ...s, ...change } : s)) }), now);

  function moveExercise(i: number, by: number) {
    edit((w) => {
      const list = [...w.exercises];
      const j = i + by;
      if (j < 0 || j >= list.length) return w;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...w, exercises: list };
    }, true);
  }

  // ------------------------------------------------------------ status
  async function startSession() {
    edit((w) => ({ ...w, status: "active", started: w.started ?? nowTime() }), true);
    await logToVault("Flesh-Forge", "workout begun", latest.current?.title ?? "");
  }

  async function finishSession() {
    const current = latest.current;
    if (!current) return;
    // Finished without ticking anything: count the whole plan as done.
    const nothingTicked = setCount(current).done === 0;
    edit(
      (w) => ({
        ...w,
        status: "done",
        started: w.started ?? nowTime(),
        finished: nowTime(),
        exercises: nothingTicked ? w.exercises.map((e) => ({ ...e, sets: e.sets.map((s) => ({ ...s, done: true })) })) : w.exercises,
      }),
      true,
    );
    const done = latest.current!;
    const { done: sets } = setCount(done);
    const fields = ["workout done", done.title, `${sets} ${sets === 1 ? "set" : "sets"}`];
    if (volumeOf(done) > 0) fields.push(`${kg(volumeOf(done))} kg`);
    await logToVault("Flesh-Forge", ...fields);
    setStatus("+++ The flesh is tempered +++");
  }

  async function asTemplate() {
    if (!draft) return;
    try {
      const t = await saveTemplate(draft);
      setStatus(`Template saved · ${t.title}`);
    } catch (err) {
      setStatus(`Could not save the template: ${String(err)}`);
    }
  }

  async function remove() {
    if (!draft) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    window.clearTimeout(timer.current);
    dirty.current = false;
    try {
      if (draft.file) await deleteWorkout(draft.file);
      latest.current = null;
      setDraft(null);
      setFile("");
      setStatus("Workout struck from the record");
      onRefresh();
    } catch (err) {
      setStatus(`Could not delete it: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------ view
  const label = dayLabel(date);
  const counts = draft ? setCount(draft) : { done: 0, total: 0 };
  const volume = draft ? volumeOf(draft) : 0;

  return (
    <div className="forge">
      <datalist id="forge-exercises">
        {knownNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <section className="cogitator forge-panel forge-day" aria-label="Day">
        <button className="forge-step" onClick={() => onDate(shiftDate(date, -1))} aria-label="Previous day">
          ‹
        </button>
        <div className="forge-date">
          <span className="forge-date-main">{label.main}</span>
          <span className="forge-date-rel">{label.rel || date}</span>
        </div>
        <button className="forge-step" onClick={() => onDate(shiftDate(date, 1))} aria-label="Next day">
          ›
        </button>
        {date !== today() && (
          <button className="lib-toggle forge-today" onClick={() => onDate(today())}>
            Today
          </button>
        )}
      </section>

      {onDay.length > 0 && (
        <div className="chips forge-picks" role="group" aria-label="Workouts this day">
          {onDay.map((w) => (
            <button key={w.file} className={w.file === draft?.file ? "chip on" : "chip"} onClick={() => open(w.file)}>
              {w.title}
            </button>
          ))}
          {draft && (
            <button className="chip" onClick={() => open("")}>
              + Another
            </button>
          )}
        </div>
      )}

      {!draft ? (
        <section className="cogitator forge-panel" aria-label="Plan a workout">
          <p className="term-label">Forge a plan</p>
          <label className="term-field">
            <span className="term-label">Designation</span>
            <input
              className="term-input"
              value={newTitle}
              placeholder="push, legs, full body…"
              aria-label="Workout name"
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && newTitle.trim() && begin(newWorkout(date, newTitle.trim()))}
            />
          </label>
          <button className="dash-link" disabled={!newTitle.trim()} onClick={() => begin(newWorkout(date, newTitle.trim()))}>
            New workout
          </button>

          {repeatable.length > 0 && (
            <div className="forge-starts">
              <p className="term-label">Repeat last</p>
              <div className="chips">
                {repeatable.map((t) => (
                  <button
                    key={t.title}
                    className="chip"
                    title={`Copy ${t.title} from ${t.date}, weights included`}
                    onClick={() => {
                      const last = lastTitled(t.title);
                      if (last) void begin(planFrom(last, date));
                    }}
                  >
                    {t.title} <span className="chip-sub">{t.date.slice(5)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {templates.length > 0 && (
            <div className="forge-starts">
              <p className="term-label">From template</p>
              <div className="chips">
                {templates.map((t) => (
                  <button key={t.file} className="chip" onClick={() => begin(planFrom(t, date))}>
                    {t.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      ) : (
        <>
          <section className="cogitator forge-panel" aria-label="Workout">
            <div className="forge-head">
              <input
                className="term-input forge-title"
                value={draft.title}
                aria-label="Workout name"
                onChange={(e) => edit((w) => ({ ...w, title: e.target.value }))}
                onBlur={() => !draft.title.trim() && edit((w) => ({ ...w, title: "Workout" }), true)}
              />
              <span className={`forge-status forge-${draft.status}`}>{draft.status}</span>
            </div>
            <p className="forge-line">
              {pad(counts.done)}/{pad(counts.total)} sets
              {volume > 0 && ` · ${kg(volume)} kg`}
              {draft.started && ` · ${draft.started}`}
              {draft.finished && `–${draft.finished}`}
            </p>
            <div className="meter" aria-hidden="true">
              <span style={{ width: `${counts.total ? (counts.done / counts.total) * 100 : 0}%` }} />
            </div>
          </section>

          {draft.exercises.map((ex, i) => {
            const last = lastTime(ex.name);
            const cardio = ex.kind === "cardio";
            return (
              <section key={i} className="cogitator forge-panel forge-ex" aria-label={ex.name || "Exercise"}>
                <div className="forge-ex-head">
                  <input
                    className="term-input forge-ex-name"
                    value={ex.name}
                    list="forge-exercises"
                    aria-label="Exercise name"
                    onChange={(e) => editExercise(i, (x) => ({ ...x, name: e.target.value }))}
                  />
                  {cardio && <span className="forge-kind">cardio</span>}
                  <span className="forge-tools">
                    <button className="forge-tool" onClick={() => moveExercise(i, -1)} disabled={i === 0} aria-label="Move up">
                      ↑
                    </button>
                    <button
                      className="forge-tool"
                      onClick={() => moveExercise(i, 1)}
                      disabled={i === draft.exercises.length - 1}
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                    <button
                      className="forge-tool"
                      aria-label="Remove exercise"
                      onClick={() => edit((w) => ({ ...w, exercises: w.exercises.filter((_, j) => j !== i) }), true)}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                {last && (
                  <p className="forge-last">
                    last {last.date.slice(5)} · {last.summary}
                  </p>
                )}

                <ol className="forge-sets">
                  {ex.sets.map((s, k) => (
                    <li key={k} className={s.done ? "done" : ""}>
                      <label className="forge-tick">
                        <input type="checkbox" checked={s.done} onChange={() => editSet(i, k, { done: !s.done }, true)} />
                        <span className="rite-box" aria-hidden="true" />
                        <span className="idx">{pad(k + 1)}</span>
                      </label>
                      {cardio ? (
                        <>
                          <NumField value={s.minutes} label={`Set ${k + 1} minutes`} placeholder="0" onChange={(n) => editSet(i, k, { minutes: n })} />
                          <span className="forge-unit">min</span>
                          <NumField value={s.km} label={`Set ${k + 1} kilometres`} placeholder="–" onChange={(n) => editSet(i, k, { km: n })} />
                          <span className="forge-unit">km</span>
                          {pace(s.minutes, s.km) && <span className="forge-unit forge-pace">{pace(s.minutes, s.km)}/km</span>}
                        </>
                      ) : (
                        <>
                          <NumField value={s.weight} label={`Set ${k + 1} weight in kg`} placeholder="bw" onChange={(n) => editSet(i, k, { weight: n })} />
                          <span className="forge-unit">kg ×</span>
                          <NumField value={s.reps} label={`Set ${k + 1} reps`} placeholder="0" integer onChange={(n) => editSet(i, k, { reps: n })} />
                          <span className="forge-unit">reps</span>
                        </>
                      )}
                      <button
                        className="forge-tool forge-del-set"
                        aria-label={`Remove set ${k + 1}`}
                        onClick={() => editExercise(i, (x) => ({ ...x, sets: x.sets.filter((_, j) => j !== k) }), true)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ol>

                <div className="forge-ex-foot">
                  <button
                    className="lib-toggle"
                    onClick={() =>
                      editExercise(
                        i,
                        (x) => {
                          const prev = x.sets[x.sets.length - 1];
                          return { ...x, sets: [...x.sets, prev ? { ...prev, done: false } : emptySet(x.kind)] };
                        },
                        true,
                      )
                    }
                  >
                    + Set
                  </button>
                  <input
                    className="term-input forge-notes"
                    value={ex.notes}
                    placeholder="notes"
                    aria-label={`${ex.name} notes`}
                    onChange={(e) => editExercise(i, (x) => ({ ...x, notes: e.target.value }))}
                  />
                </div>
              </section>
            );
          })}

          <section className="cogitator forge-panel" aria-label="Add an exercise">
            <label className="term-field">
              <span className="term-label">Add exercise</span>
              <input
                className="term-input"
                value={exName}
                list="forge-exercises"
                placeholder="bench press, squat, treadmill…"
                aria-label="New exercise name"
                onChange={(e) => setExName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addExercise("lift")}
              />
            </label>
            <div className="chips">
              <button className="chip" disabled={!exName.trim()} onClick={() => addExercise("lift")}>
                + Sets &amp; reps
              </button>
              <button className="chip" disabled={!exName.trim()} onClick={() => addExercise("cardio")}>
                + Cardio
              </button>
            </div>
            <label className="term-field">
              <span className="term-label">Session notes</span>
              <textarea
                className="term-input term-area forge-session-notes"
                value={draft.notes}
                placeholder="how it went"
                aria-label="Session notes"
                onChange={(e) => edit((w) => ({ ...w, notes: e.target.value }))}
              />
            </label>
          </section>

          <p className="forge-status-line" role="status">
            {status || "+++ Every change is inscribed in the vault +++"}
          </p>

          <div className="keys forge-keys">
            {draft.status === "planned" && (
              <button className="key lit" onClick={startSession}>
                Begin
              </button>
            )}
            {draft.status === "active" && (
              <button className="key lit" onClick={finishSession}>
                Finish
              </button>
            )}
            {draft.status === "done" && (
              <button className="key" onClick={() => edit((w) => ({ ...w, status: "active", finished: null }), true)}>
                Reopen
              </button>
            )}
            <button className="key" onClick={asTemplate} title="Save these exercises as a reusable plan">
              Template
            </button>
            <button className={confirmDelete ? "key danger" : "key"} onClick={remove}>
              {confirmDelete ? "Confirm" : "Delete"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
