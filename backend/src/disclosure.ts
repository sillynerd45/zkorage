// zkorage payroll auditor selective-disclosure (Option B — in-guest ECIES).
//
// The RISC0 payroll guest encrypts the SIGNED salary to the auditor's x25519 key and commits
// (eph_pub, ct, tag) in the PUBLIC journal. This module is the OTHER half: it mirrors the guest's ECIES
// (for tests) and implements the AUDITOR OPENER (decrypt with the view key + verify the integrity tag).
// It MUST agree with the guest byte-for-byte: same DOMAIN tags, same KDF/counter-mode, same field order.
//   guest: prover/methods/guest-payroll/src/main.rs
//
// Soundness note: the guest (not the employer) produced `ct` from the attester-signed salary, and the
// proof binds `ct` to the journal. So an auditor who decrypts `ct` with their view key is mathematically
// certain the recovered figure is the signed salary. `tag = sha256(DOMAIN_TAG ‖ salary ‖ blinding)` gives
// a definitive "faithful ✓" after decrypt (and detects a wrong key); `blinding` keeps the public tag
// hiding (salaries are low-entropy → without it the tag could be brute-forced).
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const DOMAIN_KS = new TextEncoder().encode("zkorage-payroll-ecies-v1/ks");
const DOMAIN_TAG = new TextEncoder().encode("zkorage-payroll-ecies-v1/tag");

const PT_LEN = 40; // salary_be8 ‖ blinding32

// Demo auditor x25519 view key (the SECRET unlocks disclosures). Deterministic so the deploy script's
// allow-listed auditor pubkey is reproducible. A real auditor generates + holds their own keypair; the
// secret NEVER leaves the auditor (here it lives only in the backend's auditor-open path, not the SDK).
export const DEMO_AUDITOR_SEED = sha256(
  new TextEncoder().encode("zkorage-demo-auditor-payroll-view-key"),
);

export function auditorViewSecret(seed: Uint8Array = DEMO_AUDITOR_SEED): Uint8Array {
  return seed.slice(0, 32);
}

export function auditorPublicKey(seed: Uint8Array = DEMO_AUDITOR_SEED): Uint8Array {
  return x25519.getPublicKey(auditorViewSecret(seed));
}

function u64be(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, false);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Counter-mode sha256 keystream, `len` bytes: sha256(DOMAIN_KS ‖ shared ‖ eph_pub ‖ ctr_be4) blocks. */
function keystream(shared: Uint8Array, ephPub: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let produced = 0;
  let ctr = 0;
  while (produced < len) {
    const ctrb = new Uint8Array(4);
    new DataView(ctrb.buffer).setUint32(0, ctr, false);
    const block = sha256(concat(DOMAIN_KS, shared, ephPub, ctrb));
    const take = Math.min(32, len - produced);
    for (let i = 0; i < take; i++) out[produced + i] = block[i];
    produced += take;
    ctr++;
  }
  return out;
}

export function disclosureTag(salary: bigint, blinding: Uint8Array): Uint8Array {
  return sha256(concat(DOMAIN_TAG, u64be(salary), blinding));
}

export interface SealedDisclosure {
  ephPub: Uint8Array; // 32
  ct: Uint8Array; // 40
  tag: Uint8Array; // 32
}

/** Mirror of the guest's in-guest ECIES sender (used only for tests / cross-impl checks). */
export function eciesSeal(
  salary: bigint,
  blinding: Uint8Array,
  ephSecret: Uint8Array,
  auditorPub: Uint8Array,
): SealedDisclosure {
  if (blinding.length !== 32) throw new Error("blinding must be 32 bytes");
  const ephPub = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, auditorPub);
  const pt = concat(u64be(salary), blinding); // 40
  const ks = keystream(shared, ephPub, PT_LEN);
  const ct = new Uint8Array(PT_LEN);
  for (let i = 0; i < PT_LEN; i++) ct[i] = pt[i] ^ ks[i];
  return { ephPub, ct, tag: disclosureTag(salary, blinding) };
}

export interface OpenedDisclosure {
  salary: bigint;
  blinding: Uint8Array;
  faithful: boolean; // tag matched (correct view key + untampered ciphertext)
}

