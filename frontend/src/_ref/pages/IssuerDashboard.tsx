import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  getInfo,
  getSupply,
  getResult,
  getBundle,
  proveReserves,
  getProveStatus,
  submit,
  mint,
  burn,
  fmtAmount,
  type Info,
  type Bundle,
  type VerifiedResult,
  type SubmitResp,
} from "../api";
import { decodeJournal } from "../journal";
import { ProofStatusBadge, ProveWait, VerdictMark, type ClaimState } from "../StatusBadge";
import { ConfirmModal } from "../components/ConfirmModal";
import { humanError } from "../errors";

const DECIMALS = 7;
const short = (h: string, n = 6) => (h && h.length > 2 * n ? `${h.slice(0, n)}…${h.slice(-n)}` : h);
const toBase = (whole: string) => (BigInt(whole || "0") * 10n ** BigInt(DECIMALS)).toString();

function friendlyError(e?: string): string {
  return humanError(e, "reserves");
}

export default function IssuerDashboard() {
  const [info, setInfo] = useState<Info | null>(null);
  const [supply, setSupply] = useState<string | null>(null);
  const [stored, setStored] = useState<VerifiedResult | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);

  const [reservesWhole, setReservesWhole] = useState("1200000");
  const [demoWhole, setDemoWhole] = useState("100000");
  const [pending, setPending] = useState<null | "mint" | "burn">(null); // which on-chain supply change awaits confirm

  const [state, setState] = useState<ClaimState>("draft");
  const [proveBy, setProveBy] = useState<string | null>(null);
  const [resp, setResp] = useState<SubmitResp | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const explorer = (kind: "contract" | "tx", id: string) =>
    `https://stellar.expert/explorer/${info?.network ?? "testnet"}/${kind}/${id}`;

  const refreshSupply = useCallback(() => getSupply().then((s) => setSupply(s.supply)).catch(() => {}), []);
  const refreshResult = useCallback(() => getResult().then((r) => setStored(r.result)).catch(() => {}), []);

  useEffect(() => {
    getInfo().then(setInfo).catch(() => {});
    refreshSupply();
    refreshResult();
    getBundle().then(setBundle).catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refreshSupply, refreshResult]);

  const journal = bundle?.journal ? decodeJournal(bundle.journal) : null;
  const issuerId = stored?.issuer_id ?? journal?.issuerId ?? null;

  async function onSubmit(b: Bundle | null = bundle) {
    if (!b) return;
    setBusy(true);
    setState("verifying");
    setResp(null);
    try {
      const r = await submit(b);
      setResp(r);
      setState(r.ok ? "verified" : "rejected");
      if (r.ok) { refreshResult(); refreshSupply(); }
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), policyId: info?.policyId ?? "" });
      setState("rejected");
    } finally {
      setBusy(false);
    }
  }

  async function onGenerate() {
    setBusy(true);
    setResp(null);
    setProveBy(null);
    setState("proving");
    try {
      const { jobId } = await proveReserves(toBase(reservesWhole));
      pollRef.current = setInterval(async () => {
        try {
          const s = await getProveStatus(jobId);
          setProveBy(s.by ?? null);
          if (s.status === "done" && s.bundle) {
            if (pollRef.current) clearInterval(pollRef.current);
            setBundle(s.bundle);
            setState("proved");
            setBusy(false);
            onSubmit(s.bundle);
          } else if (s.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            setResp({ ok: false, error: s.error || "proving failed", policyId: "" });
            setState("failed");
            setBusy(false);
          }
        } catch { /* keep polling */ }
      }, 4000);
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), policyId: "" });
      setState("failed");
      setBusy(false);
    }
  }

  async function onMint() {
    setBusy(true);
    try { const r = await mint(demoWhole); setSupply(r.supply); } finally { setBusy(false); }
  }
  async function onBurn() {
    setBusy(true);
    try { const r = await burn(demoWhole); setSupply(r.supply); } finally { setBusy(false); }
  }

  return (
    <>
      <p className="sub">
        An issuer proves <b>reserves ≥ circulating supply</b> without revealing the reserve figure.
        The supply is tied to a real token's total supply; the proof is checked and recorded on the public
        record. Reserves never leave the prover you run.
      </p>

      {/* engine */}
      <div className="card">
        <h2>Engine</h2>
        <div className="row"><span className="k">Network</span><span className="v">{info?.network ?? "…"}</span></div>
        {info?.tokenId && <div className="row"><span className="k">SEP-41 token</span><span className="v"><a href={explorer("contract", info.tokenId)} target="_blank" rel="noreferrer">{short(info.tokenId, 8)} ↗</a></span></div>}
        {info?.policyId && <div className="row"><span className="k">PoR policy</span><span className="v"><a href={explorer("contract", info.policyId)} target="_blank" rel="noreferrer">{short(info.policyId, 8)} ↗</a></span></div>}
        {info?.verifierId && <div className="row"><span className="k">Groth16 verifier</span><span className="v"><a href={explorer("contract", info.verifierId)} target="_blank" rel="noreferrer">{short(info.verifierId, 8)} ↗</a></span></div>}
      </div>

      {/* supply + demo controls */}
      <div className="card">
        <h2>Circulating supply <span className="demo-note">on-chain liability anchor</span></h2>
        <div className="row"><span className="k">total_supply (zUSD)</span><span className="v big" data-testid="supply">{supply ? fmtAmount(supply, DECIMALS) : "…"}</span></div>
        <div className="demo-note" style={{ marginTop: 16 }}>Demo controls — change the supply, then re-verify to see the binding react</div>
        <div className="btnrow">
          <input style={{ maxWidth: 160 }} type="number" value={demoWhole} onChange={(e) => setDemoWhole(e.target.value)} aria-label="demo amount" />
          <button className="ghost" onClick={() => setPending("mint")} disabled={busy} data-testid="mint">+ Mint</button>
          <button className="danger" onClick={() => setPending("burn")} disabled={busy} data-testid="burn">− Burn</button>
        </div>
        <ConfirmModal
          open={pending !== null}
          title={pending === "mint" ? `Mint ${demoWhole} zUSD on-chain?` : `Burn ${demoWhole} zUSD on-chain?`}
          tone="outward"
          confirmLabel={pending === "mint" ? "Yes, mint" : "Yes, burn"}
          onCancel={() => setPending(null)}
          onConfirm={() => { const a = pending; setPending(null); if (a === "mint") onMint(); else if (a === "burn") onBurn(); }}
        >
          <p style={{ margin: 0 }}>
            This changes the demo token's on-chain <code>total_supply</code> — the live liability the
            proof is bound to. {pending === "mint" ? "Minting raises" : "Burning lowers"} it by {demoWhole} zUSD,
            so a previously-verified proof will stop matching until you change it back.
          </p>
        </ConfirmModal>
      </div>

      {/* the proof */}
      <div className="card">
        <h2>Proof-of-Reserves claim <ProofStatusBadge state={state} /></h2>
        {journal ? (
          <>
            <div className="row"><span className="k">claim</span><span className="v">{journal.claimType === 2 ? "Proof-of-Reserves" : `type ${journal.claimType}`}</span></div>
            <div className="row"><span className="k">proven supply (bound)</span><span className="v">{fmtAmount(journal.threshold, DECIMALS)} zUSD</span></div>
            <div className="row"><span className="k">reserves</span><span className="v private" data-testid="reserves-private">private — never revealed</span></div>
            <div className="row"><span className="k">issuer (custodian)</span><span className="v">{short(journal.issuerId, 8)}</span></div>
            <div className="row"><span className="k">image_id</span><span className="v">{short(bundle!.image_id, 8)}</span></div>
          </>
        ) : (
          <p className="hint">No proof loaded yet. Generate one below (self-hosted proving, ~minutes on CPU).</p>
        )}
        <div className="btnrow">
          <button onClick={() => onSubmit()} disabled={!bundle || busy} data-testid="verify">
            {state === "verifying" ? "Verifying…" : "Verify on-chain"}
          </button>
          <label className="fld" style={{ margin: 0 }}>reserves (zUSD)</label>
          <input style={{ maxWidth: 160 }} type="number" value={reservesWhole} onChange={(e) => setReservesWhole(e.target.value)} aria-label="reserves" />
          <button className="ghost" onClick={onGenerate} disabled={busy} data-testid="generate">Generate new proof</button>
        </div>
        <ProveWait state={state} proveBy={proveBy} />
      </div>

      {/* verdict */}
      {resp && (
        <div className="card" data-testid="verdict-card">
          {resp.ok ? (
            <>
              <div className="verdict ok"><span className="badge"><VerdictMark ok /></span><span>Reserves ≥ Supply — verified on Stellar</span></div>
              {resp.txHash && <div className="row"><span className="k">tx</span><span className="v"><a href={explorer("tx", resp.txHash)} target="_blank" rel="noreferrer">{short(resp.txHash, 8)} ↗</a></span></div>}
              {resp.cost?.minResourceFee && <div className="row"><span className="k">resource fee</span><span className="v">{resp.cost.minResourceFee} stroops</span></div>}
              {resp.result && <div className="row"><span className="k">bound supply</span><span className="v">{fmtAmount(resp.result.supply, DECIMALS)} zUSD</span></div>}
            </>
          ) : (
            <>
              <div className="verdict err"><span className="badge"><VerdictMark ok={false} /></span><span>Rejected</span></div>
              <p className="err-text" data-testid="reject-reason">{friendlyError(resp.error)}</p>
            </>
          )}
        </div>
      )}

      {/* persisted on-chain record */}
      <div className="card">
        <h2>On-chain verified record <span className="demo-note">anyone can read / re-verify</span></h2>
        {stored ? (
          <>
            <div className="row"><span className="k">result</span><span className="v" data-testid="stored-result">{stored.result ? "reserves ≥ supply ✓" : "false"}</span></div>
            <div className="row"><span className="k">bound supply</span><span className="v">{fmtAmount(stored.supply, DECIMALS)} zUSD</span></div>
            <div className="row"><span className="k">issuer</span><span className="v">{short(stored.issuer_id, 8)}</span></div>
            <div className="row"><span className="k">ledger</span><span className="v">{stored.ledger}</span></div>
            <div className="btnrow" style={{ marginTop: 14 }}>
              <Link className="btnlink" to={issuerId ? `/verify/${issuerId}` : "/verify"} data-testid="share-verify">
                Share · verify it yourself ↗
              </Link>
              <Link className="btnlink ghost" to="/explorer">Open explorer</Link>
            </div>
          </>
        ) : (
          <p className="hint">No verified result persisted yet.</p>
        )}
      </div>
    </>
  );
}
