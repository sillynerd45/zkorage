import { useEffect, useState } from "react";
import {
  getCommitteeInfo,
  getCommitteeDocument,
  type CommitteeInfoResp,
  type CommitteeDoc,
} from "@/lib/api";
import { DEMO_DATAROOM_COMMITTEE, type OpenedCommitteeDocument } from "zkorage-sdk";
import { sdk, DEMO_RECIPIENT_SECRET } from "@/lib/sdk";
import { isHex32 } from "@/lib/format";

// DR3 (threshold-ECIES committee, key release). A per-doc key K is Shamir-split 2-of-3 across an
// independent keyper committee. The recipient collects 2 or more sealed shares, reconstructs K, and
// decrypts entirely in the browser. The recipient secret never leaves it.
export function useRelease() {
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

  // DR3: collect the keyper committee's sealed shares for the granted accessor, then reconstruct K (2-of-3)
  // and decrypt, ENTIRELY IN THE BROWSER via the SDK. The recipient x25519 secret never leaves the browser:
  // the backend aggregator only relays SEALED shares (it never sees the secret), and the
  // open, Lagrange-reconstruct, and AES-GCM decrypt all run client-side in openCommitteeDocument.
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

  return {
    committee,
    committeeDoc,
    dr3Room,
    setDr3Room,
    dr3Doc,
    setDr3Doc,
    dr3Accessor,
    setDr3Accessor,
    dr3Secret,
    setDr3Secret,
    dr3Opened,
    dr3OpenErr,
    dr3Busy,
    onCommitteeOpen,
  };
}
