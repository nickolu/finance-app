import Papa from "papaparse";
import { createHash } from "node:crypto";
import { getOrCreateAccount, type DB } from "@finance/db";
import { applyRules } from "./rules.ts";

export interface ParsedRow {
  date: string; // YYYY-MM-DD
  amountCents: number; // negative = money out
  description: string;
}

export interface ColumnMapping {
  date: string;
  description: string;
  /** Single signed amount column... */
  amount?: string;
  /** ...or separate debit/credit columns. */
  debit?: string;
  credit?: string;
  /**
   * Flip the sign of the amount column. Many credit card exports show charges as positive;
   * we store money out as negative everywhere.
   */
  invert?: boolean;
}

const DATE_HEADERS = ["date", "transaction date", "trans. date", "posting date", "posted date", "post date"];
const DESC_HEADERS = ["description", "payee", "name", "merchant", "details", "memo", "transaction description"];
const AMOUNT_HEADERS = ["amount", "transaction amount", "amount (usd)"];
const DEBIT_HEADERS = ["debit", "withdrawal", "withdrawals", "debit amount", "money out"];
const CREDIT_HEADERS = ["credit", "deposit", "deposits", "credit amount", "money in"];

function find(headers: string[], candidates: string[]): string | undefined {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c);
    if (i >= 0) return headers[i];
  }
  return undefined;
}

/** Guess column mapping from headers of common bank exports (Chase, Amex, BofA, Capital One, etc.). */
export function detectMapping(headers: string[]): ColumnMapping {
  const date = find(headers, DATE_HEADERS);
  const description = find(headers, DESC_HEADERS);
  const amount = find(headers, AMOUNT_HEADERS);
  const debit = find(headers, DEBIT_HEADERS);
  const credit = find(headers, CREDIT_HEADERS);
  if (!date || !description || (!amount && !debit && !credit)) {
    throw new Error(
      `Could not detect columns from headers: ${headers.join(", ")}. Pass an explicit mapping.`,
    );
  }
  return amount ? { date, description, amount } : { date, description, debit, credit };
}

export function parseAmount(raw: string | undefined): number {
  if (raw === undefined) return 0;
  let s = String(raw).trim();
  if (!s) return 0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.endsWith("-")) { negative = true; s = s.slice(0, -1); }
  if (/\bCR$/i.test(s)) s = s.replace(/\s*CR$/i, "");
  if (/\bDR$/i.test(s)) { negative = true; s = s.replace(/\s*DR$/i, ""); }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); }
  if (s.startsWith("+")) s = s.slice(1);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Bad amount: ${raw}`);
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

export function parseDate(raw: string): string {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // US M/D/Y
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  throw new Error(`Bad date: ${raw}`);
}

export function parseCsv(text: string, mapping?: ColumnMapping): { rows: ParsedRow[]; mapping: ColumnMapping } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: true,
  });
  const m = mapping ?? detectMapping(parsed.meta.fields ?? []);
  const rows: ParsedRow[] = [];
  for (const r of parsed.data) {
    if (!r[m.date]?.trim()) continue;
    let cents: number;
    if (m.amount) {
      cents = parseAmount(r[m.amount]);
    } else {
      // Debit/credit columns: debits are money out regardless of how they're signed in the file.
      const debit = Math.abs(parseAmount(m.debit ? r[m.debit] : undefined));
      const credit = Math.abs(parseAmount(m.credit ? r[m.credit] : undefined));
      cents = credit - debit;
    }
    if (m.invert) cents = -cents;
    rows.push({ date: parseDate(r[m.date]), amountCents: cents, description: (r[m.description] ?? "").trim() });
  }
  return { rows, mapping: m };
}

function normalize(desc: string): string {
  return desc.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Stable dedupe keys. Two identical rows on the same day (e.g. two $5 coffees) get distinct
 * keys via an occurrence index, so re-importing an overlapping file adds nothing but
 * genuine duplicates within a file are kept.
 */
export function hashRows(accountId: number, rows: ParsedRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${accountId}|${r.date}|${r.amountCents}|${normalize(r.description)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return createHash("sha256").update(`${base}|${n}`).digest("hex").slice(0, 32);
  });
}

/** Light cleanup of bank descriptions into a merchant guess: "SQ *BLUE BOTTLE #123 OAKLAND CA" -> "Blue Bottle". */
export function guessMerchant(desc: string): string {
  let s = desc
    .replace(/^(SQ \*|TST\* ?|SP \*|PAYPAL \*|PP\*|POS |DEBIT CARD PURCHASE -?|PURCHASE AUTHORIZED ON \d\d\/\d\d )/i, "")
    .replace(/#\s?\d+.*$/, "")
    .replace(/\s\d{3,}.*$/, "")
    .replace(/\s+[A-Z]{2}$/, "")
    .replace(/[*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = desc.trim();
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export interface ImportResult {
  importId: number;
  accountId: number;
  seen: number;
  added: number;
  skipped: number;
  categorizedByRules: number;
  mapping: ColumnMapping;
}

export function importCsv(
  db: DB,
  opts: { text: string; accountName: string; accountType?: string; filename?: string; mapping?: ColumnMapping; invert?: boolean },
): ImportResult {
  const accountId = getOrCreateAccount(db, opts.accountName, opts.accountType);
  const { rows, mapping } = parseCsv(opts.text, opts.mapping);
  if (opts.invert) for (const r of rows) r.amountCents = -r.amountCents;
  const hashes = hashRows(accountId, rows);

  return db.transaction(() => {
    const importId = Number(
      db
        .prepare("INSERT INTO imports (source, filename, account_id, rows_seen) VALUES ('csv', ?, ?, ?)")
        .run(opts.filename ?? null, accountId, rows.length).lastInsertRowid,
    );
    const insert = db.prepare(
      `INSERT OR IGNORE INTO transactions
         (account_id, date, amount_cents, raw_description, merchant, source, import_hash, import_id)
       VALUES (?, ?, ?, ?, ?, 'csv', ?, ?)`,
    );
    const newIds: number[] = [];
    rows.forEach((r, i) => {
      const res = insert.run(accountId, r.date, r.amountCents, r.description, guessMerchant(r.description), hashes[i], importId);
      if (res.changes) newIds.push(Number(res.lastInsertRowid));
    });
    db.prepare("UPDATE imports SET rows_added = ?, rows_skipped = ? WHERE id = ?").run(
      newIds.length,
      rows.length - newIds.length,
      importId,
    );
    const { updated } = applyRules(db, { transactionIds: newIds });
    return {
      importId,
      accountId,
      seen: rows.length,
      added: newIds.length,
      skipped: rows.length - newIds.length,
      categorizedByRules: updated,
      mapping,
    };
  })();
}
