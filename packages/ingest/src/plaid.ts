import {
  Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products,
  type AccountBase, type RemovedTransaction, type Transaction, type TransactionsSyncRequest, type TransactionsSyncResponse,
} from "plaid";
import { resolveCategory, type DB } from "@finance/db";
import { guessMerchant } from "./csv.ts";
import { mergeCsvAndPlaid } from "./merge.ts";
import { applyRules } from "./rules.ts";
import { decrypt, encrypt } from "./secrets.ts";

/** The subset of the Plaid client we use, so tests can pass a fake. */
export interface PlaidClient {
  transactionsSync(req: TransactionsSyncRequest): Promise<{ data: TransactionsSyncResponse }>;
}

export function plaidConfigured(): boolean {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

export function createPlaidClient(): PlaidApi {
  if (!plaidConfigured()) throw new Error("Set PLAID_CLIENT_ID and PLAID_SECRET in .env to use Plaid.");
  const env = (process.env.PLAID_ENV ?? "sandbox") as keyof typeof PlaidEnvironments;
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env],
      baseOptions: {
        headers: { "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID!, "PLAID-SECRET": process.env.PLAID_SECRET! },
      },
    }),
  );
}

/** Link token for Plaid Link. Pass an itemId to re-authenticate an existing connection (update mode). */
export async function createLinkToken(db: DB, client: PlaidApi, itemId?: number): Promise<string> {
  const accessToken = itemId ? decrypt(getItem(db, itemId).access_token) : undefined;
  const res = await client.linkTokenCreate({
    user: { client_user_id: "local-user" },
    client_name: "Finance",
    language: "en",
    country_codes: [CountryCode.Us],
    ...(accessToken ? { access_token: accessToken } : { products: [Products.Transactions] }),
    transactions: accessToken ? undefined : { days_requested: 730 },
    webhook: process.env.PLAID_WEBHOOK_URL || undefined,
  });
  return res.data.link_token;
}

/** Exchange the public token from Link, store the (encrypted) access token, and run the first sync. */
export async function connectItem(db: DB, client: PlaidApi, publicToken: string) {
  const { data } = await client.itemPublicTokenExchange({ public_token: publicToken });
  const item = (await client.itemGet({ access_token: data.access_token })).data.item;
  let institutionName: string | null = null;
  if (item.institution_id) {
    const inst = await client.institutionsGetById({ institution_id: item.institution_id, country_codes: [CountryCode.Us] });
    institutionName = inst.data.institution.name;
    db.prepare("INSERT OR IGNORE INTO institutions (name, plaid_institution_id) VALUES (?, ?)").run(institutionName, item.institution_id);
  }
  const institutionId = item.institution_id
    ? (db.prepare("SELECT id FROM institutions WHERE plaid_institution_id = ?").get(item.institution_id) as { id: number }).id
    : null;
  const id = Number(
    db
      .prepare(
        `INSERT INTO plaid_items (institution_id, institution_name, plaid_item_id, access_token) VALUES (?, ?, ?, ?)
         ON CONFLICT(plaid_item_id) DO UPDATE SET access_token = excluded.access_token, status = 'ok', error = NULL
         RETURNING id`,
      )
      .pluck()
      .get(institutionId, institutionName, data.item_id, encrypt(data.access_token)),
  );
  return { itemId: id, institutionName, sync: await syncItem(db, client, id) };
}

interface ItemRow {
  id: number;
  plaid_item_id: string;
  access_token: string;
  sync_cursor: string | null;
  institution_id: number | null;
}

function getItem(db: DB, id: number): ItemRow {
  const row = db.prepare("SELECT * FROM plaid_items WHERE id = ?").get(id) as ItemRow | undefined;
  if (!row) throw new Error(`No Plaid item ${id}`);
  return row;
}

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
  categorizedByRules: number;
  categorizedByPlaid: number;
  mergedWithCsv: number;
}

/** Pull every page from /transactions/sync, restarting if Plaid reports the data changed mid-pagination. */
async function fetchAllPages(client: PlaidClient, accessToken: string, cursor: string | undefined) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const added: Transaction[] = [];
    const modified: Transaction[] = [];
    const removed: RemovedTransaction[] = [];
    let accounts: AccountBase[] = [];
    let next = cursor;
    try {
      for (;;) {
        const { data } = await client.transactionsSync({
          access_token: accessToken,
          cursor: next,
          count: 500,
          options: { include_personal_finance_category: true, include_original_description: true },
        });
        added.push(...data.added);
        modified.push(...data.modified);
        removed.push(...data.removed);
        accounts = data.accounts;
        next = data.next_cursor;
        if (!data.has_more) return { added, modified, removed, accounts, cursor: next };
      }
    } catch (e) {
      if (plaidErrorCode(e) !== "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") throw e;
    }
  }
  throw new Error("Plaid data kept changing during sync; try again shortly.");
}

