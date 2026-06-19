// zkorage DR2 — anonymous eligibility (membership + nullifier) helpers.
//
// Byte-exact with the RISC0 membership guest (prover/methods/guest-membership/src/main.rs) and the
// DataRoom contract's request_access:
//   id_commitment (leaf) = sha256(0x00 ‖ id_secret ‖ id_trapdoor)            [LEAF_TAG]
//   internal node        = sha256(0x01 ‖ left ‖ right)                       [NODE_TAG]
//   nullifier            = sha256(0x02 ‖ id_secret ‖ room_id)                [NULLIFIER_TAG]
//   NEW-5 holder sig (ed25519, pk == accessor) over
//                          "zkorage-dataroom-access-v1" ‖ room_id ‖ accessor ‖ recipient_pub
// The eligible set is a depth-20 sparse Merkle tree of id_commitments (unoccupied slots = the empty
// leaf sha256(0x00 ‖ 0^32 ‖ 0^32)); the root is pinned per room on-chain. Identity stays PRIVATE; only
// the pseudonymous accessor + nullifier + root ever appear.
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "node:crypto";
import { toHex, fromHex } from "./envelope.js";

// Wire sha512 so @noble/ed25519's synchronous API works (mirrors signer.ts).
(ed.etc as { sha512Sync?: (...m: Uint8Array[]) => Uint8Array }).sha512Sync = (...m) =>
  sha512(ed.etc.concatBytes(...m));

export const TREE_DEPTH = 20;
const LEAF_TAG = 0x00;
const NODE_TAG = 0x01;
const NULLIFIER_TAG = 0x02;
const SIG_DOMAIN = new TextEncoder().encode("zkorage-dataroom-access-v1");

const tagged = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
  const t = new Uint8Array(1);
  t[0] = tag;
  return sha256(concat(t, ...parts));
};

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

function need32(b: Uint8Array, name: string): Uint8Array {
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return b;
}

/** Leaf / id_commitment = sha256(0x00 ‖ id_secret ‖ id_trapdoor). */
export function idCommitment(idSecret: Uint8Array, idTrapdoor: Uint8Array): Uint8Array {
  return tagged(LEAF_TAG, need32(idSecret, "id_secret"), need32(idTrapdoor, "id_trapdoor"));
}

/** Internal Merkle node = sha256(0x01 ‖ left ‖ right). */
function nodeHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  return tagged(NODE_TAG, a, b);
}

/** Nullifier = sha256(0x02 ‖ id_secret ‖ room_id) (external_nullifier = room_id). */
export function nullifier(idSecret: Uint8Array, roomId: Uint8Array): Uint8Array {
  return tagged(NULLIFIER_TAG, need32(idSecret, "id_secret"), need32(roomId, "room_id"));
}

const EMPTY_LEAF = idCommitment(new Uint8Array(32), new Uint8Array(32));

/** Per-level zero-subtree roots: zero[0] = empty leaf, zero[k] = node(zero[k-1], zero[k-1]). */
function zeroSubtrees(): Uint8Array[] {
  const zero: Uint8Array[] = [EMPTY_LEAF];
  for (let k = 1; k <= TREE_DEPTH; k++) zero[k] = nodeHash(zero[k - 1], zero[k - 1]);
  return zero;
}

/**
 * Build the depth-20 sparse Merkle tree over an ordered list of leaf commitments (member `i` at index
 * `i`). Returns the root and a `witness(index)` that yields the bottom→top sibling path + leaf index for
 * the membership proof. Unoccupied slots are the zero-subtree (so the root is the full depth-20 root).
 */
export function buildEligibleTree(commitments: Uint8Array[]): {
  root: Uint8Array;
  witness: (index: number) => { siblings: Uint8Array; leafIndex: number };
} {
  const zero = zeroSubtrees();
  const levels: Map<number, Uint8Array>[] = [new Map()];
  commitments.forEach((c, i) => levels[0].set(i, need32(c, `commitment[${i}]`)));
  for (let d = 0; d < TREE_DEPTH; d++) {
    const cur = levels[d];
    const next = new Map<number, Uint8Array>();
    const parents = new Set<number>();
    for (const idx of cur.keys()) parents.add(idx >> 1);
    for (const p of parents) {
      const l = cur.get(p * 2) ?? zero[d];
      const r = cur.get(p * 2 + 1) ?? zero[d];
      next.set(p, nodeHash(l, r));
    }
    levels.push(next);
  }
  const root = levels[TREE_DEPTH].get(0) ?? zero[TREE_DEPTH];
  const witness = (index: number) => {
    const sibs: Uint8Array[] = [];
    let idx = index;
    for (let d = 0; d < TREE_DEPTH; d++) {
      sibs.push(levels[d].get(idx ^ 1) ?? zero[d]);
      idx >>= 1;
    }
    return { siblings: concat(...sibs), leafIndex: index };
  };
  return { root, witness };
}

