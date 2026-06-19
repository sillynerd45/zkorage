import { useCallback, useEffect, useState } from "react";
import { DEMO_DATAROOM_TEASER, TEASER_IMAGE_ID, type Teaser } from "zkorage-sdk";
import { sdk, DEMO_AUDITOR_SECRET } from "@/lib/sdk";
import { isHex32 } from "@/lib/format";

// DR5 — faithful disclosure / data-side teaser. A teaser proves a public fact about a SEALED document
// (e.g. "revenue ≥ $1M") vouched by an allowlisted appraiser, without revealing the figure; a designated
// auditor separately gets a provably-faithful redacted view. No new guest.
export function useDisclosure() {
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

  return {
    teaser,
    teaserValid,
    dr5Room,
    setDr5Room,
    dr5Doc,
    setDr5Doc,
    dr5Verify,
    dr5Err,
    dr5Busy,
    onTeaserVerify,
    viewDoc,
    setViewDoc,
    auditorSecret,
    setAuditorSecret,
    redacted,
    openBusyDr5,
    openErrDr5,
    onAuditorOpen,
  };
}
