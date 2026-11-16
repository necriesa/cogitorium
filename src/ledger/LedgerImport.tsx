import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { dayLabel, importEntries, money, monthLabel, monthOf, readCsvPath } from "../lib/ledger";
import { planImport, readBankCsv, recategorise, sampleWestpacCsv, spanLabel, toImport, type BankFile, type ImportRow } from "../lib/ledgerImport";
import { today } from "../lib/vaultLog";
import type { LedgerData } from "./TitheLedger";

type Loaded = { name: string; file: BankFile };
type Done = { count: number; months: string[]; bills: string[] };

/** One bank row: tick to import, the category to file it under, and why it's unticked if it is. */
function Row({ row, data, onTick, onCategory }: { row: ImportRow; data: LedgerData; onTick: (on: boolean) => void; onCategory: (c: string) => void }) {
  const options = data.categories.filter((c) => c.kind === row.kind).map((c) => c.name);
  if (!options.some((o) => o.toLowerCase() === row.category.toLowerCase())) options.push(row.category);
  const dup = row.status === "duplicate";
  return (
    <li className={row.include ? "ledger-import-row" : "ledger-import-row off"}>
      <input
        type="checkbox"
        className="ledger-import-tick"
        checked={row.include}
        disabled={dup}
        aria-label={`Import ${row.note} on ${dayLabel(row.date)}`}
        onChange={(e) => onTick(e.target.checked)}
      />
      <div className="ledger-import-main">
        <div className="ledger-import-head">
          <span className="ledger-import-note" title={row.raw}>
            {row.note}
            {row.bill && <span className="forge-kind">bill</span>}
          </span>
          <span className="ledger-entry-amt">
            {row.kind === "in" ? "+" : "−"}
            {money(row.cents)}
          </span>
        </div>
        <div className="ledger-import-meta">
          <span className="ledger-dim">{dayLabel(row.date)}</span>
          {dup ? (
            <span className="ledger-dim">· {row.category}</span>
          ) : (
            <select
              className={row.guess === "none" && row.include ? "term-input ledger-category ledger-import-cat unsure" : "term-input ledger-category ledger-import-cat"}
              value={row.category}
              aria-label={`Category for ${row.note}`}
              onChange={(e) => onCategory(e.target.value)}
            >
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          )}
          {row.guess === "none" && row.include && <span className="ledger-import-flag">pick one?</span>}
        </div>
        {row.reason && <span className={row.status === "new" ? "ledger-note-line" : "ledger-note-line ledger-import-why"}>{row.reason}</span>}
      </div>
    </li>
  );
}

/**
 * Import a bank's CSV export (built for Westpac; most banks' work). The file is
 * read here and checked against the ledger: rows already imported are hidden,
 * ones that look logged by hand or like transfers are left unticked, bill
 * payments are matched to their bills, and each row gets a category from the
 * last time that merchant came up. Nothing is written until Import is pressed.
 */
