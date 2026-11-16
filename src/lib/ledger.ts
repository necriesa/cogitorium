import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitApp } from "./events";
import { today } from "./vaultLog";

/**
 * The Tithe-Ledger: a budget tracker kept as Markdown notes in the vault
 * (`<log dir>/Tithe-Ledger/`): one note per month of money in and out,
 * `Budgets.md` (categories and monthly budgets) and `Bills.md` (recurring
 * bills). The Rust backend (src-tauri/src/ledger.rs) reads and writes the
 * notes; this module counts the totals. Amounts are whole cents, in AUD.
 * In a plain browser (`npm run dev`) the ledger lives in localStorage,
 * seeded with made-up sample months.
 */

export type EntryKind = "out" | "in";
export type Entry = {
  /** YYYY-MM-DD */
  date: string;
  kind: EntryKind;
  category: string;
  /** Whole cents, always positive. */
  cents: number;
  note: string;
  /** The bill this pays, when logged from Bills; "" otherwise. */
  bill: string;
};
export type Category = { name: string; kind: EntryKind; budget: number | null };
export type Every = "week" | "fortnight" | "month" | "quarter" | "year";
export const EVERY: Every[] = ["week", "fortnight", "month", "quarter", "year"];
export const EVERY_LABEL: Record<Every, string> = {
  week: "Weekly",
  fortnight: "Fortnightly",
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
};
export type Bill = { name: string; cents: number; category: string; every: Every; next: string };

// ---------------------------------------------------------------- money

const AUD = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
const AUD_WHOLE = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

/** 123456 -> "$1,234.56". `whole` rounds to dollars (for charts and big totals). */
export function money(cents: number, whole = false): string {
  return (whole ? AUD_WHOLE : AUD).format(cents / 100);
}

/** "42.5", "$1,234.50" -> cents; null if it isn't a positive amount. */
export function parseMoney(text: string): number | null {
  const t = text.replace(/[$,\s]/g, "").replace(/^AUD/i, "");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return Number.isFinite(cents) && cents > 0 && cents <= 1_000_000_000 ? cents : null;
}

/** Cents as an input value: 4250 -> "42.50". */
export function moneyInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

// ---------------------------------------------------------------- dates

export const monthOf = (date: string) => date.slice(0, 7);

export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const utc = (date: string) => new Date(`${date}T00:00:00Z`);

export function monthLabel(month: string, style: "long" | "short" = "long"): string {
  return utc(`${month}-01`).toLocaleDateString("en-AU", { month: style, year: style === "long" ? "numeric" : undefined, timeZone: "UTC" });
}

/** "Mon 16 Nov" */
export function dayLabel(date: string): string {
  return utc(date).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000);
}

