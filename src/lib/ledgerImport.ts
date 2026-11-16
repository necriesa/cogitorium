import { addDays, dayLabel, daysBetween, kindOf, money, nextDue, type Bill, type Category, type Entry, type EntryKind } from "./ledger";

/**
 * Reading a bank's CSV export into Tithe-Ledger entries. Built for Westpac
 * (`Bank Account, Date, Narrative, Debit Amount, Credit Amount, Balance, ...`,
 * dates as DD/MM/YYYY), but the columns are found by name, so most banks'
 * exports work: one signed Amount column, or Debit and Credit columns, and
 * CommBank's headerless `date, amount, description, balance` too.
 *
 * Nothing here writes anything: `planImport` lines the bank's rows up against
 * the ledger (already imported, maybe logged by hand, a bill, a transfer) and
 * guesses a category for each, and the Import tab lets you check it first.
 */

export type BankRow = {
  date: string;
  kind: EntryKind;
  cents: number;
  /** The bank's description, as exported. */
  raw: string;
  /** The bank's own transaction type column, if any (Westpac: Categories). */
  type: string;
};

export type BankFile = {
  rows: BankRow[];
  /** "Westpac" when the columns look like Westpac's, otherwise "your bank". */
  bank: string;
  /** The last four digits of the account, when the file says. */
  account: string;
  /** Lines that weren't transactions (bad dates, no amount). */
  skipped: number;
};

// ---------------------------------------------------------------- CSV

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. Blank lines dropped. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "15/11/2026", "15/11/26", "2026-11-15", "15 Nov 2026", "15-Nov-26" -> "2026-11-15". Days come first (Australian order). */
export function parseBankDate(text: string): string | null {
  const read = (t: string): string | null => {
    let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    if (r) return isoDate(+r[1], +r[2], +r[3]);
    r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
    if (r) return isoDate(r[3].length === 2 ? 2000 + +r[3] : +r[3], +r[2], +r[1]);
    r = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{2}|\d{4})$/.exec(t);
    if (r) return isoDate(r[3].length === 2 ? 2000 + +r[3] : +r[3], MONTH_NAMES.indexOf(r[2].toLowerCase()) + 1, +r[1]);
    return null;
  };
  const t = text.trim();
  // A time after the date ("15/11/2026 00:00") is ignored.
  return read(t) ?? read(t.split(/[\sT]/)[0]);
}

/** "-12.50", "(12.50)", "$1,234.56", "12.50-" -> signed cents; null if it isn't a number. */
export function signedCents(text: string): number | null {
  let t = text.trim().replace(/[$,\s]|AUD/gi, "");
  if (!t) return null;
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (/^[-−]/.test(t)) {
    negative = !negative;
    t = t.slice(1);
  } else if (t.startsWith("+")) t = t.slice(1);
  if (t.endsWith("-")) {
    negative = !negative;
    t = t.slice(0, -1);
  }
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return negative ? -cents : cents;
}

const COLUMNS = {
  date: /^((transaction|tran|posted|posting|value|effective) )?date$|^date posted$/,
  text: /^(narrative|description|details|transaction details|transaction description|memo|payee|particulars)$/,
  debit: /^(debit( amount)?|debits|withdrawals?( amount)?|money out|paid out)$/,
  credit: /^(credit( amount)?|credits|deposits?( amount)?|money in|paid in)$/,
  amount: /^((transaction )?amount|value)$/,
  account: /^(bank account|account|account (no|number)|bsb account)$/,
  type: /^(categories|category|type|tran code|transaction type)$/,
};

/**
 * Reads a bank export. Throws an Error that says what was wrong (in words
 * for the Import tab) when it can't find dates and amounts.
 */
