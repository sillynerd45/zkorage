import { useEffect, useRef, useState } from "react";
import {
  getCommitteeInfo,
  getCommitteeDocument,
  getEnrollStatus,
  getEligible,
  proveAccess,
  queueAccess,
  getQueueStatus,
  getProveStatus,
  type CommitteeInfoResp,
  type CommitteeDoc,
  type EnrollState,
  type Bundle,
} from "@/lib/api";
import { ANON_FLOOR } from "@/components/app/dataroom/AnonymityMeter";
import {
  DEMO_MODELB_ROOM,
  DEMO_MODELB_DOC,
  signDataRoomAccess,
  type DataRoomIdentity,
  type OpenedCommitteeDocument,
  type RoomAccess,
} from "zkorage-sdk";
import { sdk } from "@/lib/sdk";
import { useWallet } from "@/lib/wallet/WalletContext";
import { useDataRoomIdentity } from "@/lib/hooks/useDataRoomIdentity";
import { isHex32 } from "@/lib/format";

// M3: "Open a shared document" with sign-to-derive identity (Model B). The reader's room identity is derived
// from their wallet IN THE BROWSER (M0), so the room never learns who they are or which member they are. The
// flow branches on the reader's live on-chain state:
//   - already granted        -> read the doc's policy/admission, then open (keepers release the key to them).
//   - on the room's list, not granted yet -> prove membership ONCE (self-hosted prover, a few minutes) ->
//                               request_access binds their accessor + recipient key on-chain -> open.
//   - not on the room's list  -> they are sent to request to join (Membership).
// ZK is load-bearing: the keepers release the key to someone they cannot identify, because a proof, not a
// login, decides who qualifies. The recipient secret never leaves the browser; the one-time membership proof
// is the only step where the witness leaves it, and it goes to the self-hosted prover alone.
//
// M7 (timing defense): the proof bundle is NOT submitted on-chain immediately. It is handed to the batching
// relay, which records the access on-chain SHUFFLED at the next fixed window boundary, together with the other
// accesses in that window. So the room owner reads only "an approved member accessed in this window", not when
// (or whether) THIS member acted. Latency until the access lands is the price of breaking that timing link.
// Honest residual (NOT closed by batching): the on-chain grant also records the membership snapshot
// (eligible_root) the proof checked, so a stable member list gives everyone the same cover, while a room that
// re-pins its set in batches narrows a grant to that snapshot's cohort. The full fix (a recent-roots ring /
// epoch roots) is a contract change, deferred.
export type ProveStage = "idle" | "proving" | "queuing" | "queued";

// One source of truth for the below-floor block message (shown when the reader tries to prove/open a room
// with fewer than ANON_FLOOR members). The backend enforces the same floor independently.
const FLOOR_BLOCK_MSG = `Access needs at least ${ANON_FLOOR} members in this room. Anonymity needs a crowd to hide in.`;

