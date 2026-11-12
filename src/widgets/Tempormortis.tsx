import { useEffect, useRef, useState } from "react";
import TitleBar from "../components/TitleBar";
import { SigilDefs } from "../components/Sigils";
import { logToVault } from "../lib/vaultLog";

type Phase = "idle" | "running" | "paused" | "finished";

function format(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** A low tolling chime (Web Audio, no sound files). */
function toll() {
  try {
    const ctx = new AudioContext();
    [220, 165, 110].forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.55;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 1.5);
    });
  } catch {
    /* no audio device: the visual verdict still shows */
  }
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
 * The Tempormortis, after the Judiciar model: a bronze hourglass on a chain,
 * skull finial, winged-skull cap, ribbed pillars, skull base, and a crux
 * pendant on a side chain. The sand is the Chapter's homeworld sand; the cyan
 * glow is the stasis field while time is being slowed.
 */
function Hourglass({ fraction, phase }: { fraction: number; phase: Phase }) {
  const top = 1 - fraction;
  const topH = 71 * top;
  const botH = 70 * fraction;
  return (
    <svg className={`tempormortis phase-${phase}`} viewBox="0 0 200 300" role="img" aria-label={`Tempormortis, ${Math.round(fraction * 100)}% elapsed`}>
      <SigilDefs />
      <defs>
        <clipPath id="tm-top"><path d={TOP_BULB} /></clipPath>
        <clipPath id="tm-bottom"><path d={BOTTOM_BULB} /></clipPath>
        <linearGradient id="sand" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffd77a" />
          <stop offset="1" stopColor="#b9782a" />
        </linearGradient>
        <radialGradient id="stasis" cx="0.5" cy="0.5" r="0.6">
          <stop offset="0" stopColor="#00e5ff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#00e5ff" stopOpacity="0" />
        </radialGradient>
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

        {/* stasis glow and glass */}
        <ellipse cx="100" cy="163" rx="70" ry="86" fill="url(#stasis)" className="stasis" />
        <path d={GLASS} className="glass" />
        <rect clipPath="url(#tm-top)" x="0" y={163 - topH} width="200" height={topH} fill="url(#sand)" className="sand" />
        <rect clipPath="url(#tm-bottom)" x="0" y={234 - botH} width="200" height={botH} fill="url(#sand)" className="sand" />
        {phase === "running" && <line x1="100" y1="160" x2="100" y2={234 - botH} className="stream" />}
        <path d="M70 100C72 120 82 136 92 148" stroke="url(#glass-sheen)" strokeWidth="5" fill="none" strokeLinecap="round" />
        <path d="M72 226C72 206 80 192 90 182" stroke="url(#glass-sheen)" strokeWidth="5" fill="none" strokeLinecap="round" />
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
 * Tempormortis: a Pomodoro timer in the Judiciar's hourglass.
 * "Invoke stasis" starts it; when the sands run out it tolls, and
 * "Record the verdict" logs the session to the vault.
 */
export default function Tempormortis() {
  const [task, setTask] = useState("");
  const [minutes, setMinutes] = useState(25);
  const [phase, setPhase] = useState<Phase>("idle");
  const [remaining, setRemaining] = useState(25 * 60);
  const [status, setStatus] = useState("");
  const endAt = useRef(0);

  const total = minutes * 60;

  // Tick against a wall-clock end time so the timer stays accurate if the window is throttled.
  useEffect(() => {
    if (phase !== "running") return;
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.round((endAt.current - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) {
        setPhase("finished");
        toll();
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  function start() {
    const secs = phase === "paused" ? remaining : total;
    endAt.current = Date.now() + secs * 1000;
    setRemaining(secs);
    setPhase("running");
    setStatus("");
  }

  function reset() {
    setPhase("idle");
    setRemaining(total);
  }

  async function recordVerdict() {
    try {
      const file = await logToVault("Tempormortis", `${minutes} min`, task || "unnamed quarry");
      setStatus(`Verdict recorded in ${file.split(/[\\/]/).pop()}`);
      reset();
    } catch (err) {
      setStatus(`The record failed: ${String(err)}`);
    }
  }

  const fraction = phase === "idle" ? 0 : 1 - remaining / total;

  return (
    <div className="widget tempormortis-widget">
      <TitleBar title="Tempormortis" sigil="⧗" />
      <main className="body center">
        <Hourglass fraction={fraction} phase={phase} />

        <div className="plaque">
          <span className={phase === "finished" ? "clock finished" : "clock"}>
            {format(phase === "idle" ? total : remaining)}
          </span>
          <span className="plaque-caption">
            {phase === "finished" ? "The sands have run" : phase === "running" ? "Time is slowed" : phase === "paused" ? "Stasis held" : "Awaiting judgement"}
          </span>
        </div>

        {phase === "idle" ? (
          <div className="fields">
            <label className="field">
              <span>Quarry</span>
              <input className="engraved-input" value={task} onChange={(e) => setTask(e.target.value)} placeholder="What must fall?" />
            </label>
            <label className="field minutes">
              <span>Min</span>
              <input
                className="engraved-input"
                type="number"
                min={1}
                max={180}
                value={minutes}
                onChange={(e) => {
                  const m = Math.min(180, Math.max(1, Number(e.target.value) || 1));
                  setMinutes(m);
                  setRemaining(m * 60);
                }}
              />
            </label>
          </div>
        ) : (
          <p className="quarry">{task || "unnamed quarry"}</p>
        )}

        <div className="row">
          {(phase === "idle" || phase === "paused") && (
            <button className="primary" onClick={start}>
              {phase === "paused" ? "Resume stasis" : "Invoke stasis"}
            </button>
          )}
          {phase === "running" && (
            <button className="primary" onClick={() => setPhase("paused")}>
              Hold
            </button>
          )}
          {phase === "finished" && (
            <button className="primary verdict" onClick={recordVerdict}>
              Record the verdict
            </button>
          )}
          {phase !== "idle" && (
            <button className="ghost" onClick={reset}>
              Release
            </button>
          )}
        </div>
        {status && <p className="status">{status}</p>}
      </main>
    </div>
  );
}
