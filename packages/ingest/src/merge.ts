import type { DB } from "@finance/db";

const MAX_DAY_GAP = 3;

interface Row {
  id: number;
  date: string;
  amount_cents: number;
  category_id: number | null;
  merchant: string | null;
  notes: string | null;
  external_id: string | null;
  plaid_category: string | null;
}

const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;

/**
 * When the same real-world transaction exists both from a CSV export and from Plaid, fold
 * the Plaid row into the CSV row: the CSV row keeps its import hash (so re-importing the file
 * stays a no-op) and its labels, and takes the Plaid transaction id (so later Plaid updates
 * and removals find it). Pairs on same account, same amount, posted dates within 3 days.
 * Pending Plaid rows are left alone because Plaid replaces them when they post.
 */
export function mergeCsvAndPlaid(db: DB, accountId: number): number {
  const csv = db
    .prepare(
      `SELECT id, date, amount_cents, category_id, merchant, notes, external_id, plaid_category FROM transactions
        WHERE account_id = ? AND source = 'csv' AND external_id IS NULL`,
    )
    .all(accountId) as Row[];
  if (!csv.length) return 0;
  const plaid = db
    .prepare(
      `SELECT id, date, amount_cents, category_id, merchant, notes, external_id, plaid_category FROM transactions
        WHERE account_id = ? AND source = 'plaid' AND pending = 0`,
    )
    .all(accountId) as Row[];
  if (!plaid.length) return 0;

  const csvByAmount = new Map<number, Row[]>();
  for (const r of csv) {
    const list = csvByAmount.get(r.amount_cents) ?? [];
    list.push(r);
    csvByAmount.set(r.amount_cents, list);
  }

  const del = db.prepare("DELETE FROM transactions WHERE id = ?");
  const moveTags = db.prepare("UPDATE OR IGNORE transaction_tags SET transaction_id = ? WHERE transaction_id = ?");
  const update = db.prepare(
    `UPDATE transactions SET external_id = ?, source = 'plaid', plaid_category = ?,
            category_id = COALESCE(category_id, ?), notes = COALESCE(notes, ?), updated_at = datetime('now')
      WHERE id = ?`,
  );

  let merged = 0;
  db.transaction(() => {
    for (const p of plaid) {
      const candidates = csvByAmount.get(p.amount_cents);
      if (!candidates?.length) continue;
      let best = -1;
      let bestGap = Infinity;
      candidates.forEach((c, i) => {
        const gap = Math.abs(dayNumber(c.date) - dayNumber(p.date));
        if (gap <= MAX_DAY_GAP && gap < bestGap) { best = i; bestGap = gap; }
      });
      if (best < 0) continue;
      const [match] = candidates.splice(best, 1);
      moveTags.run(match.id, p.id);
      del.run(p.id);
      update.run(p.external_id, p.plaid_category, p.category_id, p.notes, match.id);
      merged++;
    }
  })();
  return merged;
}