export function readBankCsv(text: string): BankFile {
  const table = parseCsv(text);
  if (table.length === 0) throw new Error("That file is empty.");
  const norm = (h: string) => h.trim().toLowerCase().replace(/[_\s]+/g, " ");

  // The header is the first line (of the first few) with a date column.
  let headerAt = -1;
  let col = { date: -1, text: -1, debit: -1, credit: -1, amount: -1, account: -1, type: -1 };
  for (let i = 0; i < Math.min(table.length, 10) && headerAt < 0; i++) {
    const h = table[i].map(norm);
    const find = (re: RegExp) => h.findIndex((x) => re.test(x));
    const c = {
      date: find(COLUMNS.date),
      text: find(COLUMNS.text),
      debit: find(COLUMNS.debit),
      credit: find(COLUMNS.credit),
      amount: find(COLUMNS.amount),
      account: find(COLUMNS.account),
      type: find(COLUMNS.type),
    };
    if (c.date >= 0 && (c.amount >= 0 || c.debit >= 0 || c.credit >= 0)) {
      headerAt = i;
      col = c;
    }
  }
  let bank = "your bank";
  if (headerAt < 0) {
    // CommBank-style: no header, "date, signed amount, description, balance".
    const first = table[0];
    if (first.length >= 3 && parseBankDate(first[0]) && signedCents(first[1]) != null) {
      col = { date: 0, amount: 1, text: 2, debit: -1, credit: -1, account: -1, type: -1 };
    } else {
      throw new Error("Couldn't find the date and amount columns. Export your transactions as CSV (not PDF, QIF or OFX) and try again.");
    }
  } else {
    const h = table[headerAt].map(norm);
    if (h.includes("narrative") && (h.includes("debit amount") || h.includes("credit amount"))) bank = "Westpac";
  }

  const rows: BankRow[] = [];
  let skipped = 0;
  let account = "";
  for (const r of table.slice(headerAt + 1)) {
    const date = parseBankDate(r[col.date] ?? "");
    let cents: number | null = null;
    if (col.amount >= 0 && (r[col.amount] ?? "").trim()) cents = signedCents(r[col.amount]);
    else {
      const out = col.debit >= 0 ? signedCents(r[col.debit] ?? "") : null;
      const inn = col.credit >= 0 ? signedCents(r[col.credit] ?? "") : null;
      if (out) cents = -Math.abs(out);
      else if (inn) cents = Math.abs(inn);
    }
    if (!date || !cents) {
      skipped++;
      continue;
    }
    if (!account && col.account >= 0) account = (r[col.account] ?? "").replace(/\D/g, "").slice(-4);
    rows.push({
      date,
      kind: cents < 0 ? "out" : "in",
      cents: Math.min(Math.abs(cents), 1_000_000_000),
      raw: (col.text >= 0 ? r[col.text] : "")?.trim() ?? "",
      type: (col.type >= 0 ? r[col.type] : "")?.trim() ?? "",
    });
  }
  if (rows.length === 0) throw new Error("No transactions in that file.");
  return { rows, bank, account, skipped };
}

// ---------------------------------------------------------------- descriptions

/** Bank wording in front of the merchant, longest first. */
const PREFIXES = [
  "debit card purchase",
  "debit card refund",
  "visa debit purchase",
  "visa purchase",
  "eftpos purchase",
  "eftpos debit",
  "eftpos",
  "payment by authority to",
  "payment by authority",
  "deposit-osko payment",
  "withdrawal-osko payment",
  "osko payment",
  "osko deposit",
  "deposit online",
  "withdrawal online",
  "deposit mobile",
  "withdrawal mobile",
  "atm withdrawal",
  "bpay payment",
  "direct debit",
  "direct credit",
  "internet banking",
  "purchase",
  "deposit",
  "withdrawal",
  "bpay",
].sort((a, b) => b.length - a.length);

/** Short names kept in capitals when a description is tidied. */
const ACRONYMS = new Set(["KFC", "AGL", "TPG", "IGA", "ATM", "BWS", "NIB", "HCF", "NSW", "ATO", "ABC", "SBS", "TFR", "RSL", "NRMA", "CBA", "NAB", "ANZ", "UNSW", "USYD", "UTS", "IKEA", "BPAY", "JB"]);

