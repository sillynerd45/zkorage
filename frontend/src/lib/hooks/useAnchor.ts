import { useCallback, useEffect, useState } from "react";
import {
  getDataroomRoom,
  createRoom,
  getDataroomDocuments,
  getMyRooms,
  getCommitteeInfo,
  dealSealed,
  committeeAnchor,
  type DataroomDoc,
  type MyRoom,
  type SubmitDocResp,
} from "@/lib/api";
import { useTxSigner, useWallet } from "@/lib/wallet/WalletContext";
import {
  DEMO_DATAROOM,
  recipientPublicKeyFromSecret,
  aeadSeal,
  randomKey,
  randomBytes,
  shamirSplit,
  sealShare,
  sealDocumentKey,
  sha256Hex,
  toHex,
  type OpenedDocument,
} from "zkorage-sdk";
import { useDataRoomIdentity } from "@/lib/hooks/useDataRoomIdentity";
import { type ClaimState } from "@/components/StatusBadge";
import { sdk, DEMO_RECIPIENT_SECRET } from "@/lib/sdk";
import { isHex32 } from "@/lib/format";

// base64 <-> bytes (chunked so a multi-MB blob doesn't blow the call stack on String.fromCharCode).
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// A file chosen in the Store flow, already read to base64 in the browser.
export type PickedFile = { name: string; type: string; size: number; b64: string };
// 8 MB raw is ~10.7 MB once base64-encoded, which stays under the backend's 12 MB JSON body limit.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// The store flow's phase, for the stepper. "room"/"key"/"anchor" each prompt the wallet (a Soroban tx for the
// room + the anchor, a SEP-53 message-sign for the room key); "encrypt" runs entirely in the browser. These
// are separate prompts by design: two Soroban contract calls can't share one transaction, the message-sign is
// not a transaction, and the wallet must sign so the room/doc stay owned by it (not the server).
export type StoreStage = "idle" | "room" | "key" | "encrypt" | "anchor" | "done";

