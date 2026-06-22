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
// (sign-to-derive, M0), then request to join in ONE step. Owner side: see pending requests for a room you own
// and approve them (your wallet signs set_eligible_root). The request carries only your public commitment + an
// OPTIONAL self-chosen label — never your wallet address (privacy choice A). The membership PROOF (a later
// step) is what keeps the actual access anonymous.

// A local "your requests" history entry (per wallet, this browser only). It records which rooms you asked to
// join + the last-known status, so you can see your pending requests at a glance without re-typing a room id.
export type JoinRequest = { roomId: string; label?: string; state: EnrollState; ts: number };
const requestsKey = (addr: string) => `zkorage.dr.requests.${addr}`;

export function useEnroll() {
  const { address, connected } = useWallet();
  const signer = useTxSigner();
  const id = useDataRoomIdentity();

  // --- member: request to join (single action: derive + request) ---
  const [joinRoom, setJoinRoom] = useState("");
  const [joinLabel, setJoinLabel] = useState("");
  const [commitment, setCommitment] = useState<string | null>(null);
  const [accessor, setAccessor] = useState<string | null>(null);
  const [memberState, setMemberState] = useState<EnrollState | null>(null);
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberErr, setMemberErr] = useState<string | null>(null);

  // --- member: local "your requests" history (per wallet, this browser) ---
  const [myRequests, setMyRequests] = useState<JoinRequest[]>([]);
  const [requestsBusy, setRequestsBusy] = useState(false);

  const loadRequests = useCallback((addr: string | null) => {
    if (!addr || typeof localStorage === "undefined") { setMyRequests([]); return; }
    try {
      const raw = localStorage.getItem(requestsKey(addr));
      setMyRequests(raw ? (JSON.parse(raw) as JoinRequest[]) : []);
    } catch { setMyRequests([]); }
  }, []);

  const persistRequests = useCallback((addr: string, list: JoinRequest[]) => {
    setMyRequests(list);
    try { localStorage.setItem(requestsKey(addr), JSON.stringify(list)); } catch { /* ignore quota */ }
  }, []);

  // ONE action: derive the per-room id (a single wallet signature, cached for the session), then file the
  // request. The backend is idempotent (already-eligible → eligible, already-pending → pending). We send only
  // the public commitment + an OPTIONAL self-chosen label, never the wallet address.
  const requestToJoin = useCallback(async () => {
    setMemberErr(null);
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
      const label = joinLabel.trim() || undefined;
      const r = await enrollRequest(joinRoom.trim(), ident.idCommitment, { label });
      if (!r.ok) {
        setMemberErr(r.error ?? "Request failed.");
        return;
      }
      setMemberState(r.state);
      if (address) {
        const next = [
          { roomId: joinRoom.trim().toLowerCase(), label, state: r.state, ts: Date.now() },
          ...myRequests.filter((x) => x.roomId !== joinRoom.trim().toLowerCase()),
        ];
        persistRequests(address, next);
      }
    } catch (e) {
      setMemberErr(String((e as Error).message ?? e));
    } finally {
      setMemberBusy(false);
    }
  }, [joinRoom, joinLabel, id, address, myRequests, persistRequests]);

  // Refresh the live status of every tracked request: derive each room's commitment (the FIRST derive prompts
  // the wallet once; the rest reuse the cached signature) and read its current state. Sequential to avoid a
  // signature race on the shared cache.
  const refreshRequests = useCallback(async () => {
    if (!address || myRequests.length === 0) return;
    setRequestsBusy(true);
    try {
      const updated: JoinRequest[] = [];
      for (const r of myRequests) {
        try {
          const ident = await id.derive(r.roomId);
          const s = ident ? await getEnrollStatus(r.roomId, ident.idCommitment).catch(() => null) : null;
          updated.push(s ? { ...r, state: s.state } : r);
        } catch { updated.push(r); }
      }
      persistRequests(address, updated);
    } finally {
      setRequestsBusy(false);
    }
  }, [address, myRequests, id, persistRequests]);

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

  // Load the local "your requests" history for the connected wallet (last-known statuses; no prompt).
  useEffect(() => { loadRequests(connected ? address : null); }, [connected, address, loadRequests]);

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
    joinLabel,
    setJoinLabel,
    commitment,
    accessor,
    memberState,
    memberBusy,
    memberErr,
    drift: id.drift,
    requestToJoin,
    // member: your-requests history
    myRequests,
    requestsBusy,
    refreshRequests,
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
