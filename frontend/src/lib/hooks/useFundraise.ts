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
} from "@/lib/api";
import { decodeIdentityJournal, decodeJournal } from "@/lib/journal";
import { type ClaimState } from "@/components/StatusBadge";
import { humanError } from "@/lib/errors";
import { useTxSigner } from "@/lib/wallet/WalletContext";

// The demo investor wallet. This is the public accessor the accreditation proof binds to. It is
// already admitted on-chain, so the composition banner reads GRANTED on first load.
export const DEMO_USER_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";

export function friendlyError(e?: string): string {
  return humanError(e, "fundraise");
}

/** A positive whole-number revenue (the input is free-text; reject empty / non-numeric / ≤ 0 before proving). */
export function validRevenue(v: string): boolean {
  return /^\d+$/.test(v.trim()) && BigInt(v.trim()) > 0n;
}

// Fundraise composition data layer (extracted from the legacy FundraisePage). The page renders from this.
export function useFundraise() {
  const [info, setInfo] = useState<Info | null>(null);
  const [fund, setFund] = useState<FundraiseInfo | null>(null);
  const signer = useTxSigner(); // connected wallet → user signs + pays; undefined → backend relays

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

  // Connecting a wallet means "I'm the investor": fill the accessor with the wallet address (and check
  // its access), but only while it's still the untouched demo default.
  useEffect(() => {
    if (signer && accessor === DEMO_USER_G) {
      setAccessor(signer.address);
      setCheckAccessor(signer.address);
      refreshAccess(signer.address);
    }
  }, [signer, accessor, refreshAccess]);

  const revJournal = revBundle?.journal ? decodeJournal(revBundle.journal) : null;
  const accJournal = accBundle?.journal ? decodeIdentityJournal(accBundle.journal) : null;
  const X = fund?.config?.revenue_threshold ?? info?.fundraiseThreshold;

  // ---- company: prove revenue ≥ X then submit ----
  async function onSubmitRevenue(b: Bundle | null) {
    if (!b) return;
    setRevBusy(true);
    setRevState("verifying");
    try {
      const r = await submitRevenue(b, signer);
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
            setRevResp({ ok: false, error: s.error || "revenue below X, so the guest produced no receipt.", fundraiseId: "" });
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
      const r = await grantAccredited(b, signer);
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
            setAccResp({ ok: false, error: accStatus ? (s.error || "proving failed") : "not accredited, so the guest produced no receipt.", gateId: "" });
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
      const r = await requestFundraiseAccess(checkAccessor, signer);
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

  return {
    info,
    fund,
    // company (revenue ≥ X)
    revenue,
    setRevenue,
    revState,
    revBy,
    revJournal,
    revResp,
    revBusy,
    onProveRevenue,
    // investor (accredited)
    subject,
    setSubject,
    accessor,
    setAccessor,
    accStatus,
    setAccStatus,
    accState,
    accBy,
    accJournal,
    accResp,
    accBusy,
    onProveAccredited,
    // composition
    checkAccessor,
    setCheckAccessor,
    access,
    admitResp,
    history,
    refreshAccess,
    onRequestAccess,
    // derived
    X,
    revVerified,
    accredited,
    canAccess,
  };
}
