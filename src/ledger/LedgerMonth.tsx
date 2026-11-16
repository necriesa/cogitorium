import { useEffect, useMemo, useRef, useState } from "react";
import {
  addEntry,
  dayLabel,
  daysInMonth,
  deleteEntry,
  money,
  moneyInput,
  monthLabel,
  monthOf,
  parseMoney,
  shiftMonth,
  summarise,
  updateEntry,
  type Category,
  type Entry,
  type EntryKind,
} from "../lib/ledger";
import { today } from "../lib/vaultLog";
import { DueBills } from "./LedgerBills";
import type { LedgerData } from "./TitheLedger";

type Props = {
  data: LedgerData;
  month: string;
  onMonth: (month: string) => void;
  onChanged: () => void;
};

/** Log money in or out, or (with `original`) change or delete an entry. */
function EntryForm({
  categories,
  original,
  defaultDate,
  onDone,
}: {
  categories: Category[];
  original: Entry | null;
  defaultDate: string;
  onDone: () => void;
}) {
  const firstOf = (kind: EntryKind) => categories.find((c) => c.kind === kind)?.name ?? (kind === "in" ? "Other income" : "Other");
  const [kind, setKind] = useState<EntryKind>(original?.kind ?? "out");
  const [amount, setAmount] = useState(original ? moneyInput(original.cents) : "");
  const [category, setCategory] = useState(original?.category ?? firstOf("out"));
  const [note, setNote] = useState(original?.note ?? "");
  const [date, setDate] = useState(original?.date ?? defaultDate);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const options = categories.filter((c) => c.kind === kind).map((c) => c.name);
  // An entry's category may not be in Budgets.md (typed in Obsidian); keep it on offer.
  if (category && !options.some((o) => o.toLowerCase() === category.toLowerCase())) options.push(category);
  const cents = parseMoney(amount);

  function pickKind(k: EntryKind) {
    setKind(k);
    if (!categories.some((c) => c.kind === k && c.name === category)) setCategory(firstOf(k));
  }

  function run(task: Promise<unknown>, after: () => void) {
    setBusy(true);
    task
      .then(() => {
        setError("");
        after();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }

  function submit() {
    if (cents == null || !date) {
      setError(cents == null ? "Enter an amount, like 42.50" : "Pick a date");
      return;
    }
    const entry: Entry = { date, kind, category, cents, note: note.trim(), bill: original?.bill ?? "" };
    if (original) {
      run(updateEntry(original, entry), onDone);
    } else {
      run(addEntry(entry), () => {
        setAmount("");
        setNote("");
        onDone();
      });
    }
  }

  return (
    <form
      className="ledger-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="chips" role="group" aria-label="Money in or out">
        <button type="button" className={kind === "out" ? "chip on" : "chip"} aria-pressed={kind === "out"} onClick={() => pickKind("out")}>
          Spent
        </button>
        <button type="button" className={kind === "in" ? "chip on" : "chip"} aria-pressed={kind === "in"} onClick={() => pickKind("in")}>
          Income
        </button>
      </div>
      <div className="ledger-form-row">
        <label className="ledger-amount">
          <span className="forge-unit">$</span>
          <input
            className="term-input forge-num"
            inputMode="decimal"
            value={amount}
            placeholder="0.00"
            aria-label="Amount in dollars"
            autoFocus={!!original}
            onChange={(e) => {
              setAmount(e.target.value);
              setError("");
            }}
          />
        </label>
        <select className="term-input ledger-category" value={category} aria-label="Category" onChange={(e) => setCategory(e.target.value)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
      <div className="ledger-form-row">
        <input className="term-input ledger-note" value={note} placeholder="Note (where, what)" aria-label="Note" onChange={(e) => setNote(e.target.value)} />
        <input className="term-input ledger-date" type="date" value={date} aria-label="Date" onChange={(e) => setDate(e.target.value)} />
      </div>
      {error && <p className="footnote error">{error}</p>}
      <div className="chips forge-form-keys">
        <button type="submit" className="chip on" disabled={busy || cents == null}>
          {original ? "Save" : kind === "in" ? "Log income" : "Log spending"}
        </button>
        {original && (
          <>
            <button type="button" className="chip" onClick={onDone}>
              Cancel
            </button>
            <button
              type="button"
              className={confirm ? "chip danger" : "chip"}
              disabled={busy}
              onClick={() => (confirm ? run(deleteEntry(original), onDone) : setConfirm(true))}
            >
              {confirm ? "Confirm delete" : "Delete"}
            </button>
          </>
        )}
      </div>
    </form>
  );
}

/** A spending category against its budget, with a tick for how far through the month we are. */
function BudgetRow({ name, spent, budget, pace }: { name: string; spent: number; budget: number | null; pace: number | null }) {
  const over = budget != null && spent > budget;
  return (
    <li className="ledger-budget">
      <div className="ledger-budget-head">
        <span className="ledger-budget-name">{name}</span>
        <span className="ledger-budget-amt">
          {money(spent, true)}
          {budget != null && <span className="ledger-dim"> / {money(budget, true)}</span>}
        </span>
      </div>
      {budget != null && (
        <div className="ledger-meter" role="img" aria-label={`${name}: ${money(spent)} of ${money(budget)}`}>
          <span className={over ? "over" : ""} style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} />
          {pace != null && <i className="ledger-pace" style={{ left: `${pace * 100}%` }} />}
        </div>
      )}
      <span className={over ? "ledger-note-line ledger-over" : "ledger-note-line"}>
        {budget == null ? "no budget" : over ? `▲ over by ${money(spent - budget)}` : `${money(budget - spent)} left`}
      </span>
    </li>
  );
}

/**
 * One month of the ledger: totals against the budgets, bills coming due, the
 * form to log money in and out, each category against its budget, and every
 * entry (click one to change or delete it).
 */
export default function LedgerMonth({ data, month, onMonth, onChanged }: Props) {
  const [editing, setEditing] = useState<Entry | null>(null);
  const formRef = useRef<HTMLElement>(null);
  // Clicking an entry far down the list brings the form up to it.
  useEffect(() => {
    if (editing) formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [editing]);
  const now = today();
  const current = monthOf(now);
  const summary = useMemo(() => summarise(data.entries, data.categories, month), [data, month]);
  const entries = useMemo(
    () => data.entries.filter((e) => monthOf(e.date) === month).sort((a, b) => b.date.localeCompare(a.date)),
    [data.entries, month],
  );
  const days = useMemo(() => {
    const out: { date: string; entries: Entry[] }[] = [];
    for (const e of entries) {
      const last = out[out.length - 1];
      if (last?.date === e.date) last.entries.push(e);
      else out.push({ date: e.date, entries: [e] });
    }
    return out;
  }, [entries]);

  // How far through the month we are, for the pace ticks (this month only).
  const pace = month === current ? Number(now.slice(8, 10)) / daysInMonth(month) : null;
  const net = summary.income - summary.spent;
  const defaultDate = month === current ? now : month < current ? `${month}-${String(daysInMonth(month)).padStart(2, "0")}` : `${month}-01`;
  const left = summary.left;

  return (
    <div className="forge">
      <section className="cogitator forge-panel forge-day" aria-label="Month">
        <button className="forge-step" onClick={() => onMonth(shiftMonth(month, -1))} aria-label="Previous month">
          ‹
        </button>
        <div className="forge-date">
          <span className="forge-date-main">{monthLabel(month)}</span>
          <span className="forge-date-rel">{month === current ? `day ${Number(now.slice(8, 10))} of ${daysInMonth(month)}` : month < current ? "past" : "ahead"}</span>
        </div>
        <button className="forge-step" onClick={() => onMonth(shiftMonth(month, 1))} aria-label="Next month">
          ›
        </button>
        {month !== current && (
          <button className="lib-toggle forge-today" onClick={() => onMonth(current)}>
            Now
          </button>
        )}
      </section>

      <section className="cogitator forge-panel ledger-kpis" aria-label="Totals">
        <div className="ledger-kpi">
          <span className="term-label">Spent</span>
          <span className="ledger-kpi-value">{money(summary.spent, true)}</span>
          <span className="kpi-sub">{summary.budget ? `of ${money(summary.budget, true)} budget` : "no budgets set"}</span>
        </div>
        <div className="ledger-kpi">
          <span className="term-label">Income</span>
          <span className="ledger-kpi-value">{money(summary.income, true)}</span>
          <span className="kpi-sub">
            net {net < 0 ? "−" : "+"}
            {money(Math.abs(net), true)}
          </span>
        </div>
        {summary.budget > 0 && (
          <div className="ledger-kpi">
            <span className="term-label">{left < 0 ? "Over" : "Left"}</span>
            <span className={left < 0 ? "ledger-kpi-value ledger-over" : "ledger-kpi-value"}>{money(Math.abs(left), true)}</span>
            <span className="kpi-sub">in budgeted categories</span>
          </div>
        )}
      </section>

      {month === current && <DueBills bills={data.bills} onChanged={onChanged} />}

      <section ref={formRef} className="cogitator forge-panel" aria-label={editing ? "Change entry" : "Log money"}>
        <p className="term-label">{editing ? "Change entry" : "Log money"}</p>
        <EntryForm
          key={editing ? JSON.stringify(editing) : `new-${month}`}
          categories={data.categories}
          original={editing}
          defaultDate={defaultDate}
          onDone={() => {
            setEditing(null);
            onChanged();
          }}
        />
      </section>

      <section className="cogitator forge-panel" aria-label="Budgets this month">
        <p className="term-label">Budgets</p>
        {summary.categories.length === 0 ? (
          <p className="dash-empty">Nothing spent yet. Set monthly budgets on the Budgets tab.</p>
        ) : (
          <ul className="ledger-budgets">
            {summary.categories.map((c) => (
              <BudgetRow key={c.name} name={c.name} spent={c.spent} budget={c.budget} pace={pace} />
            ))}
          </ul>
        )}
        {pace != null && summary.budget > 0 && <p className="ledger-note-line">The tick on each bar is where you'd be spending evenly through the month.</p>}
      </section>

      <section className="cogitator forge-panel" aria-label="Entries">
        <p className="term-label">Entries</p>
        {days.length === 0 ? (
          <p className="dash-empty">Nothing logged in {monthLabel(month)}.</p>
        ) : (
          days.map((d) => (
            <div key={d.date} className="ledger-day">
              <p className="ledger-day-head">{dayLabel(d.date)}</p>
              <ul className="ledger-entries">
                {d.entries.map((e, i) => (
                  <li key={i}>
                    <button className={e === editing ? "ledger-entry on" : "ledger-entry"} onClick={() => setEditing(e)} title="Change or delete">
                      <span className="ledger-entry-text">
                        {e.category}
                        {e.note && e.note !== e.category && <span className="ledger-dim"> · {e.note}</span>}
                        {e.bill && <span className="forge-kind">bill</span>}
                      </span>
                      <span className="ledger-entry-amt">
                        {e.kind === "in" ? "+" : "−"}
                        {money(e.cents)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