export function plaidErrorCode(e: unknown): string | undefined {
  return (e as { response?: { data?: { error_code?: string } } }).response?.data?.error_code;
}

const ACCOUNT_TYPE: Record<string, string> = { credit: "credit", loan: "loan", investment: "investment" };

export async function syncItem(db: DB, client: PlaidClient, itemId: number): Promise<SyncResult> {
  const item = getItem(db, itemId);
  let pages: Awaited<ReturnType<typeof fetchAllPages>>;
  try {
    pages = await fetchAllPages(client, decrypt(item.access_token), item.sync_cursor ?? undefined);
  } catch (e) {
    const code = plaidErrorCode(e);
    db.prepare("UPDATE plaid_items SET status = ?, error = ? WHERE id = ?").run(
      code === "ITEM_LOGIN_REQUIRED" ? "login_required" : "error",
      code ?? (e as Error).message,
      itemId,
    );
    throw e;
  }
  const { added, modified, removed, accounts, cursor } = pages;

  return db.transaction(() => {
    // Accounts and balances. Balances are stored signed like transactions: money owed is negative.
    const upsertAccount = db.prepare(
      `INSERT INTO accounts (institution_id, plaid_item_id, plaid_account_id, name, type, mask, currency, current_balance_cents, balance_updated_at)
       VALUES (@institution_id, @item, @plaid_account_id, @name, @type, @mask, @currency, @balance, datetime('now'))
       ON CONFLICT(plaid_account_id) DO UPDATE SET
         current_balance_cents = excluded.current_balance_cents, balance_updated_at = excluded.balance_updated_at, mask = excluded.mask`,
    );
    for (const a of accounts) {
      const type = ACCOUNT_TYPE[a.type] ?? "depository";
      const current = a.balances.current;
      upsertAccount.run({
        institution_id: item.institution_id,
        item: itemId,
        plaid_account_id: a.account_id,
        name: a.official_name || a.name,
        type,
        mask: a.mask ?? null,
        currency: a.balances.iso_currency_code ?? "USD",
        balance: current === null ? null : Math.round((type === "credit" || type === "loan" ? -current : current) * 100),
      });
    }
    const accountIdFor = db.prepare("SELECT id FROM accounts WHERE plaid_account_id = ?").pluck();
    const localAccount = (plaidAccountId: string) => {
      const id = accountIdFor.get(plaidAccountId) as number | undefined;
      if (!id) throw new Error(`Unknown Plaid account ${plaidAccountId}`);
      return id;
    };

    // Plaid amounts are positive for money out; ours are negative for money out.
    const fields = (t: Transaction) => ({
      account_id: localAccount(t.account_id),
      date: t.date,
      amount_cents: -Math.round(t.amount * 100),
      raw_description: t.original_description || t.name || "",
      merchant: t.merchant_name || guessMerchant(t.name || t.original_description || ""),
      pending: t.pending ? 1 : 0,
      external_id: t.transaction_id,
      plaid_category: t.personal_finance_category?.detailed ?? null,
    });

    const insert = db.prepare(
      `INSERT INTO transactions (account_id, date, amount_cents, raw_description, merchant, pending, source, external_id, plaid_category)
       VALUES (@account_id, @date, @amount_cents, @raw_description, @merchant, @pending, 'plaid', @external_id, @plaid_category)
       ON CONFLICT(external_id) DO UPDATE SET date = excluded.date, amount_cents = excluded.amount_cents,
         pending = excluded.pending, raw_description = excluded.raw_description, plaid_category = excluded.plaid_category
       RETURNING id`,
    ).pluck();
    const byExternal = db.prepare("SELECT id, category_id, notes, merchant FROM transactions WHERE external_id = ?");
    const copyLabels = db.prepare(
      "UPDATE transactions SET category_id = ?, notes = COALESCE(notes, ?), merchant = ? WHERE id = ?",
    );
    const copyTags = db.prepare(
      "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) SELECT ?, tag_id FROM transaction_tags WHERE transaction_id = ?",
    );

    const newIds: number[] = [];
    const touchedAccounts = new Set<number>();
    for (const t of added) {
      const f = fields(t);
      const id = insert.get(f) as number;
      newIds.push(id);
      touchedAccounts.add(f.account_id);
      // When a pending charge posts, Plaid removes the pending one and adds a new one; keep the user's labels.
      if (t.pending_transaction_id) {
        const prev = byExternal.get(t.pending_transaction_id) as
          | { id: number; category_id: number | null; notes: string | null; merchant: string | null }
          | undefined;
        if (prev?.category_id) {
          copyLabels.run(prev.category_id, prev.notes, prev.merchant ?? f.merchant, id);
          copyTags.run(id, prev.id);
        }
      }
    }

    const update = db.prepare(
      `UPDATE transactions SET date = @date, amount_cents = @amount_cents, pending = @pending,
         raw_description = @raw_description, plaid_category = @plaid_category, updated_at = datetime('now')
       WHERE external_id = @external_id`,
    );
    for (const t of modified) {
      const f = fields(t);
      update.run(f);
      touchedAccounts.add(f.account_id);
    }

    const del = db.prepare("DELETE FROM transactions WHERE external_id = ?");
    let removedCount = 0;
    for (const r of removed) if (r.transaction_id) removedCount += del.run(r.transaction_id).changes;

    // Labels: user rules first, then Plaid's own category for anything still unlabeled.
    const uncategorizedNew = newIds.filter(
      (id) => db.prepare("SELECT category_id FROM transactions WHERE id = ?").pluck().get(id) === null,
    );
    const { updated: byRules } = applyRules(db, { transactionIds: uncategorizedNew });
    const byPlaid = process.env.PLAID_AUTO_CATEGORIZE === "false" ? 0 : applyPlaidCategories(db, uncategorizedNew);

    let merged = 0;
    for (const accountId of touchedAccounts) merged += mergeCsvAndPlaid(db, accountId);

    db.prepare(
      "UPDATE plaid_items SET sync_cursor = ?, last_synced_at = datetime('now'), status = 'ok', error = NULL WHERE id = ?",
    ).run(cursor, itemId);
    db.prepare("INSERT INTO imports (source, rows_seen, rows_added) VALUES ('plaid', ?, ?)").run(
      added.length + modified.length + removed.length,
      added.length,
    );

    return {
      added: added.length,
      modified: modified.length,
      removed: removedCount,
      categorizedByRules: byRules,
      categorizedByPlaid: byPlaid,
      mergedWithCsv: merged,
    };
  })();
}

