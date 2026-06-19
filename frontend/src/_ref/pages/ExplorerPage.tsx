import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getHistory, getInfo, fmtAmount, type VerifiedResult, type Info } from "../api";

const short = (h: string, n = 6) => (h && h.length > 2 * n ? `${h.slice(0, n)}…${h.slice(-n)}` : h);

export default function ExplorerPage() {
  const [info, setInfo] = useState<Info | null>(null);
  const [rows, setRows] = useState<VerifiedResult[]>([]);
  const [count, setCount] = useState(0);
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getInfo().then(setInfo).catch(() => {});
    getHistory(0, 50)
      .then((h) => {
        // newest first
        setRows([...h.results].sort((a, b) => (b.index ?? 0) - (a.index ?? 0)));
        setCount(h.count);
        setState("done");
      })
      .catch((e) => { setErr(String((e as Error).message ?? e)); setState("error"); });
  }, []);

  const explorer = (id: string) =>
    `https://stellar.expert/explorer/${info?.network ?? "testnet"}/contract/${id}`;

  return (
    <>
      <p className="sub">
        <b>Verified-results explorer.</b> Every successful Proof-of-Reserves verification is appended to
        an <b>on-chain, append-only log</b> in the policy contract (events expire after ~7 days, so the
        log is the durable record). Anyone can list it directly — this page just mirrors it.
      </p>

      <div className="card">
        <h2>
          On-chain history <span className="demo-note">{count} total</span>
          {info?.policyId && <a className="explore-link" href={explorer(info.policyId)} target="_blank" rel="noreferrer">policy ↗</a>}
        </h2>
        {state === "loading" && <p className="hint">Loading…</p>}
        {state === "error" && <p className="err-text">Could not load history: {err}</p>}
        {state === "done" && rows.length === 0 && <p className="hint">No verified results yet.</p>}
        {state === "done" && rows.length > 0 && (
          <table className="tbl" data-testid="history-table">
            <thead>
              <tr><th>#</th><th>result</th><th>bound supply</th><th>issuer</th><th>ledger</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.index ?? `${r.issuer_id}-${r.nonce}`} data-testid="history-row">
                  <td>{r.index ?? "—"}</td>
                  <td><span className="pill ok">reserves ≥ supply ✓</span></td>
                  <td>{fmtAmount(r.supply, info?.decimals ?? 7)} zUSD</td>
                  <td className="mono">{short(r.issuer_id, 6)}</td>
                  <td>{r.ledger}</td>
                  <td><Link className="tlink" to={`/verify/${r.issuer_id}`}>verify ↗</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
