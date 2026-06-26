import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet, useTxSigner } from "@/lib/wallet/WalletContext";
import { useDataRoomIdentity } from "@/lib/hooks/useDataRoomIdentity";
import {
  enrollRequest,
  getEnrollStatus,
  getEnrollRequests,
  enrollApprove,
  enrollApproveBatch,
  enrollReject,
  getMyRooms,
  setRoomVisibility,
  type EnrollState,
  type EnrollRequestItem,
  type MyRoom,
  type RoomVisibility,
} from "@/lib/api";
import { isHex32 } from "@/lib/format";
import { type JoinRequest, requestsKey, readJoinRequests } from "@/lib/dataroom/requests";

// Module-level caches for the owner view (the rooms you own + each room's pending list + your last selection),
// so leaving and returning to Room Management (or the Approve sub-tab) repaints the room list, the selected
// room, and its loaded data at once, then a background refresh swaps in any change. They survive the unmount
// within one app session (a full reload clears them) and only hold public on-chain / off-chain index data,
// never a key or a secret. This mirrors the bonded locks cache in useBonded.
const ownerRoomsCache = new Map<string, MyRoom[]>(); // keyed by wallet address
const selectedOwnerCache = new Map<string, string>(); // keyed by wallet address -> last selected owner room
const pendingCache = new Map<string, { pending: EnrollRequestItem[]; memberCount: number }>(); // keyed by room id

// A background refresh that found nothing new should not re-render the list, so compare before swapping.
const sameRooms = (a: MyRoom[], b: MyRoom[]) =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

