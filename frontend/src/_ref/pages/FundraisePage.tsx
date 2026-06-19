import { useCallback, useEffect, useRef, useState } from "react";
import {
  getInfo,
  getProveStatus,
  proveAccredited,
  grantAccredited,
  proveRevenue,
  submitRevenue,
  getFundraiseInfo,
  canAccessFundraise,
  requestFundraiseAccess,
  getFundraiseHistory,
  type Info,
  type Bundle,
  type GrantResp,
  type FundraiseInfo,
  type CanAccessResp,
  type InvestorAccess,
  type RevenueSubmitResp,
  type FundraiseGrantResp,
} from "../api";
import { decodeIdentityJournal, decodeJournal } from "../journal";
import { ProofStatusBadge, ProveWait, VerdictMark, type ClaimState } from "../StatusBadge";
import { humanError } from "../errors";

// The demo investor wallet — the public accessor the accreditation proof binds to (already admitted
// on-chain, so the composition banner reads GRANTED on first load).
const DEMO_USER_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";
const short = (h: string, n = 6) => (h && h.length > 2 * n ? `${h.slice(0, n)}…${h.slice(-n)}` : h);
const fmtUsd = (v?: string) => (v ? "$" + BigInt(v).toLocaleString("en-US") : "—");

function friendlyError(e?: string): string {
  return humanError(e, "fundraise");
}

/** A positive whole-number revenue (the input is free-text; reject empty / non-numeric / ≤ 0 before proving). */
function validRevenue(v: string): boolean {
  return /^\d+$/.test(v.trim()) && BigInt(v.trim()) > 0n;
}

