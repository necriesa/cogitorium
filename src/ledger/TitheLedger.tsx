import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getBills, getCategories, listEntries, monthOf, type Bill, type Category, type Entry } from "../lib/ledger";
import { onApp } from "../lib/events";
import { today } from "../lib/vaultLog";
import LedgerMonth from "./LedgerMonth";
import LedgerBills from "./LedgerBills";
import LedgerBudgets from "./LedgerBudgets";
import LedgerTrends from "./LedgerTrends";
import LedgerImport from "./LedgerImport";

type Tab = "month" | "bills" | "budgets" | "trends" | "import";
const TABS: { id: Tab; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "bills", label: "Bills" },
  { id: "budgets", label: "Budgets" },
  { id: "trends", label: "Trends" },
  { id: "import", label: "Import" },
];
const TAB_KEY = "tithe-ledger.tab";

function readTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return TABS.some((t) => t.id === saved) ? (saved as Tab) : "month";
  } catch {
    return "month";
  }
}

export type LedgerData = { entries: Entry[]; categories: Category[]; bills: Bill[] };

/**
 * The Tithe-Ledger section: this month's spending against the budgets (and
 * the form to log money in and out), recurring bills, the budgets themselves,
 * spending over recent months, and importing a bank's CSV export. Everything is read from the vault through
 * lib/ledger.ts and refreshed when any window changes it ("ledger-changed")
 * or this window gains focus. `compact` is the popped-out widget.
 */
export default function TitheLedger({ compact = false }: { compact?: boolean }) {
  const [tab, setTab] = useState<Tab>(compact ? "month" : readTab);
  const [month, setMonth] = useState(() => monthOf(today()));
  const [data, setData] = useState<LedgerData | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    Promise.all([listEntries(), getCategories(), getBills()])
      .then(([entries, categories, bills]) => {
        setData({ entries, categories, bills });
        setError("");
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    const offLedger = onApp("ledger-changed", load);
    const offVault = onApp("vault-changed", load);
    let offFocus = () => {};
    if (isTauri()) {
      const un = getCurrentWindow().onFocusChanged(({ payload }) => payload && load());
      offFocus = () => void un.then((fn) => fn());
    }
    return () => {
      offLedger();
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
      <div className="forge-tabs ledger-tabs" role="tablist" aria-label="Tithe-Ledger">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "forge-tab on" : "forge-tab"} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {error && <p className="footnote error">The ledger could not read the vault: {error}</p>}
      {!data ? (
        !error && <p className="footnote dash-error">Opening the ledger…</p>
      ) : tab === "month" ? (
        <LedgerMonth data={data} month={month} onMonth={setMonth} onChanged={load} />
      ) : tab === "bills" ? (
        <LedgerBills data={data} onChanged={load} />
      ) : tab === "budgets" ? (
        <LedgerBudgets data={data} onChanged={load} />
      ) : tab === "import" ? (
        <LedgerImport
          data={data}
          onChanged={load}
          onOpenMonth={(m) => {
            setMonth(m);
            setTab("month");
          }}
        />
      ) : (
        <LedgerTrends
          data={data}
          onOpenMonth={(m) => {
            setMonth(m);
            setTab("month");
          }}
        />
      )}
    </div>
  );
}
