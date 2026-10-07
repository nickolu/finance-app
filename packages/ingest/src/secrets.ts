import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultDbPath } from "@finance/db";

// Plaid access tokens are encrypted at rest with AES-256-GCM. The key comes from
// FINANCE_SECRET_KEY, or a random key generated once into data/secret.key (mode 600),
// kept outside the database file so a copied DB alone can't be used against your bank.

let cachedKey: Buffer | undefined;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  let material = process.env.FINANCE_SECRET_KEY;
  if (!material) {
    const path = resolve(dirname(defaultDbPath()), "secret.key");
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600 });
    }
    material = readFileSync(path, "utf8").trim();
  }
  cachedKey = createHash("sha256").update(material).digest();
  return cachedKey;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function decrypt(stored: string): string {
  const [version, iv, tag, body] = stored.split(":");
  if (version !== "v1") throw new Error("Unrecognized token format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}
