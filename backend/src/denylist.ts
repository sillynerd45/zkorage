// Sanctions deny-list as an Indexed Merkle Tree (IMT) over SHA-256 — the off-chain authority for the
// Week-6 "not-sanctioned" non-membership proof. This module is the cross-language counterpart of the
// RISC0 guest (`prover/methods/guest-compliance/src/main.rs`): the guest VERIFIES a witness this module
// PRODUCES, so the hashing MUST match byte-for-byte:
//   * leaf     = sha256( value[32] ‖ next_value[32] ‖ next_index_be4 )
//   * internal = sha256( left[32] ‖ right[32] )
//   * values are ordered as big-endian uint256; empty leaves/subtrees hash from a 32-zero leaf.
//
// Non-membership of `x`: find the unique "low-leaf" with value < x < next_value (or next_value == 0 ⇒ x
// is past the largest sanctioned value), prove its single Merkle path. A SANCTIONED x has an exact leaf,
// so no low-leaf brackets it ⇒ the guest panics ⇒ no receipt. The on-chain gate pins the root, so a
// forged path to any other root is rejected. SHA-256 (not Poseidon) because RISC0 has a sha256 precompile
// — depth-20 stays at 1 segment vs ~28 for Poseidon-BN254 (measured); the gate only compares roots
// (no on-chain hashing), so the hash is a pure guest↔backend choice and equally sound. Leaf and internal
// hashes are explicitly domain-separated by a tag byte (LEAF_TAG/NODE_TAG) — keep these IDENTICAL to the
// guest's `LEAF_TAG`/`NODE_TAG` or the roots diverge.
import { sha256 } from "@noble/hashes/sha256";
import { demoSubjectId } from "./signer.js";
import { toHex } from "./envelope.js";

export const DENY_DEPTH = Number(process.env.DENY_DEPTH || 20);

const ZERO32 = new Uint8Array(32);
const LEAF_TAG = new Uint8Array([0x00]); // sha256(LEAF_TAG ‖ value ‖ next_value ‖ next_index)
const NODE_TAG = new Uint8Array([0x01]); // sha256(NODE_TAG ‖ left ‖ right)

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Internal Merkle node = sha256(NODE_TAG ‖ left ‖ right) — domain-separated from leaves. Also used for
// the per-level zero-subtree hashes (an internal node of two empty subtrees).
function hashInternal(a: Uint8Array, b: Uint8Array): Uint8Array {
  return sha256(concat(NODE_TAG, a, b));
}