export default function FundraisePage() {
  const [info, setInfo] = useState<Info | null>(null);
  const [fund, setFund] = useState<FundraiseInfo | null>(null);

  // company (revenue ≥ X) panel
  const [revenue, setRevenue] = useState("1500000");
  const [revState, setRevState] = useState<ClaimState>("draft");
  const [revBy, setRevBy] = useState<string | null>(null);
  const [revBundle, setRevBundle] = useState<Bundle | null>(null);
  const [revResp, setRevResp] = useState<RevenueSubmitResp | null>(null);
  const [revBusy, setRevBusy] = useState(false);
  const revPoll = useRef<ReturnType<typeof setInterval> | null>(null);

  // investor (accredited) panel
  const [subject, setSubject] = useState("ivy");
  const [accessor, setAccessor] = useState(DEMO_USER_G);
  const [accStatus, setAccStatus] = useState(true);
  const [accState, setAccState] = useState<ClaimState>("draft");
  const [accBy, setAccBy] = useState<string | null>(null);
  const [accBundle, setAccBundle] = useState<Bundle | null>(null);
  const [accResp, setAccResp] = useState<GrantResp | null>(null);
  const [accBusy, setAccBusy] = useState(false);
  const accPoll = useRef<ReturnType<typeof setInterval> | null>(null);

  // composition panel
  const [checkAccessor, setCheckAccessor] = useState(DEMO_USER_G);
  const [access, setAccess] = useState<CanAccessResp | null>(null);
  const [admitResp, setAdmitResp] = useState<FundraiseGrantResp | null>(null);
  const [history, setHistory] = useState<InvestorAccess[]>([]);

  const explorer = (kind: "contract" | "tx", id: string) =>
    `https://stellar.expert/explorer/${info?.network ?? "testnet"}/${kind}/${id}`;

  const refreshFund = useCallback(() => getFundraiseInfo().then(setFund).catch(() => {}), []);
  const refreshHistory = useCallback(() => getFundraiseHistory(0, 20).then((h) => setHistory(h.results)).catch(() => {}), []);
  const refreshAccess = useCallback(
    (who: string) => canAccessFundraise(who).then(setAccess).catch(() => setAccess(null)),
    [],
  );

  useEffect(() => {
    getInfo().then(setInfo).catch(() => {});
    refreshFund();
    refreshHistory();
    refreshAccess(DEMO_USER_G);
    return () => {
      if (revPoll.current) clearInterval(revPoll.current);
      if (accPoll.current) clearInterval(accPoll.current);
    };
  }, [refreshFund, refreshHistory, refreshAccess]);

  const revJournal = revBundle?.journal ? decodeJournal(revBundle.journal) : null;
  const accJournal = accBundle?.journal ? decodeIdentityJournal(accBundle.journal) : null;
  const X = fund?.config?.revenue_threshold ?? info?.fundraiseThreshold;

  // ---- company: prove revenue ≥ X then submit ----
  async function onSubmitRevenue(b: Bundle | null) {
    if (!b) return;
    setRevBusy(true);
    setRevState("verifying");
    try {
      const r = await submitRevenue(b);
      setRevResp(r);
      setRevState(r.ok ? "verified" : "rejected");
      if (r.ok) { refreshFund(); refreshAccess(checkAccessor); }
    } catch (e) {
      setRevResp({ ok: false, error: String((e as Error).message ?? e), fundraiseId: info?.fundraiseId ?? "" });
      setRevState("rejected");
    } finally {
      setRevBusy(false);
    }
  }
  async function onProveRevenue() {
    if (revPoll.current) clearInterval(revPoll.current);
    setRevBusy(true); setRevResp(null); setRevBundle(null); setRevBy(null); setRevState("proving");
    try {
      const { jobId } = await proveRevenue(revenue);
      revPoll.current = setInterval(async () => {
        try {
          const s = await getProveStatus(jobId);
          setRevBy(s.by ?? null);
          if (s.status === "done" && s.bundle) {
            if (revPoll.current) clearInterval(revPoll.current);
            setRevBundle(s.bundle); setRevState("proved"); setRevBusy(false); onSubmitRevenue(s.bundle);
          } else if (s.status === "error") {
            if (revPoll.current) clearInterval(revPoll.current);
            setRevResp({ ok: false, error: s.error || "revenue below X — the guest produced no receipt.", fundraiseId: "" });
            setRevState("failed"); setRevBusy(false);
          }
        } catch { /* keep polling */ }
      }, 4000);
    } catch (e) {
      setRevResp({ ok: false, error: String((e as Error).message ?? e), fundraiseId: "" });
      setRevState("failed"); setRevBusy(false);
    }
  }

  // ---- investor: prove accredited then grant ----
  async function onGrantAccredited(b: Bundle | null) {
    if (!b) return;
    setAccBusy(true); setAccState("verifying"); setAccResp(null);
    try {
      const r = await grantAccredited(b);
      setAccResp(r);
      setAccState(r.ok ? "verified" : "rejected");
      if (r.ok) { setCheckAccessor(accessor); refreshAccess(accessor); }
    } catch (e) {
      setAccResp({ ok: false, error: String((e as Error).message ?? e), gateId: info?.accreditedId ?? "" });
      setAccState("rejected");
    } finally {
      setAccBusy(false);
    }
  }
  async function onProveAccredited() {
    if (accPoll.current) clearInterval(accPoll.current);
    setAccBusy(true); setAccResp(null); setAccBundle(null); setAccBy(null); setAccState("proving");
    try {
      const { jobId } = await proveAccredited(subject, accessor, accStatus ? 1 : 0);
      accPoll.current = setInterval(async () => {
        try {
          const s = await getProveStatus(jobId);
          setAccBy(s.by ?? null);
          if (s.status === "done" && s.bundle) {
            if (accPoll.current) clearInterval(accPoll.current);
            setAccBundle(s.bundle); setAccState("proved"); setAccBusy(false); onGrantAccredited(s.bundle);
          } else if (s.status === "error") {
            if (accPoll.current) clearInterval(accPoll.current);
            setAccResp({ ok: false, error: accStatus ? (s.error || "proving failed") : "not accredited — the guest produced no receipt.", gateId: "" });
            setAccState("failed"); setAccBusy(false);
          }
        } catch { /* keep polling */ }
      }, 4000);
    } catch (e) {
      setAccResp({ ok: false, error: String((e as Error).message ?? e), gateId: "" });
      setAccState("failed"); setAccBusy(false);
    }
  }

  // ---- composition: request access + check ----
  async function onRequestAccess() {
    try {
      const r = await requestFundraiseAccess(checkAccessor);
      setAdmitResp(r);
      if (r.ok) { refreshHistory(); }
      refreshAccess(checkAccessor);
    } catch (e) {
      setAdmitResp({ ok: false, error: String((e as Error).message ?? e), fundraiseId: info?.fundraiseId ?? "" });
    }
  }

  const revVerified = fund?.revenueVerified ?? false;
  const accredited = access?.accredited ?? false;
  const canAccess = access?.canAccess ?? false;

  return (
    <>
      <p className="sub">
        A fundraise an investor can access <b>only by proving BOTH</b> — (a) they are an <b>accredited
        investor</b> (their identity stays hidden) AND (b) the fundraise has <b>revenue ≥ X</b> (the real
        revenue stays hidden). Two independent <b>private proofs</b> about two different parties, <b>checked
        together on the public record</b>.
      </p>

      {/* engine */}
      <div className="card">
        <h2>Engine</h2>
        <div className="row"><span className="k">Network</span><span className="v">{info?.network ?? "…"}</span></div>
        {info?.fundraiseId && <div className="row"><span className="k">Fundraise contract</span><span className="v"><a href={explorer("contract", info.fundraiseId)} target="_blank" rel="noreferrer">{short(info.fundraiseId, 8)} ↗</a></span></div>}
        {info?.accreditedId && <div className="row"><span className="k">Accredited gate</span><span className="v"><a href={explorer("contract", info.accreditedId)} target="_blank" rel="noreferrer">{short(info.accreditedId, 8)} ↗</a></span></div>}
        {info?.verifierId && <div className="row"><span className="k">Groth16 verifier</span><span className="v"><a href={explorer("contract", info.verifierId)} target="_blank" rel="noreferrer">{short(info.verifierId, 8)} ↗</a></span></div>}
        <div className="row"><span className="k">Revenue floor (X, public)</span><span className="v">{fmtUsd(X)}</span></div>
      </div>

      {/* COMPOSITION banner — the headline */}
      <div className="card" data-testid="composition">
        <h2>Investor access <span className="demo-note">accredited ∧ revenue ≥ X</span></h2>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>investor accessor</label>
          <input style={{ minWidth: 360, fontFamily: "monospace", fontSize: 12 }} value={checkAccessor} onChange={(e) => setCheckAccessor(e.target.value)} aria-label="check accessor" data-testid="check-accessor" />
          <button className="ghost" onClick={() => refreshAccess(checkAccessor)} data-testid="check-access">Check</button>
          <button onClick={onRequestAccess} disabled={!revVerified || !accredited} data-testid="request-access">Request fundraise access</button>
        </div>
        <div className="btnrow" style={{ gap: 24, marginTop: 12, flexWrap: "wrap" }}>
          <span className="v" data-testid="leg-accredited" data-ok={accredited}>{accredited ? "✓" : "✗"} accredited investor</span>
          <span className="v" data-testid="leg-revenue" data-ok={revVerified}>{revVerified ? "✓" : "✗"} revenue ≥ {fmtUsd(X)}</span>
        </div>
        <div className="verdict" data-testid="access-verdict" data-granted={canAccess} style={{ marginTop: 12 }}>
          <span className="badge"><VerdictMark ok={!!canAccess} /></span>
          <span>{canAccess ? "ACCESS GRANTED — both proofs hold" : accredited ? "ACCESS DENIED — fundraise revenue not proven" : revVerified ? "ACCESS DENIED — investor not accredited" : "ACCESS DENIED — neither proof holds"}</span>
        </div>
        {admitResp && (
          admitResp.ok
            ? <div className="row" style={{ marginTop: 8 }}><span className="k">admitted (tx)</span><span className="v">{admitResp.txHash ? <a href={explorer("tx", admitResp.txHash)} target="_blank" rel="noreferrer">{short(admitResp.txHash, 8)} ↗</a> : "ok"}</span></div>
            : <p className="err-text" data-testid="admit-error">{friendlyError(admitResp.error)}</p>
        )}
      </div>

      {/* company: prove revenue ≥ X */}
      <div className="card">
        <h2>Company — prove revenue ≥ X <ProofStatusBadge state={revState} /></h2>
        <p className="hint">The company's auditor signs the real (private) revenue; the zkVM proves it clears the public floor X. Only "≥ X" is revealed.</p>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>revenue (private, USD)</label>
          <input style={{ width: 160 }} value={revenue} onChange={(e) => setRevenue(e.target.value)} aria-label="revenue" data-testid="revenue" />
          <button onClick={onProveRevenue} disabled={revBusy || !validRevenue(revenue)} data-testid="prove-revenue">
            {revState === "proving" ? "Proving…" : "Prove revenue ≥ X & submit"}
          </button>
        </div>
        {!validRevenue(revenue) && <p className="hint">Enter a positive whole-number revenue (private — only "≥ X" is revealed).</p>}
        <ProveWait state={revState} proveBy={revBy} privacy="The real revenue figure never leaves the prover." />
        {revJournal && (
          <>
            <div className="demo-note" style={{ marginTop: 16 }}>Public journal — the revenue itself is absent</div>
            <div className="row"><span className="k">claim</span><span className="v">{revJournal.claimType === 6 ? "Revenue ≥ X" : `type ${revJournal.claimType}`}</span></div>
            <div className="row"><span className="k">proven floor (X)</span><span className="v">{fmtUsd(revJournal.threshold)}</span></div>
            <div className="row"><span className="k">revenue</span><span className="v private">private — never revealed</span></div>
          </>
        )}
        {revResp && !revResp.ok && <p className="err-text">{friendlyError(revResp.error)}</p>}
      </div>

      {/* investor: prove accredited */}
      <div className="card">
        <h2>Investor — prove accredited <ProofStatusBadge state={accState} /></h2>
        <p className="hint">An allow-listed accreditation provider signs the investor's credential; the zkVM proves "accredited = yes" while the investor's identity stays private, bound to a public accessor.</p>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>investor (private)</label>
          <select value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="subject" data-testid="subject">
            <option value="ivy">Ivy</option>
            <option value="fred">Fred</option>
          </select>
          <label className="fld" style={{ margin: 0 }}>status</label>
          <select value={accStatus ? "yes" : "no"} onChange={(e) => setAccStatus(e.target.value === "yes")} aria-label="accredited status" data-testid="accredited-status">
            <option value="yes">accredited</option>
            <option value="no">not accredited</option>
          </select>
        </div>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>accessor</label>
          <input style={{ minWidth: 360, fontFamily: "monospace", fontSize: 12 }} value={accessor} onChange={(e) => setAccessor(e.target.value)} aria-label="accessor" data-testid="accessor" />
          <button onClick={onProveAccredited} disabled={accBusy} data-testid="prove-accredited">
            {accState === "proving" ? "Proving…" : "Prove accredited & grant"}
          </button>
        </div>
        <ProveWait state={accState} proveBy={accBy} privacy="The investor's identity never leaves the prover." />
        {accJournal && (
          <>
            <div className="demo-note" style={{ marginTop: 16 }}>Public journal — the identity is absent</div>
            <div className="row"><span className="k">claim</span><span className="v">{accJournal.claimType === 7 ? "Accredited investor" : `type ${accJournal.claimType}`}</span></div>
            <div className="row"><span className="k">accessor (granted)</span><span className="v">{short(accJournal.accessor, 8)}</span></div>
            <div className="row"><span className="k">identity</span><span className="v private" data-testid="identity-private">private — never revealed</span></div>
          </>
        )}
        {accResp && !accResp.ok && <p className="err-text" data-testid="accredited-error">{friendlyError(accResp.error)}</p>}
      </div>

      {/* admission history */}
      <div className="card">
        <h2>Investor admissions <span className="demo-note">anyone can read on-chain</span></h2>
        {history.length ? (
          <table className="tbl" data-testid="admission-history">
            <thead><tr><th>#</th><th>accessor</th><th>revenue floor</th><th>ledger</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.index}>
                  <td>{h.index}</td>
                  <td title={h.accessor}>{short(h.accessor, 8)}</td>
                  <td>{fmtUsd(h.revenue_threshold)}</td>
                  <td>{h.ledger}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint">No admissions yet.</p>
        )}
      </div>
    </>
  );
}
