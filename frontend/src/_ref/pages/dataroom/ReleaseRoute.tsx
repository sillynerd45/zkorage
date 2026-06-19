import { useEffect, useState } from "react";
import { VerdictMark } from "../../StatusBadge";
import {
  getCommitteeInfo,
  getCommitteeDocument,
  type CommitteeInfoResp,
  type CommitteeDoc,
} from "../../api";
import { DEMO_DATAROOM_COMMITTEE, type OpenedCommitteeDocument } from "zkorage-sdk";
import { Disclosure, Hex } from "../../components/Disclosure";
import { GlossaryTip } from "../../components/GlossaryTip";
import { sdk, isHex32, DEMO_RECIPIENT_SECRET } from "./shared";

// DR3 — threshold-ECIES committee (key release). A per-doc key K is Shamir-split 2-of-3 across an
// independent keyper committee; the recipient collects ≥ 2 sealed shares and reconstructs K + decrypts
// entirely in the browser. The recipient secret never leaves it.
export default function ReleaseRoute() {
  const [committee, setCommittee] = useState<CommitteeInfoResp | null>(null);
  const [committeeDoc, setCommitteeDoc] = useState<CommitteeDoc | null>(null);
  const [dr3Room, setDr3Room] = useState(DEMO_DATAROOM_COMMITTEE.roomId);
  const [dr3Doc, setDr3Doc] = useState(DEMO_DATAROOM_COMMITTEE.docId);
  const [dr3Accessor, setDr3Accessor] = useState(DEMO_DATAROOM_COMMITTEE.accessor);
  const [dr3Secret, setDr3Secret] = useState(DEMO_RECIPIENT_SECRET);
  const [dr3Opened, setDr3Opened] = useState<OpenedCommitteeDocument | null>(null);
  const [dr3OpenErr, setDr3OpenErr] = useState<string | null>(null);
  const [dr3Busy, setDr3Busy] = useState(false);

  useEffect(() => {
    getCommitteeInfo().then(setCommittee).catch(() => {});
    getCommitteeDocument(DEMO_DATAROOM_COMMITTEE.roomId, DEMO_DATAROOM_COMMITTEE.docId)
      .then((r) => setCommitteeDoc(r.document))
      .catch(() => {});
  }, []);

  // DR3 — collect the keyper committee's sealed shares for the granted accessor, then reconstruct K (2-of-3)
  // and decrypt — ENTIRELY IN THE BROWSER via the SDK. The recipient x25519 secret never leaves the browser:
  // the backend aggregator only relays SEALED shares (it never sees the secret), and the
  // open + Lagrange-reconstruct + AES-GCM decrypt all run client-side in openCommitteeDocument.
  async function onCommitteeOpen() {
    setDr3OpenErr(null); setDr3Opened(null);
    if (!isHex32(dr3Room) || !isHex32(dr3Doc) || !isHex32(dr3Accessor)) {
      setDr3OpenErr("room, doc, and accessor must each be 32-byte hex (64 hex chars)");
      return;
    }
    setDr3Busy(true);
    try {
      const secret = (dr3Secret.trim() || DEMO_RECIPIENT_SECRET).toLowerCase();
      const res = await sdk.openCommitteeDocument(dr3Room.trim(), dr3Doc.trim(), dr3Accessor.trim(), secret);
      setDr3Opened(res);
    } catch (e) {
      setDr3OpenErr(String((e as Error).message ?? e));
    } finally { setDr3Busy(false); }
  }

  return (
    <div className="card" data-testid="dr3-card" style={{ borderColor: "var(--violet)" }}>
      <h2>Release the document key <span className="demo-note">split among 3 keepers <span aria-hidden="true">⚠️</span></span></h2>
      <p className="hint">
        A document's key is <b>split into 3 parts</b><GlossaryTip term="split key" /> held by separate
        <b> keepers</b> — <b>no single keeper can open the file; any 2 together can</b>. Each keeper watches the
        public record and releases its part <b>only to whoever won anonymous entry</b>, locked to that person's
        key. You collect 2 parts, <b>rebuild the key and decrypt — entirely in your browser</b> (your private
        key never leaves it; the keepers only ever pass <i>sealed</i> parts). Remove this and you'd be back to
        one server holding the whole key; the private proof still decides <i>who</i> gets in.
      </p>

      {/* committee status + doc commitments — demoted behind a "Verify details" expander (UX research §12) */}
      <Disclosure
        toggleTestId="dr3-engine-details"
        summary={<>The <b>3 keepers</b> and this document's fingerprints. Expand to see which keepers are online and check the key/file fingerprints.</>}
      >
        <div className="row"><span className="k">Keepers</span><span className="v" data-testid="dr3-committee">{committee ? `${committee.online}/${committee.n} keepers online · threshold ${committee.threshold}` : "—"}</span></div>
        {committee?.keypers?.map((kp) => (
          <div className="row" key={kp.endpoint}><span className="k">keeper {kp.keyperIndex ?? "?"}</span><span className="v" data-testid={`dr3-keyper-${kp.keyperIndex ?? 0}`}>{kp.ok ? `online · ${kp.shares ?? 0} part(s)` : "offline"}</span></div>
        ))}
        <div className="row"><span className="k">Demo doc file fingerprint</span><span className="v" data-testid="dr3-content-hash">{committeeDoc?.content_hash ? <Hex value={committeeDoc.content_hash} chars={8} /> : "—"}</span></div>
        <div className="row"><span className="k">Demo doc key fingerprint</span><span className="v" data-testid="dr3-k-commitment">{committeeDoc?.k_commitment ? <>sha256(K) <Hex value={committeeDoc.k_commitment} chars={8} /></> : "—"}</span></div>
      </Disclosure>

      {/* reconstruct & open (key-free, in-browser) */}
      <h3 style={{ marginTop: 18, marginBottom: 6 }}>Collect the parts, rebuild the key &amp; open <span className="demo-note">any 2 of 3 · in your browser</span></h3>
      <div className="btnrow" style={{ flexWrap: "wrap" }}>
        <label className="fld" style={{ margin: 0 }}>room</label>
        <input style={{ minWidth: 260, fontFamily: "monospace", fontSize: 12 }} value={dr3Room} onChange={(e) => setDr3Room(e.target.value)} aria-label="dr3 room" data-testid="dr3-room" />
        <label className="fld" style={{ margin: 0 }}>doc</label>
        <input style={{ minWidth: 260, fontFamily: "monospace", fontSize: 12 }} value={dr3Doc} onChange={(e) => setDr3Doc(e.target.value)} aria-label="dr3 doc" data-testid="dr3-doc" />
      </div>
      <div className="btnrow" style={{ flexWrap: "wrap" }}>
        <label className="fld" style={{ margin: 0 }}>your stand-in ID (admitted)</label>
        <input style={{ minWidth: 300, fontFamily: "monospace", fontSize: 12 }} value={dr3Accessor} onChange={(e) => setDr3Accessor(e.target.value)} aria-label="dr3 accessor" data-testid="dr3-accessor-input" />
      </div>
      <div className="btnrow" style={{ flexWrap: "wrap" }}>
        <label className="fld" style={{ margin: 0 }}>your private key (hex)</label>
        <input style={{ minWidth: 420, fontFamily: "monospace", fontSize: 12 }} value={dr3Secret} onChange={(e) => setDr3Secret(e.target.value)} aria-label="dr3 recipient secret" data-testid="dr3-secret" />
        <button onClick={onCommitteeOpen} disabled={dr3Busy} data-testid="dr3-open-btn">{dr3Busy ? "Rebuilding…" : "Collect parts, rebuild & open"}</button>
      </div>
      <p className="hint" data-testid="dr3-secret-note"><span aria-hidden="true">🔑</span> Your private key stays in this browser — the keepers only ever pass <i>sealed</i> parts, and we <b>can't recover it for you</b>. Prefilled with the demo key.</p>
      {dr3Opened && (
        <div data-testid="dr3-open-result" data-reconstructed={String(dr3Opened.reconstructed)} data-released={String(dr3Opened.released)} style={{ marginTop: 8 }}>
          {!dr3Opened.found ? (
            <div className="verdict err"><span className="badge"><VerdictMark ok={false} /></span><span>Document not found on the public record</span></div>
          ) : !dr3Opened.released ? (
            <div className="verdict err"><span className="badge"><VerdictMark ok={false} /></span><span data-testid="dr3-not-released">Not admitted — the keepers released no parts (fewer than 2). Someone without access can't rebuild the key.</span></div>
          ) : dr3Opened.reconstructed ? (
            <>
              <div className="verdict ok"><span className="badge"><VerdictMark ok /></span><span>Rebuilt the key from {dr3Opened.faithfulShares} parts (any 2 of 3) and the file matched its fingerprint</span></div>
              <div className="row"><span className="k">rebuilt from keepers</span><span className="v" data-testid="dr3-pair">{dr3Opened.reconstructedFromPair ? `#${dr3Opened.reconstructedFromPair[0]} + #${dr3Opened.reconstructedFromPair[1]}` : "—"}</span></div>
              <div className="demo-note" style={{ marginTop: 8 }}>Decrypted document</div>
              <pre className="cli" data-testid="dr3-plaintext" style={{ whiteSpace: "pre-wrap" }}>{dr3Opened.plaintextUtf8 ?? `(binary, ${dr3Opened.plaintext?.length ?? 0} bytes)`}</pre>
            </>
          ) : (
            <div className="verdict err"><span className="badge"><VerdictMark ok={false} /></span><span data-testid="dr3-unfaithful">Parts released, but {dr3Opened.faithfulShares} opened correctly — wrong private key, so the key can't be rebuilt.</span></div>
          )}
        </div>
      )}
      {dr3OpenErr && <p className="err-text" data-testid="dr3-open-error">{dr3OpenErr}</p>}
    </div>
  );
}
