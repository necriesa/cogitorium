import { useMemo, useState } from "react";
import { categoryAverages, money, monthLabel, monthOf, monthTotals, shiftMonth } from "../lib/ledger";
import { today } from "../lib/vaultLog";
import type { LedgerData } from "./TitheLedger";

const MONTHS = 12;
const AVERAGE_OVER = 3;

/**
 * Spending over the last twelve months (one bar per month; hover or focus one
 * for its income and net, click to open it), and where the money usually goes:
 * each category's average over the last three full months, against its budget.
 */
export default function LedgerTrends({ data, onOpenMonth }: { data: LedgerData; onOpenMonth: (month: string) => void }) {
  const current = monthOf(today());
  const totals = useMemo(() => monthTotals(data.entries, current, MONTHS), [data.entries, current]);
  const lastFull = useMemo(() => totals[totals.length - 2]?.month ?? current, [totals, current]);
  const averages = useMemo(() => categoryAverages(data.entries, lastFull, AVERAGE_OVER), [data.entries, lastFull]);
  const [hover, setHover] = useState<number | null>(null);

  const values = totals.map((t) => t.spent);
  const peak = Math.max(1, ...values);
  const shown = hover ?? totals.length - 1;
  const t = totals[shown];
  const net = t.income - t.spent;
  const peakAverage = Math.max(1, ...averages.map((a) => a.average));
  const budgetOf = (name: string) => data.categories.find((c) => c.name.toLowerCase() === name.toLowerCase())?.budget ?? null;

  return (
    <div className="forge">
      <section className="cogitator forge-panel" aria-label="Spending by month">
        <p className="term-label">Spending by month</p>
        {values.every((v) => v === 0) ? (
          <p className="dash-empty">Nothing spent in the last twelve months.</p>
        ) : (
          <>
            <p className="forge-readout">
              <span>
                {monthLabel(t.month)}
                {t.month === current && " (so far)"}
              </span>
              <span className="strong">{money(t.spent, true)}</span>
            </p>
            <div className="forge-bars" onMouseLeave={() => setHover(null)}>
              {totals.map((m, i) => (
                <button
                  key={m.month}
                  className={i === shown ? "forge-bar-hit on" : "forge-bar-hit"}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onClick={() => onOpenMonth(m.month)}
                  title="Open this month"
                  aria-label={`${monthLabel(m.month)}: spent ${money(m.spent)}, income ${money(m.income)}`}
                >
                  <span className={m.spent > 0 ? "forge-bar" : "forge-bar zero"} style={m.spent > 0 ? { height: `${Math.max(4, (m.spent / peak) * 100)}%` } : undefined} />
                </button>
              ))}
            </div>
            <p className="forge-axis-row">
              <span>
                {monthLabel(totals[0].month, "short")} {totals[0].month.slice(2, 4)}
              </span>
              <span>peak {money(peak, true)}</span>
              <span>
                {monthLabel(current, "short")} {current.slice(2, 4)}
              </span>
            </p>
            <p className="forge-line">
              income {money(t.income, true)} · net {net < 0 ? "−" : "+"}
              {money(Math.abs(net), true)}
            </p>
          </>
        )}
      </section>

      <section className="cogitator forge-panel" aria-label="Average by category">
        <p className="term-label">
          A usual month · {monthLabel(shiftMonth(lastFull, 1 - AVERAGE_OVER), "short")}–{monthLabel(lastFull, "short")} average
        </p>
        {averages.length === 0 ? (
          <p className="dash-empty">No spending in those months yet.</p>
        ) : (
          <ul className="ledger-budgets">
            {averages.map((a) => {
              const budget = budgetOf(a.name);
              const over = budget != null && a.average > budget;
              return (
                <li key={a.name} className="ledger-budget">
                  <div className="ledger-budget-head">
                    <span className="ledger-budget-name">{a.name}</span>
                    <span className="ledger-budget-amt">
                      {money(a.average, true)}
                      {budget != null && <span className="ledger-dim"> / {money(budget, true)}</span>}
                    </span>
                  </div>
                  <div className="ledger-meter">
                    <span style={{ width: `${(a.average / peakAverage) * 100}%` }} />
                  </div>
                  {over && <span className="ledger-note-line ledger-over">▲ usually over budget by {money(a.average - budget!, true)}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
