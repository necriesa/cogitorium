import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logToVault, today } from "../lib/vaultLog";
import { breakDown, fileNameFor, fromMarkdown, toMarkdown, type Scroll } from "../lib/scroll";
import {
  cachedOpenScroll,
  listScrolls,
  loadScroll,
  openScroll,
  rememberOpenScroll,
  restoreOpenScroll,
  saveScroll,
  scrollLibrary,
} from "../lib/scrollStore";
import type { ScrollStat } from "../lib/stats";
import { emitApp, onApp } from "../lib/events";

const pad = (n: number) => String(n).padStart(2, "0");

/** Unfinished scrolls first (most recently touched first), then finished ones. */
function libraryOrder(list: ScrollStat[]): ScrollStat[] {
  const idle = (s: ScrollStat) => s.idleDays ?? Number.MAX_SAFE_INTEGER;
  return [...list].sort(
    (a, b) =>
      Number(a.status === "complete") - Number(b.status === "complete") || idle(a) - idle(b) || a.title.localeCompare(b.title),
  );
}

/** "02/05 · idle 3d", "04/04 · complete". */
function scrollMeta(s: ScrollStat): string {
  const when =
    s.status === "complete" ? "complete" : s.idleDays == null ? "" : s.idleDays === 0 ? "today" : `idle ${s.idleDays}d`;
  return [`${pad(s.done)}/${pad(s.total)}`, when].filter(Boolean).join(" · ");
}

const bare = (file: string) => file.replace(/\.md$/, "");

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

/**
 * Data Stylus, presented as a data slate: an iron handheld casing around a
 * green cogitator screen, with rune keys underneath. Paste a task (prose or
 * bullets), the slate breaks it into subtasks, and the scroll is kept as a
 * Markdown checklist in the vault.
 * Ticks here update the note; ticks made in Obsidian come back when the
 * window is focused. The open scroll is shared between the main app and a
 * popped-out widget through the "scroll-changed" event, and remembered in
 * settings.json so it reopens after a restart. The Archive key lists every
 * scroll in the vault (checklists written by hand in Obsidian too), so any
 * earlier task can be picked up again.
 */
