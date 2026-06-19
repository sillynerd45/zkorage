// zkorage DR3 — threshold-ECIES share seal/open (the keyper's per-share envelope).
//
// Each keyper holds one Shamir share `share_y` (32 bytes) of the per-document key K (see shamir.ts). When a
// requester wins the DR2 anonymous-eligibility grant, the keyper ECIES-seals its share to the proof-bound
// `recipient_pub` (the x25519 key NEW-5 committed on-chain) and serves it. The recipient ECIES-opens each
// share with their x25519 secret, then Lagrange-reconstructs K from any t shares.
//
// The ECIES PRIMITIVE is the DR1 seal's, reused byte-for-byte (same DOMAIN_KS, same single-block keystream):
//   keystream = sha256("zkorage-dataroom-ecies-v1/ks" ‖ shared ‖ eph_pub ‖ 0x00000000)
//   ct        = share_y ⊕ keystream                          (32 bytes — one sha256 block)
// Only the integrity TAG gets a fresh domain (this is off-chain only — no guest, no image_id — so the tag
// preimage is free to choose). The tag binds the share to THIS keyper + document + recipient so the
// recipient can detect a wrong recipient key or an in-transit tamper BEFORE reconstructing:
//   tag = sha256("zkorage-dataroom-share-v1/tag" ‖ keyper_index(1) ‖ share_y ‖ room_id ‖ doc_id ‖ recipient_pub)
// The AUTHORITATIVE faithfulness check remains AES-GCM on the reconstructed-K-decrypted blob (a wrong share
// from a malicious keyper yields a wrong K → GCM rejects → the recipient tries another 2-of-3 pair).
//
// Mirrors: keyper/src/share-ecies.ts (seal) + sdk/src/committee.ts (open) — kept byte-exact by the frozen
// vector in this module's self-test. MUST agree with backend/src/disclosure.ts DR1 keystream byte-for-byte.
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { shamirReconstruct, type Share } from "./shamir.js";

const DOMAIN_KS = new TextEncoder().encode("zkorage-dataroom-ecies-v1/ks"); // SAME as DR1 seal — reused.
const DOMAIN_SHARE_TAG = new TextEncoder().encode("zkorage-dataroom-share-v1/tag"); // NEW (share tag).
const SHARE_LEN = 32; // a Shamir share of a 32-byte K is 32 bytes → one sha256 keystream block (ctr 0).

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

/** Single 32-byte keystream block: sha256(DOMAIN_KS ‖ shared ‖ eph_pub ‖ ctr0_be4). Identical to DR1. */
function keystream(shared: Uint8Array, ephPub: Uint8Array): Uint8Array {
  return sha256(concat(DOMAIN_KS, shared, ephPub, new Uint8Array(4)));
}

/** Share tag = sha256(DOMAIN_SHARE_TAG ‖ keyper_index(1) ‖ share_y ‖ room_id ‖ doc_id ‖ recipient_pub). */
export function shareTag(
  keyperIndex: number,
  shareY: Uint8Array,
  roomId: Uint8Array,
  docId: Uint8Array,
  recipientPub: Uint8Array,
): Uint8Array {
  if (keyperIndex < 1 || keyperIndex > 255) throw new Error("keyper_index must be 1..255");
  return sha256(
    concat(DOMAIN_SHARE_TAG, Uint8Array.of(keyperIndex), shareY, roomId, docId, recipientPub),
  );
}

/** A keyper's sealed share, as served to a granted recipient. `keyperIndex` is the Shamir x-coordinate. */
export interface SealedShare {
  keyperIndex: number; // Shamir x (1..n) — also the share's evaluation point
  ephPub: Uint8Array; // 32
  ct: Uint8Array; // 32 (sealed share_y)
  tag: Uint8Array; // 32
}

/**
 * SEAL (keyper side): ECIES-encrypt a 32-byte Shamir share to `recipientPub`, binding it to the keyper +
 * document + recipient. `ephSecret` is fresh per seal (CSPRNG in production; injected for test vectors).
 */