export async function syncAll(db: DB, client: PlaidClient) {
  const ids = db.prepare("SELECT id FROM plaid_items").pluck().all() as number[];
  const results: Record<number, SyncResult | { error: string }> = {};
  for (const id of ids) {
    try {
      results[id] = await syncItem(db, client, id);
    } catch (e) {
      results[id] = { error: plaidErrorCode(e) ?? (e as Error).message };
    }
  }
  return results;
}

/**
 * Plaid personal_finance_category (detailed) → our category paths. Exact matches first,
 * then the longest matching prefix.
 */
const PLAID_CATEGORY_MAP: [string, string][] = [
  ["INCOME_WAGES", "Income > Paycheck"],
  ["INCOME_INTEREST_EARNED", "Income > Interest"],
  ["INCOME_DIVIDENDS", "Income > Interest"],
  ["INCOME", "Income > Other Income"],
  ["TRANSFER_IN_ACCOUNT_TRANSFER", "Transfers > Internal Transfer"],
  ["TRANSFER_OUT_ACCOUNT_TRANSFER", "Transfers > Internal Transfer"],
  ["TRANSFER_IN_SAVINGS", "Transfers > Savings / Investing"],
  ["TRANSFER_OUT_SAVINGS", "Transfers > Savings / Investing"],
  ["TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS", "Transfers > Savings / Investing"],
  ["TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS", "Transfers > Savings / Investing"],
  ["LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", "Transfers > Credit Card Payment"],
  ["LOAN_PAYMENTS_MORTGAGE_PAYMENT", "Housing > Rent / Mortgage"],
  ["FOOD_AND_DRINK_GROCERIES", "Food > Groceries"],
  ["FOOD_AND_DRINK_COFFEE", "Food > Coffee"],
  ["FOOD_AND_DRINK", "Food > Restaurants"],
  ["RENT_AND_UTILITIES_RENT", "Housing > Rent / Mortgage"],
  ["RENT_AND_UTILITIES_TELEPHONE", "Housing > Internet & Phone"],
  ["RENT_AND_UTILITIES_INTERNET_AND_CABLE", "Housing > Internet & Phone"],
  ["RENT_AND_UTILITIES", "Housing > Utilities"],
  ["HOME_IMPROVEMENT", "Housing > Home Maintenance"],
  ["TRANSPORTATION_GAS", "Transportation > Gas"],
  ["TRANSPORTATION_PARKING", "Transportation > Parking & Tolls"],
  ["TRANSPORTATION_TOLLS", "Transportation > Parking & Tolls"],
  ["TRANSPORTATION_TAXIS_AND_RIDE_SHARES", "Transportation > Rideshare"],
  ["TRANSPORTATION_PUBLIC_TRANSIT", "Transportation > Public Transit"],
  ["TRANSPORTATION", "Transportation > Auto Maintenance"],
  ["TRAVEL_FLIGHTS", "Travel > Flights"],
  ["TRAVEL_LODGING", "Travel > Lodging"],
  ["TRAVEL", "Travel > Travel Other"],
  ["GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES", "Shopping > Clothing"],
  ["GENERAL_MERCHANDISE_ELECTRONICS", "Shopping > Electronics"],
  ["GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES", "Personal & Family > Gifts"],
  ["GENERAL_MERCHANDISE_PET_SUPPLIES", "Personal & Family > Pets"],
  ["GENERAL_MERCHANDISE", "Shopping > General"],
  ["MEDICAL_PHARMACIES_AND_SUPPLEMENTS", "Health > Pharmacy"],
  ["MEDICAL", "Health > Medical"],
  ["PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS", "Health > Fitness"],
  ["PERSONAL_CARE", "Personal & Family > Personal Care"],
  ["ENTERTAINMENT_TV_AND_MOVIES", "Entertainment > Streaming & Subscriptions"],
  ["ENTERTAINMENT_MUSIC_AND_AUDIO", "Entertainment > Streaming & Subscriptions"],
  ["ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS", "Entertainment > Events"],
  ["ENTERTAINMENT", "Entertainment > Hobbies"],
  ["BANK_FEES", "Financial > Fees"],
  ["GOVERNMENT_AND_NON_PROFIT_DONATIONS", "Financial > Charity"],
  ["GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT", "Financial > Taxes"],
  ["GENERAL_SERVICES_INSURANCE", "Housing > Insurance"],
  ["GENERAL_SERVICES_AUTOMOTIVE", "Transportation > Auto Maintenance"],
  ["GENERAL_SERVICES_CHILDCARE", "Personal & Family > Childcare"],
  ["GENERAL_SERVICES_EDUCATION", "Personal & Family > Education"],
];

