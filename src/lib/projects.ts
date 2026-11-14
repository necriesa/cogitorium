import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { onApp } from "./events";

/** Sample project notes for `npm run dev` in a browser, where there is no vault. */
const DEMO = ["Cogitorium", "Construction Cost Calculator", "Fabric Flow Tracker", "Job Applications"];

/** Project notes in the vault's `Projects/` folder, by name. */
export function listProjects(): Promise<string[]> {
  if (isTauri()) return invoke<string[]>("list_projects");
  return Promise.resolve(DEMO);
}

/** The vault's projects, refreshed when the vault changes or the window regains focus. */
export function useProjects(): string[] {
  const [projects, setProjects] = useState<string[]>([]);
  useEffect(() => {
    const load = () => listProjects().then(setProjects).catch(() => setProjects([]));
    load();
    const off = onApp("vault-changed", load);
    window.addEventListener("focus", load);
    return () => {
      off();
      window.removeEventListener("focus", load);
    };
  }, []);
  return projects;
}

/** A session's project as the log writes it: an Obsidian link, so the project note lists it in its backlinks. */
export function projectLink(project: string): string {
  return project ? `[[${project}]]` : "";
}