export function shareEciesSeal(
  shareY: Uint8Array,
  keyperIndex: number,
  recipientPub: Uint8Array,
  ephSecret: Uint8Array,
  roomId: Uint8Array,
  docId: Uint8Array,
): SealedShare {
  for (const [name, v] of [["shareY", shareY], ["recipientPub", recipientPub], ["ephSecret", ephSecret], ["roomId", roomId], ["docId", docId]] as const) {
    if (v.length !== SHARE_LEN) throw new Error(`${name} must be ${SHARE_LEN} bytes`);
  }
  const ephPub = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, recipientPub);
  const ks = keystream(shared, ephPub);
  const ct = new Uint8Array(SHARE_LEN);
  for (let i = 0; i < SHARE_LEN; i++) ct[i] = shareY[i] ^ ks[i];
  return { keyperIndex, ephPub, ct, tag: shareTag(keyperIndex, shareY, roomId, docId, recipientPub) };
}

export interface OpenedShare {
  keyperIndex: number;
  shareY: Uint8Array; // recovered 32-byte share (only meaningful when faithful)
  faithful: boolean; // tag matched (correct recipient key + untampered, bound to THIS doc + keyper)
}

/**
 * OPEN (recipient side): recover `share_y` from a sealed share with the recipient's x25519 secret and verify
 * the tag against the public `(keyper_index, room_id, doc_id, recipient_pub)`. `faithful=false` flags a wrong
 * recipient key or a tampered/mis-bound share. Pure + key-free → mirrored into the SDK for the in-browser
 * recipient. The recipient still gates final correctness on AES-GCM after reconstruction.
 */
export function shareEciesOpen(
  sealed: SealedShare,
  recipientSecret: Uint8Array,
  roomId: Uint8Array,
  docId: Uint8Array,
  recipientPub: Uint8Array,
): OpenedShare {
  for (const [name, v] of [["ct", sealed.ct], ["ephPub", sealed.ephPub], ["tag", sealed.tag], ["recipientSecret", recipientSecret], ["roomId", roomId], ["docId", docId], ["recipientPub", recipientPub]] as const) {
    if (v.length !== SHARE_LEN) throw new Error(`${name} must be ${SHARE_LEN} bytes`);
  }
  const shared = x25519.getSharedSecret(recipientSecret, sealed.ephPub);
  const ks = keystream(shared, sealed.ephPub);
  const shareY = new Uint8Array(SHARE_LEN);
  for (let i = 0; i < SHARE_LEN; i++) shareY[i] = sealed.ct[i] ^ ks[i];
  const recomputed = shareTag(sealed.keyperIndex, shareY, roomId, docId, recipientPub);
  let faithful = recomputed.length === sealed.tag.length;
  for (let i = 0; i < sealed.tag.length && faithful; i++) if (recomputed[i] !== sealed.tag[i]) faithful = false;
  return { keyperIndex: sealed.keyperIndex, shareY, faithful };
}

/** An opened share ready for reconstruction (the Shamir x-coordinate + recovered 32-byte y). */
export interface ReconstructShare {
  keyperIndex: number;
  shareY: Uint8Array;
}

export interface ReconstructResult {
  k: Uint8Array;
  pair: [number, number]; // the keyper indices whose 2-of-3 pair reconstructed K
}

/**
 * From >= 2 opened shares, recover the document key `K` by trying each 2-of-3 pair and accepting the one
 * whose `sha256(K)` matches the on-chain `kCommitment`. This is ROBUST to one bad/malicious share: a pair
 * containing it reconstructs a wrong K (commitment mismatch) and is skipped, while the all-honest pair
 * succeeds. Throws if no pair matches (too few honest shares, or wrong recipient key upstream). The caller
 * still AES-GCM-decrypts the blob with `K` as the final authenticity gate.
 */
export function reconstructWithCommitment(
  opened: ReconstructShare[],
  kCommitment: Uint8Array,
): ReconstructResult {
  if (opened.length < 2) throw new Error("need >= 2 opened shares to reconstruct (threshold t=2)");
  if (kCommitment.length !== 32) throw new Error("kCommitment must be 32 bytes");
  const shares: Share[] = opened.map((o) => ({ x: o.keyperIndex, y: o.shareY }));
  for (let i = 0; i < shares.length; i++) {
    for (let j = i + 1; j < shares.length; j++) {
      const k = shamirReconstruct([shares[i], shares[j]]);
      const c = sha256(k);
      let match = c.length === kCommitment.length;
      for (let b = 0; b < kCommitment.length && match; b++) if (c[b] !== kCommitment[b]) match = false;
      if (match) return { k, pair: [shares[i].x, shares[j].x] };
    }
  }
  throw new Error("no 2-of-3 pair reconstructs a K matching the on-chain commitment");
}

