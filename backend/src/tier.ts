// Bonded Proofs (BP5) — anonymous bonded tier (membership expiring at X) helpers + the qual-root indexer.
//
// Byte-exact with the RISC0 tier guest (prover/methods/guest-tier/src/main.rs) and the tier-gate contract:
//   member leaf      = sha256(0x00 ‖ id_secret ‖ id_trapdoor)            [reused from DR2 membership]
//   internal node    = sha256(0x01 ‖ left ‖ right)
//   qual commitment  = sha256(0x03 ‖ id_secret ‖ "escrow")              [QUAL_TAG; stored in the lock]
//   nullifier        = sha256(0x02 ‖ id_secret ‖ context)              [reused; context = external_nullifier]
//   NEW-5 holder sig (ed25519, pk == accessor) over "zkorage-tier-bonded-v1" ‖ context ‖ accessor
// The MEMBER tree (enrolled set) uses the DR2 empty leaf (sha256(0x00‖0‖0)); the QUAL tree (qualifying
// escrow locks) uses an all-zero empty leaf. Both depth 20. Identity (id_secret/id_trapdoor/both indices)
// stays PRIVATE; only the pseudonymous accessor + nullifier + the two roots ever appear on-chain.
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "node:crypto";
import { toHex, fromHex } from "./envelope.js";
import { readContract, scBytes, scU64, jsonSafe } from "./chain.js";
import { ESCROW_ID, BOND_TOKEN_ID, getLock } from "./escrow.js";
import {
  TREE_DEPTH,
  idCommitment,
  buildEligibleTree,
  nullifier as nullifierOf,
} from "./membership.js";

// Wire sha512 so @noble/ed25519's synchronous API works (membership.ts already does this on import; set
// again defensively so this module is correct even if imported first).
(ed.etc as { sha512Sync?: (...m: Uint8Array[]) => Uint8Array }).sha512Sync = (...m) =>
  sha512(ed.etc.concatBytes(...m));

// Deployed on testnet (set after deploy). Override via env.
export const TIER_GATE_ID = process.env.TIER_GATE_ID || "";
export const TIER_IMAGE_ID =
  process.env.TIER_IMAGE_ID ||
  "2671938b59598c129913fee8e0ef29159e6475dd61c37c503429bdaf0fba4e69";
/** Minimum qualifying-set size before the backend will build a proof (anonymity guard; a set of 1
 *  de-anonymizes by elimination). Off-chain by necessity — a Merkle root carries no member count. */
export const TIER_MIN_ANON_SET = Number(process.env.TIER_MIN_ANON_SET || 3);
/** A fixed 32-byte id for the enrolled-member set (the eligible-store is keyed like a DR2 room). */
export const TIER_MEMBER_SET_ID = toHex(sha256(new TextEncoder().encode("zkorage-bp5-tier-members")));

export { ESCROW_ID, BOND_TOKEN_ID };

const NODE_TAG = 0x01;
const QUAL_TAG = 0x03;
const ESCROW_LABEL = new TextEncoder().encode("escrow");
const TIER_SIG_DOMAIN = new TextEncoder().encode("zkorage-tier-bonded-v1");
const ZERO32 = new Uint8Array(32);
const SCAN_BATCH = 8;
const SCAN_MAX = Number(process.env.ESCROW_MAX_SCAN || 200);

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

function nodeHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const t = new Uint8Array(1);
  t[0] = NODE_TAG;
  return sha256(concat(t, a, b));
}

/** Qualifying-lock commitment = sha256(0x03 ‖ id_secret ‖ "escrow") — the value the depositor stores in the
 *  escrow lock's `commitment`. The frontend derives the SAME value at deposit time.
 *
 *  SEMANTICS (by design): the commitment is INDEPENDENT of (threshold, X). One bonded lock therefore lands
 *  in the qualifying set of EVERY tier whose floor + deadline it satisfies, so a single bigger/longer bond
 *  earns a member the lower tiers too (one grant per tier, since the nullifier is per-context). If a future
 *  product needs a dedicated bond PER tier, bind the tier into the tag (sha256(0x03 ‖ id_secret ‖ "escrow"
 *  ‖ threshold ‖ X)) in the guest + here + the indexer together. */
