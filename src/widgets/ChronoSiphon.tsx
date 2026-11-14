import { useEffect, useState } from "react";
import { SigilDefs } from "../components/Sigils";
import { logToVault } from "../lib/vaultLog";
import { remainingMs, useSharedTimer } from "../lib/timer";
import { projectLink, useProjects } from "../lib/projects";

type Phase = "idle" | "running" | "paused" | "finished";

const PRESETS = [15, 25, 45, 60];
const SEGMENTS = 24;

function format(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Glass geometry (viewBox 0 0 200 300). The neck is at y = 163.
const GLASS =
  "M62 92H138C138 128 110 146 102 163C110 180 138 198 138 234H62C62 198 90 180 98 163C90 146 62 128 62 92Z";
const TOP_BULB = "M62 92H138C138 128 110 146 102 163H98C90 146 62 128 62 92Z";
const BOTTOM_BULB = "M98 163H102C110 180 138 198 138 234H62C62 198 90 180 98 163Z";

/** One chain link, alternating face-on and edge-on. */
function Chain({ x, y0, y1 }: { x: number; y0: number; y1: number }) {
  const links = [];
  for (let y = y0, i = 0; y < y1; y += 9, i++) {
    links.push(
      i % 2 === 0 ? (
        <ellipse key={i} cx={x} cy={y + 5} rx="4" ry="6" className="chain-link" />
      ) : (
        <rect key={i} x={x - 1.2} y={y + 1} width="2.4" height="9" rx="1.2" className="chain-link edge" />
      ),
    );
  }
  return <g>{links}</g>;
}

/** Ribbed bronze pillar. */
function Pillar({ x }: { x: number }) {
  return (
    <g>
      <rect x={x - 6} y="90" width="12" height="148" rx="3" fill="url(#bronze)" stroke="#2a1a0c" strokeWidth="1" />
      {[104, 128, 152, 176, 200, 224].map((y) => (
        <rect key={y} x={x - 8} y={y} width="16" height="5" rx="2" fill="url(#bronze)" stroke="#2a1a0c" strokeWidth="0.8" />
      ))}
      <circle cx={x} cy="92" r="5" fill="url(#bronze-v)" stroke="#2a1a0c" />
      <circle cx={x} cy="236" r="5" fill="url(#bronze-v)" stroke="#2a1a0c" />
    </g>
  );
}

/**
 * The Chrono-Siphon: a bronze hourglass on a chain, with a skull finial,
 * winged-skull cap, ribbed pillars, skull base, and a crux pendant on a side
 * chain (design references in CREDITS.md). The cyan glow is the stasis
 * field while time is being slowed.
 */
function Hourglass({ fraction, phase }: { fraction: number; phase: Phase }) {
  const top = 1 - fraction;
  const topH = 71 * top;
  const botH = 70 * fraction;
  return (
    <svg className={`chrono-siphon phase-${phase}`} viewBox="0 0 200 300" role="img" aria-label={`Chrono-Siphon, ${Math.round(fraction * 100)}% elapsed`}>
      <SigilDefs />
      <defs>
        <clipPath id="tm-top"><path d={TOP_BULB} /></clipPath>
        <clipPath id="tm-bottom"><path d={BOTTOM_BULB} /></clipPath>
        <linearGradient id="sand" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffd77a" />
          <stop offset="1" stopColor="#b9782a" />
        </linearGradient>
        <clipPath id="tm-glass"><path d={GLASS} /></clipPath>
        {/* stasis light lives inside the glass: brightest at the neck, where time is being held */}
        <radialGradient id="stasis" cx="100" cy="163" r="72" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e2f9ff" stopOpacity="0.85" />
          <stop offset="0.3" stopColor="#8fdcf0" stopOpacity="0.4" />
          <stop offset="0.7" stopColor="#5fbcd6" stopOpacity="0.12" />
          <stop offset="1" stopColor="#5fbcd6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="stasis-alarm" cx="100" cy="163" r="62" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffb3a8" stopOpacity="0.5" />
          <stop offset="0.4" stopColor="#e5483c" stopOpacity="0.2" />
          <stop offset="1" stopColor="#e5483c" stopOpacity="0" />
        </radialGradient>
        {/* held: the light locks bright and white, and a lattice fills the glass */}
        <radialGradient id="stasis-held" cx="100" cy="163" r="78" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="0.35" stopColor="#c8f3ff" stopOpacity="0.5" />
          <stop offset="1" stopColor="#8fdcf0" stopOpacity="0.12" />
        </radialGradient>
        <pattern id="held-lattice" width="200" height="4" patternUnits="userSpaceOnUse">
          <rect width="200" height="1" fill="#e6fbff" fillOpacity="0.35" />
        </pattern>
        <linearGradient id="sweep" x1="0" x2="1">
          <stop offset="0" stopColor="#e6f9ff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#e6f9ff" stopOpacity="0.16" />
          <stop offset="1" stopColor="#e6f9ff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="glass-sheen" x1="0" x2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>

      <g className="sway">
        {/* main chain, ring and skull finial */}
        <Chain x={100} y0={-6} y1={30} />
        <circle cx="100" cy="36" r="5" fill="none" stroke="url(#bronze)" strokeWidth="3" />
        <use href="#skull" x="90" y="39" width="20" height="22" />

        {/* cap */}
        <rect x="56" y="58" width="88" height="9" rx="2" fill="url(#bronze-v)" stroke="#2a1a0c" />
        <path d="M34 90 46 66H154L166 90Z" fill="url(#bronze-v)" stroke="#2a1a0c" />
        <use href="#winged-skull" x="70" y="67" width="60" height="22" />
        {[44, 156].map((x) => (
          <circle key={x} cx={x} cy="84" r="2" fill="#f0c27b" stroke="#2a1a0c" strokeWidth="0.6" />
        ))}

        {/* glass, then the stasis light inside it (clipped, so nothing spills past the frame) */}
        <path d={GLASS} className="glass" />
        <g clipPath="url(#tm-glass)">
          <rect x="60" y="90" width="80" height="146" className="stasis" />
        </g>
        <rect clipPath="url(#tm-top)" x="0" y={163 - topH} width="200" height={topH} fill="url(#sand)" className="sand" />
        <rect clipPath="url(#tm-bottom)" x="0" y={234 - botH} width="200" height={botH} fill="url(#sand)" className="sand" />
        {/* catch-light on each sand surface, lit by the stasis glow */}
        {topH > 1 && <rect clipPath="url(#tm-top)" x="0" y={163 - topH} width="200" height="1.6" className="sand-glint" />}
        {botH > 1 && <rect clipPath="url(#tm-bottom)" x="0" y={234 - botH} width="200" height="1.6" className="sand-glint" />}
        {/* the falling sand: kept while held so its grains freeze mid-fall */}
        {(phase === "running" || phase === "paused") && <line x1="100" y1="160" x2="100" y2={234 - botH} className="stream" />}
        <g clipPath="url(#tm-glass)">
          <rect x="60" y="90" width="80" height="146" className="held-field" />
        </g>

        {/* reflections on the glass surface: two fixed highlights and a slow sheen (frozen while held) */}
        <path d="M70 100C72 120 82 136 92 148" stroke="url(#glass-sheen)" strokeWidth="5" fill="none" strokeLinecap="round" />
        <path d="M72 226C72 206 80 192 90 182" stroke="url(#glass-sheen)" strokeWidth="5" fill="none" strokeLinecap="round" />
        <g clipPath="url(#tm-glass)">
          <g className="sweep">
            <rect x="20" y="80" width="26" height="170" fill="url(#sweep)" transform="skewX(-18)" />
          </g>
        </g>
        <path d={GLASS} className="glass-edge" />

        <Pillar x={50} />
        <Pillar x={150} />

        {/* base, skull and spike */}
        <path d="M34 236H166L154 260H46Z" fill="url(#bronze-v)" stroke="#2a1a0c" />
        <use href="#skull" x="92" y="238" width="16" height="18" />
        <path d="M86 260H114L100 284Z" fill="url(#bronze)" stroke="#2a1a0c" />
        <circle cx="100" cy="286" r="3" fill="url(#bronze-v)" stroke="#2a1a0c" />

        {/* crux pendant on a side chain */}
        <path d="M156 94C176 112 182 146 182 176" fill="none" stroke="#6b6f78" strokeWidth="2.4" strokeDasharray="4 2.4" />
        <g transform="translate(182 194)">
          <path
            d="M-4-18H4L3-8 13-11V-3L3-6 4 16H-4L-3-6-13-3V-11L-3-8Z"
            fill="url(#bronze)"
            stroke="#2a1a0c"
            strokeWidth="0.8"
          />
          <use href="#skull" x="-5" y="-12" width="10" height="11" />
        </g>
      </g>
    </svg>
  );
}

/**
 * Chrono-Siphon: a Pomodoro timer in a gothic stasis hourglass.
 * The timer itself lives in the backend (lib/timer.ts), so this panel can be
 * shown in the main app and in a popped-out widget at the same time.
 * "Invoke stasis" starts it; when the sands run out it tolls, and
 * "Record the verdict" logs the session to the vault.
 */
export default function ChronoSiphon() {
  const { timer, now, start, pause, resume, reset } = useSharedTimer({ watch: true });
  const projects = useProjects();
  const [task, setTask] = useState("");
  const [project, setProject] = useState("");
  const [minutes, setMinutes] = useState(25);
  const [status, setStatus] = useState("");

  // Start the form from the last timer's task, project and length.
  useEffect(() => {
    if (timer && timer.phase === "idle") {
      setTask((t) => t || timer.task);
      setProject((p) => p || timer.project);
      setMinutes(timer.minutes);
    }
    // only when the timer first loads or returns to idle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timer?.phase]);

  const phase: Phase = timer?.phase ?? "idle";
  const shownMinutes = phase === "idle" ? minutes : (timer?.minutes ?? minutes);
  const total = shownMinutes * 60;
  const remaining = timer && phase !== "idle" ? Math.round(remainingMs(timer, now) / 1000) : total;

  async function recordVerdict() {
    if (!timer) return;
    try {
      const file = await logToVault("Chrono-Siphon", `${timer.minutes} min`, timer.task || "unnamed quarry", projectLink(timer.project));
      setStatus(`Verdict recorded in ${file.split(/[\\/]/).pop()}`);
      await reset();
    } catch (err) {
      setStatus(`The record failed: ${String(err)}`);
    }
  }

  const fraction = phase === "idle" ? 0 : 1 - remaining / total;
  const state = { idle: "Awaiting judgement", running: "Time is slowed", paused: "Stasis held", finished: "The sands have run" }[phase];
  const lit = Math.round(fraction * SEGMENTS);

  function chooseMinutes(m: number) {
    setMinutes(Math.min(180, Math.max(1, Math.round(m) || 1)));
  }

  return (
    <main className="body">
      <div className="relic">
        <Hourglass fraction={fraction} phase={phase} />
      </div>

      {/* cogitator readout, after Rogue Trader's green-phosphor panels */}
      <section className={`cogitator readout phase-${phase}`} aria-live="polite">
        <div className="readout-head">
          <span>Stasis field</span>
          <span>{state}</span>
        </div>
        <div className="readout-time">{format(remaining)}</div>
        <div className="segments" aria-hidden="true">
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <span key={i} className={i < lit ? "on" : ""} />
          ))}
        </div>
        {phase !== "idle" && <div className="readout-quarry">{timer?.task || "Unnamed quarry"}</div>}
        {phase !== "idle" && timer?.project && <div className="readout-project">For {timer.project}</div>}
      </section>

      {phase === "idle" && (
        <div className="form">
          <label className="field">
            <span className="label">Quarry</span>
            <input className="input" value={task} onChange={(e) => setTask(e.target.value)} placeholder="What must fall?" />
          </label>
          <label className="field">
            <span className="label">Project</span>
            <select className="input select" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">None</option>
              {/* keep a project from an earlier session even if its note was renamed since */}
              {[...projects, ...(project && !projects.includes(project) ? [project] : [])].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span className="label">Duration</span>
            <div className="chips" role="group" aria-label="Minutes">
              {PRESETS.map((m) => (
                <button key={m} className={m === minutes ? "chip on" : "chip"} aria-pressed={m === minutes} onClick={() => chooseMinutes(m)}>
                  {m}
                </button>
              ))}
              <input
                className="input chip-input"
                type="number"
                min={1}
                max={180}
                value={PRESETS.includes(minutes) ? "" : minutes}
                placeholder="other"
                onChange={(e) => e.target.value && chooseMinutes(Number(e.target.value))}
                aria-label="Custom minutes"
              />
            </div>
          </div>
        </div>
      )}

      <div className="actions">
        {phase === "idle" && (
          <button
            className="btn primary"
            onClick={() => {
              setStatus("");
              void start(task, minutes, project);
            }}
          >
            Invoke stasis
          </button>
        )}
        {phase === "paused" && (
          <button className="btn primary" onClick={() => void resume()}>
            Resume
          </button>
        )}
        {phase === "running" && (
          <button className="btn" onClick={() => void pause()}>
            Hold
          </button>
        )}
        {phase === "finished" && (
          <button className="btn seal" onClick={recordVerdict}>
            Record the verdict
          </button>
        )}
        {phase !== "idle" && (
          <button className="btn quiet" onClick={() => void reset()}>
            Release
          </button>
        )}
      </div>
      {status && <p className="footnote">{status}</p>}
    </main>
  );
}
