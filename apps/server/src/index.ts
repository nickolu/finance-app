import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  listAccounts, listCategories, listTransactions, openDb, spendingSummary, updateTransactions,
  type GroupBy, type TransactionPatch,
} from "@finance/db";
import {
  applyRules, connectItem, createLinkToken, createPlaidClient, importCsv, linkPlaidAccount, plaidConfigured, syncAll, syncItem,
} from "@finance/ingest";

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

// ---- Plaid ----
const plaid = plaidConfigured() ? createPlaidClient() : undefined;
const requirePlaid = () => {
  if (!plaid) throw new Error("Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to .env and restart.");
  return plaid;
};

app.onError((e, c) => c.json({ error: e.message }, 400));

app.get("/plaid/status", (c) =>
  c.json({
    configured: !!plaid,
    env: process.env.PLAID_ENV ?? "sandbox",
    items: db
      .prepare("SELECT id, institution_name, status, error, last_synced_at FROM plaid_items ORDER BY institution_name")
      .all(),
  }),
);
app.post("/plaid/link-token", async (c) => {
  const { itemId } = (await c.req.json().catch(() => ({}))) as { itemId?: number };
  return c.json({ link_token: await createLinkToken(db, requirePlaid(), itemId) });
});
app.post("/plaid/exchange", async (c) => {
  const { public_token } = (await c.req.json()) as { public_token: string };
  return c.json(await connectItem(db, requirePlaid(), public_token));
});
app.post("/plaid/sync", async (c) => {
  const { itemId } = (await c.req.json().catch(() => ({}))) as { itemId?: number };
  return c.json(itemId ? await syncItem(db, requirePlaid(), itemId) : await syncAll(db, requirePlaid()));
});
app.post("/accounts/:id/link", async (c) => {
  const { targetAccountId } = (await c.req.json()) as { targetAccountId: number };
  return c.json(linkPlaidAccount(db, Number(c.req.param("id")), targetAccountId));
});

// Plaid webhooks (needs a public URL, e.g. a Cloudflare Tunnel, set as PLAID_WEBHOOK_URL).
// The payload only triggers a sync of a known item, which is safe to repeat, so it isn't trusted beyond that.
app.post("/plaid/webhook", async (c) => {
  const body = (await c.req.json()) as { webhook_type?: string; webhook_code?: string; item_id?: string };
  if (plaid && body.webhook_type === "TRANSACTIONS" && body.webhook_code === "SYNC_UPDATES_AVAILABLE" && body.item_id) {
    const id = db.prepare("SELECT id FROM plaid_items WHERE plaid_item_id = ?").pluck().get(body.item_id) as number | undefined;
    if (id) syncItem(db, plaid, id).catch((e) => console.error(`Webhook sync failed for item ${id}:`, e.message));
  }
  return c.json({ ok: true });
});

// Scheduled sync so new transactions arrive without a webhook.
if (plaid) {
  const hours = Number(process.env.PLAID_SYNC_INTERVAL_HOURS ?? 6);
  const run = () =>
    syncAll(db, plaid)
      .then((r) => console.log(`[${new Date().toISOString()}] Plaid sync:`, JSON.stringify(r)))
      .catch((e) => console.error("Plaid sync failed:", e.message));
  setTimeout(run, 5_000);
  setInterval(run, hours * 3_600_000);
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(`API listening on http://127.0.0.1:${port}/api`);
