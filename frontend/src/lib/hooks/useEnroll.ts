import { useCallback, useEffect, useState } from "react";
import { useWallet, useTxSigner } from "@/lib/wallet/WalletContext";
import { useDataRoomIdentity } from "@/lib/hooks/useDataRoomIdentity";
import {
  enrollRequest,
  getEnrollStatus,
  getEnrollRequests,
  enrollApprove,
  enrollReject,
  getMyRooms,
  setRoomVisibility,
  type EnrollState,
  type EnrollRequestItem,
  type MyRoom,
  type RoomVisibility,
} from "@/lib/api";
import { isHex32 } from "@/lib/format";

// M1 — request-then-approve enrollment. Member side: derive your per-room id_commitment from your wallet
// (sign-to-derive, M0), then request to join. Owner side: see pending requests for a room you own and approve
// them (your wallet signs set_eligible_root). Joining is identified; the membership PROOF (a later step) is
// what keeps the actual access anonymous.
export function useEnroll() {
  const { address, connected } = useWallet();
  const signer = useTxSigner();
  const id = useDataRoomIdentity();

  // --- member: request to join ---
  const [joinRoom, setJoinRoom] = useState("");
  const [commitment, setCommitment] = useState<string | null>(null);
  const [accessor, setAccessor] = useState<string | null>(null);
  const [memberState, setMemberState] = useState<EnrollState | null>(null);
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberErr, setMemberErr] = useState<string | null>(null);

  // Derive the member's per-room commitment from the wallet (one signMessage), then read its current state.
  const deriveCommitment = useCallback(async () => {
    setMemberErr(null);
    setMemberState(null);
    setCommitment(null);
    setAccessor(null);
    if (!isHex32(joinRoom)) {
      setMemberErr("Room must be 32-byte hex (64 hex chars).");
      return;
    }
    setMemberBusy(true);
    try {
      const ident = await id.derive(joinRoom.trim());
      if (!ident) {
        setMemberErr(id.error ?? "Could not derive your identity.");
        return;
      }
      setCommitment(ident.idCommitment);
      setAccessor(ident.accessor);
      const s = await getEnrollStatus(joinRoom.trim(), ident.idCommitment).catch(() => null);
      if (s) setMemberState(s.state);
    } finally {
      setMemberBusy(false);
    }
  }, [joinRoom, id]);

  const requestJoin = useCallback(async () => {
    if (!commitment) return;
    setMemberBusy(true);
    setMemberErr(null);
    try {
      const r = await enrollRequest(joinRoom.trim(), commitment, { source: address ?? undefined });
      if (!r.ok) {
        setMemberErr(r.error ?? "Request failed.");
        return;
      }
      setMemberState(r.state);
    } catch (e) {
      setMemberErr(String((e as Error).message ?? e));
    } finally {
      setMemberBusy(false);
    }
  }, [commitment, joinRoom, address]);

  // --- owner: approve members of a room you own ---
  const [myRooms, setMyRooms] = useState<MyRoom[]>([]);
  const [ownerRoom, setOwnerRoom] = useState("");
  const [pending, setPending] = useState<EnrollRequestItem[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [ownerErr, setOwnerErr] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    if (!connected || !address) {
      setMyRooms([]);
      return;
    }
    getMyRooms(address).then((r) => setMyRooms(r.rooms)).catch(() => setMyRooms([]));
  }, [connected, address]);

  const loadPending = useCallback(async (room: string) => {
    if (!isHex32(room)) {
      setPending([]);
      setMemberCount(0);
      return;
    }
    setOwnerBusy(true);
    setOwnerErr(null);
    try {
      const r = await getEnrollRequests(room.trim());
      setPending(r.pending);
      setMemberCount(r.memberCount);
    } catch (e) {
      setOwnerErr(String((e as Error).message ?? e));
    } finally {
      setOwnerBusy(false);
    }
  }, []);

  // --- owner: room visibility (discovery tier) ---
  const [vis, setVis] = useState<RoomVisibility>("private");
  const [visName, setVisName] = useState("");
  const [visDescription, setVisDescription] = useState("");
  const [visBusy, setVisBusy] = useState(false);
  const [visErr, setVisErr] = useState<string | null>(null);
  const [visSaved, setVisSaved] = useState(false);

  const selectOwnerRoom = useCallback(
    (room: string) => {
      setOwnerRoom(room);
      // Prefill the visibility control from the owner's own room record (the /dataroom/rooms read).
      const rec = myRooms.find((r) => r.roomId === room);
      setVis((rec?.visibility as RoomVisibility) ?? "private");
      setVisName(rec?.name ?? "");
      setVisDescription(rec?.description ?? "");
      setVisErr(null);
      setVisSaved(false);
      loadPending(room);
    },
    [loadPending, myRooms],
  );

  const saveVisibility = useCallback(async () => {
    if (!ownerRoom) return;
    setVisBusy(true);
    setVisErr(null);
    setVisSaved(false);
    try {
      const r = await setRoomVisibility(ownerRoom.trim(), {
        visibility: vis,
        name: visName.trim() || undefined,
        description: visDescription.trim() || undefined,
        source: address ?? undefined,
      });
      if (!r.ok) {
        setVisErr(r.error ?? "Could not save visibility.");
        return;
      }
      setVisSaved(true);
      // Reflect the sanitized stored values + refresh the owner room list for the next select.
      setVisName(r.name ?? "");
      setVisDescription(r.description ?? "");
      if (address) getMyRooms(address).then((x) => setMyRooms(x.rooms)).catch(() => {});
    } catch (e) {
      setVisErr(String((e as Error).message ?? e));
    } finally {
      setVisBusy(false);
    }
  }, [ownerRoom, vis, visName, visDescription, address]);

  const approve = useCallback(
    async (c: string) => {
      setActing(c);
      setOwnerErr(null);
      try {
        const r = await enrollApprove(ownerRoom.trim(), c, signer);
        if (!r.ok) {
          setOwnerErr(r.error ?? "Approve failed.");
          return;
        }
        await loadPending(ownerRoom.trim());
      } catch (e) {
        setOwnerErr(String((e as Error).message ?? e));
      } finally {
        setActing(null);
      }
    },
    [ownerRoom, signer, loadPending],
  );

  const reject = useCallback(
    async (c: string) => {
      setActing(c);
      setOwnerErr(null);
      try {
        await enrollReject(ownerRoom.trim(), c);
        await loadPending(ownerRoom.trim());
      } catch (e) {
        setOwnerErr(String((e as Error).message ?? e));
      } finally {
        setActing(null);
      }
    },
    [ownerRoom, loadPending],
  );

  return {
    connected,
    address,
    // member
    joinRoom,
    setJoinRoom,
    commitment,
    accessor,
    memberState,
    memberBusy,
    memberErr,
    drift: id.drift,
    deriveCommitment,
    requestJoin,
    // owner
    myRooms,
    ownerRoom,
    selectOwnerRoom,
    pending,
    memberCount,
    ownerBusy,
    ownerErr,
    acting,
    approve,
    reject,
    // owner: visibility
    vis,
    setVis,
    visName,
    setVisName,
    visDescription,
    setVisDescription,
    visBusy,
    visErr,
    visSaved,
    saveVisibility,
  };
}
