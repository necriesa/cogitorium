import { useState } from "react";
import {
  billsDue,
  dayLabel,
  dueLabel,
  EVERY,
  EVERY_LABEL,
  kindOf,
  money,
  moneyInput,
  parseMoney,
  perMonth,
  saveBills,
  settleBill,
  settleDate,
  type Bill,
  type Category,
  type Every,
} from "../lib/ledger";
import { today } from "../lib/vaultLog";
import type { LedgerData } from "./TitheLedger";

/** Log and Skip buttons for one bill. */
function SettleKeys({ bill, onChanged, onError }: { bill: Bill; onChanged: () => void; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const settle = (date: string | null) => {
    setBusy(true);
    settleBill(bill.name, date)
      .then(onChanged)
      .catch((e) => onError(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <span className="ledger-bill-keys">
      <button className="chip on" disabled={busy} onClick={() => settle(settleDate(bill))} title={`Log ${money(bill.cents)} on ${dayLabel(settleDate(bill))} and move the due date on`}>
        Log
      </button>
      <button className="chip" disabled={busy} onClick={() => settle(null)} title="Move the due date on without logging anything">
        Skip
      </button>
    </span>
  );
}

/** Bills due within a week (overdue ones first), each with Log and Skip. Nothing when none are due. */
export function DueBills({ bills, onChanged }: { bills: Bill[]; onChanged: () => void }) {
  const [error, setError] = useState("");
  const due = billsDue(bills, 7);
  if (due.length === 0) return null;
  return (
    <section className="cogitator forge-panel" aria-label="Bills due">
      <p className="term-label">Bills due</p>
      <ul className="ledger-bills">
        {due.map((b) => (
          <li key={b.name} className="ledger-bill">
            <span className="ledger-bill-text">
              {b.name} <span className="ledger-dim">· {money(b.cents)}</span>
              <span className={b.next < today() ? "ledger-note-line ledger-over" : "ledger-note-line"}>
                {dueLabel(b.next)} · {dayLabel(b.next)}
              </span>
            </span>
            <SettleKeys bill={b} onChanged={onChanged} onError={setError} />
          </li>
        ))}
      </ul>
      {error && <p className="footnote error">{error}</p>}
    </section>
  );
}

/** The fields of one bill, for adding or editing. */
function BillForm({
  initial,
  categories,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: Bill;
  categories: Category[];
  onSave: (b: Bill) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [amount, setAmount] = useState(initial.cents ? moneyInput(initial.cents) : "");
  const [category, setCategory] = useState(initial.category || categories.find((c) => c.kind === "out")?.name || "Other");
  const [every, setEvery] = useState<Every>(initial.every);
  const [next, setNext] = useState(initial.next);
  const [confirm, setConfirm] = useState(false);
  const cents = parseMoney(amount);
  const ok = name.trim() && cents != null && next;
  const names = categories.map((c) => c.name);
  if (category && !names.includes(category)) names.push(category);

  return (
    <form
      className="ledger-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave({ name: name.trim(), cents: cents!, category, every, next });
      }}
    >
      <label className="term-field">
        <span className="term-label">Bill</span>
        <input className="term-input" value={name} placeholder="e.g. Rent, Phone, Pay" aria-label="Bill name" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="ledger-form-row">
        <label className="ledger-amount">
          <span className="forge-unit">$</span>
          <input className="term-input forge-num" inputMode="decimal" value={amount} placeholder="0.00" aria-label="Amount in dollars" onChange={(e) => setAmount(e.target.value)} />
        </label>
        <select className="term-input ledger-category" value={category} aria-label="Category" onChange={(e) => setCategory(e.target.value)}>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
              {kindOf(n, categories) === "in" ? " (income)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="chips" role="group" aria-label="Repeats">
        {EVERY.map((k) => (
          <button type="button" key={k} className={every === k ? "chip on" : "chip"} aria-pressed={every === k} onClick={() => setEvery(k)}>
            {EVERY_LABEL[k]}
          </button>
        ))}
      </div>
      <label className="term-field">
        <span className="term-label">Next due</span>
        <input className="term-input ledger-date" type="date" value={next} aria-label="Next due" onChange={(e) => setNext(e.target.value)} />
      </label>
      <div className="chips forge-form-keys">
        <button type="submit" className="chip on" disabled={!ok}>
          Save
        </button>
        <button type="button" className="chip" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button type="button" className={confirm ? "chip danger" : "chip"} onClick={() => (confirm ? onDelete() : setConfirm(true))}>
            {confirm ? "Confirm delete" : "Delete"}
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Recurring bills (kept in `Tithe-Ledger/Bills.md`): what each costs, how often,
 * and when it's next due. Log adds it to the ledger and moves the due date on;
 * Skip only moves the date. A bill in an income category (such as Pay) logs as income.
 */
export default function LedgerBills({ data, onChanged }: { data: LedgerData; onChanged: () => void }) {
  // null: list; "": a new bill; a name: editing that bill.
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const { bills, categories } = data;
  const outPerMonth = bills.filter((b) => kindOf(b.category, categories) === "out").reduce((s, b) => s + perMonth(b), 0);
  const inPerMonth = bills.filter((b) => kindOf(b.category, categories) === "in").reduce((s, b) => s + perMonth(b), 0);

  function save(list: Bill[]) {
    saveBills(list)
      .then(() => {
        setEditing(null);
        setError("");
        onChanged();
      })
      .catch((e) => setError(String(e)));
  }

  const blank: Bill = { name: "", cents: 0, category: "", every: "month", next: today() };
  const current = editing ? bills.find((b) => b.name === editing) : null;

  return (
    <div className="forge">
      <section className="cogitator forge-panel ledger-kpis" aria-label="Bills per month">
        <div className="ledger-kpi">
          <span className="term-label">Bills</span>
          <span className="ledger-kpi-value">{money(outPerMonth, true)}</span>
          <span className="kpi-sub">a month, on average</span>
        </div>
        {inPerMonth > 0 && (
          <div className="ledger-kpi">
            <span className="term-label">Regular income</span>
            <span className="ledger-kpi-value">{money(inPerMonth, true)}</span>
            <span className="kpi-sub">a month, on average</span>
          </div>
        )}
      </section>

      {editing != null ? (
        <section className="cogitator forge-panel" aria-label={current ? `Edit ${current.name}` : "New bill"}>
          <p className="term-label">{current ? `Edit ${current.name}` : "New bill"}</p>
          <BillForm
            initial={current ?? blank}
            categories={categories}
            onCancel={() => setEditing(null)}
            onSave={(b) => {
              if (bills.some((x) => x.name.toLowerCase() === b.name.toLowerCase() && x.name !== current?.name)) {
                setError(`There's already a bill called ${b.name}`);
                return;
              }
              save(current ? bills.map((x) => (x.name === current.name ? b : x)) : [...bills, b]);
            }}
            onDelete={current ? () => save(bills.filter((x) => x.name !== current.name)) : undefined}
          />
          {error && <p className="footnote error">{error}</p>}
        </section>
      ) : (
        <section className="cogitator forge-panel" aria-label="Bills">
          <p className="term-label">Bills</p>
          {bills.length === 0 ? (
            <p className="dash-empty">No bills yet. Add rent, your phone plan, subscriptions, or your pay.</p>
          ) : (
            <ul className="ledger-bills">
              {bills.map((b) => (
                <li key={b.name} className="ledger-bill">
                  <button className="ledger-bill-text ledger-link" onClick={() => setEditing(b.name)} title="Edit this bill">
                    {b.name} <span className="ledger-dim">· {money(b.cents)} · {EVERY_LABEL[b.every].toLowerCase()}</span>
                    {kindOf(b.category, categories) === "in" && <span className="forge-kind">income</span>}
                    <span className={b.next < today() ? "ledger-note-line ledger-over" : "ledger-note-line"}>
                      {dueLabel(b.next)} · {dayLabel(b.next)} · {b.category}
                    </span>
                  </button>
                  <SettleKeys bill={b} onChanged={onChanged} onError={setError} />
                </li>
              ))}
            </ul>
          )}
          {error && <p className="footnote error">{error}</p>}
          <button className="dash-link" onClick={() => setEditing("")}>
            + Add a bill
          </button>
        </section>
      )}
    </div>
  );
}
