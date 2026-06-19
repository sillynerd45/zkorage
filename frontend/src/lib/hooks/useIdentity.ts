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
} from "@/lib/api";
import { decodeIdentityJournal } from "@/lib/journal";
import { type ClaimState } from "@/components/StatusBadge";
import { useTxSigner } from "@/lib/wallet/WalletContext";

// Deterministic demo "user wallet" — the public accessor the KYC proof grants access to (Q3).
export const DEMO_USER_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";

// Identity / KYC data layer (extracted from the legacy IdentityPage). The page renders from this.
export function useIdentity() {
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
  const signer = useTxSigner(); // connected wallet → user signs + pays; undefined → backend relays

  // relying-party panel
  const [checkAccessor, setCheckAccessor] = useState(DEMO_USER_G);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [grantedRec, setGrantedRec] = useState<AccessRecord | null>(null);
  const [history, setHistory] = useState<AccessRecord[]>([]);

  const refreshHistory = useCallback(
    () => getGateHistory(0, 20).then((h) => setHistory(h.results)).catch(() => {}),
    [],
  );

  useEffect(() => {
    getInfo().then(setInfo).catch(() => {});
    refreshHistory();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refreshHistory]);

  // Connecting a wallet means "prove for my own account": fill the accessor with the wallet address,
  // but only while it's still the untouched demo default (never clobber what the user typed).
  useEffect(() => {
    if (signer && accessor === DEMO_USER_G) {
      setAccessor(signer.address);
      setCheckAccessor(signer.address);
    }
  }, [signer, accessor]);

  const journal = bundle?.journal ? decodeIdentityJournal(bundle.journal) : null;

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

  async function onGrant(b: Bundle | null = bundle) {
    if (!b) return;
    setBusy(true);
    setState("verifying");
    setResp(null);
    try {
      const r = await grantAccess(b, signer);
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

  return {
    info,
    subject,
    setSubject,
    accessor,
    setAccessor,
    kycPassed,
    setKycPassed,
    state,
    proveBy,
    bundle,
    resp,
    busy,
    journal,
    checkAccessor,
    setCheckAccessor,
    granted,
    grantedRec,
    history,
    onProve,
    onGrant,
    onCheck,
  };
}
