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
  /** Focus per project tag (the `task` field holds the project name). */
  byProject: { task: string; minutes: number }[];
  untaggedMinutes: number;
  /** Daily focus goal in minutes; 0 means no goal. */
  goalMinutes: number;
  /** Days in the range that reached the goal. */
  goalDaysMet: number;
  scrolls: ScrollStat[];
};

/** Goal choices offered on the dashboard, in minutes. */
export const GOAL_PRESETS = [60, 90, 120, 180, 240];

const DEMO_GOAL_KEY = "cogitorium.demo-goal";

/** Dashboard numbers for the last `days` days, counted by the Rust backend from the vault logs. */
export async function getStats(days = 7): Promise<Stats> {
  if (isTauri()) return invoke<Stats>("cogitator_stats", { today: today(), days });
  return demoStats(days);
}

/** Saves the daily focus goal (0 turns it off). Every window's dashboard refreshes. */
export async function setGoal(minutes: number): Promise<number> {
  if (isTauri()) return invoke<number>("set_goal", { minutes });
  try {
    localStorage.setItem(DEMO_GOAL_KEY, String(minutes));
  } catch {
    /* storage blocked: the demo just won't remember it */
  }
  return minutes;
}

function demoGoal(): number {
  try {
    const saved = localStorage.getItem(DEMO_GOAL_KEY);
    return saved == null ? 120 : Number(saved);
  } catch {
    return 120;
  }
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
  const goal = demoGoal();
  return {
    today: list[list.length - 1],
    streak: 4,
    days: list,
    byTask: [
      { task: "UE5 HUD prototype", minutes: 110 },
      { task: "UE5 C++ refresh", minutes: 95 },
      { task: "Job applications", minutes: 40 },
    ],
    byProject: [
      { task: "Games Portfolio Roadmap", minutes: 205 },
      { task: "Job Applications", minutes: 40 },
    ],
    untaggedMinutes: 70,
    goalMinutes: goal,
    goalDaysMet: goal ? list.filter((d) => d.minutes >= goal).length : 0,
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
