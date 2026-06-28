import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDataroomDocuments,
  getDirectory,
  getEnrollStatus,
  getEligible,
  proveAccess,
  requestAccess,
  queueAccess,
  getQueueStatus,
  getProveStatus,
  getBondRequirementApi,
  getBondQualSet,
  getTokenBalance,
  escrowDeposit,
  proveBond,
  submitBond,
  proveBondOpen,
  submitBondOpen,
  type DataroomDoc,
  type Bundle,
  type BondRequirement,
} from "@/lib/api";
import { ANON_FLOOR } from "@/components/app/dataroom/AnonymityMeter";
import { BOND_FLOOR } from "@/components/app/dataroom/kit";
import { signDataRoomAccess, bondAccessCommitment, type DataRoomIdentity, type OpenedCommitteeDocument, type RoomAccess } from "zkorage-sdk";
import { sdk } from "@/lib/sdk";
import { useWallet, useTxSigner } from "@/lib/wallet/WalletContext";
import { useDataRoomIdentity } from "@/lib/hooks/useDataRoomIdentity";
import { readJoinRequests, writeJoinRequests } from "@/lib/dataroom/requests";
import { pushVault, isVaultSyncOn, setVaultSyncOn } from "@/lib/dataroom/vault";
import { SYNC_EVENT } from "@/lib/sync/prefs";
import { syncRestoreAll, syncDisable } from "@/lib/sync/orchestrator";
import { writeOpenTicket, clearOpenTicket, findOpenTicket } from "@/lib/dataroom/openTicket";
import { markBondLocked, clearBondLocked, hasBondLockedFor } from "@/lib/dataroom/bondLocks";
import { getBondOpenIdentity } from "@/lib/bonded/bondOpenIdentity";
import { getBondSig, loadIdentityAt } from "@/lib/bonded/handle";
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
  | "error"
  // ── Bonded Access (BA5): a bonded room/document requires a qualifying bond proof instead of plain membership.
  | "bond-detecting" // reading the room's bond requirement
  | "bond-not-member" // bonded room, reader not on the approved list
  | "bond-deposit" // legacy bond-implies-membership room, no qualifying bond yet -> the inline deposit step
  | "bond-need-lock" // TRUE bond-only room, no qualifying bond -> lock one in Bonded Proofs (no inline deposit)
  | "bond-below-floor" // has a qualifying bond, fewer than BOND_FLOOR qualifying bonders
  | "bond-ready"; // has a qualifying bond, at/above the floor -> offer the one-time bond proof

// Cross-device sync status for the encrypted rooms vault.
export type SyncState =
  | "off" // sync turned off (or no wallet)
  | "locked" // sync on, but the wallet has not signed this session -> show a one-tap unlock
  | "syncing"
  | "synced"
  | "error";

