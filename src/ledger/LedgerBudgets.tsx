import { useEffect, useState } from "react";
import { kindOf, money, moneyInput, parseMoney, perMonth, saveCategories, type Category, type EntryKind } from "../lib/ledger";
import type { LedgerData } from "./TitheLedger";

/** A budget box that saves when you leave it (or press Enter); empty means no budget. */
function BudgetField({ category, onSave }: { category: Category; onSave: (budget: number | null) => void }) {
  const shown = category.budget == null ? "" : moneyInput(category.budget);
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => setText(shown), [shown]);
  // Reads the box itself, so a blur straight after typing never sees stale text.
  const commit = (value: string) => {
    const cents = value.trim() ? parseMoney(value) : null;
    if (value.trim() && cents == null) {
      setBad(true);
      return;
    }
    setBad(false);
    if (cents !== category.budget) onSave(cents);
  };
  return (
    <label className="ledger-amount">
      <span className="forge-unit">$</span>
      <input
        className={bad ? "term-input forge-num ledger-bad" : "term-input forge-num"}
        inputMode="decimal"
        value={text}
        placeholder="none"
        aria-label={`Monthly budget for ${category.name}`}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

/**
 * The categories (kept in `Tithe-Ledger/Budgets.md`) and a monthly budget for
 * each spending one. Removing a category keeps the entries already logged under it.
 */
export default function LedgerBudgets({ data, onChanged }: { data: LedgerData; onChanged: () => void }) {
  const { categories, bills } = data;
  const [name, setName] = useState("");
  const [kind, setKind] = useState<EntryKind>("out");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState("");

  const total = categories.reduce((s, c) => s + (c.kind === "out" ? (c.budget ?? 0) : 0), 0);
  const billsOut = bills.filter((b) => kindOf(b.category, categories) === "out").reduce((s, b) => s + perMonth(b), 0);

  function save(list: Category[]) {
    saveCategories(list)
      .then(() => {
        setError("");
        onChanged();
      })
      .catch((e) => setError(String(e)));
  }

  function add() {
    const n = name.trim();
    if (!n) return;
    if (categories.some((c) => c.name.toLowerCase() === n.toLowerCase())) {
      setError(`${n} is already a category`);
      return;
    }
    save([...categories, { name: n, kind, budget: null }]);
    setName("");
  }

  const list = (k: EntryKind) =>
    categories
      .filter((c) => c.kind === k)
      .map((c) => (
        <li key={c.name} className="ledger-cat">
          <span className="ledger-cat-name">{c.name}</span>
          {k === "out" && <BudgetField category={c} onSave={(budget) => save(categories.map((x) => (x.name === c.name ? { ...x, budget } : x)))} />}
          <button
            className={confirm === c.name ? "chip danger" : "chip ledger-x"}
            title="Remove this category (logged entries keep it)"
            aria-label={`Remove ${c.name}`}
            onClick={() => (confirm === c.name ? save(categories.filter((x) => x.name !== c.name)) : setConfirm(c.name))}
            onBlur={() => setConfirm(null)}
          >
            {confirm === c.name ? "Remove" : "×"}
          </button>
        </li>
      ));

  return (
    <div className="forge">
      <section className="cogitator forge-panel ledger-kpis" aria-label="Budget total">
        <div className="ledger-kpi">
          <span className="term-label">Budgeted</span>
          <span className="ledger-kpi-value">{money(total, true)}</span>
          <span className="kpi-sub">a month</span>
        </div>
        {billsOut > 0 && (
          <div className="ledger-kpi">
            <span className="term-label">Bills</span>
            <span className="ledger-kpi-value">{money(billsOut, true)}</span>
            <span className="kpi-sub">a month, on average</span>
          </div>
        )}
      </section>

      <section className="cogitator forge-panel" aria-label="Spending categories">
        <p className="term-label">Spending · monthly budget</p>
        <ul className="ledger-cats">{list("out")}</ul>
      </section>

      <section className="cogitator forge-panel" aria-label="Income categories">
        <p className="term-label">Income</p>
        <ul className="ledger-cats">{list("in")}</ul>
      </section>

      <section className="cogitator forge-panel" aria-label="Add a category">
        <p className="term-label">Add a category</p>
        <form
          className="ledger-form-row"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input className="term-input ledger-note" value={name} placeholder="e.g. Climbing" aria-label="Category name" onChange={(e) => setName(e.target.value)} />
          <div className="chips" role="group" aria-label="Kind">
            <button type="button" className={kind === "out" ? "chip on" : "chip"} aria-pressed={kind === "out"} onClick={() => setKind("out")}>
              Spending
            </button>
            <button type="button" className={kind === "in" ? "chip on" : "chip"} aria-pressed={kind === "in"} onClick={() => setKind("in")}>
              Income
            </button>
          </div>
          <button type="submit" className="chip on" disabled={!name.trim()}>
            Add
          </button>
        </form>
        {error && <p className="footnote error">{error}</p>}
      </section>
    </div>
  );
}
