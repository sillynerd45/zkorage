import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDataroomDocuments,
  getDirectory,
  getEnrollStatus,
  getEligible,
  proveAccess,
  queueAccess,
  getQueueStatus,
  getProveStatus,
  type DataroomDoc,
  type Bundle,
} from "@/lib/api";
import { ANON_FLOOR } from "@/components/app/dataroom/AnonymityMeter";
import { signDataRoomAccess, type DataRoomIdentity, type OpenedCommitteeDocument, type RoomAccess } from "zkorage-sdk";
import { sdk } from "@/lib/sdk";
import { useWallet } from "@/lib/wallet/WalletContext";
import { useDataRoomIdentity } from "@/lib/hooks/useDataRoomIdentity";
import { readJoinRequests, writeJoinRequests } from "@/lib/dataroom/requests";
import { pullVault, pushVault, forgetVault, isVaultSyncOn, setVaultSyncOn } from "@/lib/dataroom/vault";
import { writeOpenTicket, clearOpenTicket, findOpenTicket } from "@/lib/dataroom/openTicket";
import { isHex32 } from "@/lib/format";

// "Open a document" (Model B). One screen, one action: the member lands on the rooms they are approved for,
// picks a document, and clicks Open. A single orchestrator reads their live on-chain status and branches:
//   - not on the list / pending / revoked  -> say so plainly, point to the next step.
//   - approved but not set up yet           -> ask to run the one-time membership proof (a few minutes).
//   - already set up (on-chain grant)        -> get the key from the keepers and decrypt, automatically.
// The one-time proof's witness goes only to the SELF-HOSTED prover; the file decrypts in the browser. ZK is
// load-bearing: the keepers release the key to someone they cannot identify, because a proof, not a login,
// decides who qualifies.
//
// The proof's access is recorded on-chain in a SHUFFLED batch at a fixed window boundary (M7 timing defense),
// so the room cannot tell when this member acted. That wait can be minutes, so the queued ticket is persisted
// (per wallet+room, this browser) and the "waiting" state resumes if the member leaves and returns.

export type OpenPhase =
  | "idle" // a doc is selected but Open hasn't run
  | "checking" // deriving identity + reading on-chain status
  | "not-member" // not on the room's list
  | "pending" // join request still waiting for the owner
  | "approved" // on the list, no grant yet -> offer the one-time setup
  | "below-floor" // the room is below the anonymity floor
  | "revoked" // access removed
  | "proving" // running the self-hosted prover
  | "queuing" // handing the proof to the batching relay
  | "waiting" // queued for the batch window
  | "opening" // getting the key + decrypting
  | "opened" // done (the file is in `opened`)
  | "error";

// Cross-device sync status for the encrypted rooms vault.
export type SyncState =
  | "off" // sync turned off (or no wallet)
  | "locked" // sync on, but the wallet has not signed this session -> show a one-tap unlock
  | "syncing"
  | "synced"
  | "error";