// ── CLI self-test: `npx tsx src/committee.ts` — full DR3 crypto round-trip + negatives ──
const isMain = !!process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const run = async () => {
    const { shamirSplit, shamirReconstruct } = await import("./shamir.js");
    const { aeadSeal, aeadOpen, randomKey } = await import("./disclosure.js");
    const toHex = (u: Uint8Array) => Buffer.from(u).toString("hex");
    const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

    // Frozen share-seal vector (deterministic) — the SDK mirror asserts these EXACT bytes.
    const fShareY = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
    const fRecipientSecret = sha256(new TextEncoder().encode("dr3-frozen-recipient")).slice(0, 32);
    const fRecipientPub = x25519.getPublicKey(fRecipientSecret);
    const fEph = sha256(new TextEncoder().encode("dr3-frozen-eph")).slice(0, 32);
    const fRoom = sha256(new TextEncoder().encode("dr3-frozen-room")).slice(0, 32);
    const fDoc = sha256(new TextEncoder().encode("dr3-frozen-doc")).slice(0, 32);
    const fSealed = shareEciesSeal(fShareY, 2, fRecipientPub, fEph, fRoom, fDoc);
    const FROZEN = {
      recipientPub: "423844c026b0fd7eb13f51b964caa29c9ac6253bb8ead7d27b2331072ab91957",
      ephPub: "a86cb76a28c69482a6beaa195a83527d24275e8d76cba223c647238846c9b92b",
      ct: "6fc6f29ca740b13ae4b3f014f862bbb40b7b314064e6914a120c3f21ecc1206a",
      tag: "55019e11c71b5ba94bead89c27091ac7ccb1f43d602ba68d289e9c99bdcd9788",
    };
    if (toHex(fRecipientPub) !== FROZEN.recipientPub) throw new Error("frozen recipient_pub drifted");
    if (toHex(fSealed.ephPub) !== FROZEN.ephPub) throw new Error("frozen eph_pub drifted");
    if (toHex(fSealed.ct) !== FROZEN.ct) throw new Error("frozen ct drifted");
    if (toHex(fSealed.tag) !== FROZEN.tag) throw new Error("frozen share tag drifted");
    const fOpened = shareEciesOpen(fSealed, fRecipientSecret, fRoom, fDoc, fRecipientPub);
    if (!fOpened.faithful || !eq(fOpened.shareY, fShareY)) throw new Error("frozen share seal/open FAILED");
    console.log("[ok] frozen share seal/open vector matches + round-trips (pins SDK byte-exactness)");

    // Full DR3 path: encrypt a doc → split K into 3 → seal each share → open → reconstruct → decrypt.
    const K = randomKey();
    const plaintext = new TextEncoder().encode("zkorage DR3 — threshold-released confidential document 🔐");
    const blob = aeadSeal(plaintext, K);
    const roomId = sha256(new TextEncoder().encode("dr3-room")).slice(0, 32);
    const docId = sha256(new TextEncoder().encode("dr3-doc")).slice(0, 32);
    const recipientSecret = sha256(new TextEncoder().encode("dr3-recipient")).slice(0, 32);
    const recipientPub = x25519.getPublicKey(recipientSecret);

    const shares = shamirSplit(K, 2, 3); // x = 1,2,3
    const sealed = shares.map((s) =>
      shareEciesSeal(s.y, s.x, recipientPub, sha256(new TextEncoder().encode("eph-" + s.x)).slice(0, 32), roomId, docId),
    );
    // Recipient opens each, then reconstructs from each 2-of-3 pair and AES-GCM-decrypts.
    const opened = sealed.map((sl) => shareEciesOpen(sl, recipientSecret, roomId, docId, recipientPub));
    if (!opened.every((o) => o.faithful)) throw new Error("a sealed share failed to open faithfully");
    const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2]];
    let decryptions = 0;
    for (const [a, b] of pairs) {
      const k = shamirReconstruct([
        { x: opened[a].keyperIndex, y: opened[a].shareY },
        { x: opened[b].keyperIndex, y: opened[b].shareY },
      ]);
      const pt = aeadOpen(blob, k);
      if (!Buffer.from(pt).equals(Buffer.from(plaintext))) throw new Error(`pair (${a},${b}) decrypt mismatch`);
      decryptions++;
    }
    console.log(`[ok] all ${decryptions} 2-of-3 share pairs → reconstruct K → AES-GCM decrypt the document`);

    // reconstructWithCommitment: robust, k_commitment-gated recovery (the path the backend opener + SDK use).
    const kCommit = sha256(K);
    const recAll = reconstructWithCommitment(opened.map((o) => ({ keyperIndex: o.keyperIndex, shareY: o.shareY })), kCommit);
    if (!Buffer.from(recAll.k).equals(Buffer.from(K))) throw new Error("reconstructWithCommitment FAILED");
    // …robust to ONE malicious share: corrupt keyper 3's y, still recovers K from the honest pair.
    const corrupted = [
      { keyperIndex: opened[0].keyperIndex, shareY: opened[0].shareY },
      { keyperIndex: opened[1].keyperIndex, shareY: opened[1].shareY },
      { keyperIndex: opened[2].keyperIndex, shareY: Uint8Array.from(opened[2].shareY.map((v) => v ^ 0x5a)) },
    ];
    const recRobust = reconstructWithCommitment(corrupted, kCommit);
    if (!Buffer.from(recRobust.k).equals(Buffer.from(K))) throw new Error("commitment-gated robust reconstruct FAILED");
    let rejectedBadCommit = false;
    try { reconstructWithCommitment(corrupted.slice(0, 2).concat([corrupted[2]]), sha256(new Uint8Array(32))); } catch { rejectedBadCommit = true; }
    if (!rejectedBadCommit) throw new Error("a wrong commitment must throw (no pair matches)");
    console.log(`[ok] reconstructWithCommitment recovered K (pair ${recAll.pair}); robust to 1 malicious share (pair ${recRobust.pair}); wrong commitment rejected`);

    // Negative 1: wrong recipient key → share opens unfaithful (tag mismatch).
    const wrongSecret = sha256(new TextEncoder().encode("not-the-recipient")).slice(0, 32);
    const wrongOpen = shareEciesOpen(sealed[0], wrongSecret, roomId, docId, recipientPub);
    if (wrongOpen.faithful) throw new Error("wrong recipient key must be unfaithful");

    // Negative 2: a tampered ct → tag mismatch.
    const tampered: SealedShare = { ...sealed[0], ct: Uint8Array.from(sealed[0].ct.map((v, i) => (i === 0 ? v ^ 1 : v))) };
    if (shareEciesOpen(tampered, recipientSecret, roomId, docId, recipientPub).faithful) {
      throw new Error("tampered ct must be unfaithful");
    }

    // Negative 3: < t shares cannot reconstruct K (a single share's "K" decrypts nothing).
    let singleShareFailed = false;
    try {
      const kBad = shamirReconstruct([{ x: opened[0].keyperIndex, y: opened[0].shareY }]); // 1 share → wrong
      aeadOpen(blob, kBad); // GCM must reject
    } catch {
      singleShareFailed = true;
    }
    if (!singleShareFailed) throw new Error("a single share must NOT decrypt the document");

    // Negative 4: one MALICIOUS keyper (corrupted share that still 'opens') — the all-honest pair recovers K,
    //   a pair containing the bad share fails GCM. The recipient finds the good pair by trying all 3.
    const malicious = { keyperIndex: opened[2].keyperIndex, y: Uint8Array.from(opened[2].shareY.map((v) => v ^ 0xaa)) };
    let goodPairs = 0;
    for (const cand of [
      [{ x: opened[0].keyperIndex, y: opened[0].shareY }, { x: opened[1].keyperIndex, y: opened[1].shareY }],
      [{ x: opened[0].keyperIndex, y: opened[0].shareY }, { x: malicious.keyperIndex, y: malicious.y }],
      [{ x: opened[1].keyperIndex, y: opened[1].shareY }, { x: malicious.keyperIndex, y: malicious.y }],
    ]) {
      try {
        const pt = aeadOpen(blob, shamirReconstruct(cand));
        if (Buffer.from(pt).equals(Buffer.from(plaintext))) goodPairs++;
      } catch {
        /* GCM rejected the malicious-share pair — expected */
      }
    }
    if (goodPairs !== 1) throw new Error(`expected exactly 1 good pair with 1 malicious keyper, got ${goodPairs}`);
    console.log("[ok] negatives: wrong-key ✗, tampered-ct ✗, single-share ✗, 1-malicious → only the honest pair decrypts");

    console.log("[PASS] committee.ts self-test (DR3 crypto end-to-end)");
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
