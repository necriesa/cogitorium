import { useState } from "react";
import {
  deleteTemplate,
  fmt,
  newWorkout,
  saveLibrary,
  saveTemplate,
  setsFromTarget,
  setText,
  KIND_LABEL,
  KINDS,
  type Exercise,
  type ExerciseKind,
  type LibraryEntry,
  type Workout,
} from "../lib/forge";
import { GroupChips, useLibraryFilter } from "./LibraryPicker";

type Props = { library: LibraryEntry[]; templates: Workout[]; onChanged: () => void };

const blank: LibraryEntry = { name: "", kind: "lift", group: "", target: "", rest: "", notes: "" };

/** A template exercise in short: "4 × 6", "3 × max @ 20 kg", "3 × 45 s", "3 × 30 m", "35 min". */
function planText(e: Exercise): string {
  const s = e.sets[0];
  if (!s) return "";
  const n = e.sets.length;
  if (e.kind === "cardio") return setText("cardio", s);
  const each = e.kind === "lift" ? `${s.reps ?? "max"}${s.weight != null ? ` @ ${fmt(s.weight)} kg` : ""}` : setText(e.kind, s);
  return `${n} × ${each}`;
}

/** The fields of one library exercise, for adding or editing. */
function EntryForm({
  initial,
  groups,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: LibraryEntry;
  groups: string[];
  onSave: (e: LibraryEntry) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [e, setE] = useState(initial);
  const [confirm, setConfirm] = useState(false);
  const field = (key: keyof LibraryEntry, label: string, placeholder: string, list?: string) => (
    <label className="term-field">
      <span className="term-label">{label}</span>
      <input
        className="term-input"
        value={e[key]}
        placeholder={placeholder}
        list={list}
        aria-label={label}
        onChange={(ev) => setE({ ...e, [key]: ev.target.value })}
      />
    </label>
  );
  return (
    <form
      className="forge-entry-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (e.name.trim()) onSave({ ...e, name: e.name.trim(), group: e.group.trim() || "Other" });
      }}
    >
      {field("name", "Exercise", "e.g. Bulgarian split squat")}
      <div className="term-field">
        <span className="term-label">Type</span>
        <div className="chips" role="group" aria-label="Type">
          {KINDS.map((k) => (
            <button type="button" key={k} className={e.kind === k ? "chip on" : "chip"} aria-pressed={e.kind === k} onClick={() => setE({ ...e, kind: k as ExerciseKind })}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>
      <datalist id="forge-groups">
        {groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      {field("group", "Group", "Lower body, Push, Core…", "forge-groups")}
      {field("target", "Target", e.kind === "hold" ? "3 × 45s" : e.kind === "carry" ? "3 × 30-40m" : e.kind === "cardio" ? "35-45 min" : "4 × 6-8")}
      {field("rest", "Rest", "90 s")}
      {field("notes", "Notes", "per leg, machine, cues…")}
      <div className="chips forge-form-keys">
        <button type="submit" className="chip on" disabled={!e.name.trim()}>
          Save
        </button>
        <button type="button" className="chip" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button type="button" className={confirm ? "chip danger" : "chip"} onClick={() => (confirm ? onDelete() : setConfirm(true))}>
            {confirm ? "Confirm delete" : "Delete"}
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * The Flesh-Forge library: every exercise you can pick from (kept in the vault
 * note `Flesh-Forge/Exercise Library.md`), with a template builder: tick
 * exercises in the order you want them, name the template, and make it.
 */
export default function ForgeLibrary({ library, templates, onChanged }: Props) {
  const { query, setQuery, group, setGroup, groups, shown } = useLibraryFilter(library);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [status, setStatus] = useState("");
  const [confirmTemplate, setConfirmTemplate] = useState<string | null>(null);

  async function store(next: LibraryEntry[], message: string) {
    try {
      await saveLibrary(next);
      setStatus(message);
      onChanged();
    } catch (err) {
      setStatus(`Could not save the library: ${String(err)}`);
    }
  }

  function toggle(name: string) {
    setPicked((p) => (p.includes(name) ? p.filter((n) => n !== name) : [...p, name]));
  }

  async function makeTemplate() {
    const name = templateName.trim();
    if (!name || picked.length === 0) return;
    const exercises = picked
      .map((n) => library.find((e) => e.name === n))
      .filter((e): e is LibraryEntry => !!e)
      .map((e) => ({ name: e.name, kind: e.kind, notes: "", sets: setsFromTarget(e.kind, e.target) }));
    try {
      const t = await saveTemplate({ ...newWorkout("", name), exercises });
      setStatus(`Template saved · ${t.title} · ${exercises.length} exercises`);
      setPicked([]);
      setTemplateName("");
      onChanged();
    } catch (err) {
      setStatus(`Could not save the template: ${String(err)}`);
    }
  }

  async function removeTemplate(t: Workout) {
    if (confirmTemplate !== t.file) {
      setConfirmTemplate(t.file);
      return;
    }
    try {
      await deleteTemplate(t.file);
      setStatus(`Template deleted · ${t.title}`);
      setConfirmTemplate(null);
      onChanged();
    } catch (err) {
      setStatus(`Could not delete it: ${String(err)}`);
    }
  }

  return (
    <div className="forge">
      <section className="cogitator forge-panel" aria-label="Exercise library">
        <div className="forge-head">
          <p className="term-label forge-grow">Exercise library · {library.length}</p>
          {!adding && (
            <button className="lib-toggle" onClick={() => setAdding(true)}>
              + New exercise
            </button>
          )}
        </div>
        {adding && (
          <EntryForm
            initial={{ ...blank, group: group ?? "" }}
            groups={groups}
            onCancel={() => setAdding(false)}
            onSave={(e) => {
              setAdding(false);
              void store([...library, e], `Added · ${e.name}`);
            }}
          />
        )}
        <input
          className="term-input"
          value={query}
          placeholder="search exercises"
          aria-label="Search exercises"
          onChange={(e) => setQuery(e.target.value)}
        />
        <GroupChips groups={groups} group={group} setGroup={setGroup} />
        <p className="forge-line">Tick exercises in order to build a template.</p>

        {library.length === 0 && <p className="dash-empty">No exercises yet. Add one, or write them into the library note in the vault.</p>}
        {shown.map((g) => (
          <div key={g.group}>
            <p className="term-label forge-group-label">{g.group}</p>
            <ul className="forge-lib-list">
              {g.entries.map((e) => {
                const order = picked.indexOf(e.name);
                return (
                  <li key={e.name}>
                    {editing === e.name ? (
                      <EntryForm
                        initial={e}
                        groups={groups}
                        onCancel={() => setEditing(null)}
                        onDelete={() => {
                          setEditing(null);
                          setPicked((p) => p.filter((n) => n !== e.name));
                          void store(
                            library.filter((x) => x.name !== e.name),
                            `Deleted · ${e.name}`,
                          );
                        }}
                        onSave={(next) => {
                          setEditing(null);
                          setPicked((p) => p.map((n) => (n === e.name ? next.name : n)));
                          void store(
                            library.map((x) => (x.name === e.name ? next : x)),
                            `Saved · ${next.name}`,
                          );
                        }}
                      />
                    ) : (
                      <div className={order >= 0 ? "forge-lib-row picked" : "forge-lib-row"}>
                        <label className="forge-tick">
                          <input type="checkbox" checked={order >= 0} onChange={() => toggle(e.name)} aria-label={`Add ${e.name} to the template`} />
                          <span className="rite-box" aria-hidden="true" />
                          <span className="idx">{order >= 0 ? String(order + 1).padStart(2, "0") : "··"}</span>
                        </label>
                        <div className="forge-lib-text">
                          <span className="lib-title-plain">{e.name}</span>
                          <span className="lib-meta">
                            {[e.target, e.rest && `rest ${e.rest}`, e.kind !== "lift" && KIND_LABEL[e.kind].toLowerCase()].filter(Boolean).join(" · ")}
                          </span>
                          {e.notes && <span className="lib-next">{e.notes}</span>}
                        </div>
                        <button className="forge-tool forge-edit" aria-label={`Edit ${e.name}`} onClick={() => setEditing(e.name)}>
                          ✎
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      {picked.length > 0 && (
        <section className="cogitator forge-panel forge-builder" aria-label="New template">
          <p className="term-label">New template · {picked.length} exercises</p>
          <p className="forge-line">{picked.join(" → ")}</p>
          <label className="term-field">
            <span className="term-label">Name</span>
            <input
              className="term-input"
              value={templateName}
              placeholder="Mon · Lower body + core"
              aria-label="Template name"
              onChange={(e) => setTemplateName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && makeTemplate()}
            />
          </label>
          <div className="chips">
            <button className="chip on" disabled={!templateName.trim()} onClick={makeTemplate}>
              Make template
            </button>
            <button className="chip" onClick={() => setPicked([])}>
              Clear
            </button>
          </div>
        </section>
      )}

      <section className="cogitator forge-panel" aria-label="Templates">
        <p className="term-label">Templates · {templates.length}</p>
        {templates.length === 0 ? (
          <p className="dash-empty">No templates yet. Tick exercises above, or use Template on a workout in the planner.</p>
        ) : (
          <ul className="forge-lib-list">
            {templates.map((t) => (
              <li key={t.file}>
                <div className="forge-lib-row">
                  <div className="forge-lib-text">
                    <span className="lib-title-plain">{t.title}</span>
                    <span className="lib-next">{t.exercises.map((e) => `${e.name} ${planText(e)}`).join(" · ")}</span>
                  </div>
                  <button className={confirmTemplate === t.file ? "chip danger" : "chip"} onClick={() => removeTemplate(t)}>
                    {confirmTemplate === t.file ? "Confirm" : "Delete"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {status && (
        <p className="forge-status-line" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