export function useSharedOpen() {
  const { address, connected, connect, status: walletStatus } = useWallet();
  const ident = useDataRoomIdentity();

  // The selected room ("" = none; show the room list). Selecting a room loads its docs + anonymity meter.
  const [room, setRoom] = useState("");
  const [roomDocs, setRoomDocs] = useState<DataroomDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [anonCount, setAnonCount] = useState<number | null>(null);
  const belowFloor = anonCount !== null && anonCount < ANON_FLOOR;

  // The rooms this wallet is approved for, from the local request history (this browser). "eligible" = approved.
  const [openableRooms, setOpenableRooms] = useState<{ roomId: string; label?: string }[]>([]);
  const reloadOpenable = useCallback((addr: string | null) => {
    setOpenableRooms(
      addr
        ? readJoinRequests(addr).filter((r) => r.state === "eligible").map((r) => ({ roomId: r.roomId, label: r.label }))
        : [],
    );
  }, []);
  useEffect(() => { reloadOpenable(connected ? address : null); }, [connected, address, reloadOpenable]);

  // Automatic cross-device sync via the encrypted vault. Default ON. "locked" = sync is on but the wallet has
  // not signed this session yet, so we wait for a one-tap unlock rather than pop the wallet on page load.
  const [syncOn, setSyncOn] = useState(true);
  const [syncState, setSyncState] = useState<SyncState>("off");
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  useEffect(() => { setSyncOn(isVaultSyncOn(connected ? address : null)); }, [connected, address]);

  // Public directory names/descriptions (listed rooms only) so an approved room shows a human name like the
  // Discover tab, not just an id. One public read; a private/unlisted room falls back to your own label.
  const [directory, setDirectory] = useState<Record<string, { name: string | null; description: string | null }>>({});
  useEffect(() => {
    getDirectory()
      .then((r) => {
        const m: Record<string, { name: string | null; description: string | null }> = {};
        for (const room of r.rooms) m[room.roomId.toLowerCase()] = { name: room.name, description: room.description };
        setDirectory(m);
      })
      .catch(() => {});
  }, []);

  // Re-check the live status of every room in the local history (one cached wallet signature), persist it, and
  // recompute the approved list. This promotes a room into "Rooms you can open" right after the owner approves
  // it, with no re-request. Leak-neutral: it only re-reads enroll status for rooms you already requested.
  const [refreshing, setRefreshing] = useState(false);
  const refreshRooms = useCallback(async () => {
    if (!address) return;
    setRefreshing(true);
    try {
      const list = readJoinRequests(address);
      const updated = [];
      for (const r of list) {
        try {
          const id = await ident.derive(r.roomId);
          const s = id ? await getEnrollStatus(r.roomId, id.idCommitment).catch(() => null) : null;
          updated.push(s ? { ...r, state: s.state } : r);
        } catch { updated.push(r); }
      }
      writeJoinRequests(address, updated);
      reloadOpenable(address);
      // best-effort push the refreshed list to the vault (silent: refresh already signed, so no extra prompt)
      if (isVaultSyncOn(address) && ident.hasSignature(address)) {
        try { await pushVault(address, await ident.getSignature()); setSyncState("synced"); } catch { /* keep local */ }
      }
    } finally {
      setRefreshing(false);
    }
  }, [address, ident, reloadOpenable]);

  // Pull-on-connect (silent only if the wallet already signed this session) + propagate the merged union back.
  // A new object is returned by useDataRoomIdentity each render, so a once-guard keyed by address prevents the
  // unstable deps from re-pulling every render.
  const syncedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!connected || !address) { setSyncState("off"); return; }
    if (!syncOn) { setSyncState("off"); return; }
    if (!ident.hasSignature(address)) { setSyncState("locked"); return; } // wait for a one-tap unlock
    if (syncedFor.current === address) return;
    syncedFor.current = address;
    let live = true;
    (async () => {
      try {
        setSyncState("syncing");
        const sig = await ident.getSignature();
        await pullVault(address, sig);
        if (!live) return;
        reloadOpenable(address);
        await pushVault(address, sig);
        if (live) setSyncState("synced");
      } catch {
        if (live) setSyncState("error");
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, address, syncOn]);
  useEffect(() => { syncedFor.current = null; }, [address]);

  // One-tap unlock: sign once, pull the vault, merge, push the union back.
  const unlockSync = useCallback(async () => {
    if (!address) return;
    setSyncMsg(null);
    setSyncState("syncing");
    try {
      const sig = await ident.getSignature();
      await pullVault(address, sig);
      reloadOpenable(address);
      await pushVault(address, sig);
      syncedFor.current = address;
      setSyncState("synced");
    } catch (e) {
      setSyncState("error");
      setSyncMsg(String((e as Error).message ?? e));
    }
  }, [address, ident, reloadOpenable]);

  // Turn sync on (sync now if already signed, else show the unlock) or off (delete the server copy).
  const setSync = useCallback(
    async (on: boolean) => {
      if (!address) return;
      setVaultSyncOn(address, on);
      setSyncOn(on);
      setSyncMsg(null);
      if (on) {
        if (ident.hasSignature(address)) await unlockSync();
        else setSyncState("locked");
      } else {
        setSyncState("off");
        syncedFor.current = null;
        // Only delete the server copy if the wallet already signed this session: turning a setting OFF should
        // not pop the wallet. If not signed, say so honestly (a signature is needed to locate the copy).
        if (ident.hasSignature(address)) {
          try {
            await forgetVault(await ident.getSignature());
            setSyncMsg("Sync off. Your saved copy was deleted.");
          } catch {
            setSyncMsg("Sync off. The saved copy was not deleted.");
          }
        } else {
          setSyncMsg("Sync off on this device. Sign in once to also delete the saved copy.");
        }
      }
    },
    [address, ident, unlockSync],
  );

  // The open flow for ONE document at a time.
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [phase, setPhase] = useState<OpenPhase>("idle");
  const [identity, setIdentity] = useState<DataRoomIdentity | null>(null);
  const [access, setAccess] = useState<RoomAccess | null>(null);
  const [proveStep, setProveStep] = useState("");
  const [proveBy, setProveBy] = useState<string | null>(null);
  const [flushAt, setFlushAt] = useState<number | null>(null);
  const [opened, setOpened] = useState<OpenedCommitteeDocument | null>(null);
  const [flowErr, setFlowErr] = useState<string | null>(null);

  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);

  // A wallet account switch must stop any in-flight poll: it belongs to the previous wallet, and the derived
  // identity is now different. open() / setupAccess() / the resume effect each re-arm cancelled=false when they
  // start, so this only kills work that is mid-flight when the account changes.
  useEffect(() => { cancelled.current = true; }, [address]);

  // Load the selected room's document list (public on-chain fingerprints, committee kind only) + member count.
  useEffect(() => {
    if (!isHex32(room)) { setRoomDocs([]); setAnonCount(null); return; }
    let live = true;
    setDocsLoading(true);
    getDataroomDocuments(room.trim())
      .then((r) => { if (live) setRoomDocs(r.documents.filter((d) => d.kind === "committee")); })
      .catch(() => { if (live) setRoomDocs([]); })
      .finally(() => { if (live) setDocsLoading(false); });
    getEligible(room.trim())
      .then((r) => { if (live) setAnonCount(r.memberCount); })
      .catch(() => { if (live) setAnonCount(null); });
    return () => { live = false; };
  }, [room]);

  // Reset the per-doc open flow whenever the selected room changes.
  const resetFlow = useCallback(() => {
    setOpenDocId(null);
    setPhase("idle");
    setAccess(null);
    setOpened(null);
    setFlowErr(null);
    setProveStep("");
    setProveBy(null);
    setFlushAt(null);
  }, []);

  const selectRoom = useCallback((roomId: string) => {
    cancelled.current = true; // stop any in-flight poll for the previous room (open()/setupAccess re-arm it)
    resetFlow();
    setRoom(roomId.trim());
  }, [resetFlow]);

  // ── the orchestrated open ──────────────────────────────────────────────────────────────────────
  // Get the key from the keepers and decrypt in the browser. Only reached once the on-chain grant exists.
  const doOpen = useCallback(async (docId: string, id: DataRoomIdentity) => {
    setPhase("opening");
    setFlowErr(null);
    try {
      const out = await sdk.openCommitteeDocument(room.trim(), docId.trim(), id.accessor, id.recipientSecret, {
        minAnonSet: ANON_FLOOR,
      });
      if (cancelled.current) return;
      setOpened(out);
      setPhase("opened");
    } catch (e) {
      if (cancelled.current) return;
      setFlowErr(String((e as Error).message ?? e));
      setPhase("error");
    }
  }, [room]);

  // Poll the batch ticket until the access lands on-chain (submitted), then auto-open. Returns true if it
  // landed. Shared by a fresh setup and by resuming a persisted ticket.
  const waitForBatch = useCallback(
    async (ticketId: string, windowMs: number | null, docId: string, id: DataRoomIdentity): Promise<boolean> => {
      setPhase("waiting");
      const win = windowMs ?? 10 * 60 * 1000;
      const deadline = Date.now() + win * 2 + 60 * 1000;
      while (Date.now() < deadline) {
        if (cancelled.current) return false;
        await new Promise((r) => setTimeout(r, 4000));
        const st = await getQueueStatus(ticketId).catch(() => null);
        if (!st) continue;
        setFlushAt(st.flushAt ?? null);
        if (st.status === "submitted") {
          clearOpenTicket(address, room.trim());
          await doOpen(docId, id);
          return true;
        }
        if (st.status === "error") {
          clearOpenTicket(address, room.trim());
          setFlowErr(`${st.error || "the batched submission did not go through"}. Check access again and set up once more.`);
          setPhase("error");
          return false;
        }
      }
      // Still queued past the deadline (the relay missed two windows). Surface a recoverable error instead of a
      // dead "waiting" screen, and KEEP the ticket so a reload (or Try again) resumes the wait.
      if (!cancelled.current) {
        setFlowErr("Your access is taking longer than usual to land. Try Open again to check, or come back later.");
        setPhase("error");
      }
      return false;
    },
    [address, room, doOpen],
  );

  // Run the one-time membership proof, hand it to the batching relay, persist the ticket, wait, then auto-open.
  const setupAccess = useCallback(async () => {
    if (!identity || !openDocId) return;
    if (belowFloor) { setFlowErr(`This room needs at least ${ANON_FLOOR} members before access opens.`); setPhase("below-floor"); return; }
    cancelled.current = false;
    setFlowErr(null);
    setProveBy(null);
    setFlushAt(null);
    setPhase("proving");
    setProveStep("Setting up your access on the self-hosted prover. This runs once for the room and can take a few minutes.");
    try {
      const holderSig = signDataRoomAccess(identity);
      const pa = await proveAccess({
        roomId: room.trim(),
        idSecret: identity.idSecret,
        idTrapdoor: identity.idTrapdoor,
        accessor: identity.accessor,
        holderSig,
        recipientPub: identity.recipientPub,
        minAnonSet: ANON_FLOOR,
      });
      if (!pa.jobId) throw new Error(pa.error || "could not start the membership proof");
      let bundle: Bundle | null = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 12 * 60 * 1000) {
        if (cancelled.current) return;
        const s = await getProveStatus(pa.jobId);
        setProveBy(s.by ?? null);
        if (s.status === "done" && s.bundle) { bundle = s.bundle; break; }
        if (s.status === "error") throw new Error(s.error || "proving failed");
        await new Promise((r) => setTimeout(r, 4000));
      }
      if (!bundle) throw new Error("the proof timed out");

      setPhase("queuing");
      setProveStep("Handing your access to the batching relay.");
      const q = await queueAccess({ bundle, roomId: room.trim(), accessor: identity.accessor, nullifier: pa.nullifier });
      if (!q.ok || !q.ticket) throw new Error(q.error || "could not queue your access for batched submission");
      setFlushAt(q.flushAt ?? null);
      writeOpenTicket(address, {
        roomId: room.trim().toLowerCase(),
        docId: openDocId,
        ticket: q.ticket,
        flushAt: q.flushAt ?? null,
        windowMs: q.windowMs ?? null,
        ts: Date.now(),
      });
      await waitForBatch(q.ticket, q.windowMs ?? null, openDocId, identity);
    } catch (e) {
      if (cancelled.current) return;
      setFlowErr(String((e as Error).message ?? e));
      setPhase("error");
    }
  }, [identity, openDocId, belowFloor, room, address, waitForBatch]);

  // The single Open action for a document: derive identity, read live status, branch.
  const open = useCallback(
    async (docId: string) => {
      if (!isHex32(room) || !isHex32(docId)) { setFlowErr("This document id is not valid."); setPhase("error"); return; }
      cancelled.current = false;
      setOpenDocId(docId);
      setOpened(null);
      setFlowErr(null);
      setProveStep("");
      setPhase("checking");
      try {
        const id = await ident.derive(room.trim());
        if (!id) { setFlowErr(ident.error ?? "Could not derive your identity from the wallet."); setPhase("error"); return; }
        setIdentity(id);
        const [acc, st, elig] = await Promise.all([
          sdk.canOpenDocument(room.trim(), docId.trim(), id.accessor),
          getEnrollStatus(room.trim(), id.idCommitment).catch(() => ({ state: "none" as const })),
          getEligible(room.trim()).catch(() => null),
        ]);
        if (cancelled.current) return;
        setAccess(acc);
        if (elig) setAnonCount(elig.memberCount);
        const below = elig ? elig.memberCount < ANON_FLOOR : belowFloor;

        if (acc.revoked) setPhase("revoked");
        else if (acc.admitted) await doOpen(docId, id); // already set up -> open automatically
        else if (st.state === "eligible") setPhase(below ? "below-floor" : "approved");
        else if (st.state === "pending") setPhase("pending");
        else setPhase("not-member");
      } catch (e) {
        if (cancelled.current) return;
        setFlowErr(String((e as Error).message ?? e));
        setPhase("error");
      }
    },
    [room, ident, belowFloor, doOpen],
  );

  const dismiss = useCallback(() => { resetFlow(); }, [resetFlow]); // "Not now"

  // Resume a persisted batch wait on landing: if this wallet has an outstanding ticket, auto-select its room
  // and pick the flow back up (poll, then auto-open) so leaving the tab does not lose the "waiting" state.
  // Keyed to the address it ran for, so switching wallets re-resumes for the NEW account (the [address] effect
  // above already cancels the previous account's in-flight poll). `acct` is captured so a switch mid-resume
  // does not clear the wrong account's ticket.
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!connected || !address || resumedFor.current === address) return;
    resumedFor.current = address;
    const acct = address;
    const t = findOpenTicket(acct);
    if (!t) return;
    cancelled.current = false;
    setRoom(t.roomId);
    setOpenDocId(t.docId);
    setFlushAt(t.flushAt);
    setPhase("waiting");
    (async () => {
      const id = await ident.derive(t.roomId).catch(() => null);
      if (cancelled.current) return;
      if (!id) {
        // The wallet declined the signature (the resume auto-prompts), so the wait can't continue. Offer retry.
        setFlowErr("Sign with your wallet to resume opening this document.");
        setPhase("error");
        return;
      }
      setIdentity(id);
      // If the access already landed while away, this opens immediately; otherwise it keeps polling.
      const acc = await sdk.canOpenDocument(t.roomId, t.docId, id.accessor).catch(() => null);
      if (cancelled.current) return;
      if (acc?.admitted) { clearOpenTicket(acct, t.roomId); await doOpen(t.docId, id); return; }
      await waitForBatch(t.ticket, t.windowMs, t.docId, id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, address]);

  return {
    connected,
    connect,
    walletStatus,
    deriving: ident.busy,
    drift: ident.drift,
    // rooms + docs
    openableRooms,
    directory,
    refreshRooms,
    refreshing,
    // cross-device sync (encrypted vault)
    syncOn,
    syncState,
    syncMsg,
    unlockSync,
    setSync,
    room,
    selectRoom,
    roomDocs,
    docsLoading,
    anonCount,
    belowFloor,
    // open flow
    open,
    openDocId,
    phase,
    identity,
    access,
    proveStep,
    proveBy,
    flushAt,
    opened,
    flowErr,
    setupAccess,
    dismiss,
  };
}
