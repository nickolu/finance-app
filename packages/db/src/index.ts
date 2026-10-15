import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CATEGORIES } from "./seed.ts";

export type DB = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

// Load .env from the repo root once, for every entry point (server, MCP, CLI).
try {
  process.loadEnvFile(resolve(repoRoot, ".env"));
} catch {
  // no .env; defaults apply
}

export function defaultDbPath(): string {
  return resolve(repoRoot, process.env.FINANCE_DB ?? "data/finance.db");
}

export function openDb(path = defaultDbPath(), opts: { readonly?: boolean } = {}): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly: !!opts.readonly, fileMustExist: !!opts.readonly });
  db.pragma("foreign_keys = ON");
  if (!opts.readonly) {
    db.pragma("journal_mode = WAL");
    migrate(db);
  }
  return db;
}

// Schema changes after the initial schema.sql. Append only; each runs once, tracked by user_version.
const MIGRATIONS: string[] = [
  `ALTER TABLE transactions ADD COLUMN plaid_category TEXT;
   ALTER TABLE plaid_items ADD COLUMN institution_name TEXT;
   ALTER TABLE plaid_items ADD COLUMN error TEXT;`,
];

export function migrate(db: DB): void {
  db.exec(readFileSync(resolve(here, "schema.sql"), "utf8"));
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  const count = (db.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number }).n;
  if (count === 0) seedCategories(db);
}

function seedCategories(db: DB): void {
  const insert = db.prepare(
    "INSERT INTO categories (name, parent_id, is_income, is_transfer) VALUES (?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const [parent, children] of Object.entries(DEFAULT_CATEGORIES)) {
      const isIncome = parent === "Income" ? 1 : 0;
      const isTransfer = parent === "Transfers" ? 1 : 0;
      const parentId = insert.run(parent, null, isIncome, isTransfer).lastInsertRowid;
      for (const child of children) insert.run(child, parentId, isIncome, isTransfer);
    }
  })();
}

export * from "./queries.ts";
