// zkorage DR3 — Shamir secret sharing over GF(2^8) (byte-wise), the dealer's split + the reconstruct math.
//
// The per-document key K (32 bytes, AES-256) is split into n shares with threshold t: any t shares
// reconstruct K, any t-1 reveal NOTHING about it (information-theoretic). The DR3 dealer (the self-hosted
// upload service) splits K, hands one share to each keyper, then DELETES K — so after dealing no single
// party holds K. The recipient (after winning the DR2 anonymous-eligibility grant) collects >= t sealed
// shares from the committee, reconstructs K client-side, and decrypts the blob.
//
// Field: GF(2^8) with the AES reduction polynomial x^8+x^4+x^3+x+1 (0x11b). Secret-sharing is done
// independently per byte position: for byte j the dealer samples a random degree-(t-1) polynomial p_j with
// p_j(0) = K[j]; share i at evaluation point x_i is [p_j(x_i)]_j. Reconstruction is Lagrange interpolation
// at x = 0. This module is the CANONICAL implementation; the SDK (sdk/src/committee.ts) mirrors the
// reconstruct half byte-for-byte for the in-browser recipient, cross-checked by the frozen test vector below.
//
// Why hand-rolled: GF(256) Shamir for small (t,n) is ~one screen of well-understood code and matches the
// project's "hand-rolled crypto with byte-exact cross-impl self-tests" pattern (Merkle, ECIES). No deps.
import { randomBytes } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/** GF(2^8) multiply (AES field, reduction 0x11b). Constant set of shifts; no table needed. */
export function gmul(a: number, b: number): number {
  let p = 0;
  a &= 0xff;
  b &= 0xff;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b; // x^8 ≡ x^4+x^3+x+1 (low byte of 0x11b)
    b >>= 1;
  }
  return p & 0xff;
}

