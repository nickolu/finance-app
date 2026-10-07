import { describe, expect, it } from "vitest";
import { listTransactions, openDb, resolveCategory, spendingSummary } from "@finance/db";
import { applyRules, guessMerchant, importCsv, parseAmount, parseCsv, parseDate } from "../src/index.ts";

const chase = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
10/01/2026,10/02/2026,SQ *BLUE BOTTLE #123,Food & Drink,Sale,-5.50,
10/01/2026,10/02/2026,SQ *BLUE BOTTLE #123,Food & Drink,Sale,-5.50,
10/03/2026,10/03/2026,WHOLEFDS MKT 10234,Groceries,Sale,-82.17,
10/05/2026,10/05/2026,Payment Thank You-Mobile,,Payment,500.00,
`;

const bank = `Date,Description,Withdrawals,Deposits,Balance
2026-10-01,ACME PAYROLL,,"3,200.00",5000
2026-10-02,RENT PAYMENT,"1,800.00",,3200
`;

describe("parsing", () => {
  it("parses amounts in common formats", () => {
    expect(parseAmount("-5.50")).toBe(-550);
    expect(parseAmount("$1,234.56")).toBe(123456);
    expect(parseAmount("(12.00)")).toBe(-1200);
    expect(parseAmount("12.00-")).toBe(-1200);
    expect(parseAmount("")).toBe(0);
  });
  it("parses dates", () => {
    expect(parseDate("10/1/2026")).toBe("2026-10-01");
    expect(parseDate("2026-10-01")).toBe("2026-10-01");
    expect(parseDate("10/01/26")).toBe("2026-10-01");
  });
  it("detects debit/credit columns", () => {
    const { rows } = parseCsv(bank);
    expect(rows.map((r) => r.amountCents)).toEqual([320000, -180000]);
  });
  it("cleans merchants", () => {
    expect(guessMerchant("SQ *BLUE BOTTLE #123")).toBe("Blue Bottle");
  });
});

describe("import", () => {
  it("dedupes re-imports but keeps same-day duplicates", () => {
    const db = openDb(":memory:");
    const first = importCsv(db, { text: chase, accountName: "Chase", accountType: "credit" });
    expect(first.added).toBe(4);
    const again = importCsv(db, { text: chase, accountName: "Chase" });
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(4);
  });

  it("applies rules on import and summarizes excluding transfers", () => {
    const db = openDb(":memory:");
    const groceries = resolveCategory(db, "Groceries")!;
    const ccPayment = resolveCategory(db, "Credit Card Payment")!;
    db.prepare("INSERT INTO rules (match_description, set_category_id) VALUES (?, ?)").run("wholefds", groceries.id);
    db.prepare("INSERT INTO rules (match_description, set_category_id) VALUES (?, ?)").run("^payment thank you", ccPayment.id);
    const r = importCsv(db, { text: chase, accountName: "Chase" });
    expect(r.categorizedByRules).toBe(2);

    const summary = spendingSummary(db, { groupBy: "parent_category" });
    expect(summary.find((s) => s.key === "Food")?.spent_cents).toBe(8217);
    expect(summary.find((s) => s.key === "Transfers")).toBeUndefined();
    expect(listTransactions(db, { uncategorized: true }).total).toBe(2);
  });

  it("does not overwrite manual labels when rules re-run", () => {
    const db = openDb(":memory:");
    importCsv(db, { text: chase, accountName: "Chase" });
    const coffee = resolveCategory(db, "Coffee")!;
    const restaurants = resolveCategory(db, "Restaurants")!;
    db.prepare("UPDATE transactions SET category_id = ? WHERE raw_description LIKE '%BLUE BOTTLE%'").run(restaurants.id);
    db.prepare("INSERT INTO rules (match_merchant, set_category_id) VALUES (?, ?)").run("blue bottle", coffee.id);
    applyRules(db);
    expect(listTransactions(db, { categoryId: restaurants.id }).total).toBe(2);
  });
});
