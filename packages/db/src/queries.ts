import type { DB } from "./index.ts";

export interface TransactionFilter {
  q?: string; // matches description, merchant, notes
  dateFrom?: string;
  dateTo?: string;
  accountId?: number;
  categoryId?: number; // includes child categories
  uncategorized?: boolean;
  minCents?: number;
  maxCents?: number;
  tag?: string;
  ids?: number[];
  limit?: number;
  offset?: number;
}

export interface TransactionRow {
  id: number;
  account_id: number;
  account_name: string;
  date: string;
  amount_cents: number;
  raw_description: string;
  merchant: string | null;
  category_id: number | null;
  category: string | null;
  notes: string | null;
  pending: number;
  source: string;
  reviewed: number;
  tags: string | null;
}

/** Category name as "Parent > Child". */
const CATEGORY_PATH_SQL = `CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' > ' || c.name END`;

function buildWhere(f: TransactionFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.q) {
    where.push("(t.raw_description LIKE ? OR t.merchant LIKE ? OR t.notes LIKE ?)");
    const like = `%${f.q}%`;
    params.push(like, like, like);
  }
  if (f.dateFrom) { where.push("t.date >= ?"); params.push(f.dateFrom); }
  if (f.dateTo) { where.push("t.date <= ?"); params.push(f.dateTo); }
  if (f.accountId) { where.push("t.account_id = ?"); params.push(f.accountId); }
  if (f.categoryId) {
    where.push("(t.category_id = ? OR t.category_id IN (SELECT id FROM categories WHERE parent_id = ?))");
    params.push(f.categoryId, f.categoryId);
  }
  if (f.uncategorized) where.push("t.category_id IS NULL");
  if (f.minCents !== undefined) { where.push("t.amount_cents >= ?"); params.push(f.minCents); }
  if (f.maxCents !== undefined) { where.push("t.amount_cents <= ?"); params.push(f.maxCents); }
  if (f.tag) {
    where.push("t.id IN (SELECT tt.transaction_id FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id WHERE g.name = ?)");
    params.push(f.tag);
  }
  if (f.ids?.length) {
    where.push(`t.id IN (${f.ids.map(() => "?").join(",")})`);
    params.push(...f.ids);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export function listTransactions(db: DB, f: TransactionFilter = {}): { rows: TransactionRow[]; total: number } {
  const { sql, params } = buildWhere(f);
  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, a.name AS account_name, t.date, t.amount_cents, t.raw_description,
              t.merchant, t.category_id, ${CATEGORY_PATH_SQL} AS category, t.notes, t.pending,
              t.source, t.reviewed,
              (SELECT group_concat(g.name, ',') FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id
                WHERE tt.transaction_id = t.id) AS tags
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
         ${sql}
         ORDER BY t.date DESC, t.id DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...params, f.limit ?? 200, f.offset ?? 0) as TransactionRow[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM transactions t ${sql}`).get(...params) as { n: number }).n;
  return { rows, total };
}

export interface TransactionPatch {
  categoryId?: number | null;
  merchant?: string | null;
  notes?: string | null;
  reviewed?: boolean;
  addTags?: string[];
  removeTags?: string[];
}

export function updateTransactions(db: DB, ids: number[], patch: TransactionPatch): number {
  if (!ids.length) return 0;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.categoryId !== undefined) { sets.push("category_id = ?"); params.push(patch.categoryId); }
  if (patch.merchant !== undefined) { sets.push("merchant = ?"); params.push(patch.merchant); }
  if (patch.notes !== undefined) { sets.push("notes = ?"); params.push(patch.notes); }
  if (patch.reviewed !== undefined) { sets.push("reviewed = ?"); params.push(patch.reviewed ? 1 : 0); }

  const placeholders = ids.map(() => "?").join(",");
  return db.transaction(() => {
    let changed = 0;
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      changed = db
        .prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id IN (${placeholders})`)
        .run(...params, ...ids).changes;
    }
    for (const tag of patch.addTags ?? []) {
      const tagId = ensureTag(db, tag);
      const ins = db.prepare("INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)");
      for (const id of ids) changed += ins.run(id, tagId).changes;
    }
    for (const tag of patch.removeTags ?? []) {
      changed += db
        .prepare(
          `DELETE FROM transaction_tags WHERE tag_id = (SELECT id FROM tags WHERE name = ?)
             AND transaction_id IN (${placeholders})`,
        )
        .run(tag, ...ids).changes;
    }
    return changed;
  })();
}

