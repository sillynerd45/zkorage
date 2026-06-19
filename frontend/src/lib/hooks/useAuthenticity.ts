import { useCallback, useEffect, useState } from "react";
import { getDocauthInfo, type DocauthInfoResp } from "@/lib/api";
import { DEMO_DATAROOM_DOCAUTH, DOCAUTH_IMAGE_ID, type DocumentFact } from "zkorage-sdk";
import { sdk } from "@/lib/sdk";
import { isHex32 } from "@/lib/format";

// DR4 — document authenticity (signed-PDF / zkPDF: third-party truth on self-uploaded data). A third party
// (a bank) RSA-signs a statement; the docauth guest re-verifies that real RSA-2048 signature in-zkVM and
// proves a fact about it (e.g. "balance ≥ X") without revealing the statement or the exact value.
export function useAuthenticity() {
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

  return {
    docauth,
    docFact,
    dr4Room,
    setDr4Room,
    dr4Digest,
    setDr4Digest,
    dr4Verify,
    dr4Err,
    dr4Busy,
    onDocauthVerify,
  };
}
