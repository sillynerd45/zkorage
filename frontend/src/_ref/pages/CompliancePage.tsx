import { useCallback, useEffect, useRef, useState } from "react";
import {
  getInfo,
  getProveStatus,
  proveCompliance,
  grantCompliance,
  getComplianceAccess,
  getComplianceHistory,
  type Info,
  type Bundle,
  type ComplianceAccessRecord,
  type ComplianceGrantResp,
} from "../api";
import { decodeComplianceJournal } from "../journal";
import { ProofStatusBadge, ProveWait, VerdictMark, type ClaimState } from "../StatusBadge";
import { humanError } from "../errors";

// Deterministic demo "user wallet" — the public accessor the compliance proof grants access to.
const DEMO_USER_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";
const short = (h: string, n = 6) => (h && h.length > 2 * n ? `${h.slice(0, n)}…${h.slice(-n)}` : h);

function friendlyError(e?: string): string {
  return humanError(e, "compliance");
}

export default function CompliancePage() {
  const [info, setInfo] = useState<Info | null>(null);
  const [subject, setSubject] = useState("alice");
  const [accessor, setAccessor] = useState(DEMO_USER_G);
  const [kycPassed, setKycPassed] = useState(true);

  const [state, setState] = useState<ClaimState>("draft");
  const [proveBy, setProveBy] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [resp, setResp] = useState<ComplianceGrantResp | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // relying-party panel
  const [checkAccessor, setCheckAccessor] = useState(DEMO_USER_G);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [grantedRec, setGrantedRec] = useState<ComplianceAccessRecord | null>(null);
  const [history, setHistory] = useState<ComplianceAccessRecord[]>([]);

  const explorer = (kind: "contract" | "tx", id: string) =>
    `https://stellar.expert/explorer/${info?.network ?? "testnet"}/${kind}/${id}`;

  const refreshHistory = useCallback(
    () => getComplianceHistory(0, 20).then((h) => setHistory(h.results)).catch(() => {}),
    [],
  );

  useEffect(() => {
    getInfo().then(setInfo).catch(() => {});
    refreshHistory();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refreshHistory]);

  const journal = bundle?.journal ? decodeComplianceJournal(bundle.journal) : null;

  async function onGrant(b: Bundle | null = bundle) {
    if (!b) return;
    setBusy(true);
    setState("verifying");
    setResp(null);
    try {
      const r = await grantCompliance(b);
      setResp(r);
      setState(r.ok ? "verified" : "rejected");
      if (r.ok) { refreshHistory(); setCheckAccessor(accessor); onCheck(accessor); }
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), complianceId: info?.complianceId ?? "" });
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
      const pr = await proveCompliance(subject, accessor, kycPassed ? 1 : 0);
      // A sanctioned subject can't prove non-membership — short-circuit to the ✗ case (no proving job).
      if (pr.sanctioned) {
        setResp({ ok: false, error: pr.message || "Subject is on the sanctions deny-list.", complianceId: info?.complianceId ?? "" });
        setState("failed");
        setBusy(false);
        return;
      }
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
            // A FAILED KYC makes the guest panic → no receipt → proving "fails" by design.
            setResp({
              ok: false,
              error: kycPassed ? (s.error || "proving failed") : "KYC not passed — the guest produced no receipt (nothing to verify).",
              complianceId: "",
            });
            setState("failed");
            setBusy(false);
          }
        } catch { /* keep polling */ }
      }, 4000);
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), complianceId: "" });
      setState("failed");
      setBusy(false);
    }
  }

  async function onCheck(who: string = checkAccessor) {
    try {
      const r = await getComplianceAccess(who);
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
        A user proves they are <b>ID-checked by an approved provider</b> <b>AND not on a sanctions
        list</b> — <b>without revealing their identity</b> — in a single proof, and the proof grants
        access to a chosen account. The proof checks the ID credential, then proves the person is
        <b> not on the sanctions list</b>, sharing only a fingerprint of that list. Their identity never
        leaves the prover.
      </p>

      {/* engine */}
      <div className="card">
        <h2>Engine</h2>
        <div className="row"><span className="k">Network</span><span className="v">{info?.network ?? "…"}</span></div>
        {info?.complianceId && <div className="row"><span className="k">Compliance gate</span><span className="v"><a href={explorer("contract", info.complianceId)} target="_blank" rel="noreferrer">{short(info.complianceId, 8)} ↗</a></span></div>}
        {info?.verifierId && <div className="row"><span className="k">Groth16 verifier</span><span className="v"><a href={explorer("contract", info.verifierId)} target="_blank" rel="noreferrer">{short(info.verifierId, 8)} ↗</a></span></div>}
        {info?.kycIssuerId && <div className="row"><span className="k">KYC provider (allow-listed)</span><span className="v">{short(info.kycIssuerId, 8)}</span></div>}
        {info?.denyRoot && <div className="row"><span className="k">Sanctions deny-list</span><span className="v" title={info.denyRoot} data-testid="deny-root">root {short(info.denyRoot, 8)} · {info.denySize} entries · depth {info.denyDepth}</span></div>}
      </div>

      {/* prover */}
      <div className="card">
        <h2>Prove compliance <ProofStatusBadge state={state} /></h2>
        <p className="hint">Pick <b>Mallory</b> (on the deny-list) to see the ✗ case — a sanctioned subject cannot generate a non-membership proof.</p>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>subject (private)</label>
          <select value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="subject" data-testid="subject">
            <option value="alice">Alice (clean)</option>
            <option value="bob">Bob (clean)</option>
            <option value="mallory">Mallory (sanctioned)</option>
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
            <div className="row"><span className="k">claim</span><span className="v">{journal.claimType === 4 ? "Compliance (KYC ∧ not-sanctioned)" : `type ${journal.claimType}`}</span></div>
            <div className="row"><span className="k">result</span><span className="v">{journal.result ? "KYC passed & not sanctioned ✓" : "false"}</span></div>
            <div className="row"><span className="k">KYC provider (issuer)</span><span className="v">{short(journal.issuerId, 8)}</span></div>
            <div className="row"><span className="k">sanctions deny-root</span><span className="v" title={journal.denyRoot}>{short(journal.denyRoot, 8)}</span></div>
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
              <div className="verdict ok"><span className="badge"><VerdictMark ok /></span><span>KYC'd &amp; not sanctioned — access granted on Stellar</span></div>
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
        <h2>Relying party <span className="demo-note">gate a wallet behind compliance</span></h2>
        <p className="hint">A relying party checks whether an account is KYC'd &amp; not-sanctioned — without ever learning who the account belongs to.</p>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <input style={{ minWidth: 380, fontFamily: "monospace", fontSize: 12 }} value={checkAccessor} onChange={(e) => setCheckAccessor(e.target.value)} aria-label="check accessor" data-testid="check-accessor" />
          <button className="ghost" onClick={() => onCheck()} data-testid="check-access">Check access</button>
        </div>
        {granted !== null && (
          <div className="verdict" data-testid="access-verdict" data-granted={granted} style={{ marginTop: 12 }}>
            <span className="badge"><VerdictMark ok={granted} /></span>
            <span>{granted ? "ACCESS GRANTED — KYC'd & not-sanctioned" : "ACCESS DENIED — no valid compliance proof"}</span>
          </div>
        )}
        {granted && grantedRec && (
          <>
            <div className="row"><span className="k">KYC provider</span><span className="v">{short(grantedRec.issuer_id, 8)}</span></div>
            <div className="row"><span className="k">deny-root checked</span><span className="v" title={grantedRec.deny_root}>{short(grantedRec.deny_root, 8)}</span></div>
            <div className="row"><span className="k">granted at ledger</span><span className="v">{grantedRec.ledger}</span></div>
          </>
        )}
      </div>

      {/* access history */}
      <div className="card">
        <h2>Compliance grants <span className="demo-note">anyone can read on-chain</span></h2>
        {history.length ? (
          <table className="tbl" data-testid="access-history">
            <thead><tr><th>#</th><th>accessor</th><th>KYC provider</th><th>deny-root</th><th>ledger</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.index}>
                  <td>{h.index}</td>
                  <td title={h.accessor}>{short(h.accessor, 8)}</td>
                  <td title={h.issuer_id}>{short(h.issuer_id, 8)}</td>
                  <td title={h.deny_root}>{short(h.deny_root, 6)}</td>
                  <td>{h.ledger}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint">No compliance grants yet.</p>
        )}
      </div>
    </>
  );
}