/** Compare two 32-byte big-endian uint256 (-1 / 0 / 1). */
export function cmpBE(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

interface Leaf {
  value: Uint8Array; // 32
  nextValue: Uint8Array; // 32 (all-zero ⇒ end / +∞)
  nextIndex: number; // u32
}

// Leaf = sha256(LEAF_TAG ‖ value ‖ next_value ‖ next_index_be4) — domain-separated from internal nodes.
function leafHash(l: Leaf): Uint8Array {
  return sha256(concat(LEAF_TAG, l.value, l.nextValue, u32be(l.nextIndex)));
}

function dedupSortBE(vals: Uint8Array[]): Uint8Array[] {
  for (const v of vals) {
    if (v.length !== 32) throw new Error("sanctioned value must be 32 bytes");
    if (cmpBE(v, ZERO32) === 0) throw new Error("sanctioned value 0 is reserved for the head sentinel");
  }
  const sorted = [...vals].sort(cmpBE);
  const out: Uint8Array[] = [];
  for (const v of sorted) {
    if (out.length === 0 || cmpBE(out[out.length - 1], v) !== 0) out.push(v);
  }
  return out;
}

export class DenyTree {
  readonly depth: number;
  readonly leaves: Leaf[]; // occupied leaves at contiguous indices 0..k-1 (head sentinel at 0)
  private readonly values: Uint8Array[]; // sanctioned values (sorted, unique; excludes the 0 sentinel)
  private readonly nodes = new Map<string, Uint8Array>();
  private readonly zero: Uint8Array[]; // zero-subtree hash per level (0..depth)
  readonly root: Uint8Array;

  constructor(sanctioned: Uint8Array[], depth = DENY_DEPTH) {
    if (depth < 1 || depth > 32) throw new Error("depth out of range");
    this.depth = depth;
    if (sanctioned.length >= 2 ** depth) throw new Error("too many sanctioned entries for the tree depth");
    const sorted = dedupSortBE(sanctioned);
    this.values = sorted;

    // Occupied leaves: head sentinel (value 0) linked to the smallest value, then each sanctioned value
    // linked to the next (the largest points to 0 = end). This makes EVERY non-member x land between two
    // consecutive entries (or below the smallest / above the largest).
    const leaves: Leaf[] = [];
    leaves.push({
      value: ZERO32,
      nextValue: sorted.length ? sorted[0] : ZERO32,
      nextIndex: sorted.length ? 1 : 0,
    });
    for (let i = 0; i < sorted.length; i++) {
      const isLast = i === sorted.length - 1;
      leaves.push({
        value: sorted[i],
        nextValue: isLast ? ZERO32 : sorted[i + 1],
        nextIndex: isLast ? 0 : i + 2,
      });
    }
    this.leaves = leaves;

    // Zero-subtree hashes per level (zero[0] = the empty-leaf sentinel value; zero[L>0] = internal nodes).
    this.zero = [ZERO32];
    for (let l = 0; l < depth; l++) this.zero.push(hashInternal(this.zero[l], this.zero[l]));

    // Level 0 = leaf hashes (occupied indices only; the rest default to zero[0]).
    for (let i = 0; i < leaves.length; i++) this.nodes.set(`0:${i}`, leafHash(leaves[i]));

    // Build up: occupied indices stay a contiguous low prefix at every level.
    let count = leaves.length;
    for (let level = 0; level < depth; level++) {
      const parents = Math.ceil(count / 2);
      for (let p = 0; p < parents; p++) {
        const left = this.nodeAt(level, 2 * p);
        const right = this.nodeAt(level, 2 * p + 1);
        this.nodes.set(`${level + 1}:${p}`, hashInternal(left, right));
      }
      count = parents;
    }
    this.root = this.nodeAt(depth, 0);
  }

  private nodeAt(level: number, index: number): Uint8Array {
    return this.nodes.get(`${level}:${index}`) ?? this.zero[level];
  }

  rootHex(): string {
    return toHex(this.root);
  }

  size(): number {
    return this.values.length;
  }

  isMember(id: Uint8Array): boolean {
    return this.values.some((v) => cmpBE(v, id) === 0);
  }

  /** Index of the low-leaf bracketing x: value < x AND (next_value == 0 OR x < next_value). */
  private lowLeafIndex(x: Uint8Array): number {
    for (let i = 0; i < this.leaves.length; i++) {
      const L = this.leaves[i];
      const above = cmpBE(L.value, x) < 0;
      const end = cmpBE(L.nextValue, ZERO32) === 0;
      const below = end || cmpBE(x, L.nextValue) < 0;
      if (above && below) return i;
    }
    throw new Error("no low-leaf found (x may be a member or the tree is malformed)");
  }

  /**
   * Serialized non-membership witness (hex) for subject `x`. Throws if `x` IS sanctioned (then the only
   * honest outcome is a guest panic). Layout matches the guest exactly:
   *   low_value[32] ‖ low_next_value[32] ‖ low_next_index_be4 ‖ leaf_index_be4 ‖ depth_be4 ‖ siblings[depth*32]
   */
  nonMembershipWitness(x: Uint8Array): string {
    if (x.length !== 32) throw new Error("subject must be 32 bytes");
    if (this.isMember(x)) throw new Error("subject is on the deny-list — no non-membership witness exists");
    const idx = this.lowLeafIndex(x);
    const L = this.leaves[idx];
    const siblings: Uint8Array[] = [];
    let cur = idx;
    for (let level = 0; level < this.depth; level++) {
      siblings.push(this.nodeAt(level, cur ^ 1));
      cur = cur >> 1;
    }
    const w = concat(L.value, L.nextValue, u32be(L.nextIndex), u32be(idx), u32be(this.depth), ...siblings);
    return toHex(w);
  }
}

// Demo sanctions list — a handful of mock sanctioned identities derived the SAME way KYC subjects are
// (`demoSubjectId(label)`), so "mallory" (who can also hold a KYC credential) is genuinely on the list
// and demonstrates the ✗ rejection. "alice"/"bob" are deliberately NOT here (the ✓ case).
export const SANCTIONED_LABELS = ["mallory", "evil-corp", "ofac-john-doe", "ofac-jane-roe", "lazarus-1"];

let cachedTree: DenyTree | null = null;

/** The demo deny-list tree (cached). Root = the value the gate pins via `set_deny_root`. */
export function demoDenyTree(depth = DENY_DEPTH): DenyTree {
  if (cachedTree && cachedTree.depth === depth) return cachedTree;
  const sanctioned = SANCTIONED_LABELS.map((l) => demoSubjectId(l));
  cachedTree = new DenyTree(sanctioned, depth);
  return cachedTree;
}
