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
} from "../../api";
import {
  DEMO_DATAROOM,
  DEMO_RECIPIENT_PUB,
  decodeDataroomSealJournal,
  recipientPublicKeyFromSecret,
  type OpenedDocument,
} from "zkorage-sdk";
import { ProofStatusBadge, ProveWait, VerdictMark, type ClaimState } from "../../StatusBadge";
import { ConfirmModal } from "../../components/ConfirmModal";
import { Disclosure, Hex } from "../../components/Disclosure";
import { GlossaryTip } from "../../components/GlossaryTip";
import { humanError } from "../../errors";
import { sdk, short, isHex32, explorer, DEMO_RECIPIENT_SECRET } from "./shared";

// DR1 — the data plane: encrypt a document (fresh per-doc key K, AES-256-GCM), store the ciphertext
// off-chain, prove the faithful seal of K to a recipient's x25519 key (bound to the content hash), and
// anchor only a sha256(ciphertext) commitment + the sealed-key disclosure on-chain. The recipient later
// recovers K with their key — entirely in the browser; the key never leaves it.
export default function AnchorRoute() {
  const [info, setInfo] = useState<DataroomInfoResp | null>(null);

  // --- upload / encrypt / anchor (the slow path: real proof) ---
  const [roomLabel, setRoomLabel] = useState("zkorage-dataroom-demo");
  const [content, setContent] = useState("Confidential term sheet — Series A, $4M at $20M pre. 🔒");
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
      // 1. ensure the room exists (create it if not — owned + paid for by the demo server key).
      setStep("Ensuring room exists…");
      const room = await getDataroomRoom(roomLabel).catch(() => null);
      if (!room?.room) await createRoom(roomLabel).catch(() => {});
      // 2. encrypt (fresh K, AES-256-GCM) + upload the ciphertext + enqueue the seal proof.
      setStep("Encrypting + uploading ciphertext, enqueuing the seal proof…");
      const pr = await proveSeal(roomLabel, content, recipientPub);
      if (!pr.jobId) throw new Error(pr.error || "prove-seal failed");
      const { jobId, roomId, docId, blobPointer } = pr;
      setStep("Proving (STARK → Groth16) on the self-hosted prover…");
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
    // The open panel needs raw 32-byte hex room/doc ids (not labels) — guard up front so a typo yields a
    // clean message instead of a cryptic RPC error from a truncated `Bytes`.
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

  return (
    <>
      {/* upload / encrypt / anchor */}
      <div className="card">
        <h2>Store a document <ProofStatusBadge state={state} /></h2>
        <p className="hint">Encrypt a document, keep the file private, and post only a tamper-evident <b>fingerprint</b><GlossaryTip term="fingerprint" /> to the public record. The file never leaves the prover in the clear; creating the proof takes a few minutes on the prover you run.</p>
        {/* DR1 engine rows (the sealing program + demo recipient key) — demoted behind a "Verify details"
            expander (UX research §12); you don't need them to store a document. */}
        <Disclosure
          toggleTestId="anchor-engine-details"
          summary={<>The cryptographic engine — the <b>pinned sealing program</b> and the <b>demo recipient key</b>. Expand to check them.</>}
        >
          {info?.dataroomImageId && <div className="row"><span className="k">Sealing program (pinned)</span><span className="v" data-testid="seal-image"><Hex value={info.dataroomImageId} chars={8} /></span></div>}
          {info?.recipientPub && <div className="row"><span className="k">Demo recipient</span><span className="v" data-testid="recipient-pub">x25519 <Hex value={info.recipientPub} chars={8} /></span></div>}
        </Disclosure>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>room</label>
          <input style={{ minWidth: 220 }} value={roomLabel} onChange={(e) => setRoomLabel(e.target.value)} aria-label="room" data-testid="room-label" />
          <label className="fld" style={{ margin: 0 }}>recipient's public key</label>
          <input style={{ minWidth: 300, fontFamily: "monospace", fontSize: 12 }} value={recipientPub} onChange={(e) => setRecipientPub(e.target.value)} aria-label="recipient pub" data-testid="recipient-input" />
        </div>
        <div className="btnrow" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
          <label className="fld" style={{ margin: 0 }}>document (private)</label>
          <textarea style={{ minWidth: 460, minHeight: 70, fontFamily: "inherit" }} value={content} onChange={(e) => setContent(e.target.value)} aria-label="document content" data-testid="doc-content" />
        </div>
        <div className="btnrow">
          <button onClick={() => setConfirmAnchor(true)} disabled={busy} data-testid="upload">
            {busy ? "Working…" : "Encrypt, prove & post"}
          </button>
        </div>
        <ConfirmModal
          open={confirmAnchor}
          title="Encrypt, prove & post this document?"
          tone="cost"
          confirmLabel="Yes, post it"
          onCancel={() => setConfirmAnchor(false)}
          onConfirm={() => { setConfirmAnchor(false); onUpload(); }}
        >
          <p style={{ margin: 0 }}>
            The document is encrypted and the key sealed to the recipient on the prover you run (the file
            never leaves it in the clear). Only an encrypted file + a tamper-evident fingerprint are posted —
            never the contents.
          </p>
        </ConfirmModal>
        {busy && step && <p className="hint" data-testid="upload-step">{step}</p>}
        <ProveWait state={state} proveBy={proveBy} privacy="The document plaintext stays on the self-hosted prover — only an encrypted blob + a tamper-evident commitment go on-chain." />

        {journal && (
          <div style={{ marginTop: 16 }}>
            <Disclosure
              toggleTestId="anchor-journal-details"
              detailsLabel="Inspect the public journal"
              summary={<>Posted — and note <b>the document key is absent</b>: only a fingerprint of the file + the sealed key go on the public record, never the contents or the key in the clear.</>}
            >
              <div className="row"><span className="k">kind</span><span className="v">{journal.claimType === 8 ? "Data-room seal" : `type ${journal.claimType}`}</span></div>
              <div className="row"><span className="k">room</span><span className="v">{short(journal.roomId, 8)}</span></div>
              <div className="row"><span className="k">doc</span><span className="v">{short(journal.docId, 8)}</span></div>
              <div className="row"><span className="k">file fingerprint</span><span className="v" data-testid="journal-content-hash"><Hex value={journal.contentHash} chars={8} /></span></div>
              <div className="row"><span className="k">recipient</span><span className="v">x25519 {short(journal.recipientPub, 8)}</span></div>
              <div className="row"><span className="k">sealed key (encrypted)</span><span className="v"><Hex value={journal.ct} label="ct" chars={8} /></span></div>
              <div className="row"><span className="k">document key</span><span className="v private" data-testid="k-private">private — sealed to the recipient; never on the public record in the clear</span></div>
            </Disclosure>
          </div>
        )}
      </div>

      {/* anchor verdict */}
      {resp && (
        <div className="card" data-testid="anchor-verdict-card">
          {resp.ok ? (
            <>
              <div className="verdict ok"><span className="badge"><VerdictMark ok /></span><span>Document posted to the public record — encrypted, sealed to the recipient</span></div>
              {resp.txHash && <div className="row"><span className="k">record entry</span><span className="v"><a href={explorer("tx", resp.txHash)} target="_blank" rel="noreferrer">{short(resp.txHash, 8)} ↗</a></span></div>}
              {resp.result && <div className="row"><span className="k">file fingerprint</span><span className="v">{short(resp.result.content_hash, 8)}</span></div>}
              {resp.blobPointer && <div className="row"><span className="k">stored file</span><span className="v" title={resp.blobPointer}>{short(resp.blobPointer, 14)}</span></div>}
            </>
          ) : (
            <>
              <div className="verdict err"><span className="badge"><VerdictMark ok={false} /></span><span>{state === "failed" ? "No proof produced" : "Rejected"}</span></div>
              <p className="err-text" data-testid="anchor-reject-reason">{humanError(resp.error, "dataroom")}</p>
            </>
          )}
        </div>
      )}

      {/* recipient open (key-free, client-side) */}
      <div className="card">
        <h2>Open a document <span className="demo-note">the recipient unlocks it with their key — in your browser</span></h2>
        <p className="hint">
          The recipient unlocks the document <b>with their private key</b>. The proof guarantees the key really
          is for <i>this</i> document, the encrypted file is fetched and re-checked against its fingerprint, and
          it's decrypted — <b>all in your browser</b> (your key never leaves it). The field is prefilled with the
          demo recipient's key; paste a different key to see it <b>refuse to open</b>.
        </p>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>room</label>
          <input style={{ minWidth: 300, fontFamily: "monospace", fontSize: 12 }} value={openRoom} onChange={(e) => setOpenRoom(e.target.value)} aria-label="open room" data-testid="open-room" />
          <label className="fld" style={{ margin: 0 }}>doc</label>
          <input style={{ minWidth: 300, fontFamily: "monospace", fontSize: 12 }} value={openDoc} onChange={(e) => setOpenDoc(e.target.value)} aria-label="open doc" data-testid="open-doc" />
        </div>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>recipient's private key (hex)</label>
          <input style={{ minWidth: 420, fontFamily: "monospace", fontSize: 12 }} value={openSecret} onChange={(e) => setOpenSecret(e.target.value)} aria-label="recipient secret" data-testid="open-secret" />
          <button onClick={onOpen} disabled={openBusy} data-testid="open-btn">{openBusy ? "Opening…" : "Open document"}</button>
        </div>
        <p className="hint" data-testid="open-secret-note"><span aria-hidden="true">🔑</span> Your private key stays in this browser — we never see it and <b>can't recover it for you</b>. The field is prefilled with the demo key; paste your own to open as yourself.</p>
        {sealedToYou && <p className="hint">your public key: <code>{short(sealedToYou, 8)}</code></p>}
        {opened && (
          <div data-testid="open-result" data-faithful={String(opened.faithful)} data-found={String(opened.found)} style={{ marginTop: 8 }}>
            {!opened.found ? (
              <div className="verdict err"><span className="badge"><VerdictMark ok={false} /></span><span>Document not found on the public record</span></div>
            ) : opened.faithful ? (
              <>
                <div className="verdict ok"><span className="badge"><VerdictMark ok /></span><span>Unlocked — this is provably the right file (it matched its fingerprint)</span></div>
                <div className="demo-note" style={{ marginTop: 8 }}>Decrypted document</div>
                <pre className="cli" data-testid="open-plaintext" style={{ whiteSpace: "pre-wrap" }}>{opened.plaintextUtf8 ?? `(binary, ${opened.plaintext?.length ?? 0} bytes)`}</pre>
              </>
            ) : (
              <div className="verdict err"><span className="badge"><VerdictMark ok={false} /></span><span data-testid="open-unfaithful">Won't open — wrong key (this document isn't sealed to you).</span></div>
            )}
          </div>
        )}
        {openErr && <p className="err-text" data-testid="open-error">{openErr}</p>}
      </div>

      {/* public document browser */}
      <div className="card">
        <h2>Documents <span className="demo-note">anyone can read the record · contents hidden</span></h2>
        <div className="btnrow" style={{ flexWrap: "wrap" }}>
          <label className="fld" style={{ margin: 0 }}>room</label>
          <input style={{ minWidth: 300, fontFamily: "monospace", fontSize: 12 }} value={browseRoom} onChange={(e) => setBrowseRoom(e.target.value)} aria-label="browse room" data-testid="browse-room" />
          <button onClick={() => refreshDocs(browseRoom)} data-testid="browse-btn">List documents</button>
        </div>
        {docs.length ? (
          <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="tbl" data-testid="dataroom-docs">
            <thead><tr><th>#</th><th>doc</th><th>file fingerprint</th><th>key</th><th>contents</th><th>recorded</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.index}>
                  <td>{d.index}</td>
                  <td title={d.doc_id}>{short(d.doc_id, 6)}</td>
                  <td title={d.content_hash}>{short(d.content_hash, 6)}</td>
                  <td title={d.recipient_pub}>x25519 {short(d.recipient_pub, 6)}</td>
                  <td className="private">encrypted</td>
                  <td>{d.ledger}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <p className="hint">No documents in this room yet.</p>
        )}
      </div>
    </>
  );
}
