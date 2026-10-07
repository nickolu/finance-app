---
name: finance
description: Answer questions about Nickolus's bank and credit card transactions, and label, categorize or create rules for them, using the finance MCP server.
---

# Personal finance data

All transactions live in a local SQLite database exposed through the `finance` MCP server.

## Conventions

- Amounts are dollars. **Negative = money out, positive = money in**, for every account type (a credit card charge is negative, a card payment received is positive).
- Categories are two levels: `Parent > Child` (e.g. `Food > Groceries`). Pass either the full path or a unique child name. Filtering by a parent includes its children. Call `list_categories` when unsure.
- The `Transfers` parent (credit card payments, moves between own accounts) is excluded from spending totals by default so card payments aren't double counted.
- `merchant` is a cleaned-up name; `raw_description` is exactly what the bank sent. Rules match on either with case-insensitive regex.

- Banks connected through Plaid sync on a schedule. If the user asks about something very recent, call `sync_bank_accounts` first.

## Answering questions

- "How much did I spend on X in period Y?" → `spending_summary` with `group_by` and dates, or `search_transactions` with a `category` filter and sum.
- Trends → `spending_summary` with `group_by: "month"`.
- Anything the tools don't cover → `run_sql_readonly` (SELECT only). Remember `amount_cents` is in cents in raw SQL.
- Always state the date range you used and whether transfers were excluded.

## Changing data

1. Call `label_transactions` with `dry_run: true` first. Show the user the match count and a few sample rows.
2. Only after the user confirms, repeat with `dry_run: false`.
3. If the user is labeling something that will recur (a subscription, a regular merchant), offer to `create_rule` so future imports are labeled automatically. `create_rule` with `apply_to_existing` only touches uncategorized transactions; it never overwrites manual labels.
