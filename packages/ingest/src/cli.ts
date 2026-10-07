// Usage: pnpm import <file.csv> --account "Chase Sapphire" [--type credit] [--invert]
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "@finance/db";
import { importCsv } from "./csv.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    account: { type: "string" },
    type: { type: "string", default: "depository" },
    invert: { type: "boolean", default: false },
  },
});

if (!positionals.length || !values.account) {
  console.error('Usage: pnpm import <file.csv> [more.csv] --account "Account name" [--type credit] [--invert]');
  process.exit(1);
}

const db = openDb();
for (const file of positionals) {
  const r = importCsv(db, {
    text: readFileSync(file, "utf8"),
    accountName: values.account,
    accountType: values.type,
    filename: basename(file),
    invert: values.invert,
  });
  console.log(`${basename(file)}: ${r.added} added, ${r.skipped} already present, ${r.categorizedByRules} auto-categorized`);
}