export default function DataStylus() {
  const [scroll, setScroll] = useState<Scroll | null>(cachedOpenScroll);
  const [taskName, setTaskName] = useState("");
  const [draft, setDraft] = useState("");
  const [library, setLibrary] = useState<ScrollStat[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [seek, setSeek] = useState("");
  const [showComplete, setShowComplete] = useState(false);
  const [status, setStatus] = useState("");
  const [writing, setWriting] = useState(false);
  const writeTimer = useRef(0);

  const preview = useMemo(() => (draft.trim() ? breakDown(draft, taskName) : null), [draft, taskName]);

  // On launch, reopen the scroll that was open last time, re-read from the vault.
  useEffect(() => {
    restoreOpenScroll()
      .then((restored) => setScroll((prev) => (JSON.stringify(prev) === JSON.stringify(restored) ? prev : restored)))
      .catch((err) => setStatus(`Could not reopen the scroll: ${String(err)}`));
  }, []);

  // Pull in ticks made in Obsidian whenever the window gains focus.
  const refreshFromVault = useCallback(async () => {
    const current = cachedOpenScroll();
    if (!current) return;
    try {
      const text = await loadScroll(current.file);
      if (text == null) {
        // Deleted or renamed in Obsidian.
        await rememberOpenScroll(null);
        setScroll((prev) => (prev?.file === current.file ? null : prev));
        setStatus(`Scroll gone from the vault: ${bare(current.file)}`);
        return;
      }
      const fresh = fromMarkdown(text, current.file, current.created);
      setScroll((prev) => (prev && prev.file === fresh.file && JSON.stringify(prev) !== JSON.stringify(fresh) ? fresh : prev));
    } catch (err) {
      setStatus(`Could not read the scroll: ${String(err)}`);
    }
  }, []);

  const loadLibrary = useCallback(() => {
    scrollLibrary()
      .then((list) => setLibrary(libraryOrder(list)))
      .catch((err) => {
        setLibrary([]);
        setStatus(`Could not read the archive: ${String(err)}`);
      });
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      refreshFromVault();
      loadLibrary();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refreshFromVault, loadLibrary]);

  // The resume list (empty slate) and the archive both show the vault's scrolls.
  const openFile = scroll?.file;
  useEffect(() => {
    if (!openFile || browsing) loadLibrary();
  }, [openFile, browsing, loadLibrary]);

  // Another window opened, changed or closed the scroll.
  useEffect(() => onApp<Scroll | null>("scroll-changed", (next) => setScroll(next ?? null)), []);

  /** Shows `next` here and in every other window, and remembers it for the next launch. */
  function show(next: Scroll | null) {
    setScroll(next);
    void emitApp("scroll-changed", next);
    rememberOpenScroll(next).catch((err) => setStatus(`Could not remember the scroll: ${String(err)}`));
  }

  function scratch() {
    window.clearTimeout(writeTimer.current);
    setWriting(true);
    writeTimer.current = window.setTimeout(() => setWriting(false), 1100);
  }

  async function persist(next: Scroll, ...logFields: string[]) {
    scratch();
    show(next);
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

  /** Opens an earlier scroll from the vault, to carry on with it. */
  async function unroll(file: string) {
    try {
      const opened = await openScroll(file);
      if (!opened) {
        setStatus(`Scroll gone from the vault: ${bare(file)}`);
        loadLibrary();
        return;
      }
      setScroll(opened);
      setBrowsing(false);
      setSeek("");
      setStatus(`Unrolled · Scrolls/${file}`);
    } catch (err) {
      setStatus(`Could not unroll the scroll: ${String(err)}`);
    }
  }

  const done = scroll?.items.filter((i) => i.done).length ?? 0;
  const total = scroll?.items.length ?? 0;
  const complete = !!scroll && total > 0 && done === total;
  const footer =
    writing ? "Inscribing" : status || (browsing ? "Select a scroll" : scroll ? "Scriptor ready" : "Awaiting dictation");

  const unfinished = library.filter((s) => s.status !== "complete");
  const finishedCount = library.length - unfinished.length;
  const query = seek.trim().toLowerCase();
  // A search looks through finished scrolls too.
  const shown = library.filter(
    (s) =>
      (showComplete || !!query || s.status !== "complete") &&
      (!query || s.title.toLowerCase().includes(query) || !!s.nextItem?.toLowerCase().includes(query)),
  );

  const headCount = browsing
    ? `${pad(library.length)} scrolls`
    : scroll
      ? `${pad(done)}/${pad(total)}`
      : preview
        ? `${pad(preview.items.length)} parsed`
        : "--";

  return (
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
          <span>{browsing ? "Archive" : scroll ? "Scroll" : "Dictation"}</span>
          <span>{headCount}</span>
        </header>

        <div className="screen-body">
          {browsing ? (
            <>
              <label className="term-field">
                <span className="term-label">Seek</span>
                <input
                  className="term-input"
                  value={seek}
                  onChange={(e) => setSeek(e.target.value)}
                  placeholder="title or next rite"
                  aria-label="Filter scrolls"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && shown.length === 1) unroll(shown[0].file);
                    if (e.key === "Escape") setBrowsing(false);
                  }}
                />
              </label>
              {shown.length === 0 ? (
                <p className="term-label">
                  {library.length === 0 ? "No scrolls in the vault yet" : query ? "No scroll matches" : "Every scroll is complete"}
                </p>
              ) : (
                <ul className="library" aria-label="Scrolls in the vault">
                  {shown.map((s) => {
                    const isOpen = s.file === scroll?.file;
                    return (
                      <li key={s.file}>
                        <button
                          className={`library-entry lib-${s.status}${isOpen ? " lib-open" : ""}`}
                          onClick={() => unroll(s.file)}
                          title={s.updated ? `Last changed ${s.updated}` : undefined}
                          aria-current={isOpen ? "true" : undefined}
                        >
                          <span className="lib-title">{s.title}</span>
                          <span className="lib-meta">
                            {scrollMeta(s)}
                            {isOpen && " · open"}
                          </span>
                          {s.status !== "complete" && s.nextItem && <span className="lib-next">next: {s.nextItem}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {finishedCount > 0 && !query && (
                <button className="lib-toggle" aria-pressed={showComplete} onClick={() => setShowComplete((v) => !v)}>
                  {showComplete ? "Hide" : "Show"} {finishedCount} complete
                </button>
              )}
            </>
          ) : !scroll ? (
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
              {!preview && unfinished.length > 0 && (
                <div className="archive">
                  <p className="term-label">Resume</p>
                  {unfinished.slice(0, 4).map((s) => (
                    <button key={s.file} className="archive-entry" onClick={() => unroll(s.file)}>
                      {s.title}
                      <span className="archive-meta"> · {scrollMeta(s)}</span>
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
        {browsing ? (
          <button className="key" onClick={() => setBrowsing(false)}>
            Return
          </button>
        ) : (
          <>
            <button className="key" onClick={() => setBrowsing(true)} title="Every scroll in the vault">
              Archive
            </button>
            {!scroll ? (
              <button className="key lit" onClick={seal} disabled={!preview || preview.items.length === 0}>
                Seal
              </button>
            ) : (
              <button className="key" onClick={() => show(null)}>
                New
              </button>
            )}
          </>
        )}
      </div>
    </main>
  );
}
