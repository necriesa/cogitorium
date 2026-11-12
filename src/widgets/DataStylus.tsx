import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TitleBar from "../components/TitleBar";
import { StylusIcon } from "../components/Icons";
import { SigilDefs } from "../components/Sigils";
import { logToVault, today } from "../lib/vaultLog";
import { breakDown, fileNameFor, fromMarkdown, toMarkdown, type Scroll } from "../lib/scroll";
import { listScrolls, loadScroll, saveScroll } from "../lib/scrollStore";

// Storage keys keep the widget's pre-0.3 name (Auto Quill) so an open scroll survives the rename.
const ACTIVE_KEY = "auto-quill.active";

/** A red wax purity seal, stuck on the slate's casing. */
function WaxSeal() {
  return (
    <svg className="seal" viewBox="0 0 28 28" aria-hidden="true">
      <path
        d="M14 1.5 17 3.6 20.6 3.4 22 6.8 25.3 8.6 24.6 12.2 26.5 15.4 24.2 18.2 24.2 21.8 20.7 22.9 18.8 26 15.2 25.2 12 27 9.4 24.5 5.8 24.1 5 20.6 2.1 18.4 3.2 15 2 11.6 4.7 9.1 5.2 5.5 8.8 4.9 11 2Z"
        fill="url(#wax)"
      />
      <circle cx="14" cy="14" r="8" fill="none" stroke="#5a0b0a" strokeWidth="0.8" opacity="0.7" />
      <use href="#skull" x="9" y="8.5" width="10" height="11" opacity="0.55" />
    </svg>
  );
}

function readActive(): Scroll | null {
  try {
    const saved = localStorage.getItem(ACTIVE_KEY);
    return saved ? (JSON.parse(saved) as Scroll) : null;
  } catch {
    return null;
  }
}

/**
 * Data Stylus, presented as a data slate: an iron handheld casing around a
 * green cogitator screen, with rune keys underneath. Paste a task (prose or
 * bullets), the slate breaks it into subtasks, and the scroll is kept as a
 * Markdown checklist in the vault.
 * Ticks here update the note; ticks made in Obsidian come back when the
 * widget is focused.
 */