export default function LedgerImport({ data, onChanged, onOpenMonth }: { data: LedgerData; onChanged: () => void; onOpenMonth: (month: string) => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [plan, setPlan] = useState<ImportRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [over, setOver] = useState(false);
  const dataRef = useRef(data);
  dataRef.current = data;

  function load(text: string, name: string) {
    try {
      const file = readBankCsv(text);
      const d = dataRef.current;
      setLoaded({ name, file });
      setPlan(planImport(file.rows, d.entries, d.categories, d.bills));
      setError("");
      setDone(null);
      setShowHidden(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // In the app, files dropped on the window arrive as paths.
  useEffect(() => {
    if (!isTauri()) return;
    const un = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") setOver(true);
      else if (payload.type === "leave") setOver(false);
      else if (payload.type === "drop") {
        setOver(false);
        const path = payload.paths.find((p) => /\.(csv|txt)$/i.test(p)) ?? payload.paths[0];
        if (!path) return;
        readCsvPath(path)
          .then((text) => load(text, path.split(/[\\/]/).pop() ?? path))
          .catch((e) => setError(String(e)));
      }
    });
    return () => void un.then((fn) => fn());
  }, []);

  function readFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      setError("That file is over 5 MB. Export a shorter date range.");
      return;
    }
    f.text()
      .then((text) => load(text, f.name))
      .catch((e) => setError(String(e)));
  }

  const counts = useMemo(() => {
    const ticked = plan.filter((p) => p.include);
    return {
      ticked: ticked.length,
      out: ticked.filter((p) => p.kind === "out").reduce((s, p) => s + p.cents, 0),
      in: ticked.filter((p) => p.kind === "in").reduce((s, p) => s + p.cents, 0),
      duplicate: plan.filter((p) => p.status === "duplicate").length,
      check: plan.filter((p) => !p.include && p.status !== "duplicate").length,
      unsure: ticked.filter((p) => p.guess === "none").length,
    };
  }, [plan]);

  function runImport() {
    const { entries, billsPaid } = toImport(plan);
    if (entries.length === 0) return;
    setBusy(true);
    importEntries(entries, billsPaid)
      .then((count) => {
        const months = [...new Set(entries.map((e) => monthOf(e.date)))].sort().reverse();
        setDone({ count, months, bills: [...new Set(billsPaid)] });
        setLoaded(null);
        setPlan([]);
        setError("");
        onChanged();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }

  const picker = (
    <label className="chip on ledger-file">
      Choose CSV file
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          readFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </label>
  );

  if (loaded) {
    const { file } = loaded;
    const shown = plan.filter((p) => showHidden || p.status !== "duplicate");
    const keys = (
      <div className="chips forge-form-keys">
        <button className="chip on" disabled={busy || counts.ticked === 0} onClick={runImport}>
          {busy ? "Importing…" : `Import ${counts.ticked}`}
        </button>
        <button className="chip" disabled={busy} onClick={() => setLoaded(null)}>
          Cancel
        </button>
      </div>
    );
    return (
      <div className="forge">
        <section className="cogitator forge-panel" aria-label="Import summary">
          <p className="term-label">Check before importing</p>
          <p className="ledger-import-file">
            {loaded.name}
            <span className="ledger-note-line">
              {file.bank}
              {file.account && ` · account ending ${file.account}`} · {spanLabel(file.rows)} · {file.rows.length} transactions
            </span>
          </p>
          <div className="ledger-kpis">
            <div className="ledger-kpi">
              <span className="term-label">Spent</span>
              <span className="ledger-kpi-value">{money(counts.out, true)}</span>
            </div>
            <div className="ledger-kpi">
              <span className="term-label">Income</span>
              <span className="ledger-kpi-value">{money(counts.in, true)}</span>
            </div>
          </div>
          <p className="ledger-note-line">
            {counts.ticked} to import
            {counts.check > 0 && ` · ${counts.check} unticked to check`}
            {counts.duplicate > 0 && ` · ${counts.duplicate} already in the ledger`}
            {counts.unsure > 0 && ` · ${counts.unsure} with no category guess`}
          </p>
          {error && <p className="footnote error">{error}</p>}
          {keys}
        </section>

        <section className="cogitator forge-panel" aria-label="Transactions">
          <p className="term-label">Transactions</p>
          {shown.length === 0 ? (
            <p className="dash-empty">Everything in this file is already in the ledger.</p>
          ) : (
            <ul className="ledger-import-rows">
              {shown.map((p) => (
                <Row
                  key={p.id}
                  row={p}
                  data={data}
                  onTick={(on) => setPlan((list) => list.map((x) => (x.id === p.id ? { ...x, include: on } : x)))}
                  onCategory={(c) => setPlan((list) => recategorise(list, p.id, c))}
                />
              ))}
            </ul>
          )}
          {counts.duplicate > 0 && (
            <button className="dash-link" onClick={() => setShowHidden((s) => !s)}>
              {showHidden ? "Hide" : "Show"} the {counts.duplicate} already imported
            </button>
          )}
          {shown.length > 8 && keys}
        </section>
      </div>
    );
  }

  return (
    <div className="forge">
      {done && (
        <section className="cogitator forge-panel" aria-label="Imported">
          <p className="term-label">Imported</p>
          <p>
            {done.count} {done.count === 1 ? "entry" : "entries"} added to the ledger.
            {done.bills.length > 0 && <span className="ledger-note-line">{done.bills.join(", ")} moved on to the next due date.</span>}
          </p>
          <div className="chips">
            {done.months.slice(0, 3).map((m) => (
              <button key={m} className="chip" onClick={() => onOpenMonth(m)}>
                Open {monthLabel(m)}
              </button>
            ))}
          </div>
        </section>
      )}

      <section
        className={over ? "cogitator forge-panel ledger-drop over" : "cogitator forge-panel ledger-drop"}
        aria-label="Import from your bank"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          readFile(e.dataTransfer.files?.[0]);
        }}
      >
        <p className="term-label">Import from your bank</p>
        <p>Drop a CSV export of your transactions here, or choose the file. You'll check every row before anything is saved.</p>
        <div className="chips">
          {picker}
          {!isTauri() && (
            <button className="chip" onClick={() => load(sampleWestpacCsv(today()), "Westpac sample.csv")}>
              Try a sample file
            </button>
          )}
        </div>
        {error && <p className="footnote error">{error}</p>}
      </section>

      <section className="cogitator forge-panel" aria-label="Exporting from Westpac">
        <p className="term-label">Exporting from Westpac</p>
        <ol className="ledger-steps">
          <li>Sign in to Westpac Online Banking on a computer and open the account.</li>
          <li>Choose to export (download) its transactions, pick the dates, and pick CSV as the format.</li>
          <li>Drop the file here. Do the same for a credit card; repayments to it are left unticked as transfers.</li>
        </ol>
        <p className="ledger-note-line">
          Overlapping dates are fine: rows already in the ledger are skipped. Only the entries you import are kept (in the month notes), not the bank file.
        </p>
      </section>
    </div>
  );
}