/**
 * A bank description made readable for the note: the "DEBIT CARD PURCHASE"
 * wording, card numbers, value dates, store numbers and "AUS" go, and SHOUTING
 * words are tamed ("WOOLWORTHS 1234 SYDNEY AUS" -> "Woolworths Sydney").
 * Always gives the same note for the same description, which is how a file
 * imported twice is spotted.
 */
export function tidyNarrative(raw: string): string {
  // All capitals (as Westpac sends them): three-letter words are tamed too ("THE", "FEE"), bar known acronyms.
  const shouting = !/[a-z]/.test(raw);
  let s = raw
    .replace(/\bcard\s*x+\d+/gi, " ")
    .replace(/\bvalue date:?\s*\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const lower = s.toLowerCase();
  const prefix = PREFIXES.find((p) => lower === p || lower.startsWith(`${p} `) || lower.startsWith(`${p}-`));
  if (prefix && lower !== prefix) s = s.slice(prefix.length).replace(/^[\s-]+/, "");
  s = s
    .replace(/^(\d+\s+)+/, "")
    .replace(/\s+(AUS|AU|AUSTRALIA)$/i, "")
    .replace(/\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)$/i, "")
    .replace(/\b\d{4,}\b/g, " ")
    // A web address after the merchant ("UBER *EATS HELP.UBER.COM") is noise; one that is the merchant ("NETFLIX.COM") stays.
    .replace(/(\S)\s+\S+\.(com|net|org)(\.au)?\b/gi, "$1")
    .replace(shouting ? /\b[A-Z][A-Z'.]{2,}\b/g : /\b[A-Z][A-Z'.]{3,}\b/g, (w) => (ACRONYMS.has(w) ? w : w[0] + w.slice(1).toLowerCase()))
    .replace(/\|/g, "/")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = raw.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  return s.slice(0, 60).trim();
}

/** The merchant, for remembering categories: its first two words, then its first word. */
export function merchantKeys(note: string): [string, string] | null {
  const words = note
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, " ")
    .split(" ")
    .filter((w) => /[a-z]/.test(w));
  if (words.length === 0) return null;
  return [words.slice(0, 2).join(" "), words[0]];
}

