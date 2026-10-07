# Finance app: design

A local-first app that pulls in all bank and credit card transactions, lets you label and explore them, keeps itself up to date through Plaid, and exposes the data to Claude through an MCP server.

## Goals

1. **Ingest everything**: historical CSV/OFX exports from each bank and card, plus live sync via Plaid going forward.
2. **Label and manage**: categories, tags, notes, splits, merchant cleanup, rules that auto-label new transactions.
3. **Visualize**: spending by category and month, cash flow, merchant leaderboards, account balances over time.
4. **Talk to it from Claude**: "how much did I spend on restaurants in Q3?", "label all Venmo payments to Sam as Rent".
5. **Private by default**: data stays in one SQLite file on your machine. Plaid is the only third party that sees credentials.

## Stack

One TypeScript monorepo (pnpm workspaces), so the UI, API, sync worker and MCP server share one data layer.

| Piece | Choice | Why |
|---|---|---|
| Database | SQLite (one file) via Drizzle ORM | Zero ops, easy backup, fast enough for decades of transactions |
| API | Hono on Node | Small, typed, serves the UI and JSON endpoints |
| Web UI | React + Vite + TanStack Table + Recharts | Fast editable grid for labeling, simple charts |
| Bank sync | Plaid `/transactions/sync` + Link | Cursor-based incremental sync, handles edits and removals |
| Import fallback | CSV/OFX importer with per-bank column mappings | Plaid only reaches back ~24 months; older history comes from exports |
| Claude interface | MCP server (stdio) over the same DB | Works in Claude Code and Claude Desktop; a Skill file teaches Claude the workflows |

## Packages

```
apps/web        React UI
apps/server     Hono API + Plaid Link token/exchange + webhook endpoint
packages/db     Drizzle schema, migrations, queries (shared by everything)
packages/ingest CSV/OFX parsers, dedupe, Plaid sync, rules engine
packages/mcp    MCP server exposing tools to Claude
skill/          SKILL.md for the Claude skill
```

## Data model (core tables)

- `institutions`, `accounts` (type, mask, currency, Plaid ids, current balance)
- `transactions`: id, account_id, date, amount (cents, negative = outflow), raw_description, merchant, category_id, notes, pending, source (`plaid` | `csv`), external_id, import_hash
- `categories` (hierarchical: Food > Restaurants), `tags`, `transaction_tags`
- `rules`: match (merchant/description regex, amount range, account) → set category / tags / merchant rename; applied on ingest and on demand
- `splits`: one transaction split across categories
- `plaid_items`: access token (encrypted at rest), sync cursor, status
- `imports`: audit log of each file or sync run

Dedupe: CSV rows get `import_hash = hash(account, date, amount, normalized description, occurrence index)`; Plaid rows key on `transaction_id`. When Plaid and CSV overlap, Plaid wins and the CSV row's labels are carried over.

## Auto-ingestion

1. Connect each bank once through Plaid Link in the UI.
2. Sync runs on a schedule (every few hours) and on Plaid `SYNC_UPDATES_AVAILABLE` webhooks when a public URL is available (e.g. a Cloudflare Tunnel). Without a tunnel the schedule alone is fine.
3. New transactions run through the rules engine, then land in an "Inbox" view for anything still uncategorized.

Plaid notes: Sandbox is free for building. Real accounts need Plaid's Development/Limited Production access, which is free for a small number of personal connections but requires an application. Some banks (notably a few credit unions) need OAuth registration. CSV import covers anything Plaid can't reach.

## Claude skill / MCP tools

- `search_transactions(query, date_from, date_to, account, category, min/max amount)`
- `spending_summary(group_by: category|merchant|month|account, period)`
- `cash_flow(period)`, `account_balances()`
- `label_transactions(ids | filter, category, tags, notes)` (shows a preview count before writing)
- `create_rule(match, action, apply_to_existing)`
- `list_categories()`, `uncategorized_inbox(limit)`
- `run_sql_readonly(sql)` for ad-hoc questions

The skill (SKILL.md) explains the category scheme, how amounts are signed, and the "preview, then confirm" pattern for bulk relabeling.

## Build order

1. DB schema + CSV import + transaction table UI with inline labeling
2. Rules engine + categories + Inbox
3. Dashboard charts
4. MCP server + skill
5. Plaid Link + sync + scheduler (sandbox first, then real accounts)