/**
 * AUDITOR OPENER: decrypt `(ephPub, ct)` with the auditor's view-key secret and verify against the
 * committed `tag`. `faithful` is true iff the recomputed tag matches the journal's tag — i.e. the
 * decrypt is correct AND the figure is the attester-signed salary (the proof bound `ct`/`tag`).
 */
export function eciesOpen(
  ephPub: Uint8Array,
  ct: Uint8Array,
  tag: Uint8Array,
  viewSecret: Uint8Array,
): OpenedDisclosure {
  if (ct.length !== PT_LEN) throw new Error(`ct must be ${PT_LEN} bytes`);
  const shared = x25519.getSharedSecret(viewSecret, ephPub);
  const ks = keystream(shared, ephPub, PT_LEN);
  const pt = new Uint8Array(PT_LEN);
  for (let i = 0; i < PT_LEN; i++) pt[i] = ct[i] ^ ks[i];
  const salary = new DataView(pt.buffer, pt.byteOffset, pt.byteLength).getBigUint64(0, false);
  const blinding = pt.slice(8, 40);
  const recomputed = disclosureTag(salary, blinding);
  let faithful = recomputed.length === tag.length;
  for (let i = 0; i < tag.length && faithful; i++) if (recomputed[i] !== tag[i]) faithful = false;
  return { salary, blinding, faithful };
}

// ═══════════════════════════ DR1 — Confidential Data Room (seal opener) ═══════════════════════════
//
// The data-room seal guest (prover/methods/guest-dataroom-seal/src/main.rs) ECIES-seals a PRIVATE 32-byte
// document key `K` to a recipient's x25519 key IN-GUEST and binds K to the document's identity + ciphertext
// hash. This section is the OTHER half: it mirrors that guest (for tests) and implements the RECIPIENT
// OPENER — recover K with the recipient's x25519 secret, verify the faithful tag, then AEAD-decrypt the
// blob. It MUST agree with the guest byte-for-byte (same DOMAIN tags, same KDF, same field order). Unlike
// the payroll auditor opener, the recipient is the document's intended reader (not an auditor), the sealed
// payload is the 32-byte K (no blinding — K is high-entropy), and the tag binds K to content_hash/room_id/
// doc_id so a seal for one document is non-portable. This opener is pure crypto → portable KEY-FREE to the
// SDK (Chunk 4); the demo recipient secret below is a backend convenience only.
const DATAROOM_DOMAIN_KS = new TextEncoder().encode("zkorage-dataroom-ecies-v1/ks");
const DATAROOM_DOMAIN_TAG = new TextEncoder().encode("zkorage-dataroom-seal-v1/tag");

const K_LEN = 32; // the sealed document key is exactly one sha256 block → single-block keystream (ctr 0).

// Demo recipient x25519 keypair (the SECRET opens a sealed document). Deterministic so a test/demo flow is
// reproducible. A real recipient generates + holds their OWN keypair; the secret NEVER leaves the recipient
// (here it lives only in the backend's demo open path, not the SDK).
export const DEMO_RECIPIENT_SEED = sha256(
  new TextEncoder().encode("zkorage-demo-dataroom-recipient-key"),
);

export function recipientViewSecret(seed: Uint8Array = DEMO_RECIPIENT_SEED): Uint8Array {
  return seed.slice(0, 32);
}

export function recipientPublicKey(seed: Uint8Array = DEMO_RECIPIENT_SEED): Uint8Array {
  return x25519.getPublicKey(recipientViewSecret(seed));
}

/** Single 32-byte keystream block: sha256(DOMAIN_KS ‖ shared ‖ eph_pub ‖ ctr0_be4). */
function dataroomKeystream(shared: Uint8Array, ephPub: Uint8Array): Uint8Array {
  const ctr0 = new Uint8Array(4); // counter 0 (big-endian) — K fits in one block
  return sha256(concat(DATAROOM_DOMAIN_KS, shared, ephPub, ctr0));
}

/** Faithful tag = sha256(DOMAIN_TAG ‖ K ‖ content_hash ‖ room_id ‖ doc_id). Binds K to THIS blob+document. */
export function dataroomSealTag(
  k: Uint8Array,
  contentHash: Uint8Array,
  roomId: Uint8Array,
  docId: Uint8Array,
): Uint8Array {
  return sha256(concat(DATAROOM_DOMAIN_TAG, k, contentHash, roomId, docId));
}

export interface DataroomSeal {
  ephPub: Uint8Array; // 32
  ct: Uint8Array; // 32 (sealed K)
  tag: Uint8Array; // 32
}