/** Common Australian merchants, for a first guess when the ledger has no history yet. Earlier lines win. */
const HINTS: [category: string, kind: EntryKind, words: string[]][] = [
  ["Groceries", "out", ["woolworths", "coles", "aldi", "iga", "harris farm", "costco", "foodworks", "supermarket"]],
  ["Eating out", "out", ["uber eats", "uber *eats", "menulog", "doordash", "mcdonalds", "kfc", "hungry jacks", "guzman", "oporto", "subway", "dominos", "cafe", "coffee", "restaurant", "sushi", "pizza", "ramen", "bakery"]],
  ["Transport", "out", ["opal", "transport for nsw", "transportfornsw", "uber", "didi", "ola", "13cabs", "shell", "ampol", "caltex", "bp", "7-eleven", "linkt", "eastlink", "parking", "petrol"]],
  ["Utilities", "out", ["agl", "origin energy", "energyaustralia", "red energy", "sydney water", "jemena", "alinta"]],
  ["Phone and internet", "out", ["telstra", "optus", "vodafone", "tpg", "aussie broadband", "iinet", "belong", "amaysim", "boost mobile"]],
  ["Subscriptions", "out", ["netflix", "spotify", "disney", "stan", "binge", "kayo", "youtube", "apple.com", "amazon prime", "prime video", "chatgpt", "openai", "anthropic", "claude.ai", "icloud"]],
  ["Health", "out", ["chemist warehouse", "priceline", "pharmacy", "chemist", "medicare", "bupa", "medibank", "nib", "hcf", "dental", "physio", "medical"]],
  ["Fitness", "out", ["gym", "fitness", "anytime fitness", "jetts", "f45", "crossfit", "puregym", "plus fitness", "snap fitness", "climbing"]],
  ["Shopping", "out", ["amazon", "kmart", "target", "big w", "jb hi-fi", "jb hi fi", "officeworks", "bunnings", "ikea", "uniqlo", "myer", "david jones", "ebay", "temu", "rebel"]],
  ["Entertainment", "out", ["event cinemas", "hoyts", "cinema", "ticketek", "ticketmaster", "steam", "playstation", "nintendo", "xbox"]],
  ["Travel", "out", ["qantas", "virgin australia", "jetstar", "airbnb", "booking.com", "expedia", "hotel"]],
  ["Pay", "in", ["salary", "payroll", "wages", "pay"]],
  ["Other income", "in", ["interest"]],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HINT_RES = HINTS.map(([category, kind, words]) => ({
  category,
  kind,
  re: new RegExp(`(^|[^a-z])(${words.map(escape).join("|")})([^a-z]|$)`),
}));

function hintFor(text: string, kind: EntryKind, categories: Category[]): string | null {
  const t = text.toLowerCase();
  for (const h of HINT_RES) {
    if (h.kind !== kind || !h.re.test(t)) continue;
    const known = categories.find((c) => c.name.toLowerCase() === h.category.toLowerCase() && c.kind === kind);
    if (known) return known.name;
  }
  return null;
}

/** Money moved between your own accounts (or a credit card repayment), not spent or earned. */
export function looksLikeTransfer(row: BankRow): boolean {
  return /\b(tfr|transfer|xfer)\b|payment\W{0,3}thank you|own account/i.test(row.raw) || /^(tfr|transfer)$/i.test(row.type);
}

// ---------------------------------------------------------------- planning

export type RowStatus = "new" | "duplicate" | "maybe" | "transfer";

export type ImportRow = {
  id: number;
  date: string;
  kind: EntryKind;
  cents: number;
  note: string;
  raw: string;
  category: string;
  /** Where the category came from: a bill, an earlier entry like it, a known merchant, or nothing (a fallback). */
  guess: "bill" | "history" | "hint" | "none" | "you";
  status: RowStatus;
  /** Why it isn't ticked, or which bill it pays. */
  reason: string;
  include: boolean;
  /** The bill this pays (its due date moves on when imported). */
  bill: string;
};

/** How far a bank payment can land from a bill's due date and still be that bill. */
const BILL_EARLY = 4;
const BILL_LATE = 7;
/** How far apart a bank row and an entry logged by hand can be and still be the same money. */
const SAME_WITHIN = 3;

function fallback(kind: EntryKind, categories: Category[]): string {
  const name = kind === "in" ? "Other income" : "Other";
  return categories.find((c) => c.kind === kind && c.name.toLowerCase() === name.toLowerCase())?.name ?? categories.find((c) => c.kind === kind)?.name ?? name;
}

/**
 * Lines the bank's rows up against the ledger:
 * - **duplicate**: the same date, amount and note is already there (the file, or part of it, was imported before). Hidden.
 * - **maybe**: the same amount within three days was logged by hand (or with a bill's Log button). Unticked.
 * - a **bill**: the amount of a bill, near its due date. Gets the bill's category; importing moves the bill on.
 * - **transfer**: between your own accounts. Unticked.
 * Everything else is new, with a category from the last entry for the same
 * merchant, else a known merchant, else Other.
 */
export function planImport(rows: BankRow[], entries: Entry[], categories: Category[], bills: Bill[]): ImportRow[] {
  const plan: ImportRow[] = rows.map((r, id) => ({
    id,
    date: r.date,
    kind: r.kind,
    cents: r.cents,
    note: tidyNarrative(r.raw),
    raw: r.raw,
    category: "",
    guess: "none",
    status: "new",
    reason: "",
    include: true,
    bill: "",
  }));
  const used = new Set<number>();

  // Imported before: exactly the same row.
  for (const p of plan) {
    const i = entries.findIndex(
      (e, j) => !used.has(j) && e.date === p.date && e.kind === p.kind && e.cents === p.cents && e.note.toLowerCase() === p.note.toLowerCase(),
    );
    if (i < 0) continue;
    used.add(i);
    Object.assign(p, { status: "duplicate", category: entries[i].category, guess: "history", reason: "Already in the ledger" });
  }

  // Logged by hand: the same amount a day or three either side.
  for (const p of plan) {
    if (p.status !== "new") continue;
    let best = -1;
    let bestGap = SAME_WITHIN + 1;
    entries.forEach((e, j) => {
      if (used.has(j) || e.kind !== p.kind || e.cents !== p.cents) return;
      const gap = Math.abs(daysBetween(e.date, p.date));
      if (gap < bestGap) {
        best = j;
        bestGap = gap;
      }
    });
    if (best < 0) continue;
    used.add(best);
    const e = entries[best];
    Object.assign(p, {
      status: "maybe",
      category: e.category,
      guess: "history",
      reason: `Logged already? ${money(e.cents)} ${e.category}${e.note && e.note !== e.category ? ` · ${e.note}` : ""} on ${dayLabel(e.date)}`,
    });
  }

  // Bills: each due date in turn takes the first payment of its amount near it.
  for (const bill of bills) {
    const kind = kindOf(bill.category, categories);
    const candidates = plan.filter((p) => p.status === "new" && !p.bill && p.kind === kind && p.cents === bill.cents).sort((a, b) => a.date.localeCompare(b.date));
    let due = bill.next;
    for (const p of candidates) {
      const gap = daysBetween(due, p.date);
      if (gap < -BILL_EARLY) continue;
      if (gap > BILL_LATE) break;
      const category = categories.find((c) => c.name.toLowerCase() === bill.category.toLowerCase())?.name ?? bill.category;
      Object.assign(p, { bill: bill.name, category, guess: "bill", reason: `Pays ${bill.name}, due ${dayLabel(due)}` });
      due = nextDue(due, bill.every);
    }
  }

  // Transfers between your own accounts.
  for (const p of plan) {
    if (p.status === "new" && !p.bill && looksLikeTransfer(rows[p.id])) Object.assign(p, { status: "transfer", reason: "Looks like a transfer between your accounts" });
  }

  // Categories: the merchant's last category, else a known merchant, else Other.
  const seen = new Map<string, string>();
  for (const e of entries) {
    const keys = merchantKeys(e.note);
    if (!keys || e.bill) continue;
    seen.set(`${e.kind}:${keys[0]}`, e.category);
    seen.set(`${e.kind}:1:${keys[1]}`, e.category);
  }
  for (const p of plan) {
    if (p.category) continue;
    const keys = merchantKeys(p.note);
    const remembered = keys && (seen.get(`${p.kind}:${keys[0]}`) ?? seen.get(`${p.kind}:1:${keys[1]}`));
    const hinted = remembered ? null : hintFor(`${p.note} ${p.raw}`, p.kind, categories);
    p.category = remembered || hinted || fallback(p.kind, categories);
    p.guess = remembered ? "history" : hinted ? "hint" : "none";
  }

  // A merchant with no guess takes the category its other rows in this file got (a bill, a known name).
  for (const p of plan) {
    if (p.guess !== "none") continue;
    const key = merchantKeys(p.note)?.[0];
    const twin = key && plan.find((q) => q.guess !== "none" && q.kind === p.kind && merchantKeys(q.note)?.[0] === key);
    if (twin) Object.assign(p, { category: twin.category, guess: "history" });
  }

  for (const p of plan) p.include = p.status === "new";
  return plan.sort((a, b) => b.date.localeCompare(a.date) || a.id - b.id);
}

/**
 * Gives `category` to the row `id` and to the other rows from the same merchant
 * whose category you haven't picked yourself (and that aren't bills).
 */
export function recategorise(plan: ImportRow[], id: number, category: string): ImportRow[] {
  const row = plan.find((p) => p.id === id);
  if (!row) return plan;
  const key = merchantKeys(row.note)?.[0];
  return plan.map((p) => {
    if (p.id === id) return { ...p, category, guess: "you" };
    if (key && p.kind === row.kind && !p.bill && p.guess !== "you" && p.status !== "duplicate" && merchantKeys(p.note)?.[0] === key) return { ...p, category, guess: "history" };
    return p;
  });
}

/** The entries to add and the bills they pay, from the ticked rows. */
export function toImport(plan: ImportRow[]): { entries: Entry[]; billsPaid: string[] } {
  const ticked = plan.filter((p) => p.include);
  return {
    entries: ticked.map((p) => ({ date: p.date, kind: p.kind, category: p.category, cents: p.cents, note: p.note, bill: p.bill })),
    billsPaid: ticked.filter((p) => p.bill).map((p) => p.bill),
  };
}

/** "14 Oct – 16 Nov 2026" for the dates a file covers. */
export function spanLabel(rows: { date: string }[]): string {
  if (rows.length === 0) return "";
  const dates = rows.map((r) => r.date).sort();
  const fmt = (d: string, year: boolean) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: year ? "numeric" : undefined, timeZone: "UTC" });
  const [first, last] = [dates[0], dates[dates.length - 1]];
  if (first === last) return fmt(first, true);
  return `${fmt(first, first.slice(0, 4) !== last.slice(0, 4))} – ${fmt(last, true)}`;
}

