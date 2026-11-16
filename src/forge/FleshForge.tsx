import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getForgeStats, listTemplates, listWorkouts, type ForgeStats, type Workout } from "../lib/forge";
import { onApp } from "../lib/events";
import { today } from "../lib/vaultLog";
import Planner from "./Planner";
import ForgeRecord from "./ForgeRecord";

type Tab = "planner" | "record";
const TAB_KEY = "flesh-forge.tab";

function readTab(): Tab {
  try {
    return localStorage.getItem(TAB_KEY) === "record" ? "record" : "planner";
  } catch {
    return "planner";
  }
}

/**
 * The Flesh-Forge section: the day's workout planner and the record of gym
 * visits and progression. Both read the vault through lib/forge.ts and
 * refresh when any window saves a workout ("forge-changed") or gains focus.
 * `compact` is the popped-out widget, which leads with the planner.
 */
export default function FleshForge({ compact = false }: { compact?: boolean }) {
  const [tab, setTab] = useState<Tab>(compact ? "planner" : readTab);
  const [date, setDate] = useState(today);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [templates, setTemplates] = useState<Workout[]>([]);
  const [stats, setStats] = useState<ForgeStats | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    Promise.all([listWorkouts(), listTemplates(), getForgeStats()])
      .then(([w, t, s]) => {
        setWorkouts(w);
        setTemplates(t);
        setStats(s);
        setError("");
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    const offForge = onApp("forge-changed", load);
    const offVault = onApp("vault-changed", load);
    let offFocus = () => {};
    if (isTauri()) {
      const un = getCurrentWindow().onFocusChanged(({ payload }) => payload && load());
      offFocus = () => void un.then((fn) => fn());
    }
    return () => {
      offForge();
      offVault();
      offFocus();
    };
  }, [load]);

  useEffect(() => {
    if (compact) return;
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab, compact]);

  return (
    <div className={compact ? "forge-shell compact" : "forge-shell"}>
      <div className="forge-tabs" role="tablist" aria-label="Flesh-Forge">
        {(["planner", "record"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "forge-tab on" : "forge-tab"} onClick={() => setTab(t)}>
            {t === "planner" ? "Planner" : "Record"}
          </button>
        ))}
      </div>
      {error && <p className="footnote error">The forge could not read the vault: {error}</p>}
      {tab === "planner" ? (
        <Planner workouts={workouts} templates={templates} stats={stats} date={date} onDate={setDate} onRefresh={load} />
      ) : stats ? (
        <ForgeRecord
          stats={stats}
          workouts={workouts}
          onOpenDay={(d) => {
            setDate(d);
            setTab("planner");
          }}
        />
      ) : (
        <p className="footnote dash-error">Heating the forge…</p>
      )}
    </div>
  );
}
