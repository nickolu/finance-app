import { ensureTag, type DB } from "@finance/db";

export interface Rule {
  id: number;
  priority: number;
  match_description: string | null;
  match_merchant: string | null;
  match_account_id: number | null;
  match_min_cents: number | null;
  match_max_cents: number | null;
  set_category_id: number | null;
  set_merchant: string | null;
  add_tag: string | null;
}

interface Tx {
  id: number;
  account_id: number;
  amount_cents: number;
  raw_description: string;
  merchant: string | null;
  category_id: number | null;
}

export function ruleMatches(rule: Rule, tx: Tx): boolean {
  if (rule.match_description && !new RegExp(rule.match_description, "i").test(tx.raw_description)) return false;
  if (rule.match_merchant && !new RegExp(rule.match_merchant, "i").test(tx.merchant ?? "")) return false;
  if (rule.match_account_id && rule.match_account_id !== tx.account_id) return false;
  if (rule.match_min_cents !== null && tx.amount_cents < rule.match_min_cents) return false;
  if (rule.match_max_cents !== null && tx.amount_cents > rule.match_max_cents) return false;
  return true;
}

/**
 * Apply rules to transactions. By default only touches uncategorized transactions so
 * manual labels are never overwritten. Lower priority number wins; first matching rule
 * that sets a category decides it.
 */
export function applyRules(
  db: DB,
  opts: { transactionIds?: number[]; onlyUncategorized?: boolean; ruleIds?: number[] } = {},
): { matched: number; updated: number } {
  const onlyUncategorized = opts.onlyUncategorized ?? true;
  let rules = db.prepare("SELECT * FROM rules ORDER BY priority, id").all() as Rule[];
  if (opts.ruleIds) rules = rules.filter((r) => opts.ruleIds!.includes(r.id));
  if (!rules.length) return { matched: 0, updated: 0 };

  const where: string[] = [];
  if (onlyUncategorized) where.push("category_id IS NULL");
  if (opts.transactionIds) where.push(`id IN (${opts.transactionIds.map(Number).join(",") || "NULL"})`);
  const txs = db
    .prepare(
      `SELECT id, account_id, amount_cents, raw_description, merchant, category_id FROM transactions
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
    )
    .all() as Tx[];

  const setCategory = db.prepare("UPDATE transactions SET category_id = ?, updated_at = datetime('now') WHERE id = ?");
  const setMerchant = db.prepare("UPDATE transactions SET merchant = ?, updated_at = datetime('now') WHERE id = ?");
  const addTag = db.prepare("INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)");

  let matched = 0;
  let updated = 0;
  db.transaction(() => {
    for (const tx of txs) {
      let categorySet = false;
      let merchantSet = false;
      let hit = false;
      for (const rule of rules) {
        if (!ruleMatches(rule, tx)) continue;
        hit = true;
        if (rule.set_category_id && !categorySet) {
          updated += setCategory.run(rule.set_category_id, tx.id).changes;
          categorySet = true;
        }
        if (rule.set_merchant && !merchantSet) {
          setMerchant.run(rule.set_merchant, tx.id);
          tx.merchant = rule.set_merchant;
          merchantSet = true;
        }
        if (rule.add_tag) addTag.run(tx.id, ensureTag(db, rule.add_tag));
      }
      if (hit) matched++;
    }
  })();
  return { matched, updated };
}
