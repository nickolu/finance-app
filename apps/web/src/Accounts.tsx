import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { money, plaidApi, type Account, type PlaidStatus } from "./api.ts";

/** Opens Plaid Link as soon as it has a token; used for new connections and for re-login (update mode). */
function PlaidLauncher(props: { token: string; onDone: (msg: string) => void; update: boolean }) {
  const { open, ready } = usePlaidLink({
    token: props.token,
    onSuccess: async (publicToken) => {
      if (props.update || !publicToken) {
        props.onDone("Reconnected.");
        return;
      }
      props.onDone("Connecting and pulling history (this can take a minute)...");
      try {
        const r = await plaidApi.exchange(publicToken);
        props.onDone(`Connected ${r.institutionName ?? "bank"}: ${r.sync.added} transactions imported.`);
      } catch (e) {
        props.onDone(`Error: ${(e as Error).message}`);
      }
    },
    onExit: () => props.onDone(""),
  });
  useEffect(() => { if (ready) open(); }, [ready, open]);
  return null;
}

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [status, setStatus] = useState<PlaidStatus>();
  const [link, setLink] = useState<{ token: string; update: boolean }>();
  const [message, setMessage] = useState("");

  const load = useCallback(() => {
    plaidApi.accounts().then(setAccounts);
    plaidApi.status().then(setStatus);
  }, []);
  useEffect(load, [load]);

  const startLink = async (itemId?: number) => {
    try {
      const { link_token } = await plaidApi.linkToken(itemId);
      setLink({ token: link_token, update: !!itemId });
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    }
  };

  const sync = async (itemId?: number) => {
    setMessage("Syncing...");
    try {
      await plaidApi.sync(itemId);
      setMessage("Sync complete.");
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    }
    load();
  };

  const csvAccounts = accounts.filter((a) => !a.plaid_account_id);

  return (
    <section>
      <div className="toolbar">
        <button onClick={() => startLink()} disabled={!status?.configured}>Connect a bank</button>
        <button onClick={() => sync()} disabled={!status?.items.length}>Sync all now</button>
        {status && !status.configured && (
          <span className="muted">Add PLAID_CLIENT_ID and PLAID_SECRET to .env to connect banks.</span>
        )}
        {status?.configured && status.env !== "production" && <span className="muted">Plaid {status.env} mode</span>}
        {message && <span>{message}</span>}
      </div>
      {link && (
        <PlaidLauncher
          token={link.token}
          update={link.update}
          onDone={(msg) => { setLink(undefined); if (msg) setMessage(msg); load(); }}
        />
      )}

      {!!status?.items.length && (
        <>
          <h2>Connections</h2>
          <table>
            <thead><tr><th>Institution</th><th>Status</th><th>Last synced</th><th></th></tr></thead>
            <tbody>
              {status.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.institution_name ?? "Unknown"}</td>
                  <td>{i.status === "ok" ? "Connected" : i.status === "login_required" ? "Needs sign-in" : `Error: ${i.error}`}</td>
                  <td className="muted">{i.last_synced_at ? `${i.last_synced_at} UTC` : "Never"}</td>
                  <td>
                    {i.status === "login_required"
                      ? <button onClick={() => startLink(i.id)}>Sign in again</button>
                      : <button onClick={() => sync(i.id)}>Sync</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Accounts</h2>
      <table>
        <thead>
          <tr><th>Account</th><th>Type</th><th>Source</th><th className="num">Balance</th><th className="num">Transactions</th><th>Latest</th><th></th></tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td>{a.name}{a.mask ? ` ••${a.mask}` : ""}</td>
              <td>{a.type}</td>
              <td className="muted">{a.plaid_account_id ? a.institution ?? "Plaid" : "CSV"}</td>
              <td className="num">{a.current_balance_cents === null ? "" : money(a.current_balance_cents)}</td>
              <td className="num">{a.transaction_count.toLocaleString()}</td>
              <td className="muted">{a.latest_date}</td>
              <td>
                {a.plaid_account_id && csvAccounts.length > 0 && (
                  <select
                    value=""
                    onChange={async (e) => {
                      const target = Number(e.target.value);
                      if (!target) return;
                      const r = await plaidApi.linkAccount(a.id, target);
                      setMessage(`Combined accounts; ${r.merged} duplicate transactions merged.`);
                      load();
                    }}
                  >
                    <option value="">Combine with imported account...</option>
                    {csvAccounts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
