import { useCallback, useEffect, useRef, useState } from "react";
import {
  getInfo,
  getProveStatus,
  provePayroll,
  submitPayroll,
  getPayrollHistory,
  auditPayroll,
  type Info,
  type Bundle,
  type PayrollAccessRecord,
  type PayrollGrantResp,
  type PayrollAuditResp,
} from "../api";
import { decodePayrollJournal } from "../journal";
import { ProofStatusBadge, ProveWait, VerdictMark, type ClaimState } from "../StatusBadge";
import { humanError } from "../errors";

// Deterministic demo "employee wallet" — the public accessor the income proof grants to.
const DEMO_USER_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";
const short = (h: string, n = 6) => (h && h.length > 2 * n ? `${h.slice(0, n)}…${h.slice(-n)}` : h);

function friendlyError(e?: string): string {
  return humanError(e, "payroll");
}

export default function PayrollPage() {
  const [info, setInfo] = useState<Info | null>(null);
  const [salary, setSalary] = useState("6000");
  const [threshold, setThreshold] = useState("5000");
  const [accessor, setAccessor] = useState(DEMO_USER_G);

  const [state, setState] = useState<ClaimState>("draft");
  const [proveBy, setProveBy] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [resp, setResp] = useState<PayrollGrantResp | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // auditor view-key panel
  const [viewKey, setViewKey] = useState("");
  const [audit, setAudit] = useState<PayrollAuditResp | null>(null);
  const [auditErr, setAuditErr] = useState<string | null>(null);
  const [history, setHistory] = useState<PayrollAccessRecord[]>([]);

  const explorer = (kind: "contract" | "tx", id: string) =>
    `https://stellar.expert/explorer/${info?.network ?? "testnet"}/${kind}/${id}`;

  const refreshHistory = useCallback(
    () => getPayrollHistory(0, 20).then((h) => setHistory(h.results)).catch(() => {}),
    [],
  );

  useEffect(() => {
    getInfo().then(setInfo).catch(() => {});
    refreshHistory();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refreshHistory]);

  const journal = bundle?.journal ? decodePayrollJournal(bundle.journal) : null;

  async function onGrant(b: Bundle | null = bundle) {
    if (!b) return;
    setBusy(true);
    setState("verifying");
    setResp(null);
    try {
      const r = await submitPayroll(b);
      setResp(r);
      setState(r.ok ? "verified" : "rejected");
      if (r.ok) refreshHistory();
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), payrollId: info?.payrollId ?? "" });
      setState("rejected");
    } finally {
      setBusy(false);
    }
  }

  async function onProve() {
    if (pollRef.current) clearInterval(pollRef.current);
    setBusy(true);
    setResp(null);
    setBundle(null);
    setProveBy(null);
    setState("proving");
    try {
      const pr = await provePayroll(salary, threshold, accessor);
      const jobId = pr.jobId!;
      pollRef.current = setInterval(async () => {
        try {
          const s = await getProveStatus(jobId);
          setProveBy(s.by ?? null);
          if (s.status === "done" && s.bundle) {
            if (pollRef.current) clearInterval(pollRef.current);
            setBundle(s.bundle);
            setState("proved");
            setBusy(false);
            onGrant(s.bundle);
          } else if (s.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            // salary < threshold makes the guest panic → no receipt → proving "fails" by design.
            // Guard the BigInt parse — the fields are free text, and a throw here would otherwise be
            // swallowed by the catch below and strand the UI in the "proving" state.
            let belowThreshold = false;
            try { belowThreshold = BigInt(salary || "0") < BigInt(threshold || "0"); } catch { /* non-numeric */ }
            setResp({
              ok: false,
              error: belowThreshold
                ? "Salary is below the threshold — the guest produced no receipt (nothing to verify)."
                : (s.error || "proving failed"),
              payrollId: "",
            });
            setState("failed");
            setBusy(false);
          }
        } catch { /* keep polling */ }
      }, 4000);
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), payrollId: "" });
      setState("failed");
      setBusy(false);
    }
  }

  async function onUnlock() {
    setAuditErr(null);
    try {
      const a = await auditPayroll(viewKey.trim() || undefined);
      setAudit(a);
    } catch (e) {
      setAudit(null);
      setAuditErr(String((e as Error).message ?? e));
    }
  }

  return (
    <>
      <p className="sub">
        An employee proves <b>"paid ≥ a threshold"</b> <b>without revealing their salary</b> — the exact
        figure stays private. The proof checks a signed payroll record, confirms <code>salary ≥ threshold</code>,
        and <b>encrypts the salary to an approved auditor's key</b>. The public sees only <b>✓ paid ≥ X</b>
        plus an unreadable encrypted blob; an <b>auditor's read key</b> unlocks the exact figures —
        <i> provably the signed salary</i>. The salary never leaves the prover in the clear.
      </p>

      {/* engine */}
      <div className="card">
        <h2>Engine</h2>
        <div className="row"><span className="k">Network</span><span className="v">{info?.network ?? "…"}</span></div>
        {info?.payrollId && <div className="row"><span className="k">Payroll gate</span><span className="v"><a href={explorer("contract", info.payrollId)} target="_blank" rel="noreferrer">{short(info.payrollId, 8)} ↗</a></span></div>}
        {info?.verifierId && <div className="row"><span className="k">Groth16 verifier</span><span className="v"><a href={explorer("contract", info.verifierId)} target="_blank" rel="noreferrer">{short(info.verifierId, 8)} ↗</a></span></div>}
        {info?.payrollAttesterId && <div className="row"><span className="k">Payroll attester (allow-listed)</span><span className="v">{short(info.payrollAttesterId, 8)}</span></div>}
        {info?.auditorPub && <div className="row"><span className="k">Auditor (allow-listed)</span><span className="v" data-testid="auditor-pub">x25519 {short(info.auditorPub, 8)}</span></div>}
      </div>

      {/* prover */}
      <div className="card">
        <h2>Prove income <ProofStatusBadge state={state} /></h2>
        <p className="hint">Enter a salary &amp; the public threshold to prove against. Set the salary <b>below</b> the threshold to see the ✗ case — the guest produces no receipt.</p>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>salary (private)</label>
          <input style={{ width: 120 }} value={salary} onChange={(e) => setSalary(e.target.value)} aria-label="salary" data-testid="salary" inputMode="numeric" />
          <label className="fld" style={{ margin: 0 }}>threshold (public)</label>
          <input style={{ width: 120 }} value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-label="threshold" data-testid="threshold" inputMode="numeric" />
        </div>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>accessor (Stellar account to credential)</label>
          <input style={{ minWidth: 380, fontFamily: "monospace", fontSize: 12 }} value={accessor} onChange={(e) => setAccessor(e.target.value)} aria-label="accessor" data-testid="accessor" />
        </div>
        <div className="btnrow">
          <button onClick={onProve} disabled={busy} data-testid="prove">
            {state === "proving" ? "Proving…" : "Generate proof & grant"}
          </button>
        </div>
        <ProveWait state={state} proveBy={proveBy} privacy="Your salary never leaves the prover in clear." />

        {journal && (
          <>
            <div className="demo-note" style={{ marginTop: 16 }}>Public journal (what goes on-chain) — note the salary is absent</div>
            <div className="row"><span className="k">claim</span><span className="v">{journal.claimType === 5 ? "Payroll (proof-of-income)" : `type ${journal.claimType}`}</span></div>
            <div className="row"><span className="k">result</span><span className="v">{journal.result ? "paid ≥ threshold ✓" : "false"}</span></div>
            <div className="row"><span className="k">threshold (public)</span><span className="v">{journal.threshold}</span></div>
            <div className="row"><span className="k">payroll attester</span><span className="v">{short(journal.issuerId, 8)}</span></div>
            <div className="row"><span className="k">accessor (credentialed)</span><span className="v">{short(journal.accessor, 8)}</span></div>
            <div className="row"><span className="k">auditor disclosure</span><span className="v" title={journal.ct} data-testid="ct">encrypted ct {short(journal.ct, 8)}</span></div>
            <div className="row"><span className="k">salary</span><span className="v private" data-testid="salary-private">private — only the auditor's view key opens it</span></div>
          </>
        )}
      </div>

      {/* verdict */}
      {resp && (
        <div className="card" data-testid="grant-verdict-card">
          {resp.ok ? (
            <>
              <div className="verdict ok"><span className="badge"><VerdictMark ok /></span><span>Income verified — "paid ≥ {resp.result?.threshold}" on Stellar (salary hidden)</span></div>
              {resp.txHash && <div className="row"><span className="k">tx</span><span className="v"><a href={explorer("tx", resp.txHash)} target="_blank" rel="noreferrer">{short(resp.txHash, 8)} ↗</a></span></div>}
              {resp.cost?.minResourceFee && <div className="row"><span className="k">resource fee</span><span className="v">{resp.cost.minResourceFee} stroops</span></div>}
              {resp.result && <div className="row"><span className="k">accessor</span><span className="v">{short(resp.result.accessor, 8)}</span></div>}
            </>
          ) : (
            <>
              <div className="verdict err"><span className="badge"><VerdictMark ok={false} /></span><span>{state === "failed" ? "No proof produced" : "Rejected"}</span></div>
              <p className="err-text" data-testid="grant-reject-reason">{friendlyError(resp.error)}</p>
            </>
          )}
        </div>
      )}

      {/* auditor view-key */}
      <div className="card">
        <h2>Auditor <span className="demo-note">unlock authorized figures with the view key</span></h2>
        <p className="hint">An allow-listed auditor holds a <b>view key</b> that decrypts each employee's exact salary — and the proof guarantees it equals the attester-signed figure (<b>faithful</b>). The public, with no key, sees only the ciphertext. Leave the field blank to use the demo auditor's key; paste a different key to see <b>faithful = ✗</b>.</p>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>view key (hex, blank = demo auditor)</label>
          <input style={{ minWidth: 360, fontFamily: "monospace", fontSize: 12 }} value={viewKey} onChange={(e) => setViewKey(e.target.value)} aria-label="view key" data-testid="view-key" placeholder="32-byte hex (optional)" />
          <button onClick={onUnlock} data-testid="unlock">Unlock figures</button>
        </div>
        {audit && (
          <>
            <table className="tbl" data-testid="audit-table" style={{ marginTop: 12 }}>
              <thead><tr><th>#</th><th>accessor</th><th>threshold</th><th>salary</th><th>faithful</th></tr></thead>
              <tbody>
                {audit.entries.map((e, i) => (
                  <tr key={e.index}>
                    <td>{e.index}</td>
                    <td title={e.accessor}>{short(e.accessor, 8)}</td>
                    <td>{e.threshold}</td>
                    <td data-testid={`salary-${i}`}>{e.salary ?? "—"}</td>
                    <td>{e.faithful ? "✓" : "✗"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 8 }}><span className="k">payroll total (auditor-summed)</span><span className="v" data-testid="payroll-total"><b>{audit.total}</b> over {audit.count} employee(s){audit.grants > audit.count ? ` · ${audit.grants} grants` : ""}</span></div>
          </>
        )}
        {auditErr && !audit && <p className="err-text" data-testid="audit-error">{auditErr}</p>}
      </div>

      {/* public history */}
      <div className="card">
        <h2>Income-verified grants <span className="demo-note">anyone can read on-chain · salaries hidden</span></h2>
        {history.length ? (
          <table className="tbl" data-testid="payroll-history">
            <thead><tr><th>#</th><th>accessor</th><th>threshold</th><th>salary</th><th>ledger</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.index}>
                  <td>{h.index}</td>
                  <td title={h.accessor}>{short(h.accessor, 8)}</td>
                  <td>{h.threshold}</td>
                  <td className="private">hidden</td>
                  <td>{h.ledger}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint">No income-verified grants yet.</p>
        )}
      </div>
    </>
  );
}
