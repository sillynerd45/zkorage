import { useCallback, useEffect, useRef, useState } from "react";
import {
  getInfo,
  getProveStatus,
  proveKyc,
  grantAccess,
  getGateAccess,
  getGateHistory,
  type Info,
  type Bundle,
  type AccessRecord,
  type GrantResp,
} from "../api";
import { decodeIdentityJournal } from "../journal";
import { ProofStatusBadge, ProveWait, VerdictMark, type ClaimState } from "../StatusBadge";
import { humanError } from "../errors";

// Deterministic demo "user wallet" — the public accessor the KYC proof grants access to (Q3).
const DEMO_USER_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";
const short = (h: string, n = 6) => (h && h.length > 2 * n ? `${h.slice(0, n)}…${h.slice(-n)}` : h);

function friendlyError(e?: string): string {
  return humanError(e, "identity");
}

export default function IdentityPage() {
  const [info, setInfo] = useState<Info | null>(null);
  const [subject, setSubject] = useState("alice");
  const [accessor, setAccessor] = useState(DEMO_USER_G);
  const [kycPassed, setKycPassed] = useState(true);

  const [state, setState] = useState<ClaimState>("draft");
  const [proveBy, setProveBy] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [resp, setResp] = useState<GrantResp | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // relying-party panel
  const [checkAccessor, setCheckAccessor] = useState(DEMO_USER_G);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [grantedRec, setGrantedRec] = useState<AccessRecord | null>(null);
  const [history, setHistory] = useState<AccessRecord[]>([]);

  const explorer = (kind: "contract" | "tx", id: string) =>
    `https://stellar.expert/explorer/${info?.network ?? "testnet"}/${kind}/${id}`;

  const refreshHistory = useCallback(
    () => getGateHistory(0, 20).then((h) => setHistory(h.results)).catch(() => {}),
    [],
  );

  useEffect(() => {
    getInfo().then(setInfo).catch(() => {});
    refreshHistory();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refreshHistory]);

  const journal = bundle?.journal ? decodeIdentityJournal(bundle.journal) : null;

  async function onGrant(b: Bundle | null = bundle) {
    if (!b) return;
    setBusy(true);
    setState("verifying");
    setResp(null);
    try {
      const r = await grantAccess(b);
      setResp(r);
      setState(r.ok ? "verified" : "rejected");
      // Auto-show the relying-party result for the accessor we just granted (keep the panel input in sync).
      if (r.ok) { refreshHistory(); setCheckAccessor(accessor); onCheck(accessor); }
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), gateId: info?.gateId ?? "" });
      setState("rejected");
    } finally {
      setBusy(false);
    }
  }

  async function onProve() {
    if (pollRef.current) clearInterval(pollRef.current); // drop any stale poller before starting a new run
    setBusy(true);
    setResp(null);
    setBundle(null);
    setProveBy(null);
    setState("proving");
    try {
      const { jobId } = await proveKyc(subject, accessor, kycPassed ? 1 : 0);
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
            // For a FAILED KYC the guest panics → no receipt → proving "fails" by design.
            setResp({
              ok: false,
              error: kycPassed ? (s.error || "proving failed") : "KYC not passed — the guest produced no receipt (nothing to verify).",
              gateId: "",
            });
            setState("failed");
            setBusy(false);
          }
        } catch { /* keep polling */ }
      }, 4000);
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), gateId: "" });
      setState("failed");
      setBusy(false);
    }
  }

  async function onCheck(who: string = checkAccessor) {
    try {
      const r = await getGateAccess(who);
      setGranted(r.granted);
      setGrantedRec(r.record);
    } catch {
      setGranted(false);
      setGrantedRec(null);
    }
  }

  return (
    <>
      <p className="sub">
        A user proves they are <b>ID-checked by an approved provider</b> — <b>without revealing
        their identity</b> — and the proof grants access to a chosen account. The provider signs a
        credential about the person; the proof shows "ID check passed, by an approved source" while their
        identity stays private. The proof is tied to a public account (the one that gets access).
      </p>

      {/* engine */}
      <div className="card">
        <h2>Engine</h2>
        <div className="row"><span className="k">Network</span><span className="v">{info?.network ?? "…"}</span></div>
        {info?.gateId && <div className="row"><span className="k">KYC gate</span><span className="v"><a href={explorer("contract", info.gateId)} target="_blank" rel="noreferrer">{short(info.gateId, 8)} ↗</a></span></div>}
        {info?.verifierId && <div className="row"><span className="k">Groth16 verifier</span><span className="v"><a href={explorer("contract", info.verifierId)} target="_blank" rel="noreferrer">{short(info.verifierId, 8)} ↗</a></span></div>}
        {info?.kycIssuerId && <div className="row"><span className="k">KYC provider (allow-listed)</span><span className="v">{short(info.kycIssuerId, 8)}</span></div>}
      </div>

      {/* prover */}
      <div className="card">
        <h2>Prove KYC <ProofStatusBadge state={state} /></h2>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>subject (private)</label>
          <select value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="subject" data-testid="subject">
            <option value="alice">Alice</option>
            <option value="bob">Bob</option>
          </select>
          <label className="fld" style={{ margin: 0 }}>KYC status</label>
          <select value={kycPassed ? "passed" : "failed"} onChange={(e) => setKycPassed(e.target.value === "passed")} aria-label="kyc status" data-testid="kyc-status">
            <option value="passed">passed</option>
            <option value="failed">failed</option>
          </select>
        </div>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>accessor (Stellar account to gate)</label>
          <input style={{ minWidth: 380, fontFamily: "monospace", fontSize: 12 }} value={accessor} onChange={(e) => setAccessor(e.target.value)} aria-label="accessor" data-testid="accessor" />
        </div>
        <div className="btnrow">
          <button onClick={onProve} disabled={busy} data-testid="prove">
            {state === "proving" ? "Proving…" : "Generate proof & grant access"}
          </button>
        </div>
        <ProveWait state={state} proveBy={proveBy} privacy="Your identity never leaves the prover." />

        {journal && (
          <>
            <div className="demo-note" style={{ marginTop: 16 }}>Public journal (what goes on-chain) — note the identity is absent</div>
            <div className="row"><span className="k">claim</span><span className="v">{journal.claimType === 3 ? "Identity / KYC" : `type ${journal.claimType}`}</span></div>
            <div className="row"><span className="k">result</span><span className="v">{journal.result ? "KYC passed ✓" : "false"}</span></div>
            <div className="row"><span className="k">KYC provider (issuer)</span><span className="v">{short(journal.issuerId, 8)}</span></div>
            <div className="row"><span className="k">accessor (granted)</span><span className="v">{short(journal.accessor, 8)}</span></div>
            <div className="row"><span className="k">subject / identity</span><span className="v private" data-testid="subject-private">private — never revealed</span></div>
          </>
        )}
      </div>

      {/* verdict */}
      {resp && (
        <div className="card" data-testid="grant-verdict-card">
          {resp.ok ? (
            <>
              <div className="verdict ok"><span className="badge"><VerdictMark ok /></span><span>KYC verified — access granted on Stellar</span></div>
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

      {/* relying party */}
      <div className="card">
        <h2>Relying party <span className="demo-note">gate a wallet behind KYC</span></h2>
        <p className="hint">A relying party checks whether an account has a valid KYC access grant — without ever learning who the account belongs to.</p>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <input style={{ minWidth: 380, fontFamily: "monospace", fontSize: 12 }} value={checkAccessor} onChange={(e) => setCheckAccessor(e.target.value)} aria-label="check accessor" data-testid="check-accessor" />
          <button className="ghost" onClick={() => onCheck()} data-testid="check-access">Check access</button>
        </div>
        {granted !== null && (
          <div className="verdict" data-testid="access-verdict" data-granted={granted} style={{ marginTop: 12 }}>
            <span className="badge"><VerdictMark ok={granted} /></span>
            <span>{granted ? "ACCESS GRANTED — KYC-verified" : "ACCESS DENIED — no valid KYC proof"}</span>
          </div>
        )}
        {granted && grantedRec && (
          <>
            <div className="row"><span className="k">KYC provider</span><span className="v">{short(grantedRec.issuer_id, 8)}</span></div>
            <div className="row"><span className="k">granted at ledger</span><span className="v">{grantedRec.ledger}</span></div>
          </>
        )}
      </div>

      {/* access history */}
      <div className="card">
        <h2>Access grants <span className="demo-note">anyone can read on-chain</span></h2>
        {history.length ? (
          <table className="tbl" data-testid="access-history">
            <thead><tr><th>#</th><th>accessor</th><th>KYC provider</th><th>ledger</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.index}>
                  <td>{h.index}</td>
                  <td title={h.accessor}>{short(h.accessor, 8)}</td>
                  <td title={h.issuer_id}>{short(h.issuer_id, 8)}</td>
                  <td>{h.ledger}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint">No access grants yet.</p>
        )}
      </div>
    </>
  );
}
