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

## Run the app

```sh
pnpm dev   # API on :8787, UI on http://localhost:5173
```

- **Transactions**: search, filter, inbox of uncategorized items, inline and bulk categorizing.
- **Dashboard**: spending by category and monthly cash flow.
- **Import**: upload a CSV.

## Use it from Claude

Register the MCP server (Claude Code):

```sh
claude mcp add finance -- pnpm --silent --dir /absolute/path/to/finance-app mcp
```

For Claude Desktop, add the same command to `claude_desktop_config.json`. Then install the skill in `skill/finance/SKILL.md` so Claude knows the conventions (signed amounts, preview-before-relabel).

Tools: `search_transactions`, `spending_summary`, `list_categories`, `list_accounts`, `label_transactions`, `create_rule`, `run_sql_readonly`.

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
- [ ] Plaid Link + `/transactions/sync` + scheduled sync for auto-ingestion
- [ ] OFX/QFX import
