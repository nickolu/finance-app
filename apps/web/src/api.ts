export interface Transaction {
  id: number;
  account_name: string;
  date: string;
  amount_cents: number;
  raw_description: string;
  merchant: string | null;
  category_id: number | null;
  category: string | null;
  notes: string | null;
  pending: number;
  tags: string | null;
}
export interface Category { id: number; path: string; parent_id: number | null }
export interface SummaryRow { key: string; spent_cents: number; received_cents: number; net_cents: number; count: number }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

const qs = (params: Record<string, string | number | boolean | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();

export const api = {
  transactions: (p: Record<string, string | number | boolean | undefined>) =>
    req<{ rows: Transaction[]; total: number }>(`/transactions?${qs(p)}`),
  patch: (ids: number[], patch: Record<string, unknown>) =>
    req<{ changed: number }>("/transactions", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, ...patch }) }),
  categories: () => req<Category[]>("/categories"),
  summary: (p: Record<string, string | undefined>) => req<SummaryRow[]>(`/summary?${qs(p)}`),
  importCsv: (form: FormData) => req<{ added: number; skipped: number; categorizedByRules: number }>("/import/csv", { method: "POST", body: form }),
};

export const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
