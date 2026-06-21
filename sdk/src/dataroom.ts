// DR1 — Confidential Data Room recipient opener (key-free, browser + Node).
//
// The data-room seal guest ECIES-seals a PRIVATE 32-byte document key `K` to a recipient's x25519 key
// in-guest and binds K to the document's content_hash/room_id/doc_id (faithful disclosure). This module is
// the RECIPIENT side: given the on-chain disclosure `(eph_pub, ct, tag)` + the public bindings + the
// recipient's x25519 SECRET, recover K and verify the faithful tag; then AES-256-GCM-decrypt the
// (separately fetched) ciphertext blob. Pure + key-free at the SDK level — the caller supplies their own
// recipient secret; the SDK NEVER custodies it. MUST agree with the guest byte-for-byte:
//   guest:    prover/methods/guest-dataroom-seal/src/main.rs
//   backend:  backend/src/disclosure.ts  (dataroom section)
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { fromHex, toHex } from "./journal.js";

const DOMAIN_KS = new TextEncoder().encode("zkorage-dataroom-ecies-v1/ks");
const DOMAIN_TAG = new TextEncoder().encode("zkorage-dataroom-seal-v1/tag");
const K_LEN = 32; // the sealed doc key is exactly one sha256 block → single-block keystream (counter 0).
const AEAD_IV_LEN = 12;
const AEAD_TAG_LEN = 16;

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

/** Single 32-byte keystream block: sha256(DOMAIN_KS ‖ shared ‖ eph_pub ‖ ctr0_be4). */
function keystream(shared: Uint8Array, ephPub: Uint8Array): Uint8Array {
  return sha256(concat(DOMAIN_KS, shared, ephPub, new Uint8Array(4)));
}

/** Faithful tag = sha256(DOMAIN_TAG ‖ K ‖ content_hash ‖ room_id ‖ doc_id). */
function sealTag(k: Uint8Array, contentHash: Uint8Array, roomId: Uint8Array, docId: Uint8Array): Uint8Array {
  return sha256(concat(DOMAIN_TAG, k, contentHash, roomId, docId));
}

/** The on-chain document fields needed to recover + verify the sealed key (all hex). */
export interface DataroomDisclosure {
  ephPub: string;
  ct: string;
  tag: string;
  contentHash: string;
  roomId: string;
  docId: string;
}

export interface RecoveredKey {
  /** The recovered 32-byte document key K. Only meaningful when `faithful` is true. */
  k: Uint8Array;
  /** True iff the recomputed tag matched — right recipient key AND K is the one bound to THIS document. */
  faithful: boolean;
}

/**
 * Recover the document key `K` from `(ephPub, ct)` with the recipient's x25519 SECRET (hex) and verify it
 * against the committed `tag` + the public `(contentHash, roomId, docId)`. `faithful` is true iff the
 * recomputed tag matches — i.e. the right recipient key AND K is the key the proof bound to THIS blob +
 * document (no bait-and-switch; also detects a wrong recipient key). Pure; key-free; no I/O.
 */
export function recoverDocumentKey(d: DataroomDisclosure, recipientSecretHex: string): RecoveredKey {
  const ct = fromHex(d.ct);
  const ephPub = fromHex(d.ephPub);
  const tag = fromHex(d.tag);
  const contentHash = fromHex(d.contentHash);
  const roomId = fromHex(d.roomId);
  const docId = fromHex(d.docId);
  const secret = fromHex(recipientSecretHex);
  // Validate every 32-byte input up front (clear errors instead of a deep x25519 throw or a silent
  // faithful=false from a wrong-length tag preimage — this is the public, key-free entry point).
  for (const [name, v] of [["ct", ct], ["ephPub", ephPub], ["tag", tag], ["contentHash", contentHash], ["roomId", roomId], ["docId", docId], ["recipientSecret", secret]] as const) {
    if (v.length !== K_LEN) throw new Error(`${name} must be ${K_LEN} bytes`);
  }
  const shared = x25519.getSharedSecret(secret, ephPub);
  const ks = keystream(shared, ephPub);
  const k = new Uint8Array(K_LEN);
  for (let i = 0; i < K_LEN; i++) k[i] = ct[i] ^ ks[i];
  const recomputed = sealTag(k, contentHash, roomId, docId);
  let faithful = recomputed.length === tag.length;
  for (let i = 0; i < tag.length && faithful; i++) if (recomputed[i] !== tag[i]) faithful = false;
  return { k, faithful };
}

/** Derive the recipient's x25519 public key from a secret (hex) — for targeting / allow-list checks. */
export function recipientPublicKeyFromSecret(recipientSecretHex: string): string {
  const secret = fromHex(recipientSecretHex);
  if (secret.length !== K_LEN) throw new Error(`recipientSecret must be ${K_LEN} bytes`);
  return toHex(x25519.getPublicKey(secret));
}

