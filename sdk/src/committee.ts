// DR3 — Confidential Data Room threshold-committee RECIPIENT side (key-free, browser + Node).
//
// A committee document's key `K` is Shamir-split (GF(256), t=2/n=3) across the keyper committee; each keyper
// ECIES-seals its share to the proof-bound recipient_pub once the requester wins the DR2 grant. This module
// is the RECIPIENT half: ECIES-open each sealed share with the recipient's x25519 SECRET, then
// Lagrange-reconstruct `K` (commitment-gated, robust to one bad share). Pure + key-free — the caller supplies
// their own recipient secret; the SDK NEVER custodies it. MUST agree byte-for-byte with:
//   backend/src/shamir.ts (reconstruct) + backend/src/committee.ts (share ECIES) + keyper/src/share-ecies.ts
// (pinned by the frozen vectors in `assertFrozenVectors`).
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { fromHex, toHex } from "./journal.js";

const DOMAIN_KS = new TextEncoder().encode("zkorage-dataroom-ecies-v1/ks"); // SAME as the DR1 seal.
const DOMAIN_SHARE_TAG = new TextEncoder().encode("zkorage-dataroom-share-v1/tag"); // DR3 share tag.
const SHARE_LEN = 32;

// ── GF(2^8) (AES field 0x11b) — the byte-wise Shamir math, reconstruct half only ──

function gmul(a: number, b: number): number {
  let p = 0;
  a &= 0xff;
  b &= 0xff;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 0xff;
}

function ginv(a: number): number {
  a &= 0xff;
  if (a === 0) throw new Error("GF(256) inverse of 0 is undefined");
  let result = 1;
  let base = a;
  let e = 254;
  while (e > 0) {
    if (e & 1) result = gmul(result, base);
    base = gmul(base, base);
    e >>= 1;
  }
  return result;
}

/** GF(2^8) exponentiation by a small non-negative integer (evaluate x^d for share points; dealer side). */
function gpow(a: number, e: number): number {
  let result = 1;
  let base = a & 0xff;
  let ee = e;
  while (ee > 0) {
    if (ee & 1) result = gmul(result, base);
    base = gmul(base, base);
    ee >>= 1;
  }
  return result;
}

/** A Shamir share: its evaluation point `x` (keyper index 1..n) and the 32 share bytes `y`. */
export interface ReconShare {
  x: number;
  y: Uint8Array;
}

/**
 * DEALER side: split `secret` into `n` shares with threshold `t` over GF(2^8), byte-wise (evaluation points
 * 1..n). Any `t` reconstruct it; any `t-1` reveal nothing. Mirrors backend/src/shamir.ts byte-for-byte
 * ({@link shamirReconstruct} inverts it). `coeffs` injects the random degree-1..(t-1) coefficient vectors for
 * deterministic test vectors; production passes none -> WebCrypto CSPRNG.
 */
export function shamirSplit(
  secret: Uint8Array,
  t: number,
  n: number,
  opts: { xs?: number[]; coeffs?: Uint8Array[] } = {},
): ReconShare[] {
  if (t < 1 || t > n) throw new Error("require 1 <= t <= n");
  if (n < 1 || n > 255) throw new Error("require 1 <= n <= 255");
  const len = secret.length;
  const xs = opts.xs ?? Array.from({ length: n }, (_, i) => i + 1);
  if (xs.length !== n) throw new Error("xs must have n entries");
  if (new Set(xs).size !== n) throw new Error("evaluation points must be distinct");
  for (const x of xs) if (x < 1 || x > 255) throw new Error("evaluation points must be in 1..255");
  const coeffs: Uint8Array[] = [];
  for (let d = 1; d < t; d++) {
    const c = opts.coeffs?.[d - 1] ?? randomBytes(len);
    if (c.length !== len) throw new Error("each coefficient vector must match the secret length");
    coeffs.push(c);
  }
  return xs.map((x) => {
    const y = new Uint8Array(len);
    for (let j = 0; j < len; j++) {
      let acc = secret[j];
      for (let d = 1; d < t; d++) acc ^= gmul(coeffs[d - 1][j], gpow(x, d));
      y[j] = acc;
    }
    return { x, y };
  });
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error("WebCrypto getRandomValues unavailable (need a modern browser or Node >= 18)");
  c.getRandomValues(b);
  return b;
}