export function mapPlaidCategory(detailed: string): string | undefined {
  let best: [string, string] | undefined;
  for (const entry of PLAID_CATEGORY_MAP) {
    if (detailed === entry[0]) return entry[1];
    if (detailed.startsWith(`${entry[0]}_`) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1];
}

function applyPlaidCategories(db: DB, ids: number[]): number {
  if (!ids.length) return 0;
  const rows = db
    .prepare(`SELECT id, plaid_category FROM transactions WHERE category_id IS NULL AND id IN (${ids.map(Number).join(",")})`)
    .all() as { id: number; plaid_category: string | null }[];
  const set = db.prepare("UPDATE transactions SET category_id = ? WHERE id = ?");
  const cache = new Map<string, number | undefined>();
  let n = 0;
  for (const r of rows) {
    if (!r.plaid_category) continue;
    const path = mapPlaidCategory(r.plaid_category);
    if (!path) continue;
    if (!cache.has(path)) cache.set(path, resolveCategory(db, path)?.id);
    const categoryId = cache.get(path);
    if (categoryId) n += set.run(categoryId, r.id).changes;
  }
  return n;
}

/**
 * Point a Plaid account at an account you already imported CSVs into, so history and live
 * data live in one place. Moves the Plaid transactions over and merges duplicates.
 */
export function linkPlaidAccount(db: DB, plaidAccountRowId: number, targetAccountId: number): { merged: number } {
  return db.transaction(() => {
    const src = db.prepare("SELECT * FROM accounts WHERE id = ?").get(plaidAccountRowId) as
      | { id: number; plaid_account_id: string | null; plaid_item_id: number; institution_id: number | null; mask: string | null; current_balance_cents: number | null; balance_updated_at: string | null; type: string }
      | undefined;
    if (!src?.plaid_account_id) throw new Error("Source account is not a Plaid account");
    if (src.id === targetAccountId) return { merged: 0 };
    const target = db.prepare("SELECT plaid_account_id FROM accounts WHERE id = ?").get(targetAccountId) as
      | { plaid_account_id: string | null }
      | undefined;
    if (!target) throw new Error("Target account not found");
    if (target.plaid_account_id) throw new Error("Target account is already connected to Plaid");

    db.prepare("UPDATE transactions SET account_id = ? WHERE account_id = ?").run(targetAccountId, src.id);
    db.prepare("UPDATE imports SET account_id = ? WHERE account_id = ?").run(targetAccountId, src.id);
    db.prepare("UPDATE rules SET match_account_id = ? WHERE match_account_id = ?").run(targetAccountId, src.id);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(src.id);
    db.prepare(
      `UPDATE accounts SET plaid_account_id = ?, plaid_item_id = ?, institution_id = COALESCE(institution_id, ?), mask = ?,
              current_balance_cents = ?, balance_updated_at = ?, type = ? WHERE id = ?`,
    ).run(src.plaid_account_id, src.plaid_item_id, src.institution_id, src.mask, src.current_balance_cents, src.balance_updated_at, src.type, targetAccountId);
    return { merged: mergeCsvAndPlaid(db, targetAccountId) };
  })();
}
