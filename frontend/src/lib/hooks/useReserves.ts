import { useCallback, useEffect, useRef, useState } from "react";
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
  type Info,
  type Bundle,
  type VerifiedResult,
  type SubmitResp,
} from "@/lib/api";
import { decodeJournal } from "@/lib/journal";
import { toBase } from "@/lib/format";
import { type ClaimState } from "@/components/StatusBadge";
import { useTxSigner } from "@/lib/wallet/WalletContext";

export const DECIMALS = 7;

// Proof-of-Reserves data layer (extracted from the legacy IssuerDashboard). Both variants render from this.
export function useReserves() {
  const [info, setInfo] = useState<Info | null>(null);
  const [supply, setSupply] = useState<string | null>(null);
  const [stored, setStored] = useState<VerifiedResult | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [reservesWhole, setReservesWhole] = useState("1200000");
  const [demoWhole, setDemoWhole] = useState("100000");
  const [pending, setPending] = useState<null | "mint" | "burn">(null);
  const [state, setState] = useState<ClaimState>("draft");
  const [proveBy, setProveBy] = useState<string | null>(null);
  const [resp, setResp] = useState<SubmitResp | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const signer = useTxSigner(); // connected wallet → user signs + pays; undefined → backend relays

  const refreshSupply = useCallback(() => getSupply().then((s) => setSupply(s.supply)).catch(() => {}), []);
  const refreshResult = useCallback(() => getResult().then((r) => setStored(r.result)).catch(() => {}), []);

  useEffect(() => {
    getInfo().then(setInfo).catch(() => {});
    refreshSupply();
    refreshResult();
    getBundle().then(setBundle).catch(() => {});
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshSupply, refreshResult]);

  const journal = bundle?.journal ? decodeJournal(bundle.journal) : null;
  const issuerId = stored?.issuer_id ?? journal?.issuerId ?? null;

  const onSubmit = useCallback(
    async (b: Bundle | null = bundle) => {
      if (!b) return;
      setBusy(true);
      setState("verifying");
      setResp(null);
      try {
        const r = await submit(b, signer);
        setResp(r);
        setState(r.ok ? "verified" : "rejected");
        if (r.ok) {
          refreshResult();
          refreshSupply();
        }
      } catch (e) {
        setResp({ ok: false, error: String((e as Error).message ?? e), policyId: info?.policyId ?? "" });
        setState("rejected");
      } finally {
        setBusy(false);
      }
    },
    [bundle, info, refreshResult, refreshSupply, signer],
  );

  const onGenerate = useCallback(async () => {
    setBusy(true);
    setResp(null);
    setProveBy(null);
    setState("proving");
    try {
      const { jobId } = await proveReserves(toBase(reservesWhole, DECIMALS));
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
        } catch {
          /* keep polling */
        }
      }, 4000);
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), policyId: "" });
      setState("failed");
      setBusy(false);
    }
  }, [reservesWhole, onSubmit]);

  const onMint = useCallback(async () => {
    setBusy(true);
    try {
      const r = await mint(demoWhole);
      setSupply(r.supply);
    } finally {
      setBusy(false);
    }
  }, [demoWhole]);

  const onBurn = useCallback(async () => {
    setBusy(true);
    try {
      const r = await burn(demoWhole);
      setSupply(r.supply);
    } finally {
      setBusy(false);
    }
  }, [demoWhole]);

  return {
    info,
    supply,
    stored,
    bundle,
    journal,
    issuerId,
    reservesWhole,
    setReservesWhole,
    demoWhole,
    setDemoWhole,
    state,
    proveBy,
    resp,
    busy,
    pending,
    setPending,
    onGenerate,
    onSubmit,
    onMint,
    onBurn,
  };
}
