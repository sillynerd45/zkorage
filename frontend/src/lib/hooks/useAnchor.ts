import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDataroomInfo,
  getDataroomRoom,
  createRoom,
  proveSeal,
  submitDocument,
  getProveStatus,
  getDataroomDocuments,
  type DataroomInfoResp,
  type DataroomDoc,
  type SubmitDocResp,
  type Bundle,
} from "@/lib/api";
import {
  DEMO_DATAROOM,
  DEMO_RECIPIENT_PUB,
  decodeDataroomSealJournal,
  recipientPublicKeyFromSecret,
  type OpenedDocument,
} from "zkorage-sdk";
import { type ClaimState } from "@/components/StatusBadge";
import { sdk, DEMO_RECIPIENT_SECRET } from "@/lib/sdk";
import { isHex32 } from "@/lib/format";

// DR1 (the data plane): encrypt a document (fresh per-doc key K, AES-256-GCM), store the ciphertext
// off-chain, prove the faithful seal of K to a recipient's x25519 key (bound to the content hash), and
// anchor only a sha256(ciphertext) commitment plus the sealed-key disclosure on-chain. The recipient later
// recovers K with their key. This happens entirely in the browser, and the key never leaves it.
export function useAnchor() {
  const [info, setInfo] = useState<DataroomInfoResp | null>(null);

  // --- upload / encrypt / anchor (the slow path: real proof) ---
  const [roomLabel, setRoomLabel] = useState("zkorage-dataroom-demo");
  const [content, setContent] = useState("Confidential term sheet. Series A, $4M at $20M pre. 🔒");
  const [recipientPub, setRecipientPub] = useState(DEMO_RECIPIENT_PUB);
  const [state, setState] = useState<ClaimState>("draft");
  const [proveBy, setProveBy] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [resp, setResp] = useState<SubmitDocResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string>("");
  const [confirmAnchor, setConfirmAnchor] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- recipient open (key-free, client-side via the SDK) ---
  const [openRoom, setOpenRoom] = useState(DEMO_DATAROOM.roomId);
  const [openDoc, setOpenDoc] = useState(DEMO_DATAROOM.docId);
  const [openSecret, setOpenSecret] = useState(DEMO_RECIPIENT_SECRET);
  const [opened, setOpened] = useState<OpenedDocument | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [openBusy, setOpenBusy] = useState(false);

  // --- public document browser ---
  const [browseRoom, setBrowseRoom] = useState(DEMO_DATAROOM.roomId);
  const [docs, setDocs] = useState<DataroomDoc[]>([]);

  const refreshDocs = useCallback((room: string) => {
    if (!/^[0-9a-fA-F]{64}$/.test(room.trim())) { setDocs([]); return; }
    getDataroomDocuments(room.trim(), 0, 25).then((r) => setDocs(r.documents)).catch(() => setDocs([]));
  }, []);

  useEffect(() => {
    getDataroomInfo().then(setInfo).catch(() => {});
    refreshDocs(DEMO_DATAROOM.roomId);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refreshDocs]);

  const journal = bundle?.journal ? decodeDataroomSealJournal(bundle.journal) : null;

  async function onAnchor(b: Bundle, blobPointer: string, roomId: string, docId: string) {
    setState("verifying");
    setStep("Anchoring on Soroban (put_document)…");
    try {
      const r = await submitDocument(b, blobPointer);
      setResp(r);
      setState(r.ok ? "verified" : "rejected");
      if (r.ok) {
        // Point the open panel + the browser at the freshly-anchored document.
        setOpenRoom(roomId); setOpenDoc(docId); setBrowseRoom(roomId); refreshDocs(roomId);
      }
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), dataroomId: info?.dataroomId ?? "" });
      setState("rejected");
    } finally { setBusy(false); setStep(""); }
  }

  async function onUpload() {
    // Fail fast (and clearly) on a malformed recipient pubkey before the multi-minute proof path.
    if (recipientPub.trim() && !isHex32(recipientPub)) {
      setResp({ ok: false, error: "recipient x25519 pub must be 32-byte hex (64 hex chars)", dataroomId: "" });
      setState("rejected"); setBundle(null);
      return;
    }
    if (pollRef.current) clearInterval(pollRef.current);
    setBusy(true); setResp(null); setBundle(null); setProveBy(null); setState("proving");
    try {
      // 1. ensure the room exists (create it if not; it is owned and paid for by the demo server key).
      setStep("Making sure the room exists…");
      const room = await getDataroomRoom(roomLabel).catch(() => null);
      if (!room?.room) await createRoom(roomLabel).catch(() => {});
      // 2. encrypt (fresh K, AES-256-GCM), upload the ciphertext, and enqueue the seal proof.
      setStep("Encrypting and uploading the ciphertext, then queuing the seal proof…");
      const pr = await proveSeal(roomLabel, content, recipientPub);
      if (!pr.jobId) throw new Error(pr.error || "prove-seal failed");
      const { jobId, roomId, docId, blobPointer } = pr;
      setStep("Proving (STARK then Groth16) on the self-hosted prover…");
      // 3. poll for the proof, then anchor.
      pollRef.current = setInterval(async () => {
        try {
          const s = await getProveStatus(jobId);
          setProveBy(s.by ?? null);
          if (s.status === "done" && s.bundle) {
            if (pollRef.current) clearInterval(pollRef.current);
            setBundle(s.bundle);
            setState("proved");
            onAnchor(s.bundle, blobPointer, roomId, docId);
          } else if (s.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            setResp({ ok: false, error: s.error || "proving failed", dataroomId: "" });
            setState("failed"); setBusy(false); setStep("");
          }
        } catch { /* keep polling */ }
      }, 4000);
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), dataroomId: "" });
      setState("failed"); setBusy(false); setStep("");
    }
  }

  async function onOpen() {
    setOpenErr(null); setOpened(null);
    // The open panel needs raw 32-byte hex room/doc ids (not labels), so guard up front. That way a typo
    // yields a clean message instead of a cryptic RPC error from a truncated `Bytes`.
    if (!isHex32(openRoom) || !isHex32(openDoc)) {
      setOpenErr("room and doc must each be 32-byte hex (64 hex chars)");
      return;
    }
    setOpenBusy(true);
    try {
      const secret = (openSecret.trim() || DEMO_RECIPIENT_SECRET).toLowerCase();
      const res = await sdk.openDocument(openRoom.trim(), openDoc.trim(), secret);
      setOpened(res);
    } catch (e) {
      setOpenErr(String((e as Error).message ?? e));
    } finally { setOpenBusy(false); }
  }

  const sealedToYou = (() => {
    try { return recipientPublicKeyFromSecret((openSecret.trim() || DEMO_RECIPIENT_SECRET).toLowerCase()); }
    catch { return ""; }
  })();

  return {
    info,
    roomLabel,
    setRoomLabel,
    content,
    setContent,
    recipientPub,
    setRecipientPub,
    state,
    proveBy,
    bundle,
    resp,
    busy,
    step,
    confirmAnchor,
    setConfirmAnchor,
    openRoom,
    setOpenRoom,
    openDoc,
    setOpenDoc,
    openSecret,
    setOpenSecret,
    opened,
    openErr,
    openBusy,
    browseRoom,
    setBrowseRoom,
    docs,
    refreshDocs,
    journal,
    onUpload,
    onOpen,
    sealedToYou,
  };
}