/** Made-up Westpac-style export for the browser preview: the last few weeks of the demo ledger's bank account. */
export function sampleWestpacCsv(today: string): string {
  const lines = ["Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial"];
  const row = (daysAgo: number, narrative: string, debit: number | null, credit: number | null, type: string) => {
    const [y, m, d] = addDays(today, -daysAgo).split("-");
    lines.push(`032-000 123456,${d}/${m}/${y},"${narrative}",${debit ?? ""},${credit ?? ""},1000.00,${type},`);
  };
  row(1, "DEBIT CARD PURCHASE WOOLWORTHS 1234 SYDNEY AUS Card xx9999 Value Date: 15/11/2026", 92.4, null, "POS");
  row(2, "DEBIT CARD PURCHASE UBER *EATS HELP.UBER.COM AUS Card xx9999", 31.5, null, "POS");
  row(3, "EFTPOS PURCHASE HARBOUR RAMEN SYDNEY", 24, null, "POS");
  row(3, "WITHDRAWAL-OSKO PAYMENT 7654321 HARBOURSIDE REALTY RENT", 450, null, "OTHER");
  row(4, "DEPOSIT ACME WIDGETS PTY PAYROLL 998877", null, 2100, "DEP");
  row(4, "WITHDRAWAL MOBILE 1234567 TFR Westpac Life", 200, null, "TFR");
  row(5, "DEBIT CARD PURCHASE TRANSPORTFORNSW OPAL CHIPPENDALE AUS", 20, null, "POS");
  row(6, "PAYMENT BY AUTHORITY TO TELSTRA 1234567", 65, null, "OTHER");
  row(8, "DEBIT CARD PURCHASE NETFLIX.COM MELBOURNE AUS", 18.99, null, "POS");
  row(9, "DEPOSIT INTEREST", null, 1.23, "DEP");
  row(10, "DEBIT CARD PURCHASE CHEMIST WAREHOUSE 412 SYDNEY", 27.95, null, "POS");
  row(12, "DEBIT CARD PURCHASE KMART 1066 BROADWAY", 45, null, "POS");
  row(13, "DEBIT CARD PURCHASE THE GROUNDS CAFE ALEXANDRIA", 19.5, null, "POS");
  row(15, "DEBIT CARD PURCHASE BIG BOOK EMPORIUM NEWTOWN", 38, null, "POS");
  return lines.join("\r\n") + "\r\n";
}
