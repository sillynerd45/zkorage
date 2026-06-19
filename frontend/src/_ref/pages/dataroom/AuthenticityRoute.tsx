import { useCallback, useEffect, useState } from "react";
import { VerdictMark } from "../../StatusBadge";
import { getDocauthInfo, type DocauthInfoResp } from "../../api";
import { DEMO_DATAROOM_DOCAUTH, DOCAUTH_IMAGE_ID, type DocumentFact } from "zkorage-sdk";
import { Disclosure, Hex } from "../../components/Disclosure";
import { GlossaryTip } from "../../components/GlossaryTip";
import { sdk, short, isHex32 } from "./shared";

// DR4 — document authenticity (signed-PDF / zkPDF: third-party truth on self-uploaded data). A third party
// (a bank) RSA-signs a statement; the docauth guest re-verifies that real RSA-2048 signature in-zkVM and
// proves a fact about it (e.g. "balance ≥ X") without revealing the statement or the exact value.
export default function AuthenticityRoute() {
  const [docauth, setDocauth] = useState<DocauthInfoResp | null>(null);
  const [docFact, setDocFact] = useState<DocumentFact | null>(null);
  const [dr4Room, setDr4Room] = useState(DEMO_DATAROOM_DOCAUTH.roomId);
  const [dr4Digest, setDr4Digest] = useState(DEMO_DATAROOM_DOCAUTH.msgDigest);
  const [dr4Verify, setDr4Verify] = useState<{ factOnChain: boolean; imagePinned: boolean; issuerAllowlisted: boolean; valueHidden: boolean } | null>(null);
  const [dr4Err, setDr4Err] = useState<string | null>(null);
  const [dr4Busy, setDr4Busy] = useState(false);

  const loadDocFact = useCallback((room: string, digest: string) => {
    if (!isHex32(room) || !isHex32(digest)) { setDocFact(null); return; }
    sdk.getDocumentFact(room.trim(), digest.trim()).then(setDocFact).catch(() => setDocFact(null));
  }, []);

  useEffect(() => {
    getDocauthInfo().then(setDocauth).catch(() => {});
    loadDocFact(DEMO_DATAROOM_DOCAUTH.roomId, DEMO_DATAROOM_DOCAUTH.msgDigest);
  }, [loadDocFact]);

  // Re-verify the fact's PROVENANCE entirely in-browser via the SDK (public RPC): the fact exists on-chain
  // (so the bare Groth16 verifier accepted the proof BEFORE it was stored), the docauth guest image is the
  // pinned canonical one, the third-party issuer key is allowlisted, and the on-chain record carries NO
  // statement/value (only the predicate). This is "third-party truth on self-uploaded data".
  async function onDocauthVerify() {
    setDr4Busy(true); setDr4Err(null); setDr4Verify(null);
    try {
      const [fact, pinnedImage] = await Promise.all([
        sdk.getDocumentFact(dr4Room.trim(), dr4Digest.trim()),
        sdk.getDocauthImageId(),
      ]);
      setDocFact(fact);
      if (!fact) { setDr4Err("No fact anchored for this (room, document) — the proof hasn't been attested yet."); return; }
      const issuerAllowlisted = await sdk.isDocauthIssuerAllowed(fact.issuer_key_hash);
      setDr4Verify({
        // Compare the on-chain pinned image to the SDK's canonical constant — independent of the backend
        // /info call (so a failed info fetch can't make this read "pinned" generously).
        factOnChain: true,
        imagePinned: pinnedImage !== null && pinnedImage === DOCAUTH_IMAGE_ID,
        issuerAllowlisted,
        valueHidden: !("value" in (fact as object)) && !("statement" in (fact as object)),
      });
    } catch (e) {
      setDr4Err(String((e as Error)?.message ?? e));
    } finally {
      setDr4Busy(false);
    }
  }

  return (
    <div className="card" data-testid="dr4-card" style={{ borderColor: "var(--violet)" }}>
      <h2>Prove a signed fact <span className="demo-note">a fact a bank signed — without showing the document <span aria-hidden="true">🏦</span></span></h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Prove a fact from a document someone else signed — like a bank statement — <b>without showing the whole
        file</b>. zkorage re-checks the real <b>digital signature</b> inside a <b>private proof</b><GlossaryTip term="private proof" /> and
        proves a fact about it — e.g. <b>"balance ≥ X"</b> — <b>without revealing the statement or the exact
        value</b>. Without this, self-uploaded data is just your word for it. Only a <b>recognized bank's
        signature</b> is accepted, so you can't fake one.
      </p>
      {/* engine machinery — demoted behind a "Verify details" expander (UX research §12) */}
      <Disclosure
        toggleTestId="dr4-engine-details"
        summary={<>The cryptographic engine — the <b>pinned signature-checking program</b> and the <b>recognized bank's signing key</b> (a made-up key is rejected). Expand to check them.</>}
      >
        <div className="row"><span className="k">Signature-checking program (pinned)</span><span className="v" data-testid="dr4-image">{docauth?.docauthImageOnchain ? <Hex value={docauth.docauthImageOnchain} chars={8} /> : "—"}{docauth && docauth.docauthImageOnchain === docauth.docauthImageId ? " ✓" : ""}</span></div>
        <div className="row"><span className="k">Bank signing key</span><span className="v" data-testid="dr4-issuer">{docauth?.issuerKeyHash ? <Hex value={docauth.issuerKeyHash} chars={8} /> : "—"}{docauth?.issuerAllowlisted ? " · allowlisted ✓" : ""}</span></div>
        <div className="row"><span className="k">Kind of fact</span><span className="v">{docauth?.claimType ?? "—"} (document authenticity)</span></div>
      </Disclosure>

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>Proven fact <span className="demo-note">read-only · runs in your browser</span></h3>
      <p className="hint" style={{ marginTop: 0 }}>The public record shows only the fact — never the statement or the exact balance.</p>
      <div className="controls" style={{ flexWrap: "wrap" }}>
        <label>Room
          <input style={{ minWidth: 280, fontFamily: "monospace", fontSize: 12 }} value={dr4Room} onChange={(e) => setDr4Room(e.target.value)} aria-label="dr4 room" data-testid="dr4-room" />
        </label>
        <label>Document fingerprint
          <input style={{ minWidth: 280, fontFamily: "monospace", fontSize: 12 }} value={dr4Digest} onChange={(e) => setDr4Digest(e.target.value)} aria-label="dr4 digest" data-testid="dr4-digest" />
        </label>
        <button onClick={onDocauthVerify} disabled={dr4Busy} data-testid="dr4-verify-btn">{dr4Busy ? "Checking…" : "Check on the public record"}</button>
      </div>

      {docFact ? (
        <div data-testid="dr4-fact" style={{ marginTop: 10 }}>
          <div className="verdict ok"><span className="badge"><VerdictMark ok /></span><span data-testid="dr4-fact-claim">A bank vouched: <b>balance ≥ {Number(docFact.threshold).toLocaleString()}</b> — proven, the exact value stays hidden</span></div>
          <div className="row"><span className="k">Field</span><span className="v" data-testid="dr4-fact-field">{docFact.field_tag === 1 ? "account balance" : `field ${docFact.field_tag}`}</span></div>
          <div className="row"><span className="k">Threshold (public)</span><span className="v" data-testid="dr4-fact-threshold">{docFact.threshold}</span></div>
          <div className="row"><span className="k">Bank signing key</span><span className="v" data-testid="dr4-fact-issuer" title={docFact.issuer_key_hash}>{short(docFact.issuer_key_hash, 8)}</span></div>
          <div className="row"><span className="k">Document fingerprint</span><span className="v" title={docFact.msg_digest}>{short(docFact.msg_digest, 8)}</span></div>
          <div className="row"><span className="k">Exact balance / statement</span><span className="v" data-testid="dr4-value-hidden"><span aria-hidden="true">🔒</span> never on the public record (private)</span></div>
        </div>
      ) : (
        <p className="hint" data-testid="dr4-no-fact" style={{ marginTop: 10 }}>No fact anchored for this (room, document) yet.</p>
      )}

      {dr4Verify && (
        <div data-testid="dr4-verify-result" data-verdict={String(dr4Verify.factOnChain && dr4Verify.imagePinned && dr4Verify.issuerAllowlisted && dr4Verify.valueHidden)} style={{ marginTop: 10 }}>
          <div className="row"><span className="k">On the public record (checked before storing)</span><span className="v">{dr4Verify.factOnChain ? "✓" : "✗"}</span></div>
          <div className="row"><span className="k">Program matches the official one</span><span className="v">{dr4Verify.imagePinned ? "✓" : "✗"}</span></div>
          <div className="row"><span className="k">Signed by a recognized bank</span><span className="v">{dr4Verify.issuerAllowlisted ? "✓" : "✗"}</span></div>
          <div className="row"><span className="k">Statement + exact value hidden</span><span className="v">{dr4Verify.valueHidden ? "✓" : "✗"}</span></div>
          {dr4Verify.factOnChain && dr4Verify.imagePinned && dr4Verify.issuerAllowlisted && dr4Verify.valueHidden
            ? <div className="verdict ok" data-testid="dr4-verdict-ok"><span className="badge"><VerdictMark ok /></span><span>A bank's signature, re-checked inside a private proof — the document was never revealed.</span></div>
            : <div className="verdict err"><span className="badge"><VerdictMark ok={false} /></span><span>This check didn't fully pass.</span></div>}
        </div>
      )}
      {dr4Err && <p className="err-text" data-testid="dr4-error">{dr4Err}</p>}
    </div>
  );
}