/** NEW-5: the accessor's own ed25519 key (== pk) signs the domain-bound consent message. */
export function holderSign(
  holderSeed: Uint8Array,
  roomId: Uint8Array,
  recipientPub: Uint8Array,
): { accessor: Uint8Array; sig: Uint8Array } {
  const accessor = ed.getPublicKey(need32(holderSeed, "holder_seed"));
  const msg = concat(SIG_DOMAIN, need32(roomId, "room_id"), accessor, need32(recipientPub, "recipient_pub"));
  const sig = ed.sign(msg, holderSeed);
  return { accessor, sig };
}

/**
 * Build a complete `membership` prover job (the 9 gateway fields) for the member at `memberIndex` in the
 * room's eligible set, plus the public outputs (eligible_root, nullifier, accessor) for cross-checking.
 * `commitments` is the room's full ordered eligible set; `idSecret`/`idTrapdoor` are the member's private
 * witness (must hash to `commitments[memberIndex]`). The holder (== accessor) signs the consent (NEW-5).
 */
export function buildMembershipJob(args: {
  idSecret: Uint8Array;
  idTrapdoor: Uint8Array;
  roomId: Uint8Array;
  holderSeed: Uint8Array;
  recipientPub: Uint8Array;
  commitments: Uint8Array[];
  memberIndex: number;
}): {
  job: Record<string, string | number>;
  eligibleRoot: string;
  nullifier: string;
  accessor: string;
} {
  const { idSecret, idTrapdoor, roomId, holderSeed, recipientPub, commitments, memberIndex } = args;
  // The depth-20 tree holds at most 2^20 leaves; an index at/above capacity has no valid path (and the
  // guest's fold uses only the low 20 bits of leaf_index). Reject explicitly rather than silently aliasing.
  if (memberIndex < 0 || memberIndex >= (1 << TREE_DEPTH)) {
    throw new Error(`memberIndex out of range (must be < 2^${TREE_DEPTH}, the eligible-tree capacity)`);
  }
  const leaf = idCommitment(idSecret, idTrapdoor);
  const expected = commitments[memberIndex];
  if (!expected || toHex(expected) !== toHex(leaf)) {
    throw new Error(`id_secret/id_trapdoor do not match the eligible-set commitment at index ${memberIndex}`);
  }
  const { root, witness } = buildEligibleTree(commitments);
  const { siblings, leafIndex } = witness(memberIndex);
  const { accessor, sig } = holderSign(holderSeed, roomId, recipientPub);
  const nf = nullifier(idSecret, roomId);
  return {
    job: {
      kind: "membership",
      sig_hex: toHex(sig),
      pk_hex: toHex(accessor),
      accessor_hex: toHex(accessor),
      recipient_pubkey_hex: toHex(need32(recipientPub, "recipient_pub")),
      id_secret_hex: toHex(idSecret),
      id_trapdoor_hex: toHex(idTrapdoor),
      room_id_hex: toHex(need32(roomId, "room_id")),
      siblings_hex: toHex(siblings),
      leaf_index: leafIndex,
    },
    eligibleRoot: toHex(root),
    nullifier: toHex(nf),
    accessor: toHex(accessor),
  };
}

/** Generate a fresh demo identity (random id_secret/id_trapdoor + ed25519 holder seed). For the demo the
 *  backend mints identities; in production the member generates these client-side and registers only the
 *  commitment. */
export function freshIdentity(): {
  idSecret: Uint8Array;
  idTrapdoor: Uint8Array;
  holderSeed: Uint8Array;
  commitment: Uint8Array;
  accessor: Uint8Array;
} {
  const idSecret = new Uint8Array(randomBytes(32));
  const idTrapdoor = new Uint8Array(randomBytes(32));
  const holderSeed = new Uint8Array(randomBytes(32));
  return {
    idSecret,
    idTrapdoor,
    holderSeed,
    commitment: idCommitment(idSecret, idTrapdoor),
    accessor: ed.getPublicKey(holderSeed),
  };
}

export { toHex, fromHex };