/** GF(2^8) multiplicative inverse: a^254 = a^-1 (since a^255 = 1 for a != 0). inv(0) is undefined. */
export function ginv(a: number): number {
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

/** GF(2^8) exponentiation by a small non-negative integer (used to evaluate x^d for share points). */
export function gpow(a: number, e: number): number {
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

/** A single Shamir share: its evaluation point `x` (the keyper index, 1..n) and the 32 share bytes `y`. */
export interface Share {
  x: number; // 1..255, distinct per share (the keyper index)
  y: Uint8Array; // p(x) per secret byte
}

/**
 * Split `secret` into `n` shares with threshold `t` over GF(2^8), byte-wise. Evaluation points default to
 * 1..n (the keyper indices). `coeffs` injects the random degree-1..(t-1) coefficient vectors (one
 * `secret.length`-byte vector per degree) for DETERMINISTIC test vectors; production passes none → CSPRNG.
 * Any `t` of the returned shares reconstruct `secret`; any `t-1` reveal nothing.
 */
export function shamirSplit(
  secret: Uint8Array,
  t: number,
  n: number,
  opts: { xs?: number[]; coeffs?: Uint8Array[] } = {},
): Share[] {
  if (t < 1 || t > n) throw new Error("require 1 <= t <= n");
  if (n < 1 || n > 255) throw new Error("require 1 <= n <= 255");
  const len = secret.length;
  const xs = opts.xs ?? Array.from({ length: n }, (_, i) => i + 1);
  if (xs.length !== n) throw new Error("xs must have n entries");
  if (new Set(xs).size !== n) throw new Error("evaluation points must be distinct");
  for (const x of xs) {
    if (x < 1 || x > 255) throw new Error("evaluation points must be in 1..255 (x=0 is the secret)");
  }
  // Random coefficients for degrees 1..t-1 (each a `len`-byte vector). Degree 0 is the secret itself.
  const coeffs: Uint8Array[] = [];
  for (let d = 1; d < t; d++) {
    const c = opts.coeffs?.[d - 1] ?? new Uint8Array(randomBytes(len));
    if (c.length !== len) throw new Error("each coefficient vector must match the secret length");
    coeffs.push(c);
  }
  return xs.map((x) => {
    const y = new Uint8Array(len);
    for (let j = 0; j < len; j++) {
      let acc = secret[j]; // p_j(0)
      for (let d = 1; d < t; d++) {
        acc ^= gmul(coeffs[d - 1][j], gpow(x, d));
      }
      y[j] = acc;
    }
    return { x, y };
  });
}

/**
 * Reconstruct the secret from `shares` (>= t of them, with distinct x's) via Lagrange interpolation at
 * x = 0: secret[j] = Σ_k y_k[j] · L_k(0), L_k(0) = Π_{m≠k} x_m / (x_m − x_k) — and subtraction is XOR in
 * GF(2^8). Pass exactly the shares you trust; with t=2 a single pair is enough. The caller verifies the
 * result out-of-band (AES-GCM on the blob), so a bad share surfaces as a wrong K, not a thrown error.
 */
export function shamirReconstruct(shares: Share[]): Uint8Array {
  if (shares.length === 0) throw new Error("need at least one share");
  const len = shares[0].y.length;
  for (const s of shares) {
    if (s.y.length !== len) throw new Error("all shares must have equal length");
    if (s.x < 1 || s.x > 255) throw new Error("share x must be in 1..255");
  }
  if (new Set(shares.map((s) => s.x)).size !== shares.length) {
    throw new Error("share evaluation points must be distinct");
  }
  const out = new Uint8Array(len);
  for (let j = 0; j < len; j++) {
    let secretByte = 0;
    for (let k = 0; k < shares.length; k++) {
      // Lagrange basis L_k(0) = Π_{m≠k} x_m · (x_m ⊕ x_k)^-1.
      let lk = 1;
      for (let m = 0; m < shares.length; m++) {
        if (m === k) continue;
        const num = shares[m].x;
        const den = shares[m].x ^ shares[k].x; // x_m − x_k == x_m ⊕ x_k in GF(2^8)
        lk = gmul(lk, gmul(num, ginv(den)));
      }
      secretByte ^= gmul(shares[k].y[j], lk);
    }
    out[j] = secretByte;
  }
  return out;
}

// ── CLI self-test: `npx tsx src/shamir.ts` ──
// Robust main-module check (a bare `file://${argv[1]}` never matches under tsx on Windows).
const isMain = !!process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const toHex = (u: Uint8Array) => Buffer.from(u).toString("hex");
  const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

  // 1) GF(256) sanity: inverses round-trip for every non-zero element.
  for (let a = 1; a < 256; a++) {
    if (gmul(a, ginv(a)) !== 1) throw new Error(`ginv failed at ${a}`);
  }
  console.log("[ok] GF(256) inverse round-trips for all 255 non-zero elements");

  // 2) Frozen 2-of-3 vector (deterministic coefficients) — the SDK + keyper mirrors assert these EXACT
  //    bytes, pinning byte-exactness across the three implementations.
  const K = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
  const coeff = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 31 + 17) & 0xff));
  const shares = shamirSplit(K, 2, 3, { coeffs: [coeff] });
  console.log("[vector] K       =", toHex(K));
  shares.forEach((s) => console.log(`[vector] share x=${s.x} y =`, toHex(s.y)));
  // Frozen 2-of-3 vector for K=(7i+3) with coeff=(31i+17). The SDK/keyper mirrors assert these EXACT
  //   bytes (see FROZEN_SHARE_VECTOR in sdk/src/committee.ts) → byte-exactness pinned across all impls.
  const EXPECT = {
    K: "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc",
    s1: "123a5e76928ae6de326a0e36d2faa68e725abed6f20a267e52aa8e96b25a660e",
    s2: "216a8fc41e65a0fb2912c79c460df8b3713aff3475b5f00b4282d76c2dfda863",
    s3: "305ac0aa93c96b11203a80fac3a93b51701ac06a08294bd1bb9ae03a58691bb1",
  };
  if (EXPECT.K !== toHex(K)) throw new Error("frozen K vector drifted");
  if (toHex(shares[0].y) !== EXPECT.s1) throw new Error("frozen share x=1 drifted");
  if (toHex(shares[1].y) !== EXPECT.s2) throw new Error("frozen share x=2 drifted");
  if (toHex(shares[2].y) !== EXPECT.s3) throw new Error("frozen share x=3 drifted");
  console.log("[ok] frozen 2-of-3 share vector matches (pins SDK/keyper byte-exactness)");
  // Reconstruct from every 2-of-3 pair → must equal K.
  const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2]];
  for (const [a, b] of pairs) {
    const r = shamirReconstruct([shares[a], shares[b]]);
    if (!eq(r, K)) throw new Error(`reconstruct pair (${shares[a].x},${shares[b].x}) != K`);
  }
  console.log("[ok] all three 2-of-3 pairs reconstruct K exactly");

  // 3) Randomized round-trips: 500 random K, random coefficient, every pair must reconstruct.
  for (let it = 0; it < 500; it++) {
    const rk = new Uint8Array(randomBytes(32));
    const sh = shamirSplit(rk, 2, 3);
    for (const [a, b] of pairs) {
      if (!eq(shamirReconstruct([sh[a], sh[b]]), rk)) {
        throw new Error(`random round-trip FAILED at iter ${it}, pair (${a},${b})`);
      }
    }
    // A single share must NOT equal the secret (t=2 hides it). Vanishingly unlikely to collide.
    if (eq(sh[0].y, rk)) throw new Error("single share leaked the secret");
  }
  console.log("[ok] 500 random 32-byte secrets — every 2-of-3 pair reconstructs; single share hides");

  // 4) t=2/n=3 robustness intuition: a single corrupted share yields a WRONG reconstruction (caught later
  //    by AES-GCM), but the all-honest pair still recovers K.
  const bad = { x: shares[2].x, y: Uint8Array.from(shares[2].y.map((v) => v ^ 0xff)) };
  const withBad = shamirReconstruct([shares[0], bad]); // honest #1 + corrupted #3
  const honest = shamirReconstruct([shares[0], shares[1]]); // honest #1 + honest #2
  if (eq(withBad, K)) throw new Error("corrupted share unexpectedly reconstructed K");
  if (!eq(honest, K)) throw new Error("all-honest pair must reconstruct K");
  console.log("[ok] corrupted share → wrong K (GCM will reject); all-honest pair → K");

  console.log("[PASS] shamir.ts self-test");
}
