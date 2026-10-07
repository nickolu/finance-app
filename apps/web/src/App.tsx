import { useCallback, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, money, type Category, type SummaryRow, type Transaction } from "./api.ts";

type Tab = "transactions" | "dashboard" | "import";

export function App() {
  const [tab, setTab] = useState<Tab>("transactions");
  const [categories, setCategories] = useState<Category[]>([]);
  useEffect(() => { api.categories().then(setCategories); }, []);

  return (
    <div className="app">
      <header>
        <h1>Finance</h1>
        <nav>
          {(["transactions", "dashboard", "import"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>
      {tab === "transactions" && <Transactions categories={categories} />}
      {tab === "dashboard" && <Dashboard />}
      {tab === "import" && <Import />}
    </div>
  );
}

function CategorySelect(props: { categories: Category[]; value: number | null; onChange: (id: number | null) => void; emptyLabel?: string }) {
  return (
    <select value={props.value ?? ""} onChange={(e) => props.onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{props.emptyLabel ?? "Uncategorized"}</option>
      {props.categories.map((c) => (
        <option key={c.id} value={c.id}>{c.path}</option>
      ))}
    </select>
  );
}

function Transactions({ categories }: { categories: Category[] }) {
  const [q, setQ] = useState("");
  const [uncategorized, setUncategorized] = useState(false);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [data, setData] = useState<{ rows: Transaction[]; total: number }>({ rows: [], total: 0 });
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    api.transactions({ q, uncategorized, categoryId: categoryId ?? undefined, limit: 500 }).then(setData);
  }, [q, uncategorized, categoryId]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const setCategory = async (ids: number[], id: number | null) => {
    await api.patch(ids, { categoryId: id });
    setSelected(new Set());
    load();
  };

  const allSelected = data.rows.length > 0 && data.rows.every((r) => selected.has(r.id));

  return (
    <section>
      <div className="toolbar">
        <input placeholder="Search description, merchant, notes" value={q} onChange={(e) => setQ(e.target.value)} />
        <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} emptyLabel="All categories" />
        <label><input type="checkbox" checked={uncategorized} onChange={(e) => setUncategorized(e.target.checked)} /> Inbox (uncategorized)</label>
        <span className="muted">{data.total.toLocaleString()} transactions</span>
      </div>
      {selected.size > 0 && (
        <div className="bulk">
          {selected.size} selected. Set category:{" "}
          <CategorySelect categories={categories} value={null} onChange={(id) => setCategory([...selected], id)} />
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(data.rows.map((r) => r.id)))} /></th>
            <th>Date</th><th>Account</th><th>Merchant</th><th>Description</th><th className="num">Amount</th><th>Category</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((t) => (
            <tr key={t.id} className={t.pending ? "pending" : ""}>
              <td>
                <input type="checkbox" checked={selected.has(t.id)} onChange={() => {
                  const next = new Set(selected);
                  next.has(t.id) ? next.delete(t.id) : next.add(t.id);
                  setSelected(next);
                }} />
              </td>
              <td>{t.date}</td>
              <td>{t.account_name}</td>
              <td>{t.merchant}</td>
              <td className="muted">{t.raw_description}</td>
              <td className={`num ${t.amount_cents < 0 ? "out" : "in"}`}>{money(t.amount_cents)}</td>
              <td><CategorySelect categories={categories} value={t.category_id} onChange={(id) => setCategory([t.id], id)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function monthsAgo(n: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - n, 1);
  return d.toISOString().slice(0, 10);
}

function Dashboard() {
  const [range, setRange] = useState(12);
  const [byCategory, setByCategory] = useState<SummaryRow[]>([]);
  const [byMonth, setByMonth] = useState<SummaryRow[]>([]);
  const dateFrom = useMemo(() => monthsAgo(range), [range]);

  useEffect(() => {
    api.summary({ groupBy: "parent_category", dateFrom }).then(setByCategory);
    api.summary({ groupBy: "month", dateFrom }).then(setByMonth);
  }, [dateFrom]);

  const toDollars = (rows: SummaryRow[]) =>
    rows.map((r) => ({ key: r.key, spent: r.spent_cents / 100, received: r.received_cents / 100 }));

  return (
    <section>
      <div className="toolbar">
        <select value={range} onChange={(e) => setRange(Number(e.target.value))}>
          {[3, 6, 12, 24, 60].map((n) => <option key={n} value={n}>Last {n} months</option>)}
        </select>
      </div>
      <h2>Spending by category</h2>
      <ResponsiveContainer width="100%" height={Math.max(200, byCategory.length * 32)}>
        <BarChart data={toDollars(byCategory)} layout="vertical" margin={{ left: 120 }}>
          <CartesianGrid horizontal={false} strokeOpacity={0.3} />
          <XAxis type="number" tickFormatter={(v) => `$${v.toLocaleString()}`} />
          <YAxis type="category" dataKey="key" width={120} />
          <Tooltip formatter={(v: number) => money(v * 100)} />
          <Bar dataKey="spent" fill="#4f6bed" />
        </BarChart>
      </ResponsiveContainer>
      <h2>Cash flow by month</h2>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={toDollars(byMonth)}>
          <CartesianGrid vertical={false} strokeOpacity={0.3} />
          <XAxis dataKey="key" />
          <YAxis tickFormatter={(v) => `$${v.toLocaleString()}`} />
          <Tooltip formatter={(v: number) => money(v * 100)} />
          <Bar dataKey="received" fill="#2e9e6b" name="In" />
          <Bar dataKey="spent" fill="#d9534f" name="Out" />
        </BarChart>
      </ResponsiveContainer>
    </section>
  );
}

function Import() {
  const [status, setStatus] = useState("");
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    form.set("invert", (form.get("invert") === "on").toString());
    try {
      const r = await api.importCsv(form);
      setStatus(`${r.added} added, ${r.skipped} already present, ${r.categorizedByRules} auto-categorized`);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };
  return (
    <section>
      <form className="import" onSubmit={onSubmit}>
        <label>CSV file <input type="file" name="file" accept=".csv" required /></label>
        <label>Account name <input name="account" placeholder="Chase Sapphire" required /></label>
        <label>Type
          <select name="type">
            <option value="depository">Checking / savings</option>
            <option value="credit">Credit card</option>
          </select>
        </label>
        <label><input type="checkbox" name="invert" /> Charges are positive in this file (flip signs)</label>
        <button type="submit">Import</button>
      </form>
      {status && <p>{status}</p>}
    </section>
  );
}