export default function DataStylus() {
  const [scroll, setScroll] = useState<Scroll | null>(readActive);
  const [taskName, setTaskName] = useState("");
  const [draft, setDraft] = useState("");
  const [earlier, setEarlier] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [writing, setWriting] = useState(false);
  const writeTimer = useRef(0);

  const preview = useMemo(() => (draft.trim() ? breakDown(draft, taskName) : null), [draft, taskName]);

  // Remember which scroll is open (per-machine convenience; the vault note is the record).
  useEffect(() => {
    try {
      if (scroll) localStorage.setItem(ACTIVE_KEY, JSON.stringify(scroll));
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* ignore */
    }
  }, [scroll]);

  // Pull in ticks made in Obsidian: re-read the note on load and whenever the window gains focus.
  const refreshFromVault = useCallback(async () => {
    const current = readActive();
    if (!current) return;
    try {
      const text = await loadScroll(current.file);
      if (text == null) return;
      const fresh = fromMarkdown(text, current.file, current.created);
      setScroll((prev) => (prev && prev.file === fresh.file && JSON.stringify(prev) !== JSON.stringify(fresh) ? fresh : prev));
    } catch (err) {
      setStatus(`Could not read the scroll: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    refreshFromVault();
    if (!isTauri()) return;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) refreshFromVault();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refreshFromVault]);

  useEffect(() => {
    if (!scroll) listScrolls().then(setEarlier).catch(() => setEarlier([]));
  }, [scroll]);

  function scratch() {
    window.clearTimeout(writeTimer.current);
    setWriting(true);
    writeTimer.current = window.setTimeout(() => setWriting(false), 1100);
  }

  async function persist(next: Scroll, ...logFields: string[]) {
    scratch();
    setScroll(next);
    try {
      await saveScroll(next.file, toMarkdown(next));
      await logToVault("Data Stylus", ...logFields);
      setStatus(`Inscribed · Scrolls/${next.file}`);
    } catch (err) {
      setStatus(`The quill faltered: ${String(err)}`);
    }
  }

  async function seal() {
    if (!preview || preview.items.length === 0) return;
    // Don't overwrite an existing scroll with the same name.
    const taken = new Set(await listScrolls().catch(() => [] as string[]));
    let file = fileNameFor(preview.title);
    for (let n = 2; taken.has(file); n++) file = fileNameFor(`${preview.title} ${n}`);
    const next: Scroll = { ...preview, file, created: today() };
    setDraft("");
    setTaskName("");
    await persist(next, "task begun", next.title, `${next.items.length} subtasks`);
  }

  async function toggle(index: number) {
    if (!scroll) return;
    const item = scroll.items[index];
    const items = scroll.items.map((it, i) => (i === index ? { ...it, done: !it.done } : it));
    await persist({ ...scroll, items }, item.done ? "reopened" : "completed", item.text, scroll.title);
  }

  async function unroll(file: string) {
    const text = await loadScroll(file);
    if (text != null) setScroll(fromMarkdown(text, file, today()));
  }

  const done = scroll?.items.filter((i) => i.done).length ?? 0;
  const total = scroll?.items.length ?? 0;
  const complete = !!scroll && total > 0 && done === total;
  const footer = writing ? "Inscribing" : status || (scroll ? "Scriptor ready" : "Awaiting dictation");
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <div className="widget">
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <SigilDefs />
      </svg>
      <TitleBar title="Data Stylus" icon={<StylusIcon size={14} />} />
      <main className="slate">
        {/* casing top: speaker grille, activity lamp, maker's plate, purity seal */}
        <div className="slate-top">
          <span className="grille" aria-hidden="true" />
          <span className={writing ? "lamp busy" : "lamp"} aria-hidden="true" />
          <span className="slate-plate">Data-slate · Scriptorum</span>
          <span className="casing-seal" aria-hidden="true">
            <WaxSeal />
          </span>
        </div>

        <section className="cogitator screen">
          <header className="screen-head">
            <span>{scroll ? "Scroll" : "Dictation"}</span>
            <span>{scroll ? `${pad(done)}/${pad(total)}` : preview ? `${pad(preview.items.length)} parsed` : "--"}</span>
          </header>

          <div className="screen-body">
            {!scroll ? (
              <>
                <label className="term-field">
                  <span className="term-label">Designation</span>
                  <input
                    className="term-input"
                    value={taskName}
                    onChange={(e) => setTaskName(e.target.value)}
                    placeholder="task name (optional)"
                    aria-label="Task name"
                  />
                </label>
                <label className="term-field">
                  <span className="term-label">Dictate</span>
                  <textarea
                    className="term-input term-area"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={"> paste the task. prose is split into steps; bullet lists are kept."}
                    aria-label="Task text"
                  />
                </label>
                {preview && preview.items.length > 0 && (
                  <div className="parsed">
                    <p className="term-label">Parsed · {preview.title}</p>
                    <ol>
                      {preview.items.map((it, i) => (
                        <li key={i} style={{ paddingLeft: it.depth * 16 }}>
                          <span className="idx">{pad(i + 1)}</span>
                          {it.text}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {!preview && earlier.length > 0 && (
                  <div className="archive">
                    <p className="term-label">Archive</p>
                    {earlier.slice(0, 6).map((f) => (
                      <button key={f} className="archive-entry" onClick={() => unroll(f)}>
                        {f.replace(/\.md$/, "")}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <h1 className="slate-title">{scroll.title}</h1>
                <div className="meter" aria-hidden="true">
                  <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
                </div>
                <ol className="rites">
                  {scroll.items.map((item, i) => (
                    <li key={i} className={item.done ? "done" : ""} style={{ paddingLeft: item.depth * 18 }}>
                      <label>
                        <input type="checkbox" checked={item.done} onChange={() => toggle(i)} />
                        <span className="rite-box" aria-hidden="true" />
                        <span className="rite-text">{item.text}</span>
                      </label>
                    </li>
                  ))}
                </ol>
                {complete && <p className="complete">+++ Rites complete +++</p>}
              </>
            )}
          </div>

          <footer className={writing ? "screen-foot writing" : "screen-foot"}>
            <span>+++</span>
            <span className="foot-text">{footer}</span>
            <span>+++</span>
          </footer>
        </section>

        {/* rune keys */}
        <div className="keys">
          {!scroll ? (
            <button className="key lit" onClick={seal} disabled={!preview || preview.items.length === 0}>
              Seal
            </button>
          ) : (
            <button className="key" onClick={() => setScroll(null)}>
              New
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
