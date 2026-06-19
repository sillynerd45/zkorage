import { useCallback, useEffect, useState } from "react";
import { VerdictMark } from "../../StatusBadge";
import {
  DEMO_DATAROOM_TEASER,
  DEMO_TEASER_ATTESTER_ID,
  TEASER_IMAGE_ID,
  type Teaser,
} from "zkorage-sdk";
import { Disclosure, Hex } from "../../components/Disclosure";
import { GlossaryTip } from "../../components/GlossaryTip";
import { sdk, short, isHex32, DEMO_AUDITOR_SECRET } from "./shared";

// DR5 — faithful disclosure / data-side teaser. A teaser proves a public fact about a SEALED document
// (e.g. "revenue ≥ $1M") vouched by an allowlisted appraiser, without revealing the figure; a designated
// auditor separately gets a provably-faithful redacted view. No new guest.
export default function DisclosureRoute() {
  const [teaser, setTeaser] = useState<Teaser | null>(null);
  const [teaserValid, setTeaserValid] = useState(false);
  const [dr5Room, setDr5Room] = useState(DEMO_DATAROOM_TEASER.roomId);
  const [dr5Doc, setDr5Doc] = useState(DEMO_DATAROOM_TEASER.fullDocId);
  const [dr5Verify, setDr5Verify] = useState<{ teaserOnChain: boolean; imagePinned: boolean; appraiserAllowlisted: boolean; figureHidden: boolean } | null>(null);
  const [dr5Err, setDr5Err] = useState<string | null>(null);
  const [dr5Busy, setDr5Busy] = useState(false);
  // auditor redacted-view open (key-free, in-browser)
  const [viewDoc, setViewDoc] = useState(DEMO_DATAROOM_TEASER.viewDocId);
  const [auditorSecret, setAuditorSecret] = useState(DEMO_AUDITOR_SECRET);
  const [redacted, setRedacted] = useState<{ faithful: boolean; document?: Record<string, unknown>; log?: { field: string; mask: string; basis: string }[] } | null>(null);
  const [openBusyDr5, setOpenBusyDr5] = useState(false);
  const [openErrDr5, setOpenErrDr5] = useState<string | null>(null);

  const loadTeaser = useCallback((room: string, doc: string) => {
    if (!isHex32(room) || !isHex32(doc)) { setTeaser(null); setTeaserValid(false); return; }
    sdk.getTeaser(room.trim(), doc.trim()).then(setTeaser).catch(() => setTeaser(null));
    sdk.isTeaserValid(room.trim(), doc.trim()).then(setTeaserValid).catch(() => setTeaserValid(false));
  }, []);

  useEffect(() => {
    loadTeaser(DEMO_DATAROOM_TEASER.roomId, DEMO_DATAROOM_TEASER.fullDocId);
  }, [loadTeaser]);

  // DR5 — re-verify the TEASER's provenance entirely in-browser via the SDK (public RPC): the teaser exists
  // on-chain (so the bare Groth16 verifier accepted the generic value≥threshold proof BEFORE it was stored),
  // the teaser image == the pinned generic guest, the appraiser is allowlisted, and the record carries NO
  // figure (only the predicate). "A fact about a sealed document, verifiable without ever seeing it."
  async function onTeaserVerify() {
    setDr5Busy(true); setDr5Err(null); setDr5Verify(null);
    try {
      const [t, pinnedImage] = await Promise.all([
        sdk.getTeaser(dr5Room.trim(), dr5Doc.trim()),
        sdk.getTeaserImageId(),
      ]);
      setTeaser(t);
      setTeaserValid(await sdk.isTeaserValid(dr5Room.trim(), dr5Doc.trim()));
      if (!t) { setDr5Err("No teaser anchored for this (room, document) — it hasn't been attested yet."); return; }
      const appraiserAllowlisted = await sdk.isTeaserAttesterAllowed(t.attester);
      setDr5Verify({
        teaserOnChain: true,
        imagePinned: pinnedImage !== null && pinnedImage === TEASER_IMAGE_ID,
        appraiserAllowlisted,
        figureHidden: !("figure" in (t as object)) && !("value" in (t as object)),
      });
    } catch (e) {
      setDr5Err(String((e as Error)?.message ?? e));
    } finally {
      setDr5Busy(false);
    }
  }

  // DR5 — KEY-FREE auditor open of the redacted view, running ENTIRELY IN THE BROWSER via the SDK. Recovers
  // the doc key with the auditor's x25519 secret (never transmitted), verifies the faithful tag, fetches the
  // ciphertext via the backend's public /dataroom/blob, AES-GCM-decrypts, and parses the redacted disclosure
  // (PCI/HIPAA/GDPR-masked private fields). A wrong key → not faithful (no plaintext).
  async function onAuditorOpen() {
    setOpenBusyDr5(true); setOpenErrDr5(null); setRedacted(null);
    try {
      const room = dr5Room.trim().toLowerCase();
      const doc = viewDoc.trim().toLowerCase();
      const secret = (auditorSecret.trim() || DEMO_AUDITOR_SECRET).toLowerCase();
      const opened = await sdk.openDisclosure(room, doc, secret);
      if (!opened.found) { setOpenErrDr5("No document anchored at this (room, view doc)."); return; }
      setRedacted({
        faithful: opened.faithful,
        document: opened.disclosure?.document,
        log: (opened.disclosure?.redaction_log as { field: string; mask: string; basis: string }[] | undefined),
      });
    } catch (e) {
      setOpenErrDr5(String((e as Error)?.message ?? e));
    } finally {
      setOpenBusyDr5(false);
    }
  }

  return (
    <div className="card" data-testid="dr5-card" style={{ borderColor: "var(--violet)" }}>
      <h2>Share an unaltered copy — plus a verified preview <span className="demo-note">prove a fact about a sealed file; share a masked copy <span aria-hidden="true">🪪</span></span></h2>
      <p className="hint" style={{ marginTop: 0 }}>
        A <b>verified preview</b><GlossaryTip term="verified preview" /> proves a public fact about a <b>sealed</b>
        document — e.g. <b>"revenue ≥ $1M"</b> — vouched for by an approved <b>reviewer</b>, <b>without revealing
        the document or the exact figure</b>. A named <b>auditor</b> separately gets a <b>masked
        copy</b><GlossaryTip term="masked copy" /> (private fields blacked out, HIPAA/PCI/GDPR-style) — and it's
        <b> provably the real, unaltered file</b>.
      </p>
      {/* engine machinery — demoted behind a "Verify details" expander (UX research §12) */}
      <Disclosure
        toggleTestId="dr5-engine-details"
        summary={<>The cryptographic engine — the <b>pinned proving program</b> and the <b>approved reviewer</b> who vouches for the figure. Expand to check them.</>}
      >
        <div className="row"><span className="k">Proving program (pinned)</span><span className="v" data-testid="dr5-image"><Hex value={TEASER_IMAGE_ID} chars={8} /> (generic value≥threshold)</span></div>
        <div className="row"><span className="k">Reviewer</span><span className="v" data-testid="dr5-appraiser"><Hex value={DEMO_TEASER_ATTESTER_ID} chars={8} />{teaser ? " · allowlisted ✓" : ""}</span></div>
        <div className="row"><span className="k">Kind of fact</span><span className="v">11 (data-room preview)</span></div>
      </Disclosure>

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>The verified preview <span className="demo-note">read-only · runs in your browser</span></h3>
      <p className="hint" style={{ marginTop: 0 }}>The public record shows only the fact (figure ≥ X) — never the figure.</p>
      <div className="controls" style={{ flexWrap: "wrap" }}>
        <label>Room
          <input style={{ minWidth: 280, fontFamily: "monospace", fontSize: 12 }} value={dr5Room} onChange={(e) => setDr5Room(e.target.value)} aria-label="dr5 room" data-testid="dr5-room" />
        </label>
        <label>Document (sealed)
          <input style={{ minWidth: 280, fontFamily: "monospace", fontSize: 12 }} value={dr5Doc} onChange={(e) => setDr5Doc(e.target.value)} aria-label="dr5 doc" data-testid="dr5-doc" />
        </label>
        <button onClick={onTeaserVerify} disabled={dr5Busy} data-testid="dr5-verify-btn">{dr5Busy ? "Checking…" : "Check on the public record"}</button>
      </div>

      {teaser ? (
        <div data-testid="dr5-teaser" style={{ marginTop: 10 }}>
          <div className="verdict ok"><span className="badge"><VerdictMark ok /></span><span data-testid="dr5-teaser-claim">Verified preview: <b>{teaser.field_tag === 1 ? "revenue" : `field ${teaser.field_tag}`} ≥ {Number(teaser.threshold).toLocaleString()}</b> — proven about the sealed file, exact figure hidden</span></div>
          <div className="row"><span className="k">Threshold (public)</span><span className="v" data-testid="dr5-teaser-threshold">{teaser.threshold}</span></div>
          <div className="row"><span className="k">Tied to the file's fingerprint</span><span className="v" data-testid="dr5-teaser-bound" title={teaser.content_hash}>{short(teaser.content_hash, 8)}</span></div>
          <div className="row"><span className="k">Reviewer</span><span className="v" title={teaser.attester}>{short(teaser.attester, 8)}</span></div>
          <div className="row"><span className="k">Still valid (not expired)</span><span className="v" data-testid="dr5-teaser-valid">{teaserValid ? "✓" : "✗"}</span></div>
          <div className="row"><span className="k">Exact figure</span><span className="v" data-testid="dr5-figure-hidden"><span aria-hidden="true">🔒</span> never on the public record (private)</span></div>
        </div>
      ) : (
        <p className="hint" data-testid="dr5-no-teaser" style={{ marginTop: 10 }}>No verified preview for this (room, document) yet.</p>
      )}

      {dr5Verify && (
        <div data-testid="dr5-verify-result" data-verdict={String(dr5Verify.teaserOnChain && dr5Verify.imagePinned && dr5Verify.appraiserAllowlisted && dr5Verify.figureHidden)} style={{ marginTop: 10 }}>
          <div className="row"><span className="k">On the public record (checked before storing)</span><span className="v">{dr5Verify.teaserOnChain ? "✓" : "✗"}</span></div>
          <div className="row"><span className="k">Program matches the official one</span><span className="v">{dr5Verify.imagePinned ? "✓" : "✗"}</span></div>
          <div className="row"><span className="k">Vouched by an approved reviewer</span><span className="v">{dr5Verify.appraiserAllowlisted ? "✓" : "✗"}</span></div>
          <div className="row"><span className="k">Exact figure hidden</span><span className="v">{dr5Verify.figureHidden ? "✓" : "✗"}</span></div>
          {dr5Verify.teaserOnChain && dr5Verify.imagePinned && dr5Verify.appraiserAllowlisted && dr5Verify.figureHidden
            ? <div className="verdict ok" data-testid="dr5-verdict-ok"><span className="badge"><VerdictMark ok /></span><span>A reviewer-vouched fact, proven privately — the document was never revealed.</span></div>
            : <div className="verdict err"><span className="badge"><VerdictMark ok={false} /></span><span>This check didn't fully pass.</span></div>}
        </div>
      )}
      {dr5Err && <p className="err-text" data-testid="dr5-error">{dr5Err}</p>}

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>Auditor's masked copy <span className="demo-note">the read key never leaves your browser</span></h3>
      <p className="hint" style={{ marginTop: 0 }}>
        The auditor opens a <b>masked copy</b> of the same statement (private fields blacked out, HIPAA/PCI/GDPR-style),
        provably the <b>real, unaltered file</b>. It opens entirely in your browser; a wrong key → it won't open.
      </p>
      <div className="controls" style={{ flexWrap: "wrap" }}>
        <label>Masked copy (doc)
          <input style={{ minWidth: 280, fontFamily: "monospace", fontSize: 12 }} value={viewDoc} onChange={(e) => setViewDoc(e.target.value)} aria-label="dr5 view doc" data-testid="dr5-view-doc" />
        </label>
        <label>Auditor's read key
          <input style={{ minWidth: 420, fontFamily: "monospace", fontSize: 12 }} value={auditorSecret} onChange={(e) => setAuditorSecret(e.target.value)} aria-label="auditor secret" data-testid="dr5-auditor-secret" />
        </label>
        <button onClick={onAuditorOpen} disabled={openBusyDr5} data-testid="dr5-open-btn">{openBusyDr5 ? "Opening…" : "Open the masked copy"}</button>
      </div>
      <p className="hint" data-testid="dr5-secret-note"><span aria-hidden="true">🔑</span> Your auditor read key stays in this browser — we never see it and <b>can't recover it for you</b>. Prefilled with the demo key.</p>
      {redacted && (
        <div data-testid="dr5-redacted" data-faithful={String(redacted.faithful)} style={{ marginTop: 10 }}>
          {redacted.faithful && redacted.document ? (
            <>
              <div className="verdict ok"><span className="badge"><VerdictMark ok /></span><span data-testid="dr5-faithful">Unaltered masked copy — provably the real file's contents</span></div>
              <pre data-testid="dr5-redacted-json" style={{ fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap", marginTop: 8 }}>{JSON.stringify(redacted.document, null, 2)}</pre>
              {redacted.log && redacted.log.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <span className="k">What was masked</span>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {redacted.log.map((e) => (<li key={e.field} className="hint" style={{ fontSize: 12 }}><b>{e.field}</b>: {e.mask} — {e.basis}</li>))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="verdict err" data-testid="dr5-not-faithful"><span className="badge"><VerdictMark ok={false} /></span><span>Won't open — wrong read key (or tampered). Nothing released.</span></div>
          )}
        </div>
      )}
      {openErrDr5 && <p className="err-text" data-testid="dr5-open-error">{openErrDr5}</p>}
    </div>
  );
}