export function ensureTag(db: DB, name: string): number {
  db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as { id: number }).id;
}

export interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
  path: string;
  is_income: number;
  is_transfer: number;
}

export function listCategories(db: DB): CategoryRow[] {
  return db
    .prepare(
      `SELECT c.id, c.name, c.parent_id, ${CATEGORY_PATH_SQL} AS path, c.is_income, c.is_transfer
         FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
        ORDER BY path`,
    )
    .all() as CategoryRow[];
}

/** Find a category by id, exact path ("Food > Groceries") or unique leaf name ("Groceries"). */
export function resolveCategory(db: DB, ref: string | number): CategoryRow | undefined {
  const all = listCategories(db);
  if (typeof ref === "number") return all.find((c) => c.id === ref);
  const needle = ref.trim().toLowerCase();
  const byPath = all.find((c) => c.path.toLowerCase() === needle);
  if (byPath) return byPath;
  const byName = all.filter((c) => c.name.toLowerCase() === needle);
  return byName.length === 1 ? byName[0] : undefined;
}

export function listAccounts(db: DB) {
  return db
    .prepare(
      `SELECT a.*, i.name AS institution,
              (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS transaction_count,
              (SELECT MAX(date) FROM transactions t WHERE t.account_id = a.id) AS latest_date
         FROM accounts a LEFT JOIN institutions i ON i.id = a.institution_id
        ORDER BY a.name`,
    )
    .all();
}

export function getOrCreateAccount(db: DB, name: string, type = "depository"): number {
  const row = db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number } | undefined;
  if (row) return row.id;
  return Number(db.prepare("INSERT INTO accounts (name, type) VALUES (?, ?)").run(name, type).lastInsertRowid);
}

export type GroupBy = "category" | "parent_category" | "merchant" | "month" | "account";

/**
 * Totals of money out (spending) and in, grouped. Transfers are excluded by default
 * so credit card payments don't double-count spending.
 */
export function spendingSummary(
  db: DB,
  opts: { groupBy: GroupBy; dateFrom?: string; dateTo?: string; includeTransfers?: boolean; accountId?: number },
) {
  const key: Record<GroupBy, string> = {
    category: `COALESCE(${CATEGORY_PATH_SQL}, 'Uncategorized')`,
    parent_category: "COALESCE(p.name, c.name, 'Uncategorized')",
    merchant: "COALESCE(t.merchant, t.raw_description)",
    month: "substr(t.date, 1, 7)",
    account: "a.name",
  };
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.dateFrom) { where.push("t.date >= ?"); params.push(opts.dateFrom); }
  if (opts.dateTo) { where.push("t.date <= ?"); params.push(opts.dateTo); }
  if (opts.accountId) { where.push("t.account_id = ?"); params.push(opts.accountId); }
  if (!opts.includeTransfers) where.push("COALESCE(c.is_transfer, 0) = 0");
  return db
    .prepare(
      `SELECT ${key[opts.groupBy]} AS key,
              -SUM(CASE WHEN t.amount_cents < 0 THEN t.amount_cents ELSE 0 END) AS spent_cents,
              SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END) AS received_cents,
              SUM(t.amount_cents) AS net_cents,
              COUNT(*) AS count
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        GROUP BY key
        ORDER BY ${opts.groupBy === "month" ? "key" : "spent_cents DESC"}`,
    )
    .all(...params) as { key: string; spent_cents: number; received_cents: number; net_cents: number; count: number }[];
}
