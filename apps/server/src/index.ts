import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  listAccounts, listCategories, listTransactions, openDb, spendingSummary, updateTransactions,
  type GroupBy, type TransactionPatch,
} from "@finance/db";
import { applyRules, importCsv } from "@finance/ingest";

const db = openDb();
const app = new Hono().basePath("/api");

const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));

app.get("/transactions", (c) => {
  const q = c.req.query();
  return c.json(
    listTransactions(db, {
      q: q.q,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      accountId: num(q.accountId),
      categoryId: num(q.categoryId),
      uncategorized: q.uncategorized === "true",
      tag: q.tag,
      limit: num(q.limit),
      offset: num(q.offset),
    }),
  );
});

app.patch("/transactions", async (c) => {
  const body = (await c.req.json()) as { ids: number[] } & TransactionPatch;
  const { ids, ...patch } = body;
  return c.json({ changed: updateTransactions(db, ids, patch) });
});

app.get("/categories", (c) => c.json(listCategories(db)));
app.get("/accounts", (c) => c.json(listAccounts(db)));

app.get("/summary", (c) => {
  const q = c.req.query();
  return c.json(
    spendingSummary(db, {
      groupBy: (q.groupBy as GroupBy) ?? "parent_category",
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      accountId: num(q.accountId),
    }),
  );
});

app.post("/import/csv", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  const accountName = String(form.get("account") ?? "");
  if (!(file instanceof File) || !accountName) return c.json({ error: "file and account are required" }, 400);
  try {
    const result = importCsv(db, {
      text: await file.text(),
      filename: file.name,
      accountName,
      accountType: String(form.get("type") ?? "depository"),
      invert: form.get("invert") === "true",
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.get("/rules", (c) => c.json(db.prepare("SELECT * FROM rules ORDER BY priority, id").all()));
app.post("/rules", async (c) => {
  const r = await c.req.json();
  const id = db
    .prepare(
      `INSERT INTO rules (priority, match_description, match_merchant, match_account_id, match_min_cents,
                          match_max_cents, set_category_id, set_merchant, add_tag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.priority ?? 100, r.match_description ?? null, r.match_merchant ?? null, r.match_account_id ?? null,
      r.match_min_cents ?? null, r.match_max_cents ?? null, r.set_category_id ?? null, r.set_merchant ?? null,
      r.add_tag ?? null,
    ).lastInsertRowid;
  const applied = r.apply_to_existing ? applyRules(db, { ruleIds: [Number(id)] }) : undefined;
  return c.json({ id: Number(id), applied });
});
app.delete("/rules/:id", (c) => c.json({ deleted: db.prepare("DELETE FROM rules WHERE id = ?").run(c.req.param("id")).changes }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(`API listening on http://127.0.0.1:${port}/api`);
