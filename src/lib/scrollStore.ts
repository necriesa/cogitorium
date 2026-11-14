import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitApp } from "./events";
import { fromMarkdown, type Scroll } from "./scroll";
import { today } from "./vaultLog";
import type { ScrollStat } from "./stats";

/**
 * Where scroll notes are kept. In the desktop app they are Markdown files in
 * `<vault>/<log dir>/Scrolls/` (through the Rust commands). In a plain browser
 * they fall back to localStorage so the UI can still be developed.
 */
const memKey = (file: string) => `auto-quill.scroll:${file}`;

/**
 * A copy of the open scroll in the webview's storage, so it shows at once on
 * start-up. The record of which scroll is open is `open_scroll` in the app's
 * settings.json; the scroll itself is always re-read from the vault.
 * The key keeps the widget's pre-0.3 name (Auto Quill).
 */
const ACTIVE_KEY = "auto-quill.active";

export async function saveScroll(file: string, markdown: string): Promise<string> {
  if (isTauri()) return invoke<string>("write_scroll", { fileName: file, content: markdown });
  try {
    localStorage.setItem(memKey(file), markdown);
  } catch {
    /* ignore */
  }
  return "browser storage";
}

export async function loadScroll(file: string): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("read_scroll", { fileName: file });
  try {
    return localStorage.getItem(memKey(file));
  } catch {
    return null;
  }
}

export async function listScrolls(): Promise<string[]> {
  if (isTauri()) return invoke<string[]>("list_scrolls");
  try {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith("auto-quill.scroll:"))
      .map((k) => k.slice("auto-quill.scroll:".length));
  } catch {
    return [];
  }
}

/** Every scroll in the vault with its progress, including checklists written by hand in Obsidian. */
export async function scrollLibrary(): Promise<ScrollStat[]> {
  if (isTauri()) return invoke<ScrollStat[]>("scroll_library", { today: today() });
  const files = await listScrolls();
  const out: ScrollStat[] = [];
  for (const file of files) {
    const text = await loadScroll(file);
    if (text == null) continue;
    const s = fromMarkdown(text, file, today());
    const done = s.items.filter((i) => i.done).length;
    const updated = text.match(/^updated:\s*(.+)$/m)?.[1].trim() ?? null;
    const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000;
    const idleDays = updated && !Number.isNaN(day(updated)) ? Math.max(0, Math.round(day(today()) - day(updated))) : null;
    const finished = s.items.length > 0 && done === s.items.length;
    out.push({
      title: s.title,
      file,
      done,
      total: s.items.length,
      idleDays,
      status: finished ? "complete" : idleDays != null && idleDays >= 7 ? "stalled" : "active",
      nextItem: s.items.find((i) => !i.done)?.text ?? null,
      updated,
    });
  }
  return out;
}

/** The cached copy of the open scroll (instant, but possibly stale). */
export function cachedOpenScroll(): Scroll | null {
  try {
    const saved = localStorage.getItem(ACTIVE_KEY);
    return saved ? (JSON.parse(saved) as Scroll) : null;
  } catch {
    return null;
  }
}

function cacheOpenScroll(scroll: Scroll | null) {
  try {
    if (scroll) localStorage.setItem(ACTIVE_KEY, JSON.stringify(scroll));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

/** Records which scroll is open, so it reopens after a restart. */
export async function rememberOpenScroll(scroll: Scroll | null): Promise<void> {
  cacheOpenScroll(scroll);
  if (isTauri()) await invoke("set_open_scroll", { fileName: scroll?.file ?? null });
}

/**
 * The scroll that was open last time, re-read from the vault so ticks made in
 * Obsidian meanwhile are included. Returns null if none was open or the note
 * is gone. Scrolls opened before v0.7 (remembered only in the webview) are
 * carried over into settings.json.
 */
export async function restoreOpenScroll(): Promise<Scroll | null> {
  const cached = cachedOpenScroll();
  let file = cached?.file ?? null;
  if (isTauri()) {
    const saved = await invoke<string | null>("get_open_scroll");
    if (saved) file = saved;
    else if (file) await invoke("set_open_scroll", { fileName: file });
  }
  if (!file) return null;
  const text = await loadScroll(file);
  if (text == null) {
    await rememberOpenScroll(null);
    return null;
  }
  const scroll = fromMarkdown(text, file, cached?.file === file ? cached.created : today());
  cacheOpenScroll(scroll);
  return scroll;
}

/**
 * Opens a scroll from the vault on every window's Data Stylus (and the dashboard),
 * and remembers it. Returns null if the note no longer exists.
 */
export async function openScroll(file: string): Promise<Scroll | null> {
  const text = await loadScroll(file);
  if (text == null) return null;
  const scroll = fromMarkdown(text, file, today());
  await rememberOpenScroll(scroll);
  await emitApp("scroll-changed", scroll);
  return scroll;
}