export function addDays(date: string, n: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function addMonths(date: string, n: number): string {
  const month = shiftMonth(monthOf(date), n);
  const day = Math.min(Number(date.slice(8, 10)), daysInMonth(month));
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** The due date after `date` for a bill that repeats `every` (as the backend counts it). */
export function nextDue(date: string, every: Every): string {
  switch (every) {
    case "week":
      return addDays(date, 7);
    case "fortnight":
      return addDays(date, 14);
    case "month":
      return addMonths(date, 1);
    case "quarter":
      return addMonths(date, 3);
    case "year":
      return addMonths(date, 12);
  }
}

/** "overdue 2d", "due today", "due tomorrow", "due in 5d" */
export function dueLabel(next: string, now = today()): string {
  const d = daysBetween(now, next);
  if (d < 0) return `overdue ${-d}d`;
  if (d === 0) return "due today";
  if (d === 1) return "due tomorrow";
  return `due in ${d}d`;
}

// ---------------------------------------------------------------- totals

/** What a bill comes to per month on average, in cents. */
export function perMonth(bill: Bill): number {
  const times: Record<Every, number> = { week: 52 / 12, fortnight: 26 / 12, month: 1, quarter: 1 / 3, year: 1 / 12 };
  return Math.round(bill.cents * times[bill.every]);
}

export type CategoryMonth = { name: string; spent: number; budget: number | null };
export type MonthSummary = {
  month: string;
  spent: number;
  income: number;
  /** Sum of the spending budgets. */
  budget: number;
  /** Budget minus what was spent in budgeted categories (negative when over). */
  left: number;
  /** Spending by category: budgeted ones first (by how far through the budget), then the rest by amount. */
  categories: CategoryMonth[];
};

export function kindOf(category: string, categories: Category[], fallback: EntryKind = "out"): EntryKind {
  return categories.find((c) => c.name.toLowerCase() === category.toLowerCase())?.kind ?? fallback;
}

export function summarise(entries: Entry[], categories: Category[], month: string): MonthSummary {
  const inMonth = entries.filter((e) => monthOf(e.date) === month);
  const spentBy = new Map<string, number>();
  let spent = 0;
  let income = 0;
  for (const e of inMonth) {
    if (e.kind === "in") {
      income += e.cents;
    } else {
      spent += e.cents;
      const known = categories.find((c) => c.name.toLowerCase() === e.category.toLowerCase());
      const name = known?.name ?? e.category;
      spentBy.set(name, (spentBy.get(name) ?? 0) + e.cents);
    }
  }
  const out = categories.filter((c) => c.kind === "out");
  const rows: CategoryMonth[] = out
    .filter((c) => c.budget != null || spentBy.has(c.name))
    .map((c) => ({ name: c.name, spent: spentBy.get(c.name) ?? 0, budget: c.budget }));
  for (const [name, cents] of spentBy) {
    if (!out.some((c) => c.name === name)) rows.push({ name, spent: cents, budget: null });
  }
  rows.sort((a, b) => {
    if ((a.budget != null) !== (b.budget != null)) return a.budget != null ? -1 : 1;
    if (a.budget != null && b.budget != null) return b.spent / b.budget - a.spent / a.budget;
    return b.spent - a.spent;
  });
  const budget = out.reduce((sum, c) => sum + (c.budget ?? 0), 0);
  const left = budget - rows.reduce((sum, c) => sum + (c.budget != null ? c.spent : 0), 0);
  return { month, spent, income, budget, left, categories: rows };
}

export type MonthTotal = { month: string; spent: number; income: number };

/** Money out and in for each of the `count` months up to and including `last`. */
export function monthTotals(entries: Entry[], last: string, count: number): MonthTotal[] {
  const months = Array.from({ length: count }, (_, i) => shiftMonth(last, i - count + 1));
  const by = new Map(months.map((m) => [m, { month: m, spent: 0, income: 0 }]));
  for (const e of entries) {
    const t = by.get(monthOf(e.date));
    if (!t) continue;
    if (e.kind === "in") t.income += e.cents;
    else t.spent += e.cents;
  }
  return months.map((m) => by.get(m)!);
}

/** Average monthly spend per category over the `count` months up to `last`, biggest first. */
export function categoryAverages(entries: Entry[], last: string, count: number): { name: string; average: number }[] {
  const first = shiftMonth(last, -count + 1);
  const by = new Map<string, number>();
  for (const e of entries) {
    const m = monthOf(e.date);
    if (e.kind !== "out" || m < first || m > last) continue;
    by.set(e.category, (by.get(e.category) ?? 0) + e.cents);
  }
  return [...by].map(([name, total]) => ({ name, average: Math.round(total / count) })).sort((a, b) => b.average - a.average);
}

/** Bills due on or before `days` from today (overdue ones included), soonest first. */
export function billsDue(bills: Bill[], days = 7, now = today()): Bill[] {
  return bills.filter((b) => daysBetween(now, b.next) <= days).sort((a, b) => a.next.localeCompare(b.next));
}

/** The date to log a bill on: its due date if that has come, otherwise today (paid early). */
export function settleDate(bill: Bill, now = today()): string {
  return bill.next <= now ? bill.next : now;
}

// ---------------------------------------------------------------- storage

async function demoWrite<T>(fn: () => T): Promise<T> {
  const out = fn();
  await emitApp("ledger-changed");
  return out;
}

export async function listEntries(): Promise<Entry[]> {
  if (isTauri()) return invoke<Entry[]>("ledger_entries");
  return demo.entries();
}

export async function addEntry(entry: Entry): Promise<Entry> {
  if (isTauri()) return invoke<Entry>("ledger_add", { entry });
  return demoWrite(() => {
    demo.writeEntries([...demo.entries(), entry]);
    return entry;
  });
}

/** Replaces `original` (as loaded) with `entry`. */
export async function updateEntry(original: Entry, entry: Entry): Promise<Entry> {
  if (isTauri()) return invoke<Entry>("ledger_update", { original, entry });
  return demoWrite(() => {
    demo.writeEntries([...demo.without(original), entry]);
    return entry;
  });
}

export async function deleteEntry(entry: Entry): Promise<void> {
  if (isTauri()) return invoke("ledger_delete", { entry });
  return demoWrite(() => demo.writeEntries(demo.without(entry)));
}

export async function getCategories(): Promise<Category[]> {
  if (isTauri()) return invoke<Category[]>("ledger_categories");
  return demo.categories();
}

export async function saveCategories(categories: Category[]): Promise<Category[]> {
  if (isTauri()) return invoke<Category[]>("ledger_save_categories", { categories });
  return demoWrite(() => demo.write(CATEGORIES_KEY, categories));
}

export async function getBills(): Promise<Bill[]> {
  if (isTauri()) return invoke<Bill[]>("ledger_bills");
  return [...demo.bills()].sort((a, b) => a.next.localeCompare(b.next));
}

export async function saveBills(bills: Bill[]): Promise<Bill[]> {
  if (isTauri()) return invoke<Bill[]>("ledger_save_bills", { bills });
  return demoWrite(() => demo.write(BILLS_KEY, bills));
}

/** Logs a bill on `date` (null skips it this time) and moves it on to its next due date. */
export async function settleBill(name: string, date: string | null): Promise<Bill[]> {
  if (isTauri()) return invoke<Bill[]>("ledger_settle_bill", { name, date });
  return demoWrite(() => {
    const bills = demo.bills();
    const bill = bills.find((b) => b.name === name);
    if (!bill) throw new Error(`No bill called ${name}`);
    if (date) {
      const kind = kindOf(bill.category, demo.categories());
      demo.writeEntries([...demo.entries(), { date, kind, category: bill.category, cents: bill.cents, note: bill.name, bill: bill.name }]);
    }
    return demo.write(
      BILLS_KEY,
      bills.map((b) => (b.name === name ? { ...b, next: nextDue(b.next, b.every) } : b)),
    );
  });
}

/**
 * Adds entries from a bank import in one go and moves each bill in `billsPaid`
 * on by one period per mention. Returns how many entries were added.
 */
export async function importEntries(entries: Entry[], billsPaid: string[]): Promise<number> {
  if (isTauri()) return invoke<number>("ledger_import", { entries, billsPaid });
  return demoWrite(() => {
    demo.writeEntries([...demo.entries(), ...entries]);
    let bills = demo.bills();
    for (const name of billsPaid) bills = bills.map((b) => (b.name === name ? { ...b, next: nextDue(b.next, b.every) } : b));
    demo.write(BILLS_KEY, bills);
    return entries.length;
  });
}

/** The text of a CSV file dropped on the app window (Tauri only: the webview is given a path). */
export async function readCsvPath(path: string): Promise<string> {
  return invoke<string>("ledger_read_csv", { path });
}

// ---------------------------------------------------------------- browser demo

const ENTRIES_KEY = "tithe-ledger.demo.entries";
const CATEGORIES_KEY = "tithe-ledger.demo.categories";
const BILLS_KEY = "tithe-ledger.demo.bills";

const sameEntry = (a: Entry, b: Entry) =>
  a.date === b.date && a.kind === b.kind && a.category === b.category && a.cents === b.cents && a.note === b.note && a.bill === b.bill;

const SAMPLE_CATEGORIES: Category[] = [
  { name: "Rent", kind: "out", budget: 195_000 },
  { name: "Groceries", kind: "out", budget: 50_000 },
  { name: "Eating out", kind: "out", budget: 20_000 },
  { name: "Transport", kind: "out", budget: 15_000 },
  { name: "Utilities", kind: "out", budget: null },
  { name: "Phone and internet", kind: "out", budget: null },
  { name: "Fitness", kind: "out", budget: null },
  { name: "Subscriptions", kind: "out", budget: 4_000 },
  { name: "Shopping", kind: "out", budget: 15_000 },
  { name: "Entertainment", kind: "out", budget: 10_000 },
  { name: "Other", kind: "out", budget: null },
  { name: "Pay", kind: "in", budget: null },
  { name: "Other income", kind: "in", budget: null },
];

/** Made-up months of spending, so the browser preview has something to show. */
function sampleLedger(): { entries: Entry[]; bills: Bill[] } {
  const t = today();
  const entries: Entry[] = [];
  const add = (date: string, kind: EntryKind, category: string, dollars: number, note: string, bill = "") => {
    if (date <= t) entries.push({ date, kind, category, cents: Math.round(dollars * 100), note, bill });
  };
  const start = addDays(t, -160);
  for (let i = 0; i <= 160; i++) {
    const d = addDays(start, i);
    const dow = utc(d).getUTCDay();
    const n = i % 7;
    if (i % 14 === 3) add(d, "in", "Pay", 2100, "Pay", "Pay");
    if (dow === 1) add(d, "out", "Rent", 450, "Rent", "Rent");
    if (dow === 6) add(d, "out", "Groceries", 85 + ((i * 37) % 60), "Weekly shop");
    if (dow === 3) add(d, "out", "Transport", 18 + (i % 5) * 3, "Opal top-up");
    if (n === 4 && i % 3 !== 0) add(d, "out", "Eating out", 22 + ((i * 13) % 40), i % 2 ? "Ramen" : "Lunch out");
    if (d.endsWith("-12")) add(d, "out", "Phone and internet", 35, "Phone", "Phone");
    if (d.endsWith("-20")) add(d, "out", "Subscriptions", 17.99, "Streaming", "Streaming");
    if (i % 14 === 9) add(d, "out", "Fitness", 26, "Gym", "Gym");
    if (i % 23 === 11) add(d, "out", "Shopping", 40 + ((i * 7) % 90), "Clothes");
    if (i % 31 === 17) add(d, "out", "Entertainment", 32, "Movies");
    if (i % 45 === 20) add(d, "out", "Utilities", 160 + (i % 30), "Electricity");
    if (i === 100) add(d, "in", "Other income", 120, "Sold a monitor");
  }
  const next = (from: string, every: Every) => {
    let d = from;
    while (d <= t) d = nextDue(d, every);
    return d;
  };
  const bills: Bill[] = [
    { name: "Rent", cents: 45_000, category: "Rent", every: "week", next: next(addDays(start, (8 - utc(start).getUTCDay()) % 7), "week") },
    { name: "Pay", cents: 210_000, category: "Pay", every: "fortnight", next: next(addDays(start, 3), "fortnight") },
    { name: "Phone", cents: 3_500, category: "Phone and internet", every: "month", next: next(`${monthOf(start)}-12`, "month") },
    { name: "Streaming", cents: 1_799, category: "Subscriptions", every: "month", next: next(`${monthOf(start)}-20`, "month") },
    { name: "Gym", cents: 2_600, category: "Fitness", every: "fortnight", next: next(addDays(start, 9), "fortnight") },
  ];
  return { entries, bills };
}

const demo = {
  read<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  write<T>(key: string, value: T): T {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage blocked: changes last until reload */
    }
    return value;
  },
  seed() {
    if (demo.read(ENTRIES_KEY)) return;
    const { entries, bills } = sampleLedger();
    demo.write(ENTRIES_KEY, entries);
    demo.write(BILLS_KEY, bills);
    demo.write(CATEGORIES_KEY, SAMPLE_CATEGORIES);
  },
  entries(): Entry[] {
    demo.seed();
    return [...(demo.read<Entry[]>(ENTRIES_KEY) ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  },
  writeEntries(list: Entry[]) {
    demo.write(ENTRIES_KEY, list);
  },
  without(entry: Entry): Entry[] {
    const list = demo.entries();
    const i = list.findIndex((e) => sameEntry(e, entry));
    if (i < 0) throw new Error("That entry has changed since it was loaded. Reload and try again.");
    return list.filter((_, j) => j !== i);
  },
  categories(): Category[] {
    demo.seed();
    return demo.read<Category[]>(CATEGORIES_KEY) ?? SAMPLE_CATEGORIES;
  },
  bills(): Bill[] {
    demo.seed();
    return demo.read<Bill[]>(BILLS_KEY) ?? [];
  },
};