export function qualCommitment(idSecret: Uint8Array): Uint8Array {
  const t = new Uint8Array(1);
  t[0] = QUAL_TAG;
  return sha256(concat(t, need32(idSecret, "id_secret"), ESCROW_LABEL));
}

/**
 * Build a depth-20 sparse Merkle tree over an ordered list of leaves (leaf `i` at index `i`), with a given
 * empty-slot leaf. Returns the root + a `witness(index)` (bottom→top sibling path + leaf index). This is
 * the membership.ts builder generalized over the empty leaf (member tree uses sha256(0x00‖0‖0); qual tree
 * uses 0^32).
 */
export function buildSparseTree(
  leaves: Uint8Array[],
  emptyLeaf: Uint8Array,
): { root: Uint8Array; witness: (index: number) => { siblings: Uint8Array; leafIndex: number } } {
  const zero: Uint8Array[] = [emptyLeaf];
  for (let k = 1; k <= TREE_DEPTH; k++) zero[k] = nodeHash(zero[k - 1], zero[k - 1]);
  const levels: Map<number, Uint8Array>[] = [new Map()];
  leaves.forEach((c, i) => levels[0].set(i, need32(c, `leaf[${i}]`)));
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

/** NEW-5: the accessor's own ed25519 key (== pk) signs "zkorage-tier-bonded-v1" ‖ context ‖ accessor. */
export function tierHolderSign(
  holderSeed: Uint8Array,
  context: Uint8Array,
): { accessor: Uint8Array; sig: Uint8Array } {
  const accessor = ed.getPublicKey(need32(holderSeed, "holder_seed"));
  const msg = concat(TIER_SIG_DOMAIN, need32(context, "context"), accessor);
  const sig = ed.sign(msg, holderSeed);
  return { accessor, sig };
}

export interface QualLock {
  id: number;
  commitment: string; // 32-byte hex
  amount: string;
  unlock_time: number;
  depositor: string;
}

export interface QualSet {
  /** Unique qualifying commitments, in lock-id order (deduped). */
  commitments: string[];
  /** The depth-20 qual-tree root over `commitments`. */
  root: string;
  /** The qualifying locks (for transparency / the UI). */
  locks: QualLock[];
  /** Anonymity-set size (== commitments.length). */
  size: number;
}

function isContractError(reason: unknown): boolean {
  return /contract/i.test(String((reason as Error)?.message ?? reason));
}

/**
 * The qual-root indexer. Scans the escrow's PUBLIC locks and builds the Merkle root over the commitments of
 * all locks that currently qualify for the tier `(threshold, X)`: amount >= threshold ∧ unlock_time >= X ∧
 * still-locked ∧ NON-revocable ∧ in the bond token ∧ a non-zero commitment. This root is publicly auditable
 * (anyone reruns this from on-chain state). Commitments are deduped (a member with two qualifying locks of
 * the same commitment is one anonymity member) and ordered by lock id.
 *
 * Scan bound: lock ids are sequential from 1 and `get_lock` keeps returning a record for RELEASED locks
 * (released = true, not LockNotFound), so a released lock never opens a gap that ends the scan early — the
 * scan stops only on a fully-not-found batch (past the highest id) or on `SCAN_MAX` (default 200). A
 * qualifying lock beyond the cap is invisible to BOTH this indexer and the SDK's recomputeQualRoot, so the
 * published root and any recompute agree with each other while excluding it. Raise ESCROW_MAX_SCAN if the
 * escrow ever grows past the cap.
 */
export async function buildQualSet(threshold: bigint, unlockAfter: number): Promise<QualSet> {
  const now = Math.floor(Date.now() / 1000);
  const qualifying: QualLock[] = [];
  const seen = new Set<string>();
  for (let start = 1; start <= SCAN_MAX; start += SCAN_BATCH) {
    const ids: number[] = [];
    for (let i = 0; i < SCAN_BATCH && start + i <= SCAN_MAX; i++) ids.push(start + i);
    const settled = await Promise.allSettled(ids.map((id) => getLock(id)));
    let anyFound = false;
    let transient = false;
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        if (!r.value) return;
        anyFound = true;
        const l = r.value;
        const commitment = String(l.commitment).toLowerCase().replace(/^0x/, "");
        const released = Boolean(l.released);
        const revocable = Boolean(l.revocable);
        const token = String(l.token);
        const amount = BigInt(String(l.amount));
        const unlock = Number(l.unlock_time);
        const isLocked = !released && now < unlock;
        const isZero = /^0*$/.test(commitment);
        if (
          isLocked &&
          !revocable &&
          token === BOND_TOKEN_ID &&
          amount >= threshold &&
          unlock >= unlockAfter &&
          !isZero &&
          !seen.has(commitment)
        ) {
          seen.add(commitment);
          qualifying.push({ id: ids[i], commitment, amount: amount.toString(), unlock_time: unlock, depositor: String(l.depositor) });
        }
      } else if (!isContractError(r.reason)) {
        transient = true;
      }
    });
    if (transient && !anyFound) throw new Error("could not reach the network while building the qualifying set");
    if (!anyFound) break;
  }
  qualifying.sort((a, b) => a.id - b.id);
  const commitments = qualifying.map((q) => q.commitment);
  const { root } = buildSparseTree(commitments.map((h) => fromHex(h)), ZERO32);
  return { commitments, root: toHex(root), locks: qualifying, size: commitments.length };
}

