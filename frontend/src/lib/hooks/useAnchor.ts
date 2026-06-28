import { useCallback, useEffect, useRef, useState } from "react";
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
import { makeOpenCache } from "@/lib/dataroom/openCache";
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

// Module-level caches for the "My files" browser, keyed so leaving and returning to Documents repaints the
// room list, the selected room, and its document list at once, then a background refresh swaps in any change.
// They survive the page unmount within one app session (a full browser reload clears them) and only ever hold
// public on-chain data (room records + document records), never a key or a secret. This mirrors the bonded
// locks cache in useBonded.
const myRoomsCache = new Map<string, MyRoom[]>(); // keyed by wallet address
// Keyed by room id (trimmed); grows with the number of distinct rooms browsed this session (cleared on reload).
const docsCache = new Map<string, DataroomDoc[]>();
const lastBrowseCache = new Map<string, string>(); // keyed by wallet address -> last selected room id
// Decrypted owner-opened committee docs + which My-files rows are expanded, per room, so they survive a submenu
// switch (which unmounts the panel). Memory-only (decrypted plaintext is sensitive); a reload clears it.
const ownerOpenCache = makeOpenCache<OpenedDocument>();

// A background refresh that found nothing new should not re-render the list, so compare before swapping. Both
// are flat records of primitives, so a stable-shape JSON compare is sufficient (matching useBonded).
const sameDocs = (a: DataroomDoc[], b: DataroomDoc[]) =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
const sameRooms = (a: MyRoom[], b: MyRoom[]) =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

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
  // Seed from the module caches so leaving and returning to Documents repaints at once (the selected room and
  // its document list survive the unmount), then a background refresh swaps in any on-chain change.
  const seededRoom = connected && address ? lastBrowseCache.get(address) ?? "" : "";
  const [browseRoom, setBrowseRoom] = useState(seededRoom);
  const [docs, setDocs] = useState<DataroomDoc[]>(seededRoom ? docsCache.get(seededRoom) ?? [] : []);
  // docsLoading = the COLD path (fetching a room's docs with nothing cached -> skeleton). docsRefreshing = the
  // WARM path (refreshing the already-painted cached docs in the background -> the thin refresh bar).
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsRefreshing, setDocsRefreshing] = useState(false);
  const [myRooms, setMyRooms] = useState<MyRoom[]>(connected && address ? myRoomsCache.get(address) ?? [] : []);
  const [roomsLoading, setRoomsLoading] = useState(false); // cold: loading the room list with nothing cached
  const [roomsRefreshing, setRoomsRefreshing] = useState(false); // warm: refreshing the cached room list
  // The most recently requested browse room, so a slow response for room A cannot overwrite room B's docs.
  const docsReq = useRef(seededRoom);
  // Owner re-open of committee docs via the escrow copy (no membership proof, no anonymity floor). Per document
  // now, so several rows can stay open at once (expandable cards, like the Open tab): the decrypted result map,
  // a per-doc error map, which rows are expanded, and the in-flight doc id. Restored from ownerOpenCache when a
  // room is selected, so they survive a submenu switch.
  const [ownerOpenedDocs, setOwnerOpenedDocs] = useState<Record<string, OpenedDocument>>(() =>
    seededRoom ? ownerOpenCache.get(address ?? "", seededRoom).opened : {},
  );
  const [ownerOpenErrors, setOwnerOpenErrors] = useState<Record<string, string>>({});
  const [ownerExpanded, setOwnerExpanded] = useState<string[]>(() =>
    seededRoom ? ownerOpenCache.get(address ?? "", seededRoom).expanded : [],
  );
  const [ownerOpeningId, setOwnerOpeningId] = useState<string | null>(null);

  // Load a room's documents: paint the cached list at once when we have one (then refresh in the background),
  // otherwise show the skeleton while the first read runs. A race guard (docsReq) drops a stale response so
  // clicking room B while room A is still loading never shows A's documents under B.
  const refreshDocs = useCallback((room: string) => {
    const r = room.trim();
    docsReq.current = r;
    if (!/^[0-9a-fA-F]{64}$/.test(r)) { setDocs([]); setDocsLoading(false); setDocsRefreshing(false); return; }
    const cached = docsCache.get(r);
    if (cached) { setDocs(cached); setDocsLoading(false); setDocsRefreshing(true); }
    else { setDocs([]); setDocsLoading(true); setDocsRefreshing(false); }
    getDataroomDocuments(r, 0, 25)
      .then((res) => {
        docsCache.set(r, res.documents);
        if (docsReq.current !== r) return; // a newer room was selected; ignore this stale response
        setDocs((prev) => (sameDocs(prev, res.documents) ? prev : res.documents));
      })
      .catch(() => { if (docsReq.current === r && !cached) setDocs([]); }) // keep the cached list on a refresh error
      .finally(() => { if (docsReq.current === r) { setDocsLoading(false); setDocsRefreshing(false); } });
  }, []);

  // Select a room in the My files browser: remember it (so it is restored on return), restore its opened docs +
  // expanded rows from the cache (survives a submenu switch), and load its documents.
  const selectBrowseRoom = useCallback((room: string) => {
    setBrowseRoom(room);
    if (address) lastBrowseCache.set(address, room);
    const c = ownerOpenCache.get(address ?? "", room);
    setOwnerOpenedDocs(c.opened);
    setOwnerExpanded(c.expanded);
    setOwnerOpenErrors({});
    refreshDocs(room);
  }, [address, refreshDocs]);

  // Load the rooms the wallet owns: paint the cached list at once when we have one (then refresh in the
  // background), otherwise show the skeleton while the first read runs.
  const loadMyRooms = useCallback((addr: string | null) => {
    if (!addr) { setMyRooms([]); setRoomsLoading(false); setRoomsRefreshing(false); return; }
    const cached = myRoomsCache.get(addr);
    if (cached) { setMyRooms(cached); setRoomsLoading(false); setRoomsRefreshing(true); }
    else { setRoomsLoading(true); setRoomsRefreshing(false); }
    getMyRooms(addr)
      .then((r) => { myRoomsCache.set(addr, r.rooms); setMyRooms((prev) => (sameRooms(prev, r.rooms) ? prev : r.rooms)); })
      .catch(() => { if (!cached) setMyRooms([]); }) // keep the cached list on a refresh error
      .finally(() => { setRoomsLoading(false); setRoomsRefreshing(false); });
  }, []);

  // "My rooms" follows the connected wallet (cleared on disconnect). Nothing seeded is auto-loaded beyond the
  // wallet's own rooms, so a fresh wallet starts empty. On connect/return, restore the last browsed room so
  // its documents repaint from cache instead of forcing a re-pick.
  useEffect(() => {
    loadMyRooms(connected ? address : null);
    // Restore the last-browsed room only if the wallet still owns it (loadMyRooms seeds the cache
    // synchronously above), so a room that was removed never restores as a phantom selection.
    const restored = connected && address ? lastBrowseCache.get(address) ?? "" : "";
    const owned = connected && address ? (myRoomsCache.get(address) ?? []).some((r) => r.roomId === restored) : false;
    const finalRoom = owned ? restored : "";
    setBrowseRoom(finalRoom);
    if (finalRoom) {
      const c = ownerOpenCache.get(address ?? "", finalRoom);
      setOwnerOpenedDocs(c.opened);
      setOwnerExpanded(c.expanded);
      setOwnerOpenErrors({});
      refreshDocs(finalRoom);
    } else {
      docsReq.current = "";
      setDocs([]);
      setDocsLoading(false);
      setDocsRefreshing(false);
      setOwnerOpenedDocs({});
      setOwnerExpanded([]);
    }
  }, [connected, address, loadMyRooms, refreshDocs]);

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
    setOwnerOpenErrors((prev) => { if (!(docIdHex in prev)) return prev; const n = { ...prev }; delete n[docIdHex]; return n; });
    setOwnerOpeningId(docIdHex);
    try {
      const ident = await identity.derive(roomIdHex);
      if (!ident) throw new Error(identity.error || "could not derive your room key from the wallet");
      const result = await sdk.openCommitteeDocumentAsOwner(roomIdHex, docIdHex, ident.recipientSecret);
      if (!result.found) throw new Error("document not found on the public record");
      if (!result.faithful) {
        throw new Error("this document is not sealed to your wallet's room key, so you cannot reopen it here (it was stored by a different wallet, or your wallet's signing format changed)");
      }
      setOwnerOpenedDocs((prev) => { const next = { ...prev, [docIdHex]: result }; ownerOpenCache.setOpened(address ?? "", roomIdHex, next); return next; });
    } catch (e) {
      setOwnerOpenErrors((prev) => ({ ...prev, [docIdHex]: String((e as Error).message ?? e) }));
    } finally {
      setOwnerOpeningId(null);
    }
  }

  // Expand or collapse a My-files row. Expanding an un-opened committee doc opens it (owner escrow, no keepers,
  // no membership proof); collapsing keeps the cached content, so re-expanding is instant. Several stay open.
  function toggleOwnerDoc(roomIdHex: string, docIdHex: string) {
    const wasOpen = ownerExpanded.includes(docIdHex);
    setOwnerExpanded((prev) => {
      const next = wasOpen ? prev.filter((d) => d !== docIdHex) : [...prev, docIdHex];
      ownerOpenCache.setExpanded(address ?? "", roomIdHex, next);
      return next;
    });
    if (wasOpen) return;
    if (ownerOpenedDocs[docIdHex] || ownerOpenErrors[docIdHex]) return; // a cached result / error renders in the row
    void openOwnerDoc(roomIdHex, docIdHex);
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
    selectBrowseRoom,
    docs,
    docsLoading,
    docsRefreshing,
    refreshDocs,
    myRooms,
    roomsLoading,
    roomsRefreshing,
    loadMyRooms,
    connected,
    address,
    onOpen,
    sealedToYou,
    onStoreShared,
    sharedResult,
    ownerOpenedDocs,
    ownerOpenErrors,
    ownerExpanded,
    ownerOpeningId,
    openOwnerDoc,
    toggleOwnerDoc,
    identityDrift: identity.drift,
  };
}
