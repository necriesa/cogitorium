import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getForgeStats, getLibrary, listTemplates, listWorkouts, type ForgeStats, type LibraryEntry, type Workout } from "../lib/forge";
import { onApp } from "../lib/events";
import { today } from "../lib/vaultLog";
import Planner from "./Planner";
import ForgeRecord from "./ForgeRecord";
import ForgeLibrary from "./ForgeLibrary";

type Tab = "planner" | "library" | "record";
const TABS: { id: Tab; label: string }[] = [
  { id: "planner", label: "Planner" },
  { id: "library", label: "Library" },
  { id: "record", label: "Record" },
];
const TAB_KEY = "flesh-forge.tab";

function readTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return TABS.some((t) => t.id === saved) ? (saved as Tab) : "planner";
  } catch {
    return "planner";
  }
}

/**
 * The Flesh-Forge section: the day's workout planner, the exercise library
 * (with the template builder) and the record of gym visits and progression. Both read the vault through lib/forge.ts and
 * refresh when any window saves a workout ("forge-changed") or gains focus.
 * `compact` is the popped-out widget, which leads with the planner.
 */
export default function FleshForge({ compact = false }: { compact?: boolean }) {
  const [tab, setTab] = useState<Tab>(compact ? "planner" : readTab);
  const [date, setDate] = useState(today);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [templates, setTemplates] = useState<Workout[]>([]);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [stats, setStats] = useState<ForgeStats | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    Promise.all([listWorkouts(), listTemplates(), getForgeStats(), getLibrary()])
      .then(([w, t, s, l]) => {
        setWorkouts(w);
        setTemplates(t);
        setStats(s);
        setLibrary(l);
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
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "forge-tab on" : "forge-tab"} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {error && <p className="footnote error">The forge could not read the vault: {error}</p>}
      {tab === "planner" ? (
        <Planner workouts={workouts} templates={templates} library={library} stats={stats} date={date} onDate={setDate} onRefresh={load} />
      ) : tab === "library" ? (
        <ForgeLibrary library={library} templates={templates} onChanged={load} />
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