/** Reconstruct the 32-byte secret from >= t shares via Lagrange interpolation at x=0 (GF(256)). */
export function shamirReconstruct(shares: ReconShare[]): Uint8Array {
  if (shares.length === 0) throw new Error("need at least one share");
  const len = shares[0].y.length;
  for (const s of shares) {
    if (s.y.length !== len) throw new Error("all shares must have equal length");
    if (s.x < 1 || s.x > 255) throw new Error("share x must be in 1..255");
  }
  if (new Set(shares.map((s) => s.x)).size !== shares.length) throw new Error("share points must be distinct");
  const out = new Uint8Array(len);
  for (let j = 0; j < len; j++) {
    let acc = 0;
    for (let k = 0; k < shares.length; k++) {
      let lk = 1;
      for (let m = 0; m < shares.length; m++) {
        if (m === k) continue;
        lk = gmul(lk, gmul(shares[m].x, ginv(shares[m].x ^ shares[k].x)));
      }
      acc ^= gmul(shares[k].y[j], lk);
    }
    out[j] = acc;
  }
  return out;
}

// ── Threshold-ECIES share open (mirror of the keyper seal) ──

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

function keystream(shared: Uint8Array, ephPub: Uint8Array): Uint8Array {
  return sha256(concat(DOMAIN_KS, shared, ephPub, new Uint8Array(4)));
}

function shareTag(keyperIndex: number, shareY: Uint8Array, roomId: Uint8Array, docId: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  return sha256(concat(DOMAIN_SHARE_TAG, Uint8Array.of(keyperIndex), shareY, roomId, docId, recipientPub));
}

/** A sealed share as served by a keyper (all hex). */
export interface SealedShareHex {
  keyperIndex: number;
  ephPub: string;
  ct: string;
  tag: string;
}

export interface OpenedShare {
  keyperIndex: number;
  shareY: Uint8Array;
  faithful: boolean;
}

/**
 * Open a sealed share with the recipient's x25519 SECRET and verify its tag against the public
 * `(keyper_index, room_id, doc_id, recipient_pub)`. `faithful=false` flags a wrong recipient key or a
 * tampered/mis-bound share. Pure; key-free; no I/O.
 */
export function openShare(
  sealed: SealedShareHex,
  recipientSecretHex: string,
  roomIdHex: string,
  docIdHex: string,
  recipientPubHex: string,
): OpenedShare {
  const ct = fromHex(sealed.ct);
  const ephPub = fromHex(sealed.ephPub);
  const tag = fromHex(sealed.tag);
  const secret = fromHex(recipientSecretHex);
  const roomId = fromHex(roomIdHex);
  const docId = fromHex(docIdHex);
  const recipientPub = fromHex(recipientPubHex);
  for (const [name, v] of [["ct", ct], ["ephPub", ephPub], ["tag", tag], ["recipientSecret", secret], ["roomId", roomId], ["docId", docId], ["recipientPub", recipientPub]] as const) {
    if (v.length !== SHARE_LEN) throw new Error(`${name} must be ${SHARE_LEN} bytes`);
  }
  const shared = x25519.getSharedSecret(secret, ephPub);
  const ks = keystream(shared, ephPub);
  const shareY = new Uint8Array(SHARE_LEN);
  for (let i = 0; i < SHARE_LEN; i++) shareY[i] = ct[i] ^ ks[i];
  const recomputed = shareTag(sealed.keyperIndex, shareY, roomId, docId, recipientPub);
  let faithful = recomputed.length === tag.length;
  for (let i = 0; i < tag.length && faithful; i++) if (recomputed[i] !== tag[i]) faithful = false;
  return { keyperIndex: sealed.keyperIndex, shareY, faithful };
}

/**
 * DEALER side: ECIES-seal a 32-byte Shamir share to `recipientPub` (here a keeper's static x25519 key when
 * dealing, or the reader's recipient key), binding it to `(keyper_index, room, doc, recipientPub)` so it is
 * non-portable. Inverse of {@link openShare}; mirrors backend/src/committee.ts shareEciesSeal byte-for-byte.
 * `ephSecret` is injectable for deterministic test vectors.
 */
