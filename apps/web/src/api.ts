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

export interface Account {
  id: number;
  name: string;
  type: string;
  mask: string | null;
  institution: string | null;
  plaid_account_id: string | null;
  current_balance_cents: number | null;
  transaction_count: number;
  latest_date: string | null;
}
export interface PlaidStatus {
  configured: boolean;
  env: string;
  items: { id: number; institution_name: string | null; status: string; error: string | null; last_synced_at: string | null }[];
}

const post = <T,>(path: string, body: unknown = {}) =>
  req<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const plaidApi = {
  accounts: () => req<Account[]>("/accounts"),
  status: () => req<PlaidStatus>("/plaid/status"),
  linkToken: (itemId?: number) => post<{ link_token: string }>("/plaid/link-token", { itemId }),
  exchange: (public_token: string) => post<{ institutionName: string | null; sync: { added: number } }>("/plaid/exchange", { public_token }),
  sync: (itemId?: number) => post<unknown>("/plaid/sync", { itemId }),
  linkAccount: (id: number, targetAccountId: number) => post<{ merged: number }>(`/accounts/${id}/link`, { targetAccountId }),
};

export const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
