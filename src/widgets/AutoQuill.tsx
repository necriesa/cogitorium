import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TitleBar from "../components/TitleBar";
import { SigilDefs } from "../components/Sigils";
import { logToVault, today } from "../lib/vaultLog";
import { breakDown, fileNameFor, fromMarkdown, toMarkdown, type Scroll } from "../lib/scroll";
import { listScrolls, loadScroll, saveScroll } from "../lib/scrollStore";

const ACTIVE_KEY = "auto-quill.active";

/**
 * The auto-quill mechanism: a riveted brass housing with a Mechanicus cog,
 * an ink well, and an articulated arm holding a quill over the scroll.
 * `writing` makes the arm scratch for a moment.
 */
function Mechanism({ writing }: { writing: boolean }) {
  return (
    <svg className={writing ? "mechanism writing" : "mechanism"} viewBox="0 0 320 92" aria-hidden="true">
      <rect x="6" y="8" width="132" height="54" rx="6" fill="url(#brass)" stroke="#3b2a14" strokeWidth="1.2" />
      <rect x="14" y="16" width="116" height="38" rx="3" fill="#1a130b" stroke="#3b2a14" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={i} x={22 + i * 11} y="24" width="6" height="22" rx="2" fill="#2c2114" stroke="#5e4718" strokeWidth="0.6" />
      ))}
      <use href="#cog" x="92" y="19" width="32" height="32" className="cog-spin" />
      {[12, 132].flatMap((x) =>
        [12, 58].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="2" fill="#ffe3a0" stroke="#3b2a14" strokeWidth="0.5" />),
      )}
      <path d="M250 62h36l-4 22h-28Z" fill="#14100c" stroke="url(#brass)" strokeWidth="2" />
      <rect x="246" y="58" width="44" height="6" rx="2" fill="url(#brass)" stroke="#3b2a14" strokeWidth="0.6" />
      <g className="arm">
        <circle cx="138" cy="35" r="8" fill="url(#brass)" stroke="#3b2a14" />
        <rect x="136" y="31" width="64" height="8" rx="4" fill="url(#brass)" stroke="#3b2a14" transform="rotate(14 138 35)" />
        <g className="forearm">
          <circle cx="200" cy="50" r="6" fill="url(#brass)" stroke="#3b2a14" />
          <rect x="198" y="47" width="46" height="6" rx="3" fill="url(#brass)" stroke="#3b2a14" transform="rotate(32 200 50)" />
          <g transform="translate(238 74) rotate(-28)">
            <path d="M0 0C10-12 30-34 64-46C46-28 22-10 2 4Z" fill="#efe6d2" stroke="#6d6250" strokeWidth="0.7" />
            {[12, 22, 32, 42, 52].map((x) => (
              <path key={x} d={`M${x} ${-x * 0.62}l6 -7`} stroke="#a89f8a" strokeWidth="0.6" />
            ))}
            <path d="M2 4-10 14" stroke="#2b1d12" strokeWidth="2" strokeLinecap="round" />
          </g>
        </g>
      </g>
    </svg>
  );
}

/** A red wax purity seal stamped over a completed subtask. */
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
 * Auto Quill: paste a task (prose or bullets), the quill breaks it into
 * subtasks, and the scroll is kept as a Markdown checklist in the vault.
 * Ticks here update the note; ticks made in Obsidian come back when the
 * widget is focused.
 */
export default function AutoQuill() {
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
      await logToVault("Auto Quill", ...logFields);
      setStatus(`Inscribed in Scrolls/${next.file}`);
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

  return (
    <div className="widget auto-quill-widget">
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <SigilDefs />
      </svg>
      <TitleBar title="Auto Quill" sigil="✒" />
      <main className="body quill-body">
        <Mechanism writing={writing} />

        <div className="scroll">
          <div className="roller" />
          <div className="parchment-sheet">
            {!scroll ? (
              <>
                <input
                  className="scroll-title-input"
                  value={taskName}
                  onChange={(e) => setTaskName(e.target.value)}
                  placeholder="Task (optional)"
                  aria-label="Task name"
                />
                <textarea
                  className="dictation"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={"Paste the task. Prose is broken into steps; bullets stay as they are.\n\ne.g. Set up the UE5 project, then build the main menu in CommonUI. After that test gamepad navigation."}
                  aria-label="Task text"
                />
                {preview && preview.items.length > 0 && (
                  <div className="preview">
                    <p className="preview-head">
                      <span className="drop-cap small">{preview.title.charAt(0)}</span>
                      {preview.title.slice(1)} · {preview.items.length} subtasks
                    </p>
                    <ul>
                      {preview.items.map((it, i) => (
                        <li key={i} style={{ paddingLeft: it.depth * 14 }}>
                          {it.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!preview && earlier.length > 0 && (
                  <div className="earlier">
                    <p className="preview-head">Unroll an earlier scroll</p>
                    {earlier.slice(0, 6).map((f) => (
                      <button key={f} className="link" onClick={() => unroll(f)}>
                        {f.replace(/\.md$/, "")}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <h1 className="scroll-title">
                  <span className="drop-cap">{scroll.title.charAt(0)}</span>
                  {scroll.title.slice(1)}
                </h1>
                <ol className="rites">
                  {scroll.items.map((item, i) => (
                    <li key={i} className={item.done ? "done" : ""} style={{ marginLeft: item.depth * 18 }}>
                      <label>
                        <input type="checkbox" checked={item.done} onChange={() => toggle(i)} />
                        <span className="rite-mark">{item.done ? <WaxSeal /> : <span className="rite-box" />}</span>
                        <span className="rite-text">{item.text}</span>
                      </label>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
          <div className="roller" />
          {scroll && (
            <div className="ribbon" title={`${done} of ${total} subtasks complete`}>
              <span>
                {done} / {total}
              </span>
            </div>
          )}
        </div>

        <div className="row">
          {!scroll ? (
            <button className="primary" onClick={seal} disabled={!preview || preview.items.length === 0}>
              Seal the scroll
            </button>
          ) : (
            <button className="ghost" onClick={() => setScroll(null)}>
              New scroll
            </button>
          )}
        </div>
        {status && <p className="status">{status}</p>}
      </main>
    </div>
  );
}