/**
 * Build a complete `tier` prover job (the 12 gateway fields) + the public outputs. `memberCommitments` is
 * the enrolled set (member at `memberIndex`); the qualifying set is rebuilt live. The member's private
 * witness (id_secret/id_trapdoor) must hash to both `memberCommitments[memberIndex]` and a commitment in
 * the qualifying set.
 */
export async function buildTierJob(args: {
  idSecret: Uint8Array;
  idTrapdoor: Uint8Array;
  holderSeed: Uint8Array;
  context: Uint8Array;
  threshold: bigint;
  unlockAfter: number;
  memberCommitments: Uint8Array[];
  memberIndex: number;
}): Promise<{
  job: Record<string, string | number>;
  memberRoot: string;
  qualRoot: string;
  nullifier: string;
  accessor: string;
  qualSize: number;
}> {
  const { idSecret, idTrapdoor, holderSeed, context, threshold, unlockAfter, memberCommitments, memberIndex } = args;
  if (memberIndex < 0 || memberIndex >= 1 << TREE_DEPTH) {
    throw new Error(`memberIndex out of range (must be < 2^${TREE_DEPTH})`);
  }
  // The member's secrets must hash to the enrolled commitment at memberIndex.
  const leaf = idCommitment(idSecret, idTrapdoor);
  const expected = memberCommitments[memberIndex];
  if (!expected || toHex(expected) !== toHex(leaf)) {
    throw new Error(`id_secret/id_trapdoor do not match the enrolled commitment at index ${memberIndex}`);
  }
  // The qualifying set (live from the escrow). The member's qual commitment must be in it.
  const qual = await buildQualSet(threshold, unlockAfter);
  if (qual.size < TIER_MIN_ANON_SET) {
    throw new Error(
      `qualifying set too small (${qual.size} < ${TIER_MIN_ANON_SET}); a proof now would weaken anonymity — wait for more qualifying bonds`,
    );
  }
  const qc = toHex(qualCommitment(idSecret));
  const qualIndex = qual.commitments.indexOf(qc);
  if (qualIndex < 0) {
    throw new Error(
      "no qualifying bonded lock for this identity — deposit a non-revocable lock with commitment = sha256(0x03‖id_secret‖'escrow'), amount >= threshold, unlock_time >= X",
    );
  }

  const { root: memberRoot, witness: memberWitness } = buildEligibleTree(memberCommitments);
  const m = memberWitness(memberIndex);
  const { witness: qualWitness } = buildSparseTree(qual.commitments.map((h) => fromHex(h)), ZERO32);
  const q = qualWitness(qualIndex);
  const { accessor, sig } = tierHolderSign(holderSeed, context);
  const nf = nullifierOf(idSecret, context);

  return {
    job: {
      kind: "tier",
      sig_hex: toHex(sig),
      pk_hex: toHex(accessor),
      accessor_hex: toHex(accessor),
      id_secret_hex: toHex(idSecret),
      id_trapdoor_hex: toHex(idTrapdoor),
      context_hex: toHex(need32(context, "context")),
      threshold: threshold.toString(),
      unlock_after: String(unlockAfter),
      member_siblings_hex: toHex(m.siblings),
      member_leaf_index: m.leafIndex,
      qual_siblings_hex: toHex(q.siblings),
      qual_leaf_index: q.leafIndex,
    },
    memberRoot: toHex(memberRoot),
    qualRoot: qual.root,
    nullifier: toHex(nf),
    accessor: toHex(accessor),
    qualSize: qual.size,
  };
}

