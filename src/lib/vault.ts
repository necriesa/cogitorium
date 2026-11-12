import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

/** The remembered vault folder, or null if none is set. Browser mode has no vault and needs none. */
export async function getVault(): Promise<string | null> {
  if (!isTauri()) return "browser";
  return invoke<string | null>("get_vault");
}

/** Opens a folder picker and remembers the choice. Returns the path, or null if cancelled. */
export async function chooseVault(): Promise<string | null> {
  if (!isTauri()) return null;
  const picked = await open({ directory: true, title: "Choose your Obsidian vault folder" });
  if (typeof picked !== "string") return null;
  return invoke<string>("set_vault", { path: picked });
}

/** Calls `onChange` whenever any window changes the vault. Returns an unsubscribe function. */
export function onVaultChanged(onChange: (path: string) => void): () => void {
  if (!isTauri()) return () => {};
  const unlisten = listen<string>("vault-changed", (e) => onChange(e.payload));
  return () => {
    unlisten.then((fn) => fn());
  };
}