/** Mirror of the guest's in-guest ECIES sealer (used only for tests / cross-impl checks). */
export function dataroomEciesSeal(
  k: Uint8Array,
  recipientPub: Uint8Array,
  ephSecret: Uint8Array,
  contentHash: Uint8Array,
  roomId: Uint8Array,
  docId: Uint8Array,
): DataroomSeal {
  if (k.length !== K_LEN) throw new Error("doc key K must be 32 bytes");
  const ephPub = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, recipientPub);
  const ks = dataroomKeystream(shared, ephPub);
  const ct = new Uint8Array(K_LEN);
  for (let i = 0; i < K_LEN; i++) ct[i] = k[i] ^ ks[i];
  return { ephPub, ct, tag: dataroomSealTag(k, contentHash, roomId, docId) };
}

export interface OpenedSeal {
  k: Uint8Array; // recovered 32-byte document key
  faithful: boolean; // tag matched (correct recipient key + untampered seal, bound to THIS document)
}

/**
 * RECIPIENT OPENER: recover the document key `K` from `(ephPub, ct)` with the recipient's x25519 secret and
 * verify it against the committed `tag` + the public `(content_hash, room_id, doc_id)`. `faithful` is true
 * iff the recomputed tag matches — i.e. the decrypt is correct AND K is the key the proof bound to THIS
 * blob+document (no bait-and-switch; also detects a wrong recipient key).
 */
export function dataroomEciesOpen(
  ephPub: Uint8Array,
  ct: Uint8Array,
  tag: Uint8Array,
  contentHash: Uint8Array,
  roomId: Uint8Array,
  docId: Uint8Array,
  recipientSecret: Uint8Array,
): OpenedSeal {
  // Validate every 32-byte input — a wrong length would otherwise either throw deep inside x25519 or
  // silently change the tag preimage (→ a confusing faithful=false instead of a clear error).
  for (const [name, v] of [["ct", ct], ["ephPub", ephPub], ["tag", tag], ["contentHash", contentHash], ["roomId", roomId], ["docId", docId], ["recipientSecret", recipientSecret]] as const) {
    if (v.length !== 32) throw new Error(`${name} must be 32 bytes`);
  }
  const shared = x25519.getSharedSecret(recipientSecret, ephPub);
  const ks = dataroomKeystream(shared, ephPub);
  const k = new Uint8Array(K_LEN);
  for (let i = 0; i < K_LEN; i++) k[i] = ct[i] ^ ks[i];
  const recomputed = dataroomSealTag(k, contentHash, roomId, docId);
  let faithful = recomputed.length === tag.length;
  for (let i = 0; i < tag.length && faithful; i++) if (recomputed[i] !== tag[i]) faithful = false;
  return { k, faithful };
}

// ── Blob AEAD (AES-256-GCM) ──
// The document plaintext is sealed under K with AES-256-GCM before it ever leaves the prover. The stored
// blob is self-describing: iv(12) ‖ ciphertext ‖ tag(16). The on-chain content_hash = sha256(this blob),
// so the AEAD choice is a pure backend/SDK concern (the guest only binds K to content_hash, never the AEAD).

const AEAD_IV_LEN = 12;
const AEAD_TAG_LEN = 16;

/** AES-256-GCM seal: returns iv(12) ‖ ciphertext ‖ tag(16). `k` is the 32-byte document key. */
export function aeadSeal(plaintext: Uint8Array, k: Uint8Array): Uint8Array {
  if (k.length !== K_LEN) throw new Error("AEAD key must be 32 bytes");
  const iv = randomBytes(AEAD_IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, ct, tag]));
}

/** AES-256-GCM open of an iv ‖ ciphertext ‖ tag blob. Throws if the tag fails (wrong key / tampering). */
export function aeadOpen(blob: Uint8Array, k: Uint8Array): Uint8Array {
  if (k.length !== K_LEN) throw new Error("AEAD key must be 32 bytes");
  // `<=` (not `<`): a blob of exactly iv+tag would be a zero-length-ciphertext seal, which we never produce.
  if (blob.length <= AEAD_IV_LEN + AEAD_TAG_LEN) throw new Error("blob too short");
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, AEAD_IV_LEN);
  const tag = buf.subarray(buf.length - AEAD_TAG_LEN);
  const ct = buf.subarray(AEAD_IV_LEN, buf.length - AEAD_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
}