// The Data Room stores a document one way: an anonymous, policy-gated committee document (Model B). A fresh
// per-doc key K (AES-256-GCM) encrypts the file IN THE BROWSER, K is split across the keeper committee, and
// only a sha256(ciphertext) commitment goes on-chain. Anyone who proves room membership can open it later,
// without revealing which member. The key and the plaintext never leave the browser in the clear.
export function useAnchor() {
  // --- store a shared document (browser dealer; no prover) ---
  // No default room: the field starts empty (placeholder-guided). The connected wallet's existing rooms are
  // offered as a picker in the Store form, so you name a new room or pick one you already own.
  const [roomLabel, setRoomLabel] = useState("");
  // The text input starts empty so its placeholder shows (like the Room field). Default store mode is "file".
  const [content, setContent] = useState("");
  // The Store form asks for ONE input at a time: a file or pasted text. `storeMode` is the explicit choice
  // (default "file"); switching modes preserves both inputs (an accidental tap is reversible), and submit
  // sends only the active mode's input. Picking/dropping a file snaps the mode to "file".
  const [storeMode, setStoreMode] = useState<"file" | "text">("file");
  const identity = useDataRoomIdentity();
  // On a successful shared (committee) store: the room/doc ids to open it from "Open a shared document".
  const [sharedResult, setSharedResult] = useState<{ roomId: string; docId: string } | null>(null);
  // A chosen file (PDF, image, any bytes). Read to base64 in the browser; the backend encrypts the bytes
  // exactly like text. Capped so the base64 body stays under the backend's JSON limit.
  const [file, setFileState] = useState<PickedFile | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [state, setState] = useState<ClaimState>("draft");
  const [resp, setResp] = useState<SubmitDocResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string>("");
  const [confirmAnchor, setConfirmAnchor] = useState(false);
  // The store flow's current phase, surfaced by the stepper so the owner knows what each wallet prompt is for.
  const [storeStage, setStoreStage] = useState<StoreStage>("idle");
  // A pre-submit validation message (missing room name / file / text / wallet), shown inline at the button
  // BEFORE the confirm dialog. Cleared automatically when the relevant input changes.
  const [storeErr, setStoreErr] = useState<string | null>(null);

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
  // Owner re-open of a committee doc via the escrow copy (no membership proof, no anonymity floor): the
  // decrypted result, the in-flight doc id, and any error. Cleared whenever the browsed room changes.
  const [ownerOpened, setOwnerOpened] = useState<{ docId: string; result: OpenedDocument } | null>(null);
  const [ownerOpenErr, setOwnerOpenErr] = useState<string | null>(null);
  const [ownerOpeningId, setOwnerOpeningId] = useState<string | null>(null);

  const refreshDocs = useCallback((room: string) => {
    setOwnerOpened(null); setOwnerOpenErr(null);
    if (!/^[0-9a-fA-F]{64}$/.test(room.trim())) { setDocs([]); return; }
    getDataroomDocuments(room.trim(), 0, 25).then((r) => setDocs(r.documents)).catch(() => setDocs([]));
  }, []);

  const loadMyRooms = useCallback((addr: string | null) => {
    if (!addr) { setMyRooms([]); return; }
    setRoomsLoading(true);
    getMyRooms(addr).then((r) => setMyRooms(r.rooms)).catch(() => setMyRooms([])).finally(() => setRoomsLoading(false));
  }, []);

  // "My rooms" follows the connected wallet (cleared on disconnect). Nothing seeded is auto-loaded, so a
  // fresh wallet starts empty: you only ever see rooms you own.
  useEffect(() => { loadMyRooms(connected ? address : null); }, [connected, address, loadMyRooms]);

  // Clear the pre-submit validation message as soon as the user fixes the offending input (or connects),
  // so a stale "name a room" doesn't linger after they've named one.
  useEffect(() => { setStoreErr(null); }, [roomLabel, content, file, storeMode, connected]);

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

  // Model B browser dealer: K is generated, the document encrypted, the key split, and every share + the
  // owner-escrow copy sealed ALL IN THIS BROWSER. The relay receives only ciphertext + sealed shares, so the
  // server never sees K or the plaintext. Then the owner signs put_committee_document. No slow prover.
  // Pre-submit validation: the room name + the active input (file or text) + a connected wallet must all be
  // present. Returns an error message, or null when the store is ready. Single source of truth for both the
  // button pre-check (requestStore) and onStoreShared's own guard.
  function validateStore(): string | null {
    if (!roomLabel.trim()) return "Name a room, or pick one you already own.";
    if (!connected || !address) return "Connect your wallet to store a document.";
    if (storeMode === "file" && !file) return "Choose a file to store, or switch to Text.";
    if (storeMode === "text" && !content.trim()) return "Paste some text to store, or switch to File.";
    return null;
  }

  // The "Store document" button: validate FIRST so a missing room/file/text is caught here, inline, and the
  // confirm dialog only opens when the inputs are ready (not after the user has committed in the dialog).
  function requestStore() {
    const err = validateStore();
    if (err) { setStoreErr(err); return; }
    setStoreErr(null);
    setConfirmAnchor(true);
  }

  async function onStoreShared() {
    // Defense-in-depth: requestStore already gated this, but re-check in case onStoreShared is reached another way.
    const invalid = validateStore();
    if (invalid) {
      setResp({ ok: false, error: invalid, dataroomId: "" });
      setState("rejected"); return;
    }
    setBusy(true); setResp(null); setSharedResult(null); setState("verifying"); setStoreStage("room");
    try {
      // 1) resolve the room's 32-byte id. The backend hashes a label deterministically, so `roomId` is present
      //    even before the room is on-chain (avoids a create→read propagation race). It binds the share +
      //    escrow tags and your room identity.
      setStep("Resolving the room…");
      const roomResp = await getDataroomRoom(roomLabel).catch(() => null);
      const roomIdHex = roomResp?.roomId;
      if (!roomIdHex || !isHex32(roomIdHex)) throw new Error("could not resolve the room id");

      // 2) the keeper committee + their static seal keys — checked BEFORE any wallet popup so a committee that
      //    is offline fails fast (no wasted signatures).
      setStep("Checking the keeper committee…");
      const info = await getCommitteeInfo();
      const sealedKeepers = info.keypers.filter((k) => k.ok && k.sealPub && k.keyperIndex);
      if (sealedKeepers.length < info.n) {
        throw new Error(`all ${info.n} keepers must be online with a seal key (got ${sealedKeepers.length})`);
      }

      // 3) create the room on-chain if it doesn't exist yet (your wallet signs + owns it).
      if (!roomResp?.room) {
        setStep("Creating the room (your wallet signs)…");
        const cr = await createRoom(roomLabel, signer).catch((e) => ({ ok: false, error: String((e as Error)?.message ?? e) }));
        if (!cr.ok) throw new Error((cr as { error?: string }).error || "could not create the room (the wallet signature is needed to own it)");
      }

      // 4) derive YOUR room identity — the owner-escrow copy is sealed to it so you can reopen on any device.
      setStoreStage("key");
      setStep("Deriving your room key…");
      const ident = await identity.derive(roomIdHex);
      if (!ident) throw new Error(identity.error || "could not derive your room identity");

      // 5) THE DEALER, in your browser: generate K, encrypt the file, split + seal — none of it leaves as plaintext.
      setStoreStage("encrypt");
      setStep("Encrypting and splitting the key in your browser…");
      const k = randomKey();
      const plaintext = storeMode === "file" && file ? b64ToBytes(file.b64) : new TextEncoder().encode(content);
      const blob = await aeadSeal(plaintext, k);
      const contentHash = sha256Hex(blob);
      const kCommitment = sha256Hex(k);
      const docIdHex = toHex(randomBytes(32));
      const shares = shamirSplit(k, info.threshold, info.n);
      const sealedShares = shares.map((sh) => {
        const keeper = sealedKeepers.find((kp) => kp.keyperIndex === sh.x);
        if (!keeper?.sealPub) throw new Error(`no seal key for keeper ${sh.x}`);
        const s = sealShare(sh.y, sh.x, keeper.sealPub, roomIdHex, docIdHex);
        return { keyperIndex: sh.x, eph_pub: s.ephPub, ct: s.ct, tag: s.tag };
      });
      const escrow = sealDocumentKey(k, ident.recipientPub, contentHash, roomIdHex, docIdHex);

      // 6) relay: ciphertext + sealed shares + the owner-escrow copy (the server never sees K).
      setStep("Uploading the encrypted file and sealed shares…");
      const dealt = await dealSealed({
        roomId: roomIdHex,
        docId: docIdHex,
        blobB64: bytesToB64(blob),
        kCommitment,
        sealedShares,
        escrow: { ephPub: escrow.ephPub, ct: escrow.ct, tag: escrow.tag, recipientPub: ident.recipientPub },
      });
      if (!dealt.ok || !dealt.blobPointer || !dealt.contentHash) throw new Error(dealt.error || "share distribution failed");

      // 7) anchor on-chain — your wallet signs put_committee_document.
      setStoreStage("anchor");
      setStep("Anchoring on Soroban (your wallet signs)…");
      const anchored = await committeeAnchor(
        { roomId: roomIdHex, docId: docIdHex, contentHash: dealt.contentHash, kCommitment, blobPointer: dealt.blobPointer },
        signer,
      );
      if (!anchored.ok) throw new Error(anchored.error || "anchoring failed");

      setResp({ ok: true, txHash: anchored.txHash, blobPointer: dealt.blobPointer, dataroomId: info.dataroomId ?? "" });
      setSharedResult({ roomId: roomIdHex, docId: docIdHex });
      setState("verified"); setStoreStage("done");
      loadMyRooms(connected ? address : null);
    } catch (e) {
      setResp({ ok: false, error: String((e as Error).message ?? e), dataroomId: "" });
      setState("failed"); setStoreStage("idle");
    } finally {
      setBusy(false);
      setStep("");
    }
  }

  // After a successful store, clear the document inputs + the verdict so the owner can store another doc in
  // the same room without the previous result lingering. The room stays selected (you usually file several
  // docs into one room); the wallet-derived room key is cached, so a follow-up store prompts once (anchor).
  function resetStore() {
    setFileState(null); setFileErr(null); setContent("");
    setResp(null); setSharedResult(null); setStep(""); setStoreErr(null);
    setState("draft"); setStoreStage("idle");
  }

  // Reopen a committee doc you OWN via the escrow copy (sealed to your wallet-derived room key) — no keepers,
  // no membership proof, no anonymity floor. Derives the room key once (cached for the session), then opens
  // client-side. faithful=false means this wallet did not store the doc (the escrow is not sealed to its key).
  async function openOwnerDoc(roomIdHex: string, docIdHex: string) {
    setOwnerOpenErr(null); setOwnerOpened(null); setOwnerOpeningId(docIdHex);
    try {
      const ident = await identity.derive(roomIdHex);
      if (!ident) throw new Error(identity.error || "could not derive your room key from the wallet");
      const result = await sdk.openCommitteeDocumentAsOwner(roomIdHex, docIdHex, ident.recipientSecret);
      if (!result.found) throw new Error("document not found on the public record");
      if (!result.faithful) {
        throw new Error("this document is not sealed to your wallet's room key, so you cannot reopen it here (it was stored by a different wallet, or your wallet's signing format changed)");
      }
      setOwnerOpened({ docId: docIdHex, result });
    } catch (e) {
      setOwnerOpenErr(String((e as Error).message ?? e));
    } finally {
      setOwnerOpeningId(null);
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
    state,
    resp,
    busy,
    step,
    storeStage,
    storeErr,
    requestStore,
    resetStore,
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
    onOpen,
    sealedToYou,
    onStoreShared,
    sharedResult,
    ownerOpened,
    ownerOpenErr,
    ownerOpeningId,
    openOwnerDoc,
    identityDrift: identity.drift,
  };
}
