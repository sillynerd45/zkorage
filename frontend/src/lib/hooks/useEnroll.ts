import { useCallback, useEffect, useState } from "react";
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
  const [myRooms, setMyRooms] = useState<MyRoom[]>([]);
  const [ownerRoom, setOwnerRoom] = useState("");
  const [pending, setPending] = useState<EnrollRequestItem[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [ownerErr, setOwnerErr] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);

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
  // The last-saved snapshot, so the UI can disable Save when nothing changed (e.g. Private -> Private). Names
  // are compared trimmed, with null/undefined treated as "" so a stored-null and an empty input read as equal.
  const [savedVis, setSavedVis] = useState<RoomVisibility>("private");
  const [savedName, setSavedName] = useState("");
  const [savedDescription, setSavedDescription] = useState("");

  const selectOwnerRoom = useCallback(
    (room: string) => {
      setOwnerRoom(room);
      // Prefill the visibility control from the owner's own room record (the /dataroom/rooms read), and seed
      // the saved snapshot from the same record so Save starts disabled until something actually changes.
      const rec = myRooms.find((r) => r.roomId === room);
      const v = (rec?.visibility as RoomVisibility) ?? "private";
      const n = (rec?.name ?? "").trim();
      const dsc = (rec?.description ?? "").trim();
      setVis(v);
      setVisName(n);
      setVisDescription(dsc);
      setSavedVis(v);
      setSavedName(n);
      setSavedDescription(dsc);
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
      if (address) getMyRooms(address).then((x) => setMyRooms(x.rooms)).catch(() => {});
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
    ownerRoom,
    selectOwnerRoom,
    pending,
    memberCount,
    ownerBusy,
    ownerErr,
    acting,
    approvingAll,
    approve,
    approveAll,
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
    visDirty,
    saveVisibility,
  };
}
