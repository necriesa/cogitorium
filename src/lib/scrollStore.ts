import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Where scroll notes are kept. In the desktop app they are Markdown files in
 * `<vault>/<log dir>/Scrolls/` (through the Rust commands). In a plain browser
 * they fall back to localStorage so the UI can still be developed.
 */
const memKey = (file: string) => `auto-quill.scroll:${file}`;

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