export function useSharedOpen() {
  const { connected, connect, status: walletStatus } = useWallet();
  const ident = useDataRoomIdentity();

  const [committee, setCommittee] = useState<CommitteeInfoResp | null>(null);
  const [committeeDoc, setCommitteeDoc] = useState<CommitteeDoc | null>(null);
  const [room, setRoom] = useState(DEMO_MODELB_ROOM);
  const [doc, setDoc] = useState(DEMO_MODELB_DOC);

  // The room's eligible-set size (the anonymity set). null = unknown (room not resolved). Below ANON_FLOOR,
  // access is disabled (a set too small to hide in).
  const [anonCount, setAnonCount] = useState<number | null>(null);
  const belowFloor = anonCount !== null && anonCount < ANON_FLOOR;

  // The reader's wallet-derived identity for the CURRENT room (null until they check). Re-derived per room.
  const [identity, setIdentity] = useState<DataRoomIdentity | null>(null);
  const [access, setAccess] = useState<RoomAccess | null>(null);
  const [enrollState, setEnrollState] = useState<EnrollState | null>(null);
  const [accessErr, setAccessErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // The one-time membership proof (only when the reader is on the list but not yet granted).
  const [proveStage, setProveStage] = useState<ProveStage>("idle");
  const [proveStep, setProveStep] = useState("");
  const [proveBy, setProveBy] = useState<string | null>(null);
  const [proveErr, setProveErr] = useState<string | null>(null);
  // M7: the window boundary (unix ms) the queued access lands at, surfaced so the reader sees roughly when.
  const [flushAt, setFlushAt] = useState<number | null>(null);

  const [opened, setOpened] = useState<OpenedCommitteeDocument | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  useEffect(() => {
    getCommitteeInfo().then(setCommittee).catch(() => {});
  }, []);

  // Load the document's public fingerprints (content + key commitment) whenever the room/doc are valid hex.
  // Display only; reveals nothing about the reader.
  useEffect(() => {
    if (!isHex32(room) || !isHex32(doc)) {
      setCommitteeDoc(null);
      return;
    }
    let live = true;
    getCommitteeDocument(room.trim(), doc.trim())
      .then((r) => { if (live) setCommitteeDoc(r.document); })
      .catch(() => { if (live) setCommitteeDoc(null); });
    return () => { live = false; };
  }, [room, doc]);

  // The room's anonymity-set size drives the meter + the access floor (read whenever the room is valid hex).
  useEffect(() => {
    if (!isHex32(room)) {
      setAnonCount(null);
      return;
    }
    let live = true;
    getEligible(room.trim())
      .then((r) => { if (live) setAnonCount(r.memberCount); })
      .catch(() => { if (live) setAnonCount(null); });
    return () => { live = false; };
  }, [room]);

  // Changing the target room/doc invalidates the per-room identity + every result, so the reader re-checks.
  useEffect(() => {
    setIdentity(null);
    setAccess(null);
    setEnrollState(null);
    setOpened(null);
    setAccessErr(null);
    setOpenErr(null);
    setProveErr(null);
    setProveStep("");
  }, [room, doc]);

  // Derive the reader's identity for this room (one wallet signature, cached for the session), then read their
  // live admission (on-chain) + whether they are on the room's list (so we know which step to offer).
  async function onCheck() {
    setAccessErr(null);
    setOpened(null);
    setOpenErr(null);
    setProveErr(null);
    setProveStep("");
    if (!isHex32(room) || !isHex32(doc)) {
      setAccessErr("room and doc must each be 32-byte hex (64 hex chars)");
      return;
    }
    setChecking(true);
    try {
      const id = await ident.derive(room.trim());
      if (!id) {
        setAccessErr(ident.error ?? "Could not derive your identity from the wallet.");
        return;
      }
      setIdentity(id);
      const [acc, st] = await Promise.all([
        sdk.canOpenDocument(room.trim(), doc.trim(), id.accessor),
        getEnrollStatus(room.trim(), id.idCommitment).catch(() => ({ state: "none" as EnrollState })),
      ]);
      setAccess(acc);
      setEnrollState(st.state);
    } catch (e) {
      setAccessErr(String((e as Error).message ?? e));
    } finally {
      setChecking(false);
    }
  }

  // Prove membership ONCE, then hand the proof to the batching relay instead of submitting it directly. The
  // witness (the reader's wallet-derived secrets) goes to the self-hosted prover, which returns a Groth16
  // bundle; the relay records the access on-chain (request_access) SHUFFLED at the next fixed window boundary,
  // so the on-chain timestamp + order reveal the window, not this member's action. The reader waits for the
  // window to flush, then can open. After it lands, opening any document in the room is instant.
  async function onProve() {
    if (!identity) return;
    if (belowFloor) {
      setProveErr(FLOOR_BLOCK_MSG);
      return;
    }
    setProveErr(null);
    setProveBy(null);
    setFlushAt(null);
    setProveStep("Proving your membership (sha256-Merkle, nullifier, holder signature) on the self-hosted prover. This runs once for the room and can take a few minutes.");
    setProveStage("proving");
    try {
      cancelled.current = false;
      // Sign the NEW-5 consent IN THE BROWSER, so accessor_seed never leaves the device; the backend + prover
      // receive only the signature + the public accessor.
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
        if (s.status === "done" && s.bundle) {
          bundle = s.bundle;
          break;
        }
        if (s.status === "error") throw new Error(s.error || "proving failed");
        await new Promise((r) => setTimeout(r, 4000));
      }
      if (!bundle) throw new Error("the proof timed out");

      // Hand the proven bundle to the batching relay (the timing defense). It will be submitted on-chain,
      // shuffled with the window's other accesses, at the next boundary — not the instant you proved.
      setProveStage("queuing");
      setProveStep("Handing your access to the batching relay.");
      const q = await queueAccess({
        bundle,
        roomId: room.trim(),
        accessor: identity.accessor,
        nullifier: pa.nullifier,
      });
      if (!q.ok || !q.ticket) throw new Error(q.error || "could not queue your access for batched submission");
      setFlushAt(q.flushAt ?? null);
      setProveStage("queued");
      setProveStep("Your access is queued. It lands on-chain at the next batch window, shuffled with the others in that window, so the room cannot tell when you acted.");

      // Poll the ticket until the window flushes and the access lands (or fails). Allow up to two windows
      // (the relay may have just missed a boundary) plus a margin.
      const windowMs = q.windowMs ?? 10 * 60 * 1000;
      const deadline = Date.now() + windowMs * 2 + 60 * 1000;
      let landed = false;
      while (Date.now() < deadline) {
        if (cancelled.current) return;
        await new Promise((r) => setTimeout(r, 4000));
        const st = await getQueueStatus(q.ticket);
        if (st.status === "submitted") {
          landed = true;
          break;
        }
        if (st.status === "error") {
          // A common cause is the room re-pinning its eligible set while the access waited (the proof was built
          // against the old snapshot), so point the reader at re-proving rather than showing a raw chain error.
          throw new Error(
            `${st.error || "the batched submission did not go through"}. If the room changed its members while you waited, check access again and prove once more.`,
          );
        }
      }
      if (!landed) throw new Error("your batched access has not landed yet; try Check access again shortly");

      // Re-read the live admission now that the grant exists; the reader can open below. (enrollState is
      // already "eligible" here, since that is the only branch that offers the prove step.)
      const acc = await sdk.canOpenDocument(room.trim(), doc.trim(), identity.accessor);
      setAccess(acc);
    } catch (e) {
      setProveErr(String((e as Error).message ?? e));
    } finally {
      setProveStage("idle");
      setProveStep("");
    }
  }

  // Release + open: the keepers release sealed shares only to a doc-admitted accessor; the SDK reconstructs K
  // (any 2 of 3) and AES-decrypts in the browser. The reader's recipient secret never leaves it.
  async function onOpen() {
    if (!identity) {
      setOpenErr("Check access first so your identity is derived.");
      return;
    }
    if (belowFloor) {
      setOpenErr(FLOOR_BLOCK_MSG);
      return;
    }
    setOpenErr(null);
    setOpened(null);
    setOpening(true);
    try {
      setOpened(
        await sdk.openCommitteeDocument(room.trim(), doc.trim(), identity.accessor, identity.recipientSecret, {
          minAnonSet: ANON_FLOOR,
        }),
      );
    } catch (e) {
      setOpenErr(String((e as Error).message ?? e));
    } finally {
      setOpening(false);
    }
  }

  return {
    // wallet
    connected,
    connect,
    walletStatus,
    deriving: ident.busy,
    drift: ident.drift,
    // committee + doc
    committee,
    committeeDoc,
    // anonymity meter + floor
    anonCount,
    belowFloor,
    // inputs
    room,
    setRoom,
    doc,
    setDoc,
    // check
    identity,
    access,
    enrollState,
    accessErr,
    checking,
    onCheck,
    // prove
    proveStage,
    proveStep,
    proveBy,
    proveErr,
    flushAt,
    onProve,
    // open
    opened,
    openErr,
    opening,
    onOpen,
  };
}
