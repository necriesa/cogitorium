import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitApp, onApp } from "./events";

/** The shared Chrono-Siphon timer (owned by the Rust backend in the app). */
export type TimerState = {
  phase: "idle" | "running" | "paused" | "finished";
  task: string;
  minutes: number;
  /** Unix ms when a running timer ends. */
  endAt: number | null;
  /** Time left while paused. */
  remainingMs: number | null;
};

// In a plain browser there is no Rust backend, so a copy of its rules runs here.
let browserTimer: TimerState = { phase: "idle", task: "", minutes: 25, endAt: null, remainingMs: null };

function browserApply(cmd: string, args: { task?: string; minutes?: number } = {}): TimerState | boolean {
  const now = Date.now();
  const t = browserTimer;
  let finished = false;
  switch (cmd) {
    case "timer_start": {
      const minutes = Math.min(180, Math.max(1, Math.round(args.minutes ?? 25)));
      browserTimer = { phase: "running", task: args.task ?? "", minutes, endAt: now + minutes * 60_000, remainingMs: null };
      break;
    }
    case "timer_pause":
      if (t.phase === "running" && t.endAt) browserTimer = { ...t, phase: "paused", remainingMs: Math.max(0, t.endAt - now), endAt: null };
      break;
    case "timer_resume":
      if (t.phase === "paused" && t.remainingMs != null) browserTimer = { ...t, phase: "running", endAt: now + t.remainingMs, remainingMs: null };
      break;
    case "timer_reset":
      browserTimer = { ...t, phase: "idle", endAt: null, remainingMs: null };
      break;
    case "timer_finish":
      if (t.phase === "running" && t.endAt && now + 1000 >= t.endAt) {
        browserTimer = { ...t, phase: "finished", endAt: null, remainingMs: 0 };
        finished = true;
      }
      break;
  }
  if (cmd !== "timer_get") void emitApp("timer-changed", browserTimer);
  return cmd === "timer_finish" ? finished : browserTimer;
}

async function call<T>(cmd: string, args?: { task?: string; minutes?: number }): Promise<T> {
  if (isTauri()) return invoke<T>(cmd, args);
  return browserApply(cmd, args) as T;
}

/** Milliseconds left on the timer at `now`. */
export function remainingMs(t: TimerState, now: number): number {
  if (t.phase === "running" && t.endAt) return Math.max(0, t.endAt - now);
  if (t.phase === "paused" && t.remainingMs != null) return t.remainingMs;
  if (t.phase === "finished") return 0;
  return t.minutes * 60_000;
}

/** A low tolling chime (Web Audio, no sound files). */
export function toll() {
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

/**
 * The shared timer, kept in sync across windows.
 * With `watch`, this window also finishes the timer when time is up and tolls;
 * the backend lets only the first window do that, so the toll plays once.
 */
export function useSharedTimer({ watch = false } = {}) {
  const [timer, setTimer] = useState<TimerState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    call<TimerState>("timer_get").then(setTimer).catch(() => {});
    return onApp<TimerState>("timer-changed", setTimer);
  }, []);

  // Tick for display (and for the finish check) only while running.
  useEffect(() => {
    if (timer?.phase !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [timer?.phase]);

  useEffect(() => {
    if (!watch || timer?.phase !== "running" || !timer.endAt || now < timer.endAt) return;
    call<boolean>("timer_finish")
      .then((won) => {
        if (won) toll();
      })
      .catch(() => {});
  }, [watch, timer, now]);

  const start = useCallback((task: string, minutes: number) => call<TimerState>("timer_start", { task, minutes }).then(setTimer), []);
  const pause = useCallback(() => call<TimerState>("timer_pause").then(setTimer), []);
  const resume = useCallback(() => call<TimerState>("timer_resume").then(setTimer), []);
  const reset = useCallback(() => call<TimerState>("timer_reset").then(setTimer), []);

  return { timer, now: timer?.phase === "running" ? now : Date.now(), start, pause, resume, reset };
}
