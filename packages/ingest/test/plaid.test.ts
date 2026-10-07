import { beforeAll, describe, expect, it } from "vitest";
import type { TransactionsSyncRequest, TransactionsSyncResponse } from "plaid";
import { listTransactions, openDb, resolveCategory, type DB } from "@finance/db";
import { encrypt, importCsv, linkPlaidAccount, mapPlaidCategory, syncItem, type PlaidClient } from "../src/index.ts";

beforeAll(() => {
  process.env.FINANCE_SECRET_KEY = "test-key";
});

const account = {
  account_id: "acc-1",
  name: "Sapphire",
  official_name: "Chase Sapphire Preferred",
  mask: "1234",
  type: "credit",
  balances: { current: 412.5, iso_currency_code: "USD" },
};

function tx(id: string, date: string, amount: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    transaction_id: id, account_id: "acc-1", date, amount, name, merchant_name: null, pending: false,
    personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" }, ...extra,
  };
}

/** Fake Plaid: each call returns the next scripted page, keyed by cursor. */
function fakeClient(pages: Record<string, Partial<TransactionsSyncResponse>>): PlaidClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async transactionsSync(req: TransactionsSyncRequest) {
      const key = req.cursor ?? "";
      calls.push(key);
      const page = pages[key];
      if (!page) throw new Error(`unexpected cursor ${key}`);
      return { data: { added: [], modified: [], removed: [], accounts: [account], has_more: false, ...page } as TransactionsSyncResponse };
    },
  };
}

function addItem(db: DB): number {
  return Number(
    db.prepare("INSERT INTO plaid_items (plaid_item_id, access_token) VALUES ('item-1', ?)").run(encrypt("access-sandbox-x")).lastInsertRowid,
  );
}

describe("plaid sync", () => {
  it("pages through results, flips signs, categorizes, and saves the cursor", async () => {
    const db = openDb(":memory:");
    const item = addItem(db);
    const client = fakeClient({
      "": { added: [tx("t1", "2026-10-01", 5.5, "BLUE BOTTLE")] as never, has_more: true, next_cursor: "c1" },
      c1: { added: [tx("t2", "2026-10-02", -1000, "PAYROLL", { personal_finance_category: { primary: "INCOME", detailed: "INCOME_WAGES" } })] as never, next_cursor: "c2" },
    });
    const r = await syncItem(db, client, item);
    expect(r).toMatchObject({ added: 2, categorizedByPlaid: 2 });
    const { rows } = listTransactions(db);
    expect(rows.map((t) => [t.amount_cents, t.category])).toEqual([
      [100000, "Income > Paycheck"],
      [-550, "Food > Coffee"],
    ]);
    const acct = db.prepare("SELECT name, type, current_balance_cents FROM accounts").get();
    expect(acct).toEqual({ name: "Chase Sapphire Preferred", type: "credit", current_balance_cents: -41250 });
    expect(db.prepare("SELECT sync_cursor FROM plaid_items").pluck().get()).toBe("c2");

    // Next sync resumes from the saved cursor.
    const next = fakeClient({ c2: { modified: [tx("t1", "2026-10-01", 6.0, "BLUE BOTTLE")] as never, next_cursor: "c3" } });
    await syncItem(db, next, item);
    expect(next.calls).toEqual(["c2"]);
    expect(listTransactions(db, { q: "blue" }).rows[0].amount_cents).toBe(-600);
  });

  it("keeps user labels when a pending charge posts", async () => {
    const db = openDb(":memory:");
    const item = addItem(db);
    await syncItem(db, fakeClient({ "": { added: [tx("p1", "2026-10-01", 20, "SHELL", { pending: true, personal_finance_category: null })] as never, next_cursor: "c1" } }), item);
    const gas = resolveCategory(db, "Gas")!;
    db.prepare("UPDATE transactions SET category_id = ?, notes = 'road trip'").run(gas.id);

    await syncItem(db, fakeClient({
      c1: {
        added: [tx("t1", "2026-10-02", 20, "SHELL", { pending_transaction_id: "p1", personal_finance_category: null })] as never,
        removed: [{ transaction_id: "p1", account_id: "acc-1" }],
        next_cursor: "c2",
      },
    }), item);
    const { rows } = listTransactions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "Transportation > Gas", notes: "road trip", pending: 0 });
  });

  it("merges Plaid rows into CSV history after linking accounts, and CSV re-import stays a no-op", async () => {
    const db = openDb(":memory:");
    const csv = "Date,Description,Amount\n10/01/2026,BLUE BOTTLE COFFEE,-5.50\n09/15/2026,OLD THING,-10.00\n";
    importCsv(db, { text: csv, accountName: "Chase CSV", accountType: "credit" });
    const restaurants = resolveCategory(db, "Restaurants")!;
    db.prepare("UPDATE transactions SET category_id = ? WHERE raw_description LIKE 'BLUE%'").run(restaurants.id);

    const item = addItem(db);
    await syncItem(db, fakeClient({ "": { added: [tx("t1", "2026-10-02", 5.5, "BLUE BOTTLE")] as never, next_cursor: "c1" } }), item);
    expect(listTransactions(db).total).toBe(3);

    const plaidAcct = db.prepare("SELECT id FROM accounts WHERE plaid_account_id = 'acc-1'").pluck().get() as number;
    const csvAcct = db.prepare("SELECT id FROM accounts WHERE name = 'Chase CSV'").pluck().get() as number;
    expect(linkPlaidAccount(db, plaidAcct, csvAcct)).toEqual({ merged: 1 });

    const { rows } = listTransactions(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ category: "Food > Restaurants", source: "plaid", account_id: csvAcct });

    // Plaid updates still find the merged row; CSV re-import adds nothing.
    await syncItem(db, fakeClient({ c1: { modified: [tx("t1", "2026-10-02", 5.75, "BLUE BOTTLE")] as never, next_cursor: "c2" } }), item);
    expect(listTransactions(db, { q: "blue" }).rows[0].amount_cents).toBe(-575);
    expect(importCsv(db, { text: csv, accountName: "Chase CSV" }).added).toBe(0);
  });

  it("records login-required errors on the item", async () => {
    const db = openDb(":memory:");
    const item = addItem(db);
    const failing: PlaidClient = {
      async transactionsSync() {
        throw Object.assign(new Error("400"), { response: { data: { error_code: "ITEM_LOGIN_REQUIRED" } } });
      },
    };
    await expect(syncItem(db, failing, item)).rejects.toThrow();
    expect(db.prepare("SELECT status, error FROM plaid_items").get()).toEqual({ status: "login_required", error: "ITEM_LOGIN_REQUIRED" });
  });

  it("maps Plaid categories by exact match then prefix", () => {
    expect(mapPlaidCategory("FOOD_AND_DRINK_COFFEE")).toBe("Food > Coffee");
    expect(mapPlaidCategory("FOOD_AND_DRINK_FAST_FOOD")).toBe("Food > Restaurants");
    expect(mapPlaidCategory("SOMETHING_NEW")).toBeUndefined();
  });
});
