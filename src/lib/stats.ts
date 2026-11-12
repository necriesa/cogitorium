import { invoke, isTauri } from "@tauri-apps/api/core";
import { today } from "./vaultLog";

export type DayStat = { date: string; minutes: number; sessions: number; subtasksDone: number };
export type ScrollStat = {
  title: string;
  file: string;
  done: number;
  total: number;
  idleDays: number | null;
  status: "complete" | "stalled" | "active";
  nextItem: string | null;
};
export type Stats = {
  today: DayStat;
  streak: number;
  days: DayStat[];
  byTask: { task: string; minutes: number }[];
  scrolls: ScrollStat[];
};

/** Dashboard numbers for the last `days` days, counted by the Rust backend from the vault logs. */
export async function getStats(days = 7): Promise<Stats> {
  if (isTauri()) return invoke<Stats>("cogitator_stats", { today: today(), days });
  return demoStats(days);
}

/** Sample numbers for `npm run dev` in a browser, where there is no vault. */
function demoStats(days: number): Stats {
  const minutes = [25, 15, 0, 95, 25, 60, 45, 30, 0, 50, 75, 20, 40, 65];
  const list: DayStat[] = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const m = minutes[(i + 14 - days) % minutes.length] ?? 0;
    return { date: d.toLocaleDateString("en-CA"), minutes: m, sessions: Math.ceil(m / 25), subtasksDone: m ? 1 + (i % 3) : 0 };
  });
  return {
    today: list[list.length - 1],
    streak: 4,
    days: list,
    byTask: [
      { task: "UE5 HUD prototype", minutes: 110 },
      { task: "UE5 C++ refresh", minutes: 95 },
      { task: "Job applications", minutes: 40 },
    ],
    scrolls: [
      { title: "UE5 HUD prototype", file: "UE5 HUD prototype.md", done: 2, total: 4, idleDays: 9, status: "stalled", nextItem: "Build the health bar widget" },
      { title: "Job apps week 46", file: "Job apps week 46.md", done: 1, total: 5, idleDays: 2, status: "active", nextItem: "Tailor the Riot cover letter" },
      { title: "Sunday reset", file: "Sunday reset.md", done: 4, total: 4, idleDays: 0, status: "complete", nextItem: null },
    ],
  };
}

export function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}
