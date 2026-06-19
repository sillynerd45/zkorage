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
} from "@/lib/api";
import { decodeComplianceJournal } from "@/lib/journal";
import { type ClaimState } from "@/components/StatusBadge";
import { useTxSigner } from "@/lib/wallet/WalletContext";

// Deterministic demo "user wallet" — the public accessor the compliance proof grants access to.
export const DEMO_USER_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";

// Compliance (KYC ∧ not-sanctioned) data layer — extracted verbatim from the legacy CompliancePage.
export function useCompliance() {
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
  const signer = useTxSigner(); // connected wallet → user signs + pays; undefined → backend relays

  // relying-party panel
  const [checkAccessor, setCheckAccessor] = useState(DEMO_USER_G);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [grantedRec, setGrantedRec] = useState<ComplianceAccessRecord | null>(null);
  const [history, setHistory] = useState<ComplianceAccessRecord[]>([]);

  const refreshHistory = useCallback(
    () => getComplianceHistory(0, 20).then((h) => setHistory(h.results)).catch(() => {}),
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

  const journal = bundle?.journal ? decodeComplianceJournal(bundle.journal) : null;

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

  async function onGrant(b: Bundle | null = bundle) {
    if (!b) return;
    setBusy(true);
    setState("verifying");
    setResp(null);
    try {
      const r = await grantCompliance(b, signer);
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
    journal,
    resp,
    busy,
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
