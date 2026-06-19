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
} from "@/lib/api";
import { decodePayrollJournal } from "@/lib/journal";
import { type ClaimState } from "@/components/StatusBadge";

// Deterministic demo "employee wallet" — the public accessor the income proof grants to.
export const DEMO_USER_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";

// Confidential payroll data layer (extracted from the legacy PayrollPage). Both variants render from this.
export function usePayroll() {
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

  const onGrant = useCallback(
    async (b: Bundle | null = bundle) => {
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
    },
    [bundle, info, refreshHistory],
  );

  const onProve = useCallback(async () => {
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
  }, [salary, threshold, accessor, onGrant]);

  const onUnlock = useCallback(async () => {
    setAuditErr(null);
    try {
      const a = await auditPayroll(viewKey.trim() || undefined);
      setAudit(a);
    } catch (e) {
      setAudit(null);
      setAuditErr(String((e as Error).message ?? e));
    }
  }, [viewKey]);

  return {
    info,
    salary,
    setSalary,
    threshold,
    setThreshold,
    accessor,
    setAccessor,
    state,
    proveBy,
    bundle,
    journal,
    resp,
    busy,
    viewKey,
    setViewKey,
    audit,
    auditErr,
    history,
    onProve,
    onGrant,
    onUnlock,
  };
}
