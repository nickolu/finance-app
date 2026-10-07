CREATE TABLE IF NOT EXISTS institutions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  plaid_institution_id TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS plaid_items (
  id INTEGER PRIMARY KEY,
  institution_id INTEGER REFERENCES institutions(id),
  plaid_item_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  sync_cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  institution_id INTEGER REFERENCES institutions(id),
  plaid_item_id INTEGER REFERENCES plaid_items(id),
  plaid_account_id TEXT UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'depository', -- depository | credit | loan | investment
  mask TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  current_balance_cents INTEGER,
  balance_updated_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id),
  is_income INTEGER NOT NULL DEFAULT 0,
  is_transfer INTEGER NOT NULL DEFAULT 0,
  UNIQUE(name, parent_id)
);

-- amount_cents: negative = money out, positive = money in (for every account type)
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,              -- YYYY-MM-DD
  amount_cents INTEGER NOT NULL,
  raw_description TEXT NOT NULL,
  merchant TEXT,
  category_id INTEGER REFERENCES categories(id),
  notes TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,            -- 'csv' | 'plaid' | 'manual'
  external_id TEXT,                -- Plaid transaction_id
  import_hash TEXT,                -- dedupe key for CSV rows
  import_id INTEGER REFERENCES imports(id),
  reviewed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, import_hash),
  UNIQUE(external_id)
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);

CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (transaction_id, tag_id)
);

CREATE TABLE IF NOT EXISTS splits (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id),
  amount_cents INTEGER NOT NULL,
  notes TEXT
);

-- A rule matches on any combination of fields; null fields are ignored.
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  priority INTEGER NOT NULL DEFAULT 100,
  match_description TEXT,          -- case-insensitive regex on raw_description
  match_merchant TEXT,             -- case-insensitive regex on merchant
  match_account_id INTEGER REFERENCES accounts(id),
  match_min_cents INTEGER,
  match_max_cents INTEGER,
  set_category_id INTEGER REFERENCES categories(id),
  set_merchant TEXT,
  add_tag TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,            -- 'csv' | 'plaid'
  filename TEXT,
  account_id INTEGER REFERENCES accounts(id),
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_added INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
