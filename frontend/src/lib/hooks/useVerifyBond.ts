import { useCallback, useEffect, useState } from "react";
import { getBondStatus, type BondStatus } from "@/lib/api";

// Read-only verification of a shared bonded-access grant. Everything comes from the public bond gate read
// is_granted(accessor, req_id); no wallet, no secret. The accessor is the anonymous handle id, so this view
// reveals nothing about the wallet behind it.

export interface BondVerifyParams {
  accessor: string;
  reqId: string;
  token?: string;
  amount?: string;
  symbol?: string;
  decimals: number;
  deadline?: number;
}

export type BondVerdict = "verified" | "expired" | "not-found" | "invalid";

const HEX64 = /^[0-9a-f]{64}$/i;

/** Parse + validate the /verify/bond query params. Returns null when the link is missing the essentials. */
export function parseBondVerifyParams(sp: URLSearchParams): BondVerifyParams | null {
  const accessor = sp.get("accessor") ?? "";
  const reqId = sp.get("req") ?? "";
  if (!HEX64.test(accessor) || !HEX64.test(reqId)) return null;
  const amount = sp.get("amount") ?? "";
  const deadlineRaw = sp.get("deadline") ?? "";
  const decRaw = sp.get("decimals") ?? "";
  const symbol = (sp.get("symbol") ?? "").slice(0, 16);
  return {
    accessor: accessor.toLowerCase(),
    reqId: reqId.toLowerCase(),
    token: sp.get("token") ?? undefined,
    amount: /^\d{1,40}$/.test(amount) ? amount : undefined,
    symbol: symbol || undefined,
    decimals: /^\d{1,2}$/.test(decRaw) ? Number(decRaw) : 7,
    deadline: /^\d{1,15}$/.test(deadlineRaw) ? Number(deadlineRaw) : undefined,
  };
}

export function useVerifyBond(params: BondVerifyParams | null) {
  const [state, setState] = useState<"checking" | "done" | "error">("checking");
  const [status, setStatus] = useState<BondStatus | null>(null);
  const [verdict, setVerdict] = useState<BondVerdict>("invalid");
  const [err, setErr] = useState("");

  const run = useCallback(async () => {
    if (!params) {
      setVerdict("invalid");
      setStatus(null);
      setState("done");
      return;
    }
    setState("checking");
    setErr("");
    try {
      const s = await getBondStatus(params.accessor, params.reqId);
      setStatus(s);
      const now = Math.floor(Date.now() / 1000);
      if (s.is_granted) setVerdict("verified");
      else if (s.grant || (params.deadline && now >= params.deadline)) setVerdict("expired");
      else setVerdict("not-found");
      setState("done");
    } catch (e) {
      setErr((e as Error)?.message ?? "Could not reach the bond gate.");
      setState("error");
    }
    // Re-run only when the verified requirement changes, not on every object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.accessor, params?.reqId, params?.deadline]);

  useEffect(() => {
    void run();
  }, [run]);

  const gateId = status?.bondGateId ?? null;
  return { state, status, verdict, err, run, gateId };
}