/**
 * AES-256-GCM decrypt of a stored blob `iv(12) ‖ ciphertext ‖ tag(16)` under the recovered key `K`.
 * Uses the platform WebCrypto (browser + Node ≥ 18), which expects `ciphertext ‖ tag` as the body — the
 * exact byte layout the backend's `aeadSeal` produces. Throws if the GCM tag fails (wrong key / tamper).
 */
export async function aeadDecrypt(blob: Uint8Array, k: Uint8Array): Promise<Uint8Array> {
  if (k.length !== K_LEN) throw new Error("AEAD key must be 32 bytes");
  // `<=` (not `<`): a blob of exactly iv+tag would be a zero-length-ciphertext seal, which we never produce.
  if (blob.length <= AEAD_IV_LEN + AEAD_TAG_LEN) throw new Error("blob too short");
  const iv = blob.slice(0, AEAD_IV_LEN);
  const body = blob.slice(AEAD_IV_LEN); // ciphertext ‖ tag — WebCrypto wants the tag appended
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto subtle unavailable (need a modern browser or Node ≥ 18)");
  // Copy into fresh ArrayBuffers — WebCrypto's BufferSource type rejects Uint8Array<ArrayBufferLike>.
  const key = await subtle.importKey("raw", toArrayBuffer(k), "AES-GCM", false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(body));
  return new Uint8Array(pt);
}

/** Copy a view's bytes into a fresh, plain ArrayBuffer (satisfies WebCrypto's strict BufferSource type). */
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u.byteLength);
  new Uint8Array(ab).set(u);
  return ab;
}

// ── Dealer side (browser): encrypt + seal, mirroring the backend byte-for-byte ──
// These let the OWNER's browser be the dealer (Model B): generate K, AES-seal the document, and ECIES-seal
// K to a recipient (the owner-escrow copy, or a 1:1 direct share), so the server never sees K or plaintext.

/** Cryptographically-strong random bytes via WebCrypto (browser + Node >= 18). */
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error("WebCrypto getRandomValues unavailable (need a modern browser or Node >= 18)");
  c.getRandomValues(b);
  return b;
}

/** A fresh 32-byte document key K. */
export function randomKey(): Uint8Array {
  return randomBytes(K_LEN);
}

/**
 * AES-256-GCM seal: returns `iv(12) ‖ ciphertext ‖ tag(16)`, the exact byte layout the backend `aeadSeal`
 * produces (so {@link aeadDecrypt} and the on-chain `content_hash = sha256(blob)` agree). The document is
 * encrypted in the caller's environment; only the resulting blob is uploaded.
 */
export async function aeadSeal(plaintext: Uint8Array, k: Uint8Array): Promise<Uint8Array> {
  if (k.length !== K_LEN) throw new Error("AEAD key must be 32 bytes");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto subtle unavailable (need a modern browser or Node >= 18)");
  const iv = randomBytes(AEAD_IV_LEN);
  const key = await subtle.importKey("raw", toArrayBuffer(k), "AES-GCM", false, ["encrypt"]);
  const body = await subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(plaintext));
  return concat(iv, new Uint8Array(body)); // WebCrypto returns ciphertext ‖ tag, matching the backend
}

/**
 * Seal a 32-byte document key `K` to a recipient's x25519 public key, bound to `(contentHash, room, doc)`.
 * Returns the {@link DataroomDisclosure} the recipient opens with {@link recoverDocumentKey}. This is a plain
 * ECIES seal (no ZK proof, no guest) used for the owner-escrow copy and 1:1 direct shares; the faithful tag
 * makes a seal non-portable across documents. `ephSecret` is injectable for deterministic test vectors.
 */
export function sealDocumentKey(
  k: Uint8Array,
  recipientPubHex: string,
  contentHashHex: string,
  roomIdHex: string,
  docIdHex: string,
  ephSecret?: Uint8Array,
): DataroomDisclosure {
  if (k.length !== K_LEN) throw new Error("doc key K must be 32 bytes");
  const recipientPub = fromHex(recipientPubHex);
  const contentHash = fromHex(contentHashHex);
  const roomId = fromHex(roomIdHex);
  const docId = fromHex(docIdHex);
  const eph = ephSecret ?? randomBytes(K_LEN);
  if (eph.length !== K_LEN) throw new Error("ephSecret must be 32 bytes");
  const ephPub = x25519.getPublicKey(eph);
  const shared = x25519.getSharedSecret(eph, recipientPub);
  const ks = keystream(shared, ephPub);
  const ct = new Uint8Array(K_LEN);
  for (let i = 0; i < K_LEN; i++) ct[i] = k[i] ^ ks[i];
  return {
    ephPub: toHex(ephPub),
    ct: toHex(ct),
    tag: toHex(sealTag(k, contentHash, roomId, docId)),
    contentHash: contentHashHex,
    roomId: roomIdHex,
    docId: docIdHex,
  };
}
