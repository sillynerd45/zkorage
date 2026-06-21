import { useEffect, useRef, useState } from "react";
import {
  getMembershipInfo,
  getEligible,
  createRoom,
  registerMember,
  setEligibleRoot,
  proveAccess,
  requestAccess,
  getProveStatus,
  type MembershipInfoResp,
  type EligibleResp,
  type Bundle,
} from "@/lib/api";
import { DEMO_DATAROOM } from "zkorage-sdk";
import { type ClaimState } from "@/components/StatusBadge";
import { sdk } from "@/lib/sdk";
import { isHex32 } from "@/lib/format";

// DR2 (the marquee): anonymous eligibility plus nullifier (the load-bearing ZK).
export const DR2_DEMO_ROOM = DEMO_DATAROOM.roomId;
export const DR2_DEMO_ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";

export interface Dr2Grant {
  accessor: string;
  nullifier?: string;
  reused?: boolean;
}

export function useEligibility() {
  const [memInfo, setMemInfo] = useState<MembershipInfoResp | null>(null);
  const [elig, setElig] = useState<EligibleResp | null>(null);
  const [state, setState] = useState<ClaimState>("draft");
  const [step, setStep] = useState("");
  const [proveBy, setProveBy] = useState<string | null>(null);
  const [grant, setGrant] = useState<Dr2Grant | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [statusRoom, setStatusRoom] = useState(DR2_DEMO_ROOM);
  const [statusAccessor, setStatusAccessor] = useState(DR2_DEMO_ACCESSOR);
  const [statusRes, setStatusRes] = useState<{
    granted: boolean;
    grant: Awaited<ReturnType<typeof sdk.getGrant>>;
  } | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusErr, setStatusErr] = useState<string | null>(null);

  const cancel = useRef(false);

  useEffect(() => {
    getMembershipInfo().then(setMemInfo).catch(() => {});
    getEligible(DR2_DEMO_ROOM).then(setElig).catch(() => {});
    return () => {
      cancel.current = true;
    };
  }, []);

  // The full anonymous-eligibility ZK flow: mint an identity into a FRESH room's eligible set (anonymity
  // set of 2), pin the root, prove membership worker-first, request_access for the pseudonymous accessor.
  // Re-submitting the SAME proof must then be rejected #NullifierUsed.
  async function onRequestAccess() {
    setBusy(true);
    setErr(null);
    setGrant(null);
    setProveBy(null);
    setState("proving");
    const room = `zkorage-dr2-demo-${Math.random().toString(16).slice(2, 10)}`;
    try {
      cancel.current = false;
      setStep("Creating a fresh room + eligible set…");
      await createRoom(room);
      const me = await registerMember(room, true);
      await registerMember(room, true);
      if (!me.minted) throw new Error("register did not mint an identity");
      setStep("Pinning the eligible-set Merkle root on-chain…");
      const sr = await setEligibleRoot(room);
      if (!sr.ok) throw new Error(sr.error || "set-root failed");
      setStep("Proving membership (sha256-Merkle, nullifier, holder sig), worker-first. This takes a few minutes…");
      const pa = await proveAccess({
        roomId: room,
        idSecret: me.minted.idSecret,
        idTrapdoor: me.minted.idTrapdoor,
        holderSeed: me.minted.holderSeed,
      });
      if (!pa.jobId) throw new Error(pa.error || "prove-access failed");
      let bundle: Bundle | null = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 12 * 60 * 1000) {
        if (cancel.current) return;
        const s = await getProveStatus(pa.jobId);
        setProveBy(s.by ?? null);
        if (s.status === "done" && s.bundle) {
          bundle = s.bundle;
          break;
        }
        if (s.status === "error") throw new Error(s.error || "proving failed");
        await new Promise((r) => setTimeout(r, 4000));
      }
      if (!bundle) throw new Error("proof timed out");
      setState("verifying");
      setStep("Submitting the proof (request_access)…");
      const ra = await requestAccess(bundle);
      if (!ra.ok) throw new Error(ra.error || "request_access rejected");
      setGrant({ accessor: pa.accessor, nullifier: pa.nullifier });
      setState("verified");
      setStep("Re-submitting the same proof to show the nullifier in action…");
      const ra2 = await requestAccess(bundle);
      setGrant({
        accessor: pa.accessor,
        nullifier: pa.nullifier,
        reused: ra2.ok === false && /#15|NullifierUsed/.test(ra2.error || ""),
      });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setState("failed");
    } finally {
      setBusy(false);
      setStep("");
    }
  }

  // Read-only status check (entirely in-browser via the SDK): is this accessor granted, and what is its
  // (pseudonymous) on-chain grant record? Reveals NO identity.
  async function onCheckStatus() {
    setStatusErr(null);
    setStatusRes(null);
    if (!isHex32(statusRoom) || !isHex32(statusAccessor)) {
      setStatusErr("room and accessor must each be 32-byte hex");
      return;
    }
    setStatusBusy(true);
    try {
      const [granted, g] = await Promise.all([
        sdk.isRoomGranted(statusRoom.trim(), statusAccessor.trim()),
        sdk.getGrant(statusRoom.trim(), statusAccessor.trim()),
      ]);
      setStatusRes({ granted, grant: g });
    } catch (e) {
      setStatusErr(String((e as Error).message ?? e));
    } finally {
      setStatusBusy(false);
    }
  }

  return {
    memInfo,
    elig,
    state,
    step,
    proveBy,
    grant,
    err,
    busy,
    onRequestAccess,
    statusRoom,
    setStatusRoom,
    statusAccessor,
    setStatusAccessor,
    statusRes,
    statusBusy,
    statusErr,
    onCheckStatus,
  };
}
