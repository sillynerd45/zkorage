import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDataroomInfo,
  getDataroomRoom,
  createRoom,
  proveSeal,
  submitDocument,
  getProveStatus,
  getDataroomDocuments,
  getMyRooms,
  type DataroomInfoResp,
  type DataroomDoc,
  type MyRoom,
  type SubmitDocResp,
  type Bundle,
} from "@/lib/api";
import { useTxSigner, useWallet } from "@/lib/wallet/WalletContext";
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

// A file chosen in the Store flow, already read to base64 in the browser.
export type PickedFile = { name: string; type: string; size: number; b64: string };
// 8 MB raw is ~10.7 MB once base64-encoded, which stays under the backend's 12 MB JSON body limit.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// DR1 (the data plane): encrypt a document (fresh per-doc key K, AES-256-GCM), store the ciphertext
// off-chain, prove the faithful seal of K to a recipient's x25519 key (bound to the content hash), and
// anchor only a sha256(ciphertext) commitment plus the sealed-key disclosure on-chain. The recipient later
// recovers K with their key. This happens entirely in the browser, and the key never leaves it.
export function useAnchor() {
  const [info, setInfo] = useState<DataroomInfoResp | null>(null);

  // --- upload / encrypt / anchor (the slow path: real proof) ---
  // No default room: the field starts empty (placeholder-guided). The connected wallet's existing rooms are
  // offered as a picker in the Store form, so you name a new room or pick one you already own.
  const [roomLabel, setRoomLabel] = useState("");
  const [content, setContent] = useState("Confidential term sheet. Series A, $4M at $20M pre.");
  // The Store form asks for ONE input at a time: a file or pasted text. `storeMode` is the explicit choice
  // (default "file"); switching modes preserves both inputs (an accidental tap is reversible), and submit
  // sends only the active mode's input. Picking/dropping a file snaps the mode to "file".
  const [storeMode, setStoreMode] = useState<"file" | "text">("file");
  // A chosen file (PDF, image, any bytes). Read to base64 in the browser; the backend encrypts the bytes
  // exactly like text. Capped so the base64 body stays under the backend's JSON limit.
  const [file, setFileState] = useState<PickedFile | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
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

  // --- "my documents" browser: rooms the connected wallet owns ON-CHAIN ---
  const signer = useTxSigner();
  const { address, connected } = useWallet();
  const [browseRoom, setBrowseRoom] = useState("");
  const [docs, setDocs] = useState<DataroomDoc[]>([]);
  const [myRooms, setMyRooms] = useState<MyRoom[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);

  const refreshDocs = useCallback((room: string) => {
    if (!/^[0-9a-fA-F]{64}$/.test(room.trim())) { setDocs([]); return; }
    getDataroomDocuments(room.trim(), 0, 25).then((r) => setDocs(r.documents)).catch(() => setDocs([]));
  }, []);

  const loadMyRooms = useCallback((addr: string | null) => {
    if (!addr) { setMyRooms([]); return; }
    setRoomsLoading(true);
    getMyRooms(addr).then((r) => setMyRooms(r.rooms)).catch(() => setMyRooms([])).finally(() => setRoomsLoading(false));
  }, []);

  useEffect(() => {
    getDataroomInfo().then(setInfo).catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // "My rooms" follows the connected wallet (cleared on disconnect). Nothing seeded is auto-loaded, so a
  // fresh wallet starts empty: you only ever see rooms you own.
  useEffect(() => { loadMyRooms(connected ? address : null); }, [connected, address, loadMyRooms]);

  // Read a chosen file to base64 in the browser (FileReader handles large inputs without blowing the call
  // stack). Enforce the size cap up front so a too-big file fails clearly, not as a 413 mid-upload.
  const pickFile = useCallback((f: File | null) => {
    setFileErr(null);
    if (!f) { setFileState(null); return; }
    if (f.size > MAX_UPLOAD_BYTES) {
      setFileState(null);
      setFileErr(`That file is ${(f.size / 1024 / 1024).toFixed(1)} MB. The demo cap is 8 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setFileErr("Could not read that file.");
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const b64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : "";
      setFileState({ name: f.name, type: f.type || "application/octet-stream", size: f.size, b64 });
      // Picking or dropping a file is an unambiguous "use a file" signal: snap to file mode (any typed text
      // stays in state, just hidden, so the switch is reversible).
      setStoreMode("file");
    };
    reader.readAsDataURL(f);
  }, []);
  const clearFile = useCallback(() => { setFileState(null); setFileErr(null); }, []);

  const journal = bundle?.journal ? decodeDataroomSealJournal(bundle.journal) : null;

  async function onAnchor(b: Bundle, blobPointer: string, roomId: string, docId: string) {
    setState("verifying");
    setStep("Anchoring on Soroban (put_document)…");
    try {
      const r = await submitDocument(b, blobPointer, signer);
      setResp(r);
      setState(r.ok ? "verified" : "rejected");
      if (r.ok) {
        // Point the open panel + the browser at the freshly-anchored document, and refresh "my rooms" so the
        // room you just created (and own) appears in Browse.
        setOpenRoom(roomId); setOpenDoc(docId); setBrowseRoom(roomId); refreshDocs(roomId);
        loadMyRooms(connected ? address : null);
      }
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), dataroomId: info?.dataroomId ?? "" });
      setState("rejected");
    } finally { setBusy(false); setStep(""); }
  }

  async function onUpload() {
    // Need a room to store into (the field has no default now): name a new one or pick an existing one.
    if (!roomLabel.trim()) {
      setResp({ ok: false, error: "Name a room, or pick one you already own.", dataroomId: "" });
      setState("rejected"); setBundle(null);
      return;
    }
    // Fail fast (and clearly) on a malformed recipient pubkey before the multi-minute proof path.
    if (recipientPub.trim() && !isHex32(recipientPub)) {
      setResp({ ok: false, error: "recipient x25519 pub must be 32-byte hex (64 hex chars)", dataroomId: "" });
      setState("rejected"); setBundle(null);
      return;
    }
    // Need something to store in the ACTIVE mode (the other mode's input is ignored on submit).
    if (storeMode === "file" && !file) {
      setResp({ ok: false, error: "Choose a file to store, or switch to Text.", dataroomId: "" });
      setState("rejected"); setBundle(null);
      return;
    }
    if (storeMode === "text" && !content.trim()) {
      setResp({ ok: false, error: "Paste some text to store, or switch to File.", dataroomId: "" });
      setState("rejected"); setBundle(null);
      return;
    }
    if (pollRef.current) clearInterval(pollRef.current);
    setBusy(true); setResp(null); setBundle(null); setProveBy(null); setState("proving");
    try {
      // 1. ensure the room exists (create it if not; it is owned and paid for by the demo server key).
      setStep("Making sure the room exists…");
      const room = await getDataroomRoom(roomLabel).catch(() => null);
      if (!room?.room) {
        // With a wallet connected, the room is created ON-CHAIN owned by the wallet (it signs create_room),
        // so it shows up under "your documents". No wallet → the server relay owns it.
        const cr = await createRoom(roomLabel, signer).catch((e) => ({ ok: false, error: String((e as Error)?.message ?? e) }));
        if (signer && !cr.ok) throw new Error(cr.error || "could not create the room (the wallet signature is needed to own it)");
      }
      // 2. encrypt (fresh K, AES-256-GCM), upload the ciphertext, and enqueue the seal proof.
      setStep("Encrypting and uploading the ciphertext, then queuing the seal proof…");
      const pr = await proveSeal(
        roomLabel,
        storeMode === "file" && file ? { contentB64: file.b64 } : { content },
        recipientPub,
      );
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
    storeMode,
    setStoreMode,
    file,
    pickFile,
    clearFile,
    fileErr,
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
    myRooms,
    roomsLoading,
    loadMyRooms,
    connected,
    address,
    journal,
    onUpload,
    onOpen,
    sealedToYou,
  };
}