export function sealShare(
  shareY: Uint8Array,
  keyperIndex: number,
  recipientPubHex: string,
  roomIdHex: string,
  docIdHex: string,
  ephSecret?: Uint8Array,
): SealedShareHex {
  if (keyperIndex < 1 || keyperIndex > 255) throw new Error("keyper_index must be 1..255");
  const recipientPub = fromHex(recipientPubHex);
  const roomId = fromHex(roomIdHex);
  const docId = fromHex(docIdHex);
  const eph = ephSecret ?? randomBytes(SHARE_LEN);
  for (const [name, v] of [["shareY", shareY], ["recipientPub", recipientPub], ["ephSecret", eph], ["roomId", roomId], ["docId", docId]] as const) {
    if (v.length !== SHARE_LEN) throw new Error(`${name} must be ${SHARE_LEN} bytes`);
  }
  const ephPub = x25519.getPublicKey(eph);
  const shared = x25519.getSharedSecret(eph, recipientPub);
  const ks = keystream(shared, ephPub);
  const ct = new Uint8Array(SHARE_LEN);
  for (let i = 0; i < SHARE_LEN; i++) ct[i] = shareY[i] ^ ks[i];
  return {
    keyperIndex,
    ephPub: toHex(ephPub),
    ct: toHex(ct),
    tag: toHex(shareTag(keyperIndex, shareY, roomId, docId, recipientPub)),
  };
}

export interface ReconstructResult {
  k: Uint8Array;
  pair: [number, number];
}

/**
 * Recover `K` from >= 2 opened shares by trying each 2-of-3 pair and accepting the one whose `sha256(K)`
 * equals the on-chain `kCommitment` (hex). Robust to one bad/malicious share. Throws if no pair matches.
 */
export function reconstructWithCommitment(opened: OpenedShare[], kCommitmentHex: string): ReconstructResult {
  const usable = opened.filter((o) => o.faithful);
  if (usable.length < 2) throw new Error("need >= 2 faithfully-opened shares to reconstruct (threshold t=2)");
  const kCommitment = fromHex(kCommitmentHex);
  if (kCommitment.length !== 32) throw new Error("kCommitment must be 32 bytes");
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const k = shamirReconstruct([
        { x: usable[i].keyperIndex, y: usable[i].shareY },
        { x: usable[j].keyperIndex, y: usable[j].shareY },
      ]);
      const c = sha256(k);
      let match = c.length === kCommitment.length;
      for (let b = 0; b < kCommitment.length && match; b++) if (c[b] !== kCommitment[b]) match = false;
      if (match) return { k, pair: [usable[i].keyperIndex, usable[j].keyperIndex] };
    }
  }
  throw new Error("no 2-of-3 pair reconstructs a K matching the on-chain commitment");
}

/** Derive an x25519 public key (hex) from a recipient secret (hex) — for targeting / matching the grant. */
export function recipientPublicKeyFromSecret(recipientSecretHex: string): string {
  const secret = fromHex(recipientSecretHex);
  if (secret.length !== SHARE_LEN) throw new Error(`recipientSecret must be ${SHARE_LEN} bytes`);
  return toHex(x25519.getPublicKey(secret));
}

/** Self-check this module against the backend's frozen vectors (byte-exactness across implementations). */
export function assertFrozenVectors(): void {
  // 1) Shamir reconstruct — the backend's frozen 2-of-3 shares must reconstruct the frozen K.
  const K = "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc";
  const s1 = "123a5e76928ae6de326a0e36d2faa68e725abed6f20a267e52aa8e96b25a660e";
  const s2 = "216a8fc41e65a0fb2912c79c460df8b3713aff3475b5f00b4282d76c2dfda863";
  const rec = shamirReconstruct([{ x: 1, y: fromHex(s1) }, { x: 2, y: fromHex(s2) }]);
  if (toHex(rec) !== K) throw new Error("SDK shamirReconstruct drifted from the backend frozen vector");
  // 2) Share open — the backend's frozen sealed share must open to the frozen share_y, faithfully.
  const shareY = toHex(Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)));
  const recipientSecret = toHex(sha256(new TextEncoder().encode("dr3-frozen-recipient")).slice(0, 32));
  const recipientPub = recipientPublicKeyFromSecret(recipientSecret);
  const roomId = toHex(sha256(new TextEncoder().encode("dr3-frozen-room")).slice(0, 32));
  const docId = toHex(sha256(new TextEncoder().encode("dr3-frozen-doc")).slice(0, 32));
  const sealed: SealedShareHex = {
    keyperIndex: 2,
    ephPub: "a86cb76a28c69482a6beaa195a83527d24275e8d76cba223c647238846c9b92b",
    ct: "6fc6f29ca740b13ae4b3f014f862bbb40b7b314064e6914a120c3f21ecc1206a",
    tag: "55019e11c71b5ba94bead89c27091ac7ccb1f43d602ba68d289e9c99bdcd9788",
  };
  const o = openShare(sealed, recipientSecret, roomId, docId, recipientPub);
  if (!o.faithful || toHex(o.shareY) !== shareY) throw new Error("SDK openShare drifted from the backend frozen vector");
}
