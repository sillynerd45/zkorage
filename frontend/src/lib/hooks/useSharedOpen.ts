import { useEffect, useState } from "react";
import {
  getCommitteeInfo,
  getCommitteeDocument,
  type CommitteeInfoResp,
  type CommitteeDoc,
} from "@/lib/api";
import { DEMO_DATAROOM_POLICY, type OpenedCommitteeDocument, type RoomAccess } from "zkorage-sdk";
import { sdk, DEMO_RECIPIENT_SECRET } from "@/lib/sdk";
import { isHex32 } from "@/lib/format";

// Pattern 2 — prove-a-policy self-serve document access (the reader side). A committee document carries a
// per-document policy (member / KYC / accredited). A would-be reader reads the policy + their live per-leg
// admission (sdk.canOpenDocument, all on-chain reads, no keepers needed), and ON ADMISSION releases the key
// via the DR3 key-free committee open (sdk.openCommitteeDocument: collect >= 2 sealed shares, reconstruct K,
// AES-decrypt). The recipient secret never leaves the browser. Defaults to the live Pattern-2 demo doc.
export function useSharedOpen() {
  const [committee, setCommittee] = useState<CommitteeInfoResp | null>(null);
  const [committeeDoc, setCommitteeDoc] = useState<CommitteeDoc | null>(null);
  const [room, setRoom] = useState(DEMO_DATAROOM_POLICY.roomId);
  const [doc, setDoc] = useState(DEMO_DATAROOM_POLICY.docId);
  const [accessor, setAccessor] = useState(DEMO_DATAROOM_POLICY.accessor);
  const [secret, setSecret] = useState(DEMO_RECIPIENT_SECRET);

  const [access, setAccess] = useState<RoomAccess | null>(null);
  const [accessErr, setAccessErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const [opened, setOpened] = useState<OpenedCommitteeDocument | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    getCommitteeInfo().then(setCommittee).catch(() => {});
    getCommitteeDocument(DEMO_DATAROOM_POLICY.roomId, DEMO_DATAROOM_POLICY.docId)
      .then((r) => setCommitteeDoc(r.document))
      .catch(() => {});
    // Pre-load the demo doc's policy + admission so the page shows what to prove without a click.
    sdk.canOpenDocument(DEMO_DATAROOM_POLICY.roomId, DEMO_DATAROOM_POLICY.docId, DEMO_DATAROOM_POLICY.accessor)
      .then(setAccess)
      .catch(() => {});
  }, []);

  // Read the document's effective policy + this reader's live per-leg admission (the exact gate the keepers
  // use). On-chain reads only; reveals only the pseudonymous accessor.
  async function onCheck() {
    setAccessErr(null);
    setOpened(null);
    setOpenErr(null);
    if (!isHex32(room) || !isHex32(doc) || !isHex32(accessor)) {
      setAccessErr("room, doc, and stand-in ID must each be 32-byte hex (64 hex chars)");
      return;
    }
    setChecking(true);
    try {
      setAccess(await sdk.canOpenDocument(room.trim(), doc.trim(), accessor.trim()));
    } catch (e) {
      setAccessErr(String((e as Error).message ?? e));
    } finally {
      setChecking(false);
    }
  }

  // Release + open: the keepers release sealed shares only if the reader is doc-admitted; the SDK
  // reconstructs K (any 2 of 3) and AES-decrypts in the browser. The recipient secret never leaves it.
  async function onOpen() {
    setOpenErr(null);
    setOpened(null);
    if (!isHex32(room) || !isHex32(doc) || !isHex32(accessor)) {
      setOpenErr("room, doc, and stand-in ID must each be 32-byte hex (64 hex chars)");
      return;
    }
    setOpening(true);
    try {
      const sec = (secret.trim() || DEMO_RECIPIENT_SECRET).toLowerCase();
      setOpened(await sdk.openCommitteeDocument(room.trim(), doc.trim(), accessor.trim(), sec));
    } catch (e) {
      setOpenErr(String((e as Error).message ?? e));
    } finally {
      setOpening(false);
    }
  }

  return {
    committee,
    committeeDoc,
    room,
    setRoom,
    doc,
    setDoc,
    accessor,
    setAccessor,
    secret,
    setSecret,
    access,
    accessErr,
    checking,
    onCheck,
    opened,
    openErr,
    opening,
    onOpen,
  };
}
