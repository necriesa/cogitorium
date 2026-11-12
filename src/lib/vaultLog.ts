import { invoke, isTauri } from "@tauri-apps/api/core";

/** Local date as YYYY-MM-DD (the en-CA locale formats dates that way). */
export function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** Local time as HH:MM, 24-hour. */
export function nowTime(): string {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Appends one Markdown list line to today's log in the vault, through the Rust
 * `append_log` command. Every widget writes the same shape so the Cogitator
 * (Claude reading the logs) can parse them:
 *
 *   - 14:32 · Tempormortis · 25 min · film demo
 *
 * Returns the file it wrote to. Outside Tauri it only logs to the console.
 */
export async function logToVault(widget: string, ...fields: string[]): Promise<string> {
  const clean = fields.map((f) => f.replace(/[\r\n]+/g, " ").trim()).filter(Boolean);
  const entry = `- ${nowTime()} · ${widget} · ${clean.join(" · ")}`;
  if (!isTauri()) {
    console.info("[vault log, browser mode]", entry);
    return "browser console";
  }
  return invoke<string>("append_log", { date: today(), entry });
}