export function useSharedOpen() {
  const { address, connected, connect, status: walletStatus, signMessage } = useWallet();
  const signer = useTxSigner();
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

  // Cross-device sync via the encrypted vault. Default OFF (opt-in). "locked" = sync was turned on before but
  // the wallet has not signed THIS session (a page reload), so we wait for a one-tap sign-in rather than pop the
  // wallet on load. Turning the switch on (an explicit action) signs right away, so the happy path syncs at once.
  const [syncOn, setSyncOn] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("off");
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  useEffect(() => { setSyncOn(isVaultSyncOn(connected ? address : null)); }, [connected, address]);
  // When sync is turned on / restored elsewhere (the connect dialog or the wallet menu), re-read the preference
  // and the freshly merged rooms so this page reflects it without a navigation.
  useEffect(() => {
    const onSync = () => {
      const on = isVaultSyncOn(connected ? address : null);
      setSyncOn(on);
      if (address) reloadOpenable(address);
      if (on && address && ident.hasSignature(address)) {
        // The originator (the connect dialog or the wallet menu) already pulled both pillars and emitted, so
        // mark this address synced to keep the pull-on-connect effect (re-run by syncOn flipping on) from
        // pulling the rooms vault a second time.
        syncedFor.current = address;
        setSyncState("synced");
      }
    };
    window.addEventListener(SYNC_EVENT, onSync);
    return () => window.removeEventListener(SYNC_EVENT, onSync);
  }, [connected, address, reloadOpenable, ident.hasSignature]);

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
  // True while a manual turn-on/unlock is signing, so this effect (re-run when syncOn flips on) does not
  // clobber the "syncing" state with "locked" while the wallet signature dialog is still open.
  const unlocking = useRef(false);
  useEffect(() => {
    if (!connected || !address) { setSyncState("off"); return; }
    if (!syncOn) { setSyncState("off"); return; }
    if (unlocking.current) return; // a manual unlock is in flight; it owns syncState
    if (!ident.hasSignature(address)) { setSyncState("locked"); return; } // wait for a one-tap unlock
    if (syncedFor.current === address) return;
    syncedFor.current = address;
    let live = true;
    (async () => {
      try {
        setSyncState("syncing");
        await syncRestoreAll(address, signMessage); // both pillars, one cached signature
        if (!live) return;
        reloadOpenable(address);
        if (live) setSyncState("synced");
      } catch {
        if (live) setSyncState("error");
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, address, syncOn]);
  useEffect(() => { syncedFor.current = null; }, [address]);

  // One-tap unlock: sign once, restore both pillars (rooms + Bonded Access), merge, push the union back.
  const unlockSync = useCallback(async () => {
    if (!address) return;
    setSyncMsg(null);
    unlocking.current = true;
    setSyncState("syncing");
    try {
      await syncRestoreAll(address, signMessage);
      reloadOpenable(address);
      syncedFor.current = address;
      setSyncState("synced");
    } catch (e) {
      setSyncState("error");
      setSyncMsg(String((e as Error).message ?? e));
    } finally {
      unlocking.current = false;
    }
  }, [address, signMessage, reloadOpenable]);

  // Turn sync on or off. Turning it ON is an explicit opt-in, so sign + pull right away (no separate Unlock
  // step); a declined signature lands in the "error" state with a retry. Turning it OFF deletes the server copy.
  const setSync = useCallback(
    async (on: boolean) => {
      if (!address) return;
      setVaultSyncOn(address, on);
      setSyncOn(on);
      setSyncMsg(null);
      if (on) {
        await unlockSync();
      } else {
        setSyncState("off");
        syncedFor.current = null;
        // syncDisable only deletes the server copy if the wallet already signed this session, so turning a
        // setting OFF never pops the wallet; it also keeps the Bonded Access handle backup intact.
        const deleted = await syncDisable(address, signMessage);
        setSyncMsg(
          deleted
            ? "Sync off. Your saved copy was deleted."
            : "Sync off on this device. Sign in once to also delete the saved copy.",
        );
      }
    },
    [address, signMessage, unlockSync],
  );

  // The open flow. One document is "active" (openDocId + phase) at a time, but every document that opened stays
  // open: its decrypted content is cached in `openedDocs` so switching between documents needs no re-check and
  // no re-prove, and several can be expanded at once. `expandedDocs` is which rows are open in the UI.
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [phase, setPhase] = useState<OpenPhase>("idle");
  const [identity, setIdentity] = useState<DataRoomIdentity | null>(null);
  const [access, setAccess] = useState<RoomAccess | null>(null);
  const [proveStep, setProveStep] = useState("");
  const [proveBy, setProveBy] = useState<string | null>(null);
  const [flushAt, setFlushAt] = useState<number | null>(null);
  const [flowErr, setFlowErr] = useState<string | null>(null);
  // The decrypted result per document (success OR a not-released / wrong-key result, so the row can show why).
  const [openedDocs, setOpenedDocs] = useState<Record<string, OpenedCommitteeDocument>>({});
  // A per-document open ERROR (a thrown keeper/RPC failure), so one document failing does not strand the others:
  // the auto-open chain skips a failed document, and its row shows a retry instead of a perpetual spinner.
  const [docErrors, setDocErrors] = useState<Record<string, string>>({});
  const [expandedDocs, setExpandedDocs] = useState<string[]>([]);
  // True once the room's access has landed (a first reconstructed open). Subsequent documents then open by just
  // fetching + decrypting, with no gate re-check and no new proof. `openFloorRef` remembers the anonymity floor
  // that worked, for those follow-up opens.
  const [roomAccessReady, setRoomAccessReady] = useState(false);
  const openFloorRef = useRef(ANON_FLOOR);
  // Set when arriving from a "Check Bonded Access" redirect (?setup=bond): auto-run the one-time setup once the
  // flow resolves to a ready state, so the reader does not have to click again.
  const autoSetupRef = useRef(false);

  // ── Bonded Access (BA5) state ──
  const [bondReq, setBondReq] = useState<BondRequirement | null>(null);
  const [bondCount, setBondCount] = useState<number | null>(null);
  const [bondTokenMeta, setBondTokenMeta] = useState<{ symbol: string; decimals: number; issuer: string | null } | null>(null);
  const [bondLocking, setBondLocking] = useState(false);
  const bondBelowFloor = bondCount !== null && bondCount < BOND_FLOOR;

  // The SELECTED room's own bond requirement, read on room select (public, no signature), so the Open page can
  // show a bond-aware panel (requirement + set count + a set-up action) BEFORE the reader does anything. Only
  // set for a TRUE bond-only room (`bondOpen`); a membership / legacy-bonded room leaves it null and uses the
  // per-document flow. `roomBondMeta` carries the token's symbol/decimals/issuer for the requirement detail.
  const [roomBond, setRoomBond] = useState<BondRequirement | null>(null);
  const [roomBondMeta, setRoomBondMeta] = useState<{ symbol: string; decimals: number; issuer: string | null } | null>(null);
  const [roomBondMetaLoading, setRoomBondMetaLoading] = useState(false);
  const [roomBondCount, setRoomBondCount] = useState<number | null>(null);
  // Whether this wallet actually holds a qualifying bond for the room's requirement (its reusable Bonded Access
  // handle's commitment is in the live qualifying set). null while unknown. Drives the room banner: hold one ->
  // "open a document below"; hold none -> point to Bonded Proofs to lock one (no bond is ever locked here now).
  const [roomBondHas, setRoomBondHas] = useState<boolean | null>(null);
  // True if this wallet has a LOCAL marker that it already locked a qualifying bond for this room's current
  // requirement, so the idle panel can say "you've locked a bond, continue" instead of a bare "Set up access".
  // A hint only (no wallet signature); the live check on click is authoritative. Set/cleared as the flow learns
  // the real state (lock success, or a live read that finds the bond present/absent).
  const [roomBondLocked, setRoomBondLocked] = useState(false);

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

  // Read the selected room's bond requirement (public, no signature) so the Open page knows on landing whether
  // it is a bond-only room and can show the bond-aware panel. Loads the token meta + the live qualifying-set
  // count for display. A membership / legacy room leaves roomBond null (the per-document flow handles those).
  useEffect(() => {
    if (!isHex32(room)) { setRoomBond(null); setRoomBondMeta(null); setRoomBondCount(null); setRoomBondMetaLoading(false); setRoomBondLocked(false); setRoomBondHas(null); return; }
    let live = true;
    setRoomBond(null); setRoomBondMeta(null); setRoomBondCount(null); setRoomBondMetaLoading(true); setRoomBondLocked(false); setRoomBondHas(null);
    getBondRequirementApi(room.trim())
      .then((r) => {
        if (!live) return;
        if (r.found && r.bondOpen && r.token && r.minAmount && r.deadline) {
          setRoomBond(r);
          // Seed the "you've already locked a bond" hint from the local marker (matched to this requirement's
          // reqId, so a changed requirement does not show a stale hint).
          setRoomBondLocked(hasBondLockedFor(address, room.trim(), r.reqId));
          getBondQualSet(r.token, r.minAmount, r.deadline)
            .then((q) => {
              if (!live) return;
              setRoomBondCount(q.anonSetSize);
              // Does this wallet already hold a qualifying bond? Read the reusable handle from this browser (no
              // signature) and look for its commitment in the set. No handle -> no qualifying bond.
              const handle = loadIdentityAt(address);
              if (handle) {
                const mine = bondAccessCommitment(handle.idSecret).toLowerCase();
                setRoomBondHas(q.locks.some((l) => l.commitment.toLowerCase() === mine));
              } else {
                setRoomBondHas(false);
              }
            })
            .catch(() => { if (live) { setRoomBondCount(null); setRoomBondHas(null); } });
          if (address) {
            getTokenBalance(address, r.token)
              .then((t) => { if (live) setRoomBondMeta({ symbol: t.symbol, decimals: t.decimals, issuer: t.issuer ?? null }); })
              .catch(() => { /* leave null -> the detail reads "unavailable" */ })
              .finally(() => { if (live) setRoomBondMetaLoading(false); });
          } else if (live) {
            setRoomBondMetaLoading(false);
          }
        } else {
          setRoomBond(null);
          setRoomBondMetaLoading(false);
        }
      })
      .catch(() => { if (live) { setRoomBond(null); setRoomBondMetaLoading(false); } });
    return () => { live = false; };
  }, [room, address]);

  // Reset the open flow whenever the selected room changes (drops the per-document open cache too).
  const resetFlow = useCallback(() => {
    setOpenDocId(null);
    setPhase("idle");
    setIdentity(null);
    setAccess(null);
    setOpenedDocs({});
    setDocErrors({});
    setExpandedDocs([]);
    setRoomAccessReady(false);
    openFloorRef.current = ANON_FLOOR;
    autoSetupRef.current = false;
    setFlowErr(null);
    setProveStep("");
    setProveBy(null);
    setFlushAt(null);
    setBondReq(null);
    setBondCount(null);
    setBondTokenMeta(null);
  }, []);

  const selectRoom = useCallback((roomId: string) => {
    cancelled.current = true; // stop any in-flight poll for the previous room (open()/setupAccess re-arm it)
    resetFlow();
    setRoom(roomId.trim());
  }, [resetFlow]);

  // ── the orchestrated open ──────────────────────────────────────────────────────────────────────
  // Get the key from the keepers and decrypt in the browser. Only reached once the on-chain grant exists.
  // `minAnonSet` is the eligible-set floor the share aggregator enforces: ANON_FLOOR (5) on the plain
  // membership path, BOND_FLOOR (3) on a bonded room (a bonded room is sized to the bond floor, so 5 would
  // wrongly refuse a 3-member room).
  const doOpen = useCallback(async (docId: string, id: DataRoomIdentity, minAnonSet: number = ANON_FLOOR) => {
    setOpenDocId(docId);
    setPhase("opening");
    setFlowErr(null);
    // Drop any stale cached result OR prior error for this doc (e.g. a previous "not released yet" / a thrown
    // keeper failure), so the row shows the opening spinner during a retry instead of the old failure.
    setOpenedDocs((prev) => {
      if (!(docId in prev)) return prev;
      const next = { ...prev };
      delete next[docId];
      return next;
    });
    setDocErrors((prev) => {
      if (!(docId in prev)) return prev;
      const next = { ...prev };
      delete next[docId];
      return next;
    });
    try {
      const open1 = () =>
        sdk.openCommitteeDocument(room.trim(), docId.trim(), id.accessor, id.recipientSecret, { minAnonSet });
      let out = await open1();
      // The grant + the keepers' view of it read the chain independently and can lag a few seconds behind a
      // just-recorded access tx. If the document exists but no shares were released yet (no grant visible, or
      // the keepers have not seen it), that is almost always propagation lag, so retry a few times before
      // surfacing a failure rather than the scary "key could not be rebuilt". A released-but-unfaithful result
      // (wrong recipient key) is a real failure and is NOT retried (released stays true).
      for (let i = 0; i < 3 && out.found && !out.released; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        if (cancelled.current) return;
        out = await open1();
      }
      if (cancelled.current) return;
      // Cache the result (success, not-released, or wrong-key) so the row renders it and a re-expand is instant.
      setOpenedDocs((prev) => ({ ...prev, [docId]: out }));
      if (out.reconstructed) {
        // Room access is established: remember the floor so follow-up documents open with no re-prove.
        setRoomAccessReady(true);
        openFloorRef.current = minAnonSet;
      }
      // Free the active slot (the row now renders from openedDocs); a queued document opens via the effect.
      setPhase("idle");
      setOpenDocId((cur) => (cur === docId ? null : cur));
    } catch (e) {
      if (cancelled.current) return;
      // Record a per-document error and free the slot, so a thrown failure on one document does not strand the
      // others: the auto-open chain skips this doc, and its row shows a retry. (Setup-flow errors stay on
      // `flowErr`/phase "error"; this is only the keeper-fetch step.)
      setDocErrors((prev) => ({ ...prev, [docId]: String((e as Error).message ?? e) }));
      setPhase("idle");
      setOpenDocId((cur) => (cur === docId ? null : cur));
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

  // ── Bonded Access (BA5) ──────────────────────────────────────────────────────────────────────
  // Resolve which bond phase a member is in for a bonded document: read the live qualifying set, see whether
  // this member already has a qualifying lock (their bond commitment is in the set), and whether the set has
  // reached the anonymity floor. Membership is checked first (the bond proof also proves membership, so a
  // non-member must request to join + then bond). `memberState` is the reader's enroll status (already read).
  const resolveBondPhase = useCallback(
    async (req: BondRequirement, id: DataRoomIdentity, memberState: "none" | "pending" | "eligible") => {
      setBondReq(req);
      // Resolve the token's decimals/symbol for the deposit input. Leave it NULL until the read returns (and
      // null on failure), so the deposit step blocks rather than guessing 7 decimals: a wrong scale would
      // mis-size the human->base amount conversion. The on-chain minimum is in base units, so a reader can
      // never lock below the minimum, but a wrong decimals could over-lock.
      setBondTokenMeta(null);
      if (address && req.token) {
        getTokenBalance(address, req.token)
          .then((t) => { if (!cancelled.current) setBondTokenMeta({ symbol: t.symbol, decimals: t.decimals, issuer: t.issuer ?? null }); })
          .catch(() => { /* leave null; BondDeposit shows a "reading the token" state + blocks the lock */ });
      }
      // A lapsed deadline can never be satisfied (a qualifying lock needs unlock_time >= deadline AND
      // now < unlock_time), so the room is silently un-openable. Surface it instead of routing the reader to
      // a deposit that the escrow will reject.
      const now = Math.floor(Date.now() / 1000);
      if (req.deadline && req.deadline <= now) {
        setFlowErr("This room's bond deadline has passed. Ask the room owner to update the requirement.");
        setPhase("error");
        return;
      }
      const qual = await getBondQualSet(req.token!, req.minAmount!, req.deadline!).catch(() => null);
      if (cancelled.current) return;
      setBondCount(qual ? qual.anonSetSize : null);
      // TRUE bond-only (no-approval): the bond is the only gate, so skip the membership check entirely. A
      // reader who never asked to join can deposit + prove straight away. The legacy bond-implies-membership
      // path still requires an approved member (the bond proof also proves membership there).
      if (!req.bondOpen) {
        if (memberState === "pending") { setPhase("pending"); return; }
        if (memberState !== "eligible") { setPhase("bond-not-member"); return; }
      }
      const mine = bondAccessCommitment(id.idSecret).toLowerCase();
      const hasBond = !!qual && qual.locks.some((l) => l.commitment.toLowerCase() === mine);
      if (!hasBond) {
        // The live read found no qualifying bond for this member, so a stale "you locked one" hint is wrong.
        clearBondLocked(address, room.trim());
        setRoomBondLocked(false);
        setRoomBondHas(false);
        // TRUE bond-only (no-approval): bonds are locked on Bonded Proofs > Bonded Access now, never here, so
        // point the reader there (no inline deposit). The legacy bond-implies-membership path still locks inline.
        setPhase(req.bondOpen ? "bond-need-lock" : "bond-deposit");
        return;
      }
      markBondLocked(address, room.trim(), req.reqId);
      setRoomBondLocked(true);
      setRoomBondHas(true);
      setPhase(qual && qual.anonSetSize < BOND_FLOOR ? "bond-below-floor" : "bond-ready");
    },
    [address, room],
  );

  // Re-read the qualifying set after a deposit (or on a "Check again"), then move to the right bond phase
  // without a fresh identity derive. Uses the identity + requirement already in state.
  const refreshBond = useCallback(async () => {
    if (!identity || !bondReq?.token || !bondReq.minAmount || !bondReq.deadline) return;
    const qual = await getBondQualSet(bondReq.token, bondReq.minAmount, bondReq.deadline).catch(() => null);
    if (cancelled.current) return;
    setBondCount(qual ? qual.anonSetSize : null);
    // Keep the room-level panel's count in sync too (e.g. after this reader deposits, then dismisses to idle).
    setRoomBondCount(qual ? qual.anonSetSize : null);
    const mine = bondAccessCommitment(identity.idSecret).toLowerCase();
    const hasBond = !!qual && qual.locks.some((l) => l.commitment.toLowerCase() === mine);
    if (!hasBond) {
      clearBondLocked(address, room.trim());
      setRoomBondLocked(false);
      setRoomBondHas(false);
      setPhase(bondReq.bondOpen ? "bond-need-lock" : "bond-deposit");
      return;
    }
    markBondLocked(address, room.trim(), bondReq.reqId);
    setRoomBondLocked(true);
    setRoomBondHas(true);
    setPhase(qual && qual.anonSetSize < BOND_FLOOR ? "bond-below-floor" : "bond-ready");
  }, [identity, bondReq, room, address]);

  // Lock a qualifying bond inline: a NON-revocable self-bond of the required token, at least `amountBase`,
  // until the requirement's deadline, with the access commitment = sha256(0x03 ‖ id_secret ‖ "escrow") so it
  // counts for THIS member anonymously. The wallet signs the escrow deposit; then re-resolve the bond phase.
  const lockBond = useCallback(
    async (amountBase: string) => {
      if (!identity || !bondReq?.token || !bondReq.deadline) return;
      if (!signer) { setFlowErr("Connect your wallet on testnet to lock a bond."); setPhase("error"); return; }
      setBondLocking(true);
      setFlowErr(null);
      try {
        const commitment = bondAccessCommitment(identity.idSecret);
        const r = await escrowDeposit(
          { amount: amountBase, unlock_time: bondReq.deadline, revocable: false, token: bondReq.token, commitment },
          signer,
        );
        if (!r.ok) throw new Error(r.error || "could not lock your bond");
        if (cancelled.current) return;
        // Remember this lock locally (per wallet + room) so a later re-landing shows "you've locked a bond,
        // continue" instead of a bare "Set up access". refreshBond re-confirms it from the live set.
        markBondLocked(address, room.trim(), bondReq.reqId);
        setRoomBondLocked(true);
        await refreshBond();
      } catch (e) {
        if (cancelled.current) return;
        setFlowErr(String((e as Error).message ?? e));
        setPhase("error");
      } finally {
        setBondLocking(false);
      }
    },
    [identity, bondReq, signer, refreshBond, room, address],
  );

  // Poll a prover job until its bundle is ready (or it errors / times out). Shared by the two concurrent
  // proofs the bonded setup runs. Throws on cancel/error/timeout; the caller bails silently on cancel.
  const pollProveBundle = useCallback(async (jobId: string): Promise<Bundle> => {
    const t0 = Date.now();
    while (Date.now() - t0 < 12 * 60 * 1000) {
      if (cancelled.current) throw new Error("cancelled");
      const s = await getProveStatus(jobId);
      setProveBy(s.by ?? null);
      if (s.status === "done" && s.bundle) return s.bundle;
      if (s.status === "error") throw new Error(s.error || "proving failed");
      await new Promise((r) => setTimeout(r, 4000));
    }
    throw new Error("the proof timed out");
  }, []);

  // Run the one-time bonded setup, then auto-open. A bonded room needs TWO grants for the same identity:
  //  - the MEMBERSHIP proof records a proof-bound recipient_pub (the DR3 keepers seal the document key to it),
  //  - the BOND proof grants admission (is_doc_admitted).
  // The bond leg REPLACES the membership spine for ADMISSION (Option A), but the key release still needs the
  // membership grant's recipient_pub, so we record both. Both submit DIRECTLY (the bond submit is direct
  // anyway, so batching membership would add no timing cover; the accessor is a per-room key unlinkable to the
  // wallet). Both proofs run concurrently on the self-hosted prover; the witness reaches it only.
  const setupBondAccess = useCallback(async () => {
    if (!identity || !openDocId || !bondReq?.token || !bondReq.minAmount || !bondReq.deadline) return;
    if (bondBelowFloor) { setPhase("bond-below-floor"); return; }
    cancelled.current = false;
    setFlowErr(null);
    setProveBy(null);
    setPhase("proving");
    setProveStep("Setting up your access on the self-hosted prover. This runs once for the room and can take a few minutes.");
    try {
      // TRUE bond-only (no-approval): ONE bond-open proof. It carries its own proof-bound recipient_pub, so
      // the keepers can seal the document key without a membership grant. No enrollment, no membership proof.
      if (bondReq.bondOpen) {
        const bp = await proveBondOpen({
          idSecret: identity.idSecret,
          idTrapdoor: identity.idTrapdoor,
          holderSeed: identity.accessorSeed,
          recipientPub: identity.recipientPub,
          token: bondReq.token,
          minAmount: bondReq.minAmount,
          deadline: bondReq.deadline,
        });
        if (!bp.jobId) throw new Error(bp.error || "could not start the bond proof");
        const bondBundle = await pollProveBundle(bp.jobId);
        if (cancelled.current) return;
        setPhase("queuing");
        setProveStep("Recording your access on-chain.");
        const r = await submitBondOpen(bondBundle);
        if (cancelled.current) return;
        if (!r.ok) throw new Error(r.error || "could not record your access on-chain");
        await doOpen(openDocId, identity, BOND_FLOOR);
        return;
      }
      // The key leg: the keepers seal the document key to the recipient_pub recorded by a MEMBERSHIP grant. If
      // this identity already has one (it opened a doc in this room before the bond requirement), skip the
      // membership proof; the nullifier is per-room, so re-proving would be rejected anyway.
      const existing = await sdk.getGrant(room.trim(), identity.accessor).catch(() => null);
      const needMembership = !(existing && existing.recipient_pub);
      const holderSig = signDataRoomAccess(identity);
      // Start the needed proofs together (the prover queues them).
      const [mp, bp] = await Promise.all([
        needMembership
          ? proveAccess({
              roomId: room.trim(),
              idSecret: identity.idSecret,
              idTrapdoor: identity.idTrapdoor,
              accessor: identity.accessor,
              holderSig,
              recipientPub: identity.recipientPub,
              minAnonSet: BOND_FLOOR,
            })
          : Promise.resolve(null),
        proveBond({
          roomId: room.trim(),
          idSecret: identity.idSecret,
          idTrapdoor: identity.idTrapdoor,
          holderSeed: identity.accessorSeed,
          token: bondReq.token,
          minAmount: bondReq.minAmount,
          deadline: bondReq.deadline,
        }),
      ]);
      if (!bp.jobId) throw new Error(bp.error || "could not start the bond proof");
      if (needMembership && !mp?.jobId) throw new Error(mp?.error || "could not start the membership proof");
      const [memberBundle, bondBundle] = await Promise.all([
        needMembership && mp?.jobId ? pollProveBundle(mp.jobId) : Promise.resolve(null),
        pollProveBundle(bp.jobId),
      ]);
      if (cancelled.current) return;
      setPhase("queuing");
      setProveStep("Recording your access on-chain.");
      // Record both grants. The membership grant carries the recipient_pub the keepers seal to; the bond grant
      // satisfies is_doc_admitted. Both must exist before the keepers will release the key.
      const submits: Promise<{ ok: boolean; error?: string }>[] = [submitBond(bondBundle)];
      if (memberBundle) submits.unshift(requestAccess(memberBundle));
      const results = await Promise.all(submits);
      if (cancelled.current) return;
      for (const r of results) {
        if (!r.ok) throw new Error(r.error || "could not record your access on-chain");
      }
      await doOpen(openDocId, identity, BOND_FLOOR);
    } catch (e) {
      if (cancelled.current) return;
      setFlowErr(String((e as Error).message ?? e));
      setPhase("error");
    }
  }, [identity, openDocId, bondReq, bondBelowFloor, room, doOpen, pollProveBundle]);

  // The single Open action for a document: derive identity, read live status, branch.
  const open = useCallback(
    async (docId: string, opts?: { autoSetup?: boolean }) => {
      if (!isHex32(room) || !isHex32(docId)) { setFlowErr("This document id is not valid."); setPhase("error"); return; }
      // Already opened in this session -> just make sure the row is expanded; no re-check, no re-fetch.
      if (openedDocs[docId]?.reconstructed) {
        setExpandedDocs((prev) => (prev.includes(docId) ? prev : [...prev, docId]));
        return;
      }
      cancelled.current = false;
      setExpandedDocs((prev) => (prev.includes(docId) ? prev : [...prev, docId]));
      setOpenDocId(docId);
      setFlowErr(null);
      setProveStep("");
      setBondReq(null);
      if (opts?.autoSetup) autoSetupRef.current = true;
      // Room access already landed (a document opened before): open this one by just fetching + decrypting, with
      // no gate re-check and no new proof.
      if (roomAccessReady && identity) {
        await doOpen(docId, identity, openFloorRef.current);
        return;
      }
      setPhase("checking");
      try {
        // Read the room's requirement first to pick the identity. A TRUE bond-only room opens with the REUSABLE
        // per-wallet Bonded Access handle (one bond opens every room sharing the requirement, plus the standalone
        // page); membership + legacy bond-implies-membership rooms keep the per-room Data Room identity.
        const req = await getBondRequirementApi(room.trim(), docId.trim()).catch(() => ({ found: false }) as BondRequirement);
        if (cancelled.current) return;

        if (req.found && req.bondOpen && req.token && req.minAmount && req.deadline) {
          let id: DataRoomIdentity;
          try {
            id = await getBondOpenIdentity(address ?? "", () => getBondSig(address, signMessage), room.trim());
          } catch (e) {
            setFlowErr(String((e as Error).message ?? e));
            setPhase("error");
            return;
          }
          if (cancelled.current) return;
          setIdentity(id);
          setBondReq(req);
          const acc = await sdk.canOpenDocument(room.trim(), docId.trim(), id.accessor);
          if (cancelled.current) return;
          setAccess(acc);
          if (acc.revoked) { setPhase("revoked"); return; }
          if (acc.admitted) { await doOpen(docId, id, BOND_FLOOR); return; } // already has a grant -> open
          setPhase("bond-detecting");
          await resolveBondPhase(req, id, "none"); // bond-only: no membership leg, so member state is irrelevant
          return;
        }

        // Membership OR legacy bond-implies-membership: the per-room Data Room identity (unchanged).
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

        if (acc.revoked) { setPhase("revoked"); return; }
        if (acc.admitted) { await doOpen(docId, id, req.found ? BOND_FLOOR : ANON_FLOOR); return; } // already set up -> open

        // Legacy bond-implies-membership document: the bond proof grants admission; a membership proof provides
        // the key (recipient_pub).
        if (req.found && req.token && req.minAmount && req.deadline) {
          setBondReq(req);
          setPhase("bond-detecting");
          await resolveBondPhase(req, id, st.state);
          return;
        }

        // Plain-membership path (no bond requirement).
        const below = elig ? elig.memberCount < ANON_FLOOR : belowFloor;
        if (st.state === "eligible") setPhase(below ? "below-floor" : "approved");
        else if (st.state === "pending") setPhase("pending");
        else setPhase("not-member");
      } catch (e) {
        if (cancelled.current) return;
        setFlowErr(String((e as Error).message ?? e));
        setPhase("error");
      }
    },
    [room, ident, belowFloor, doOpen, resolveBondPhase, address, signMessage, openedDocs, roomAccessReady, identity],
  );

  // Expand or collapse a document row. Expanding an un-opened document starts its open: the first one runs the
  // gate / setup; the rest queue and open on their own once the room's access lands (the auto-open effect). A
  // document already processing blocks starting another, so two setups never run at once. Collapsing keeps the
  // cached content, so re-expanding is instant.
  const toggleDoc = useCallback(
    (docId: string) => {
      const wasOpen = expandedDocs.includes(docId);
      setExpandedDocs((prev) => (wasOpen ? prev.filter((d) => d !== docId) : [...prev, docId]));
      if (wasOpen) return;
      if (openedDocs[docId] || docErrors[docId]) return; // a cached result / error (with retry) renders in the row
      // Bond-only room where this wallet holds no qualifying bond (or has no handle yet): do NOT derive an
      // identity or prompt for a signature on a casual expand. The row shows the "create a bond" pointer; the
      // reader locks one on Bonded Proofs (the only place bonds are created now).
      if (roomBond?.bondOpen && roomBondHas === false) return;
      if (roomAccessReady) return; // the auto-open effect opens it
      // A flow is already active for another document (processing OR awaiting the reader's one-time setup): this
      // one queues, and opens on its own once the room's access lands. Keeps a single document driving the gate
      // so the "Set up access" / "Prove access" prompt does not hop between rows. (An errored flow does not
      // block, so the reader can try a different document.)
      if (phase !== "idle" && phase !== "error") return;
      void open(docId);
    },
    [expandedDocs, openedDocs, docErrors, roomBond, roomBondHas, roomAccessReady, phase, open],
  );

  // Once the room's access has landed, open any document that is expanded but not yet opened. Runs one at a time
  // (doOpen flips phase to "opening", which gates this effect) and chains as each completes. A document that
  // failed to fetch is skipped (its row offers a retry), so one failure does not stall the rest.
  useEffect(() => {
    if (!roomAccessReady || !identity) return;
    if (phase !== "idle") return; // a doOpen / setup is in flight
    const next = expandedDocs.find((d) => !openedDocs[d] && !docErrors[d] && d !== openDocId);
    if (next) void doOpen(next, identity, openFloorRef.current);
  }, [roomAccessReady, identity, phase, expandedDocs, openedDocs, docErrors, openDocId, doOpen]);

  // Auto-run the one-time setup after a "Check Bonded Access" redirect, once the flow resolves to a ready state.
  useEffect(() => {
    if (!autoSetupRef.current) return;
    if (phase === "bond-ready") { autoSetupRef.current = false; void setupBondAccess(); }
    else if (phase === "approved") { autoSetupRef.current = false; void setupAccess(); }
    else if (phase !== "checking" && phase !== "bond-detecting") {
      // A blocked/terminal state (below-floor, need-lock, not-member, error, ...): nothing to auto-run.
      autoSetupRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const dismiss = useCallback(() => { resetFlow(); }, [resetFlow]); // "Not now"

  // Open (and expand) the room's first document, optionally auto-running the one-time setup. Used by the
  // "Check Bonded Access" redirect (?setup=bond) so a reader who already holds a qualifying bond lands and the
  // open proof starts on its own; the decrypted content then appears under that document.
  const setupRoomAccess = useCallback(
    (autoSetup = false) => {
      const first = roomDocs[0];
      if (first) void open(first.doc_id, { autoSetup });
    },
    [roomDocs, open],
  );

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
    setExpandedDocs([t.docId]); // expand it so the waiting status (and then the content) shows under it
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
    toggleDoc,
    openDocId,
    expandedDocs,
    openedDocs,
    docErrors,
    roomAccessReady,
    phase,
    identity,
    access,
    proveStep,
    proveBy,
    flushAt,
    flowErr,
    setupAccess,
    dismiss,
    // bonded access (BA5)
    bondReq,
    bondCount,
    bondTokenMeta,
    bondBelowFloor,
    bondLocking,
    lockBond,
    refreshBond,
    setupBondAccess,
    // the selected room's bond requirement (for the bond-aware Open panel) + the room-level set-up action
    roomBond,
    roomBondMeta,
    roomBondMetaLoading,
    roomBondCount,
    roomBondLocked,
    roomBondHas,
    setupRoomAccess,
  };
}
