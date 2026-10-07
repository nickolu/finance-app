// MCP server exposing the finance database to Claude. Runs over stdio:
//   claude mcp add finance -- pnpm --dir /path/to/finance-app mcp
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  listAccounts, listCategories, listTransactions, openDb, resolveCategory, spendingSummary,
  updateTransactions, type TransactionFilter,
} from "@finance/db";
import { applyRules } from "@finance/ingest";

const db = openDb();
const server = new McpServer({ name: "finance", version: "0.1.0" });

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const dollars = (cents: number) => Math.round(cents) / 100;

const filterShape = {
  query: z.string().optional().describe("Text to match in description, merchant or notes"),
  date_from: z.string().optional().describe("YYYY-MM-DD inclusive"),
  date_to: z.string().optional().describe("YYYY-MM-DD inclusive"),
  account_id: z.number().optional(),
  category: z.string().optional().describe('Category path ("Food > Groceries") or unique name; parents include children'),
  uncategorized: z.boolean().optional(),
  min_amount: z.number().optional().describe("Dollars, signed (money out is negative)"),
  max_amount: z.number().optional().describe("Dollars, signed (money out is negative)"),
  tag: z.string().optional(),
  ids: z.array(z.number()).optional(),
};

type FilterArgs = { [K in keyof typeof filterShape]?: z.infer<(typeof filterShape)[K]> };

function toFilter(a: FilterArgs): TransactionFilter {
  let categoryId: number | undefined;
  if (a.category) {
    const cat = resolveCategory(db, a.category);
    if (!cat) throw new Error(`Unknown category "${a.category}". Call list_categories.`);
    categoryId = cat.id;
  }
  return {
    q: a.query,
    dateFrom: a.date_from,
    dateTo: a.date_to,
    accountId: a.account_id,
    categoryId,
    uncategorized: a.uncategorized,
    minCents: a.min_amount === undefined ? undefined : Math.round(a.min_amount * 100),
    maxCents: a.max_amount === undefined ? undefined : Math.round(a.max_amount * 100),
    tag: a.tag,
    ids: a.ids,
  };
}

server.registerTool(
  "search_transactions",
  {
    description: "Find transactions. Amounts are dollars; negative = money out. Returns up to `limit` rows plus the total match count.",
    inputSchema: { ...filterShape, limit: z.number().max(500).default(50), offset: z.number().default(0) },
  },
  async (a) => {
    const { rows, total } = listTransactions(db, { ...toFilter(a), limit: a.limit, offset: a.offset });
    return json({
      total,
      rows: rows.map(({ amount_cents, ...r }) => ({ ...r, amount: dollars(amount_cents) })),
    });
  },
);

server.registerTool(
  "spending_summary",
  {
    description: "Totals grouped by category, parent_category, merchant, month or account. Transfers (e.g. card payments) excluded unless include_transfers.",
    inputSchema: {
      group_by: z.enum(["category", "parent_category", "merchant", "month", "account"]),
      date_from: z.string().optional(),
      date_to: z.string().optional(),
      account_id: z.number().optional(),
      include_transfers: z.boolean().default(false),
      limit: z.number().default(50),
    },
  },
  async (a) =>
    json(
      spendingSummary(db, {
        groupBy: a.group_by,
        dateFrom: a.date_from,
        dateTo: a.date_to,
        accountId: a.account_id,
        includeTransfers: a.include_transfers,
      })
        .slice(0, a.limit)
        .map((r) => ({ key: r.key, spent: dollars(r.spent_cents), received: dollars(r.received_cents), net: dollars(r.net_cents), count: r.count })),
    ),
);

server.registerTool("list_categories", { description: "All categories with their full paths and ids." }, async () =>
  json(listCategories(db).map((c) => ({ id: c.id, path: c.path, income: !!c.is_income, transfer: !!c.is_transfer }))),
);

server.registerTool("list_accounts", { description: "Accounts with balances and transaction counts." }, async () =>
  json(listAccounts(db)),
);