/** Fresh demo identity (random id_secret/id_trapdoor + ed25519 holder seed). Demo only — in production the
 *  member generates + holds these client-side and only the commitments are published. */
export function freshTierIdentity(): {
  idSecret: Uint8Array;
  idTrapdoor: Uint8Array;
  holderSeed: Uint8Array;
  memberCommitment: Uint8Array;
  qualCommitment: Uint8Array;
  accessor: Uint8Array;
} {
  const idSecret = new Uint8Array(randomBytes(32));
  const idTrapdoor = new Uint8Array(randomBytes(32));
  const holderSeed = new Uint8Array(randomBytes(32));
  return {
    idSecret,
    idTrapdoor,
    holderSeed,
    memberCommitment: idCommitment(idSecret, idTrapdoor),
    qualCommitment: qualCommitment(idSecret),
    accessor: ed.getPublicKey(holderSeed),
  };
}

// ---- on-chain reads (key-free; the gate is permissionless to read) ----

function requireGate(): string {
  if (!TIER_GATE_ID) throw new Error("TIER_GATE_ID not configured");
  return TIER_GATE_ID;
}

export async function isTierGranted(accessorHex: string): Promise<boolean> {
  const { value } = await readContract(requireGate(), "is_granted", [scBytes(accessorHex)]);
  return Boolean(value);
}

export async function getTierGrant(accessorHex: string): Promise<unknown | null> {
  const { value } = await readContract(requireGate(), "get_grant", [scBytes(accessorHex)]);
  return value ? jsonSafe(value) : null;
}

export async function isTierNullifierUsed(nullifierHex: string): Promise<boolean> {
  const { value } = await readContract(requireGate(), "is_nullifier_used", [scBytes(nullifierHex)]);
  return Boolean(value);
}

export async function getTierConfig(): Promise<unknown> {
  const { value } = await readContract(requireGate(), "get_config");
  return jsonSafe(value);
}

export async function getTierMemberRoot(): Promise<string | null> {
  const { value } = await readContract(requireGate(), "get_member_root");
  return value ? toHex(new Uint8Array(value as Uint8Array)) : null;
}

export async function getTierQualRing(threshold: bigint, unlockAfter: number): Promise<string[]> {
  const { value } = await readContract(requireGate(), "get_qual_ring", [scU64(threshold), scU64(unlockAfter)]);
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).map((v) => toHex(new Uint8Array(v as Uint8Array)));
}

export { toHex, fromHex };
