import { useCallback, useEffect, useState } from "react";
import { DEMO_DATAROOM_POLICY, type RoomAccess } from "zkorage-sdk";
import { sdk } from "@/lib/sdk";
import { isHex32 } from "@/lib/format";

// DR6 — private-policy composition + revocation/rotation (the finale). A requester is admitted only by
// satisfying a composite policy (member ∧ KYC ∧ accredited ∧ not-sanctioned), each an independent ZK
// proof bound to one pseudonymous accessor, AND'd on-chain. No new guest — the AND is the cross-call.
export function usePolicy() {
  const [dr6Room, setDr6Room] = useState(DEMO_DATAROOM_POLICY.roomId);
  const [dr6Accessor, setDr6Accessor] = useState(DEMO_DATAROOM_POLICY.accessor);
  const [dr6Access, setDr6Access] = useState<RoomAccess | null>(null);
  const [dr6Epoch, setDr6Epoch] = useState<number | null>(null);
  const [dr6Counts, setDr6Counts] = useState<{ grants: number; admissions: number } | null>(null);
  const [dr6Busy, setDr6Busy] = useState(false);
  const [dr6Err, setDr6Err] = useState<string | null>(null);

  // DR6 — read the live composed admission (per-leg) + the room's grant/admission counts + key epoch,
  // entirely in-browser via the SDK (public RPC). The reads reveal only the pseudonymous accessor.
  const loadAccess = useCallback((room: string, accessor: string) => {
    if (!isHex32(room) || !isHex32(accessor)) { setDr6Access(null); return; }
    sdk.canAccessRoom(room.trim(), accessor.trim()).then(setDr6Access).catch(() => setDr6Access(null));
    sdk.getCommitteeKeyEpoch(DEMO_DATAROOM_POLICY.roomId, DEMO_DATAROOM_POLICY.docId).then(setDr6Epoch).catch(() => setDr6Epoch(null));
    Promise.all([sdk.getGrantCount(room.trim()), sdk.getAdmissionCount(room.trim())])
      .then(([grants, admissions]) => setDr6Counts({ grants, admissions })).catch(() => setDr6Counts(null));
  }, []);

  useEffect(() => {
    loadAccess(DEMO_DATAROOM_POLICY.roomId, DEMO_DATAROOM_POLICY.accessor);
  }, [loadAccess]);

  // DR6 — read the live composed admission for any (room, accessor), entirely in-browser via the SDK.
  async function onCheckAccess() {
    setDr6Busy(true); setDr6Err(null);
    try {
      const room = dr6Room.trim().toLowerCase();
      const accessor = dr6Accessor.trim().toLowerCase();
      if (!isHex32(room) || !isHex32(accessor)) { setDr6Err("Room and accessor must be 32-byte hex."); return; }
      setDr6Access(await sdk.canAccessRoom(room, accessor));
      const [grants, admissions] = await Promise.all([sdk.getGrantCount(room), sdk.getAdmissionCount(room)]);
      setDr6Counts({ grants, admissions });
    } catch (e) {
      setDr6Err(String((e as Error)?.message ?? e)); setDr6Access(null);
    } finally {
      setDr6Busy(false);
    }
  }

  return {
    dr6Room,
    setDr6Room,
    dr6Accessor,
    setDr6Accessor,
    dr6Access,
    dr6Epoch,
    dr6Counts,
    dr6Busy,
    dr6Err,
    onCheckAccess,
  };
}
