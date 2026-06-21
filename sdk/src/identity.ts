// zkorage-sdk — Data Room sign-to-derive identity (Model B). Derives a member's whole anonymous-eligibility
// identity DETERMINISTICALLY from ONE Stellar wallet signature, so the same wallet reproduces the same
// identity on any device and no secret is ever stored. The wallet signs a fixed app message (Freighter
// signMessage = SEP-53: prefix "Stellar Signed Message:\n" then SHA-256 then a deterministic ed25519
// signature per RFC 8032), and the resulting signature is the HKDF input keying material. Per-room,
// per-capability HKDF info tags give cross-room-unlinkable identities from one signature (the Sismo
// "one vault secret, per-app identifiers" pattern).
//
// MUST agree byte-for-byte with the membership guest (prover/methods/guest-membership/src/main.rs) and the
// witness builder (backend/scripts/dr2-build-membership-job.mjs):
//   id_commitment (leaf) = sha256(0x00 ‖ id_secret ‖ id_trapdoor)
//   nullifier            = sha256(0x02 ‖ id_secret ‖ room_id)
//   accessor             = ed25519 public key of accessor_seed   (holder key == accessor)
//   recipient_pub        = x25519 public key of recipient_secret
//   holder signature     = ed25519 over ("zkorage-dataroom-access-v1" ‖ room_id ‖ accessor ‖ recipient_pub)
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import { fromHex, toHex } from "./journal.js";

// --- guest-pinned domain constants (DO NOT change without re-pinning the membership image_id) ---
const LEAF_TAG = 0x00;
const NULLIFIER_TAG = 0x02;
const SIG_DOMAIN = new TextEncoder().encode("zkorage-dataroom-access-v1");

// --- sign-to-derive constants (client-side only; changing any of these rotates everyone's identity) ---
/** The fixed message the wallet signs to seed a member's Data Room identity. App + scope + version are
 * pinned: a unique message per app is required so the same wallet cannot be linked across apps (the
 * Semaphore cross-site-reuse warning). NEVER change without versioning, or members lose their identity. */
export const DATAROOM_IDENTITY_MESSAGE = "zkorage:dataroom-identity:v1";
const HKDF_SALT = new TextEncoder().encode("zkorage-v1");
/** Per-capability HKDF info prefixes; the room_id is appended so each room yields an independent identity
 * (cross-room unlinkable). RFC 5869: distinct `info` per use-case keeps the derived keys independent. */
const CAP_ID_SECRET = "zkorage:id_secret";
const CAP_ID_TRAPDOOR = "zkorage:id_trapdoor";
const CAP_ACCESSOR = "zkorage:accessor";
const CAP_RECIPIENT = "zkorage:recipient";

const enc = (s: string) => new TextEncoder().encode(s);

function cat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

// ---- low-level, byte-exact primitives (mirror the guest exactly; take raw 32-byte inputs) ----

/** Merkle leaf = sha256(0x00 ‖ id_secret ‖ id_trapdoor). The public commitment enrolled in a room's tree. */
export function idCommitment(idSecret: Uint8Array, idTrapdoor: Uint8Array): Uint8Array {
  return sha256(cat([LEAF_TAG], idSecret, idTrapdoor));
}

/** Per-room nullifier = sha256(0x02 ‖ id_secret ‖ room_id). Same identity + same room => same nullifier
 * (one access per identity per room); different rooms => different nullifiers (cross-room unlinkable). */
export function nullifierFor(idSecret: Uint8Array, roomId: Uint8Array): Uint8Array {
  return sha256(cat([NULLIFIER_TAG], idSecret, roomId));
}

/** The accessor (grant target) = the ed25519 public key of accessor_seed. The guest asserts pk == accessor. */
export function accessorFromSeed(accessorSeed: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(accessorSeed);
}

/** The recipient key (DR3 keypers seal shares to it) = the x25519 public key of recipient_secret. */
export function recipientFromSecret(recipientSecret: Uint8Array): Uint8Array {
  return x25519.getPublicKey(recipientSecret);
}

/** The NEW-5 holder signature: ed25519 over (SIG_DOMAIN ‖ room_id ‖ accessor ‖ recipient_pub) with the
 * accessor's OWN seed. Deterministic per RFC 8032, so it reproduces byte-for-byte across libraries/devices. */
export function holderSignature(
  accessorSeed: Uint8Array,
  roomId: Uint8Array,
  accessor: Uint8Array,
  recipientPub: Uint8Array,
): Uint8Array {
  return ed25519.sign(cat(SIG_DOMAIN, roomId, accessor, recipientPub), accessorSeed);
}

// ---- sign-to-derive: one wallet signature -> a full per-room identity ----

/** A member's complete Data Room identity for ONE room, derived from one wallet signature. The four `*Secret`
 * fields are PRIVATE (never leave the member's device / never go on-chain); the rest are public artifacts. */
export interface DataRoomIdentity {
  /** The room this identity is scoped to (hex, 64 chars). */
  roomId: string;
  /** PRIVATE witness secrets. */
  idSecret: string;
  idTrapdoor: string;
  accessorSeed: string;
  recipientSecret: string;
  /** PUBLIC artifacts. */
  accessor: string;
  recipientPub: string;
  /** The leaf the owner enrolls in the room's eligible tree. */
  idCommitment: string;
  /** The per-room nullifier (recorded on first access; reuse rejected). */
  nullifier: string;
}

/**
 * Derive a member's per-room Data Room identity from a wallet signature.
 * @param signature the raw bytes of the wallet's signature over {@link DATAROOM_IDENTITY_MESSAGE}
 *   (Freighter `signMessage`, SEP-53). Used as HKDF input keying material; never stored.
 * @param roomIdHex the 32-byte room id (64 hex chars).
 *
 * Each of id_secret / id_trapdoor / accessor_seed / recipient_secret is an independent HKDF-Expand with a
 * distinct, room-scoped `info` tag, so (a) one signature unlocks every room, (b) a different room yields a
 * fully unlinkable identity, and (c) no single derived key doubles as another (RFC 5869 domain separation).
 */
export function deriveDataRoomIdentity(signature: Uint8Array, roomIdHex: string): DataRoomIdentity {
  if (!(signature instanceof Uint8Array) || signature.length < 32) {
    throw new Error("signature (HKDF input keying material) must be at least 32 bytes");
  }
  const roomId = fromHex(roomIdHex);
  if (roomId.length !== 32) throw new Error("room_id must be 32 bytes (64 hex chars)");
  const roomHex = toHex(roomId);
  const derive = (cap: string) => hkdf(sha256, signature, HKDF_SALT, enc(`${cap}:${roomHex}`), 32);

  const idSecret = derive(CAP_ID_SECRET);
  const idTrapdoor = derive(CAP_ID_TRAPDOOR);
  const accessorSeed = derive(CAP_ACCESSOR);
  const recipientSecret = derive(CAP_RECIPIENT);
  const accessor = accessorFromSeed(accessorSeed);
  const recipientPub = recipientFromSecret(recipientSecret);

  return {
    roomId: roomHex,
    idSecret: toHex(idSecret),
    idTrapdoor: toHex(idTrapdoor),
    accessorSeed: toHex(accessorSeed),
    recipientSecret: toHex(recipientSecret),
    accessor: toHex(accessor),
    recipientPub: toHex(recipientPub),
    idCommitment: toHex(idCommitment(idSecret, idTrapdoor)),
    nullifier: toHex(nullifierFor(idSecret, roomId)),
  };
}
