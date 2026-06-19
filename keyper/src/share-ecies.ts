// zkorage DR3 keyper — threshold-ECIES share SEAL (+ open, for the self-test).
//
// BYTE-EXACT MIRROR of the canonical backend/src/committee.ts (and sdk/src/committee.ts). Kept in sync by
// the FROZEN vector below — the same recipient_pub/eph_pub/ct/tag the backend pins. The keyper is an
// independently-deployable service (one per committee member), so it carries its own copy rather than
// reaching into another package's tree; the frozen vector guarantees no drift.
//
// Reuses the DR1 seal keystream byte-for-byte; only the tag domain is DR3-specific (off-chain only):
//   keystream = sha256("zkorage-dataroom-ecies-v1/ks"  ‖ shared ‖ eph_pub ‖ 0x00000000)   (single block)
//   ct        = share_y(32) ⊕ keystream
//   tag       = sha256("zkorage-dataroom-share-v1/tag" ‖ keyper_index(1) ‖ share_y ‖ room_id ‖ doc_id ‖ recipient_pub)
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

const DOMAIN_KS = new TextEncoder().encode("zkorage-dataroom-ecies-v1/ks");
const DOMAIN_SHARE_TAG = new TextEncoder().encode("zkorage-dataroom-share-v1/tag");
const SHARE_LEN = 32;

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

export interface SealedShare {
  keyperIndex: number;
  ephPub: Uint8Array;
  ct: Uint8Array;
  tag: Uint8Array;
}

/** SEAL: ECIES-encrypt a 32-byte Shamir share to `recipientPub`, binding it to keyper + document + recipient. */
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
  shareY: Uint8Array;
  faithful: boolean;
}

/** OPEN (recipient side, used here only by the self-test): recover share_y + verify the tag. */
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

/** Assert this module matches the backend's frozen share-seal vector (byte-exact across implementations). */
export function assertFrozenVector(): void {
  const shareY = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
  const recipientSecret = sha256(new TextEncoder().encode("dr3-frozen-recipient")).slice(0, 32);
  const recipientPub = x25519.getPublicKey(recipientSecret);
  const eph = sha256(new TextEncoder().encode("dr3-frozen-eph")).slice(0, 32);
  const room = sha256(new TextEncoder().encode("dr3-frozen-room")).slice(0, 32);
  const doc = sha256(new TextEncoder().encode("dr3-frozen-doc")).slice(0, 32);
  const sealed = shareEciesSeal(shareY, 2, recipientPub, eph, room, doc);
  const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
  const FROZEN = {
    ephPub: "a86cb76a28c69482a6beaa195a83527d24275e8d76cba223c647238846c9b92b",
    ct: "6fc6f29ca740b13ae4b3f014f862bbb40b7b314064e6914a120c3f21ecc1206a",
    tag: "55019e11c71b5ba94bead89c27091ac7ccb1f43d602ba68d289e9c99bdcd9788",
  };
  if (hex(sealed.ephPub) !== FROZEN.ephPub || hex(sealed.ct) !== FROZEN.ct || hex(sealed.tag) !== FROZEN.tag) {
    throw new Error("keyper share-ecis DRIFTED from the backend frozen vector");
  }
}
