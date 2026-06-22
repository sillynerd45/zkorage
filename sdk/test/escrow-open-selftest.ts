// Owner-escrow committee-doc opener — openCommitteeDocumentAsOwner.
//   cd sdk && npx tsx test/escrow-open-selftest.ts
// The owner stored a committee doc (browser dealer) and an escrow copy of K sealed to their own room key.
// This reopens it WITHOUT the keepers and WITHOUT a membership proof. We stub the chain read + the two I/O
// fetches (escrow + blob) so the test is hermetic, and assert: happy path decrypts; a wrong owner secret is
// unfaithful (no plaintext); a content-hash mismatch and a missing escrow both throw (fail-closed).
import {
  ZkorageClient,
  aeadSeal,
  sealDocumentKey,
  recipientPublicKeyFromSecret,
  randomKey,
  toHex,
  sha256Hex,
} from "../src/index.js";
import { sha256 } from "@noble/hashes/sha256";

let failures = 0;
const ok = (c: boolean, label: string) => {
  console.log(`${c ? "✓" : "✗"} ${label}`);
  if (!c) failures++;
};
const secretOf = (s: string) => toHex(sha256(new TextEncoder().encode(s)).slice(0, 32));

// ---- build a stored committee doc + its owner-escrow copy (the dealer's outputs) ----
const K = randomKey();
const plaintext = "Series A board minutes — owner reopened via escrow 🔐";
const blob = await aeadSeal(new TextEncoder().encode(plaintext), K);
const contentHash = sha256Hex(blob);
const roomId = secretOf("escrow-open-room");
const docId = secretOf("escrow-open-doc");
const ownerSecret = secretOf("escrow-open-owner");
const ownerPub = recipientPublicKeyFromSecret(ownerSecret);
const disc = sealDocumentKey(K, ownerPub, contentHash, roomId, docId);
const escrow = { ...disc, recipientPub: ownerPub };

const committeeDoc = {
  index: 0, room_id: roomId, doc_id: docId, content_hash: contentHash,
  k_commitment: sha256Hex(K), blob_pointer: "local://x", ledger: 1, timestamp: "0",
};

const client = new ZkorageClient({ apiBaseUrl: "http://localhost:8787" });
// Stub the chain read so the test is hermetic (no RPC); the opener's I/O is injected via opts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(client as any).getCommitteeDocument = async () => committeeDoc;
const io = { fetchEscrow: async () => escrow, fetchBlob: async () => blob };

// ---- 1) happy path: the owner's secret recovers K, the blob verifies, plaintext decrypts ----
const opened = await client.openCommitteeDocumentAsOwner(roomId, docId, ownerSecret, io);
ok(opened.found && opened.faithful && opened.contentHashVerified, "owner open: found + faithful + content verified");
ok(opened.plaintextUtf8 === plaintext, "owner open: decrypted plaintext matches");

// ---- 2) a wrong owner secret is unfaithful and yields no plaintext ----
const wrong = await client.openCommitteeDocumentAsOwner(roomId, docId, secretOf("not-the-owner"), io);
ok(wrong.found && !wrong.faithful && wrong.plaintext === null, "wrong owner key: unfaithful, no plaintext");

// ---- 3) an escrow whose contentHash != the on-chain doc throws (bait-copy guard) ----
let baitThrew = false;
try {
  await client.openCommitteeDocumentAsOwner(roomId, docId, ownerSecret, {
    fetchEscrow: async () => ({ ...escrow, contentHash: secretOf("a-different-blob") }),
    fetchBlob: async () => blob,
  });
} catch { baitThrew = true; }
ok(baitThrew, "content-hash mismatch between escrow and chain throws (no bait decrypt)");

// ---- 4) a missing escrow throws (fail-closed, not a silent empty) ----
let missingThrew = false;
try {
  await client.openCommitteeDocumentAsOwner(roomId, docId, ownerSecret, { fetchEscrow: async () => null, fetchBlob: async () => blob });
} catch { missingThrew = true; }
ok(missingThrew, "missing owner-escrow copy throws");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