/** A fresh 32-byte document key K (CSPRNG). */
export function randomKey(): Uint8Array {
  return new Uint8Array(randomBytes(K_LEN));
}

// Wire sha512 for any @noble/ed25519 sync consumers that share this module's process (parity w/ signer).
void sha512;

// CLI self-test: round-trip both openers (`npx tsx src/disclosure.ts`).
// (Robust main-module check — a bare `file://${process.argv[1]}` never matches under tsx on Windows, where
// argv[1] is a relative path but import.meta.url is an absolute file URL, so the self-test silently no-ops.)
const isMain = !!process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // ── payroll auditor opener ──
  const salary = 6000n;
  const blinding = sha256(new TextEncoder().encode("demo-blinding")).slice(0, 32);
  const ephSecret = sha256(new TextEncoder().encode("demo-eph")).slice(0, 32);
  const auditorPub = auditorPublicKey();
  const sealed = eciesSeal(salary, blinding, ephSecret, auditorPub);
  const opened = eciesOpen(sealed.ephPub, sealed.ct, sealed.tag, auditorViewSecret());
  const wrong = eciesOpen(sealed.ephPub, sealed.ct, sealed.tag, sha256(new TextEncoder().encode("wrong")).slice(0, 32));
  console.log("[payroll] opened.salary =", opened.salary, "faithful =", opened.faithful);
  console.log("[payroll] wrong-key faithful =", wrong.faithful);
  if (opened.salary !== salary || !opened.faithful) throw new Error("payroll round-trip FAILED");
  if (wrong.faithful) throw new Error("payroll wrong-key must be unfaithful");
  console.log("[ok] payroll ECIES round-trip + wrong-key rejection");

  // ── dataroom recipient opener + blob AEAD ──
  const k = randomKey();
  const plaintext = new TextEncoder().encode("zkorage confidential data-room document — top secret 🔒");
  const blob = aeadSeal(plaintext, k);
  const contentHash = sha256(blob);
  const roomId = sha256(new TextEncoder().encode("demo-room")).slice(0, 32);
  const docId = sha256(new TextEncoder().encode("demo-doc")).slice(0, 32);
  const drEph = sha256(new TextEncoder().encode("demo-dr-eph")).slice(0, 32);
  const recipientPub = recipientPublicKey();
  const drSeal = dataroomEciesSeal(k, recipientPub, drEph, contentHash, roomId, docId);
  const drOpen = dataroomEciesOpen(drSeal.ephPub, drSeal.ct, drSeal.tag, contentHash, roomId, docId, recipientViewSecret());
  const recovered = drOpen.faithful ? aeadOpen(blob, drOpen.k) : new Uint8Array();
  const ptMatch = drOpen.faithful && Buffer.from(recovered).equals(Buffer.from(plaintext));
  // Negatives: wrong recipient key, and a tag bound to a DIFFERENT document (replay) must be unfaithful.
  const wrongRecipient = dataroomEciesOpen(drSeal.ephPub, drSeal.ct, drSeal.tag, contentHash, roomId, docId, sha256(new TextEncoder().encode("nope")).slice(0, 32));
  const wrongDoc = dataroomEciesOpen(drSeal.ephPub, drSeal.ct, drSeal.tag, contentHash, roomId, sha256(new TextEncoder().encode("other-doc")).slice(0, 32), recipientViewSecret());
  console.log("[dataroom] recipient_pub =", Buffer.from(recipientPub).toString("hex"));
  console.log("[dataroom] content_hash  =", Buffer.from(contentHash).toString("hex"));
  console.log("[dataroom] K recovered + faithful =", drOpen.faithful, "| plaintext match =", ptMatch);
  console.log("[dataroom] wrong-recipient faithful =", wrongRecipient.faithful, "| wrong-doc faithful =", wrongDoc.faithful);
  if (!drOpen.faithful || !ptMatch) throw new Error("dataroom round-trip FAILED");
  if (wrongRecipient.faithful) throw new Error("dataroom wrong-recipient must be unfaithful");
  if (wrongDoc.faithful) throw new Error("dataroom wrong-document tag must be unfaithful");
  console.log("[ok] dataroom ECIES + AEAD round-trip + wrong-key/wrong-doc rejection");
}
