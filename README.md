# Finance

Local-first personal finance app: import every bank and credit card transaction, label and explore them, and ask Claude about them through an MCP server. See [docs/design.md](docs/design.md) for the full design.

## Setup

```sh
pnpm install
cp .env.example .env   # optional; defaults work
```

Data lives in one SQLite file, `data/finance.db` by default (set `FINANCE_DB` to move it). It is git-ignored.

## Import history

Export CSVs from each bank/card, then either use the **Import** tab in the UI or:

```sh
pnpm import ~/Downloads/chase-2024.csv ~/Downloads/chase-2025.csv --account "Chase Sapphire" --type credit
```

Common column layouts (Chase, Amex, BofA, Capital One, debit/credit-split exports) are detected automatically. If a card export shows charges as positive numbers, add `--invert`. Re-importing overlapping files is safe: rows already present are skipped.

## Connect banks with Plaid (auto-ingestion)

1. Sign up at [dashboard.plaid.com](https://dashboard.plaid.com) and copy your client id and sandbox secret into `.env` (see `.env.example`).
2. Run the app, open **Accounts**, click **Connect a bank**. In sandbox, sign in with `user_good` / `pass_good`.
3. The first sync pulls up to two years of history. After that the server syncs every `PLAID_SYNC_INTERVAL_HOURS` (default 6) while it is running. Set `PLAID_WEBHOOK_URL` to a public tunnel URL if you want updates as soon as Plaid has them.

For real accounts, request Production access in the Plaid dashboard, then set `PLAID_ENV=production` and the production secret.

If you already imported CSVs for an account, use **Combine with imported account** next to the Plaid account. Overlapping transactions are merged (same amount, dates within 3 days) and your labels are kept. New Plaid transactions are labeled by your rules first, then by Plaid's own category.

Access tokens are encrypted in the database; the key is `FINANCE_SECRET_KEY` or `data/secret.key`.

## Run the app

```sh
pnpm dev   # API on :8787, UI on http://localhost:5173
```

- **Transactions**: search, filter, inbox of uncategorized items, inline and bulk categorizing.
- **Dashboard**: spending by category and monthly cash flow.
- **Accounts**: connect banks, sync, balances, combine Plaid and CSV accounts.
- **Import**: upload a CSV.

## Use it from Claude

Register the MCP server (Claude Code):

```sh
claude mcp add finance -- pnpm --silent --dir /absolute/path/to/finance-app mcp
```

For Claude Desktop, add the same command to `claude_desktop_config.json`. Then install the skill in `skill/finance/SKILL.md` so Claude knows the conventions (signed amounts, preview-before-relabel).

Tools: `search_transactions`, `spending_summary`, `list_categories`, `list_accounts`, `label_transactions`, `create_rule`, `run_sql_readonly`, `sync_bank_accounts`.

## Develop

```sh
pnpm test
pnpm typecheck
```

## Roadmap

- [x] SQLite schema, CSV import with dedupe, rules engine
- [x] Transactions table with labeling, dashboard, import UI
- [x] MCP server + skill
- [ ] Rules management UI, tags and notes editing, splits
- [x] Plaid Link + `/transactions/sync` + scheduled sync for auto-ingestion
- [ ] OFX/QFX import