server.registerTool(
  "label_transactions",
  {
    description:
      "Set category / merchant / notes / tags on transactions matching a filter. Always call first with dry_run=true, show the user the count and a sample, then repeat with dry_run=false once they confirm.",
    inputSchema: {
      ...filterShape,
      set_category: z.string().optional().describe("Category path or unique name"),
      clear_category: z.boolean().optional(),
      set_merchant: z.string().optional(),
      set_notes: z.string().optional(),
      add_tags: z.array(z.string()).optional(),
      remove_tags: z.array(z.string()).optional(),
      dry_run: z.boolean().default(true),
    },
  },
  async (a) => {
    const filter = toFilter(a);
    if (Object.values(filter).every((v) => v === undefined)) throw new Error("Refusing to label with an empty filter.");
    const { rows, total } = listTransactions(db, { ...filter, limit: 100000 });
    let categoryId: number | null | undefined;
    if (a.clear_category) categoryId = null;
    else if (a.set_category) {
      const cat = resolveCategory(db, a.set_category);
      if (!cat) throw new Error(`Unknown category "${a.set_category}". Call list_categories.`);
      categoryId = cat.id;
    }
    if (a.dry_run) {
      return json({
        would_change: total,
        sample: rows.slice(0, 10).map((r) => ({ id: r.id, date: r.date, amount: dollars(r.amount_cents), description: r.raw_description, category: r.category })),
      });
    }
    const changed = updateTransactions(
      db,
      rows.map((r) => r.id),
      { categoryId, merchant: a.set_merchant, notes: a.set_notes, addTags: a.add_tags, removeTags: a.remove_tags },
    );
    return json({ matched: total, changed });
  },
);

server.registerTool(
  "create_rule",
  {
    description: "Create an auto-labeling rule applied to future imports. Optionally apply now to existing uncategorized transactions.",
    inputSchema: {
      match_description: z.string().optional().describe("Case-insensitive regex on the raw bank description"),
      match_merchant: z.string().optional().describe("Case-insensitive regex on merchant"),
      match_account_id: z.number().optional(),
      min_amount: z.number().optional(),
      max_amount: z.number().optional(),
      set_category: z.string().optional(),
      set_merchant: z.string().optional(),
      add_tag: z.string().optional(),
      priority: z.number().default(100),
      apply_to_existing: z.boolean().default(true),
    },
  },
  async (a) => {
    if (!a.match_description && !a.match_merchant) throw new Error("A rule needs match_description or match_merchant.");
    const cat = a.set_category ? resolveCategory(db, a.set_category) : undefined;
    if (a.set_category && !cat) throw new Error(`Unknown category "${a.set_category}".`);
    const id = Number(
      db
        .prepare(
          `INSERT INTO rules (priority, match_description, match_merchant, match_account_id, match_min_cents,
                              match_max_cents, set_category_id, set_merchant, add_tag)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          a.priority, a.match_description ?? null, a.match_merchant ?? null, a.match_account_id ?? null,
          a.min_amount === undefined ? null : Math.round(a.min_amount * 100),
          a.max_amount === undefined ? null : Math.round(a.max_amount * 100),
          cat?.id ?? null, a.set_merchant ?? null, a.add_tag ?? null,
        ).lastInsertRowid,
    );
    const applied = a.apply_to_existing ? applyRules(db, { ruleIds: [id] }) : undefined;
    return json({ rule_id: id, applied });
  },
);

server.registerTool(
  "run_sql_readonly",
  {
    description: "Run a read-only SQL query against the SQLite database for ad-hoc analysis. Tables: transactions (amount_cents, negative = out), accounts, categories (parent_id), tags, transaction_tags, rules, imports.",
    inputSchema: { sql: z.string() },
  },
  async ({ sql }) => {
    const ro = openDb(undefined, { readonly: true });
    try {
      const stmt = ro.prepare(sql);
      if (!stmt.reader) throw new Error("Only SELECT queries are allowed.");
      return json(stmt.all().slice(0, 1000));
    } finally {
      ro.close();
    }
  },
);

await server.connect(new StdioServerTransport());
