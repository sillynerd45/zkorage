import { useEffect, useRef, useState } from "react";
import {
  getCommitteeInfo,
  getCommitteeDocument,
  getEnrollStatus,
  getEligible,
  proveAccess,
  requestAccess,
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
export type ProveStage = "idle" | "proving" | "requesting";

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

  // Prove membership ONCE: the witness (the reader's wallet-derived secrets) goes to the self-hosted prover,
  // which returns a Groth16 bundle; request_access then binds the reader's accessor + recipient key on-chain.
  // After this, opening any document in the room is instant (no re-proof).
  async function onProve() {
    if (!identity) return;
    if (belowFloor) {
      setProveErr(FLOOR_BLOCK_MSG);
      return;
    }
    setProveErr(null);
    setProveBy(null);
    setProveStep("Proving your membership (sha256-Merkle, nullifier, holder signature) on the self-hosted prover. This runs once for the room and can take a few minutes.");
    setProveStage("proving");
    try {
      cancelled.current = false;
      const pa = await proveAccess(
        room.trim(),
        identity.idSecret,
        identity.idTrapdoor,
        identity.accessorSeed,
        identity.recipientPub,
        ANON_FLOOR,
      );
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
      setProveStage("requesting");
      setProveStep("Recording your anonymous access on-chain (request_access).");
      const ra = await requestAccess(bundle);
      if (!ra.ok) throw new Error(ra.error || "request_access was rejected");
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
    onProve,
    // open
    opened,
    openErr,
    opening,
    onOpen,
  };
}
