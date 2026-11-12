import { isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

/**
 * Events shared between the main window and popped-out widgets.
 * - timer-changed: the shared Chrono-Siphon timer changed (payload: TimerState)
 * - scroll-changed: a Data Stylus scroll was written, opened or closed
 * - log-changed: a line was added to the daily log (the dashboard refreshes)
 * - widgets-changed: a widget was popped out or closed (payload: open labels)
 * In a plain browser (`npm run dev`) they stay inside the page.
 */
export type AppEvent = "timer-changed" | "scroll-changed" | "log-changed" | "widgets-changed";

const local = new EventTarget();

export async function emitApp(name: AppEvent, payload?: unknown): Promise<void> {
  if (isTauri()) return emit(name, payload);
  local.dispatchEvent(new CustomEvent(name, { detail: payload }));
}

/** Subscribes to an app event; returns an unsubscribe function. */
export function onApp<T = unknown>(name: AppEvent, handler: (payload: T) => void): () => void {
  if (isTauri()) {
    const off = listen<T>(name, (e) => handler(e.payload));
    return () => {
      off.then((fn) => fn());
    };
  }
  const fn = (e: Event) => handler((e as CustomEvent<T>).detail);
  local.addEventListener(name, fn);
  return () => local.removeEventListener(name, fn);
}