// M1 — request-then-approve enrollment. Member side: derive your per-room id_commitment from your wallet
// (sign-to-derive, M0), then request to join in ONE step. Owner side: see pending requests for a room you own
// and approve them (your wallet signs set_eligible_root). The request carries only your public commitment + an
// OPTIONAL self-chosen label — never your wallet address (privacy choice A). The membership PROOF (a later
// step) is what keeps the actual access anonymous.
//
// The local "your requests" history (per wallet, this browser) lives in @/lib/dataroom/requests so Discover
// can read the same store to reflect status without re-deriving an identity.

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
  // The room id (normalized) the current memberState/commitment belong to. Lets the UI keep the "Request sent"
  // result tied to the room that was actually requested, and reset when the member edits the room id.
  const [requestedRoom, setRequestedRoom] = useState<string | null>(null);

  // --- member: local "your requests" history (per wallet, this browser) ---
  const [myRequests, setMyRequests] = useState<JoinRequest[]>([]);
  const [requestsBusy, setRequestsBusy] = useState(false);

  const loadRequests = useCallback((addr: string | null) => {
    setMyRequests(readJoinRequests(addr));
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
      setRequestedRoom(joinRoom.trim().toLowerCase());
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

  // If the member edits the room id after filing a request, reset the per-room result so the button and the
  // status reflect the NEW room, not the one already requested.
  useEffect(() => {
    if (requestedRoom && joinRoom.trim().toLowerCase() !== requestedRoom) {
      setMemberState(null);
      setCommitment(null);
      setAccessor(null);
      setMemberErr(null);
      setRequestedRoom(null);
    }
  }, [joinRoom, requestedRoom]);

  // True once the current room has been requested in this session (state pins to the requested room via the
  // reset effect above). Drives the "Request sent" / "Already approved" disabled button.
  const joinDone = memberState === "pending" || memberState === "eligible";

  // Refresh the live status of every tracked request: derive each room's commitment (the FIRST derive prompts
  // the wallet once; the rest reuse the cached signature) and read its current state. Sequential to avoid a
  // signature race on the shared cache.
  const refreshRequests = useCallback(async () => {
    if (!address) return;
    // Re-read from disk (not the stale `myRequests` snapshot) so a request the Open tab's Refresh wrote in the
    // meantime is not clobbered. Both refreshers do read-modify-write on the same per-wallet key.
    const list = readJoinRequests(address);
    if (list.length === 0) return;
    setRequestsBusy(true);
    try {
      const updated: JoinRequest[] = [];
      for (const r of list) {
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
  }, [address, id, persistRequests]);

  // --- owner: approve members of a room you own ---
  // Seed the owner view from the module caches so the selected room + its pending list survive a tab switch
  // (an unmount). The visibility seeds below read the same cached room record. Computed each render; only the
  // useState initializers (first render) consume them.
  const seededRooms = connected && address ? ownerRoomsCache.get(address) ?? [] : [];
  const seededOwnerRoom = connected && address ? selectedOwnerCache.get(address) ?? "" : "";
  const seededRec = seededOwnerRoom ? seededRooms.find((r) => r.roomId === seededOwnerRoom) : undefined;
  const seededVis = (seededRec?.visibility as RoomVisibility) ?? "private";
  const seededName = (seededRec?.name ?? "").trim();
  const seededDesc = (seededRec?.description ?? "").trim();
  const seededPending = seededOwnerRoom ? pendingCache.get(seededOwnerRoom) : undefined;

  const [myRooms, setMyRooms] = useState<MyRoom[]>(seededRooms);
  const [myRoomsLoading, setMyRoomsLoading] = useState(false); // cold: loading the owner room list (skeleton)
  const [myRoomsRefreshing, setMyRoomsRefreshing] = useState(false); // warm: refreshing the cached room list
  const [ownerRoom, setOwnerRoom] = useState(seededOwnerRoom);
  const [pending, setPending] = useState<EnrollRequestItem[]>(seededPending?.pending ?? []);
  const [memberCount, setMemberCount] = useState(seededPending?.memberCount ?? 0);
  const [ownerBusy, setOwnerBusy] = useState(false); // cold: loading a room's pending with nothing cached
  const [pendingRefreshing, setPendingRefreshing] = useState(false); // warm: refreshing the cached pending list
  const [ownerErr, setOwnerErr] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  // The most recently requested room, so a slow pending response for room A cannot overwrite room B's list.
  const pendingReq = useRef(seededOwnerRoom);

  // Load the rooms the wallet owns: paint the cached list at once when we have one (then refresh in the
  // background), otherwise show the skeleton while the first read runs.
  const loadOwnerRooms = useCallback((addr: string | null) => {
    if (!addr) { setMyRooms([]); setMyRoomsLoading(false); setMyRoomsRefreshing(false); return; }
    const cached = ownerRoomsCache.get(addr);
    if (cached) { setMyRooms(cached); setMyRoomsLoading(false); setMyRoomsRefreshing(true); }
    else { setMyRoomsLoading(true); setMyRoomsRefreshing(false); }
    getMyRooms(addr)
      .then((r) => { ownerRoomsCache.set(addr, r.rooms); setMyRooms((prev) => (sameRooms(prev, r.rooms) ? prev : r.rooms)); })
      .catch(() => { if (!cached) setMyRooms([]); }) // keep the cached list on a refresh error
      .finally(() => { setMyRoomsLoading(false); setMyRoomsRefreshing(false); });
  }, []);

  // Load the local "your requests" history for the connected wallet (last-known statuses; no prompt).
  useEffect(() => { loadRequests(connected ? address : null); }, [connected, address, loadRequests]);

  // Load a room's pending requests + member count: paint the cached values at once when we have them (then
  // refresh in the background), otherwise show the loading state while the first read runs. A race guard drops
  // a stale response so selecting room B while room A is loading never shows A's list under B.
  const loadPending = useCallback(async (room: string) => {
    if (!isHex32(room)) { setPending([]); setMemberCount(0); setOwnerBusy(false); setPendingRefreshing(false); return; }
    const r = room.trim();
    pendingReq.current = r;
    const cached = pendingCache.get(r);
    if (cached) { setPending(cached.pending); setMemberCount(cached.memberCount); setOwnerBusy(false); setPendingRefreshing(true); }
    else { setOwnerBusy(true); setPendingRefreshing(false); }
    setOwnerErr(null);
    try {
      const resp = await getEnrollRequests(r);
      pendingCache.set(r, { pending: resp.pending, memberCount: resp.memberCount });
      if (pendingReq.current !== r) return; // a newer room was selected; ignore this stale response
      setPending(resp.pending);
      setMemberCount(resp.memberCount);
    } catch (e) {
      if (pendingReq.current === r) {
        setOwnerErr(String((e as Error).message ?? e));
        if (!cached) { setPending([]); setMemberCount(0); } // keep the cached list on a refresh error
      }
    } finally {
      if (pendingReq.current === r) { setOwnerBusy(false); setPendingRefreshing(false); }
    }
  }, []);

  // --- owner: room visibility (discovery tier) ---
  // Seeded from the cached room record so a restored selection keeps its visibility form without a flash.
  const [vis, setVis] = useState<RoomVisibility>(seededVis);
  const [visName, setVisName] = useState(seededName);
  const [visDescription, setVisDescription] = useState(seededDesc);
  const [visBusy, setVisBusy] = useState(false);
  const [visErr, setVisErr] = useState<string | null>(null);
  const [visSaved, setVisSaved] = useState(false);
  // The last-saved snapshot, so the UI can disable Save when nothing changed (e.g. Private -> Private). Names
  // are compared trimmed, with null/undefined treated as "" so a stored-null and an empty input read as equal.
  const [savedVis, setSavedVis] = useState<RoomVisibility>(seededVis);
  const [savedName, setSavedName] = useState(seededName);
  const [savedDescription, setSavedDescription] = useState(seededDesc);

  // Apply an owner-room selection: set it, prefill the visibility form from the room's own record, and load
  // its pending list. It reads the room record from the module cache (not the myRooms state) so it stays
  // stable and the restore effect can call it without re-running on every list refresh.
  const applyOwnerSelection = useCallback(
    (room: string, addr: string | null) => {
      setOwnerRoom(room);
      setVisErr(null);
      setVisSaved(false);
      if (!room) {
        setVis("private"); setVisName(""); setVisDescription("");
        setSavedVis("private"); setSavedName(""); setSavedDescription("");
        setPending([]); setMemberCount(0);
        pendingReq.current = "";
        return;
      }
      const rec = (addr ? ownerRoomsCache.get(addr) : undefined)?.find((r) => r.roomId === room);
      const v = (rec?.visibility as RoomVisibility) ?? "private";
      const n = (rec?.name ?? "").trim();
      const dsc = (rec?.description ?? "").trim();
      setVis(v); setVisName(n); setVisDescription(dsc);
      setSavedVis(v); setSavedName(n); setSavedDescription(dsc);
      loadPending(room);
    },
    [loadPending],
  );

  // Pick a room you own (from a click). Remember it so it is restored on return, then apply the selection.
  const selectOwnerRoom = useCallback(
    (room: string) => {
      if (address) selectedOwnerCache.set(address, room);
      applyOwnerSelection(room, address);
    },
    [address, applyOwnerSelection],
  );

  // On connect/return (or wallet switch), refresh the owner room list and restore the last-selected room so
  // Room Management and the Approve sub-tab keep the room and its loaded data across a tab switch. The state
  // is already seeded from cache for the first paint; this re-affirms it and runs the background refresh.
  useEffect(() => {
    const addr = connected ? address : null;
    loadOwnerRooms(addr);
    // Restore the last-selected room only if the wallet still owns it (loadOwnerRooms seeds the cache
    // synchronously above), so a room that was removed never restores as a phantom selection.
    const restored = addr ? selectedOwnerCache.get(addr) ?? "" : "";
    const stillOwned = addr ? (ownerRoomsCache.get(addr) ?? []).some((r) => r.roomId === restored) : false;
    applyOwnerSelection(stillOwned ? restored : "", addr);
  }, [connected, address, loadOwnerRooms, applyOwnerSelection]);

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
      // Reflect the sanitized stored values + reset the saved snapshot to them (so Save goes disabled again
      // and "Saved." shows until the next real edit). Refresh the owner room list for the next select.
      const n = (r.name ?? "").trim();
      const dsc = (r.description ?? "").trim();
      setVis(r.visibility);
      setVisName(n);
      setVisDescription(dsc);
      setSavedVis(r.visibility);
      setSavedName(n);
      setSavedDescription(dsc);
      if (address) getMyRooms(address).then((x) => { ownerRoomsCache.set(address, x.rooms); setMyRooms((prev) => (sameRooms(prev, x.rooms) ? prev : x.rooms)); }).catch(() => {});
    } catch (e) {
      setVisErr(String((e as Error).message ?? e));
    } finally {
      setVisBusy(false);
    }
  }, [ownerRoom, vis, visName, visDescription, address]);

  // Has the visibility form changed from the last-saved snapshot? Disables Save when nothing changed (the
  // Private -> Private case the owner asked about, plus any unchanged name/description). Trim-compared so
  // trailing whitespace alone is not a change, matching how the values are stored.
  const visDirty =
    vis !== savedVis || visName.trim() !== savedName || visDescription.trim() !== savedDescription;

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

  // Approve EVERY pending request for the selected room in one batch (one wallet signature, one root re-pin).
  // The backend appends the new commitments in randomized order (M7 timing defense) and pins the root once.
  const approveAll = useCallback(async () => {
    if (!ownerRoom) return;
    setApprovingAll(true);
    setOwnerErr(null);
    let failure: string | null = null;
    try {
      const r = await enrollApproveBatch(ownerRoom.trim(), signer);
      if (!r.ok) failure = r.error ?? "Approve all failed.";
    } catch (e) {
      failure = String((e as Error).message ?? e);
    } finally {
      // Refresh regardless: a partial batch may have admitted some members on-chain, so never leave the full
      // list shown as still-pending. loadPending clears ownerErr, so restore the batch error after it.
      await loadPending(ownerRoom.trim());
      if (failure) setOwnerErr(failure);
      setApprovingAll(false);
    }
  }, [ownerRoom, signer, loadPending]);

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
    joinDone,
    drift: id.drift,
    requestToJoin,
    // member: your-requests history
    myRequests,
    requestsBusy,
    refreshRequests,
    // owner
    myRooms,
    myRoomsLoading,
    myRoomsRefreshing,
    ownerRoom,
    selectOwnerRoom,
    pending,
    memberCount,
    ownerBusy,
    pendingRefreshing,
    ownerErr,
    acting,
    approvingAll,
    approve,
    approveAll,
    reject,
    // owner: visibility
    vis,
    setVis,
    savedVis,
    visName,
    setVisName,
    visDescription,
    setVisDescription,
    visBusy,
    visErr,
    visSaved,
    visDirty,
    saveVisibility,
  };
}
