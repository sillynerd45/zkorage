// Bonded Access (BA1) — anonymous per-requirement bond gate: helpers + the per-requirement qual-root
// indexer + the prove-job binding. The generalized successor to tier.ts: instead of ONE hardcoded token +
// (threshold, X) tier, every requirement is identified by
//   req_id = sha256(token_contract_id(32) ‖ min_amount(i128 BE 16) ‖ deadline(u64 BE 8))
// so each Data Room document/room can require its OWN bond. Byte-exact with the RISC0 bond guest
// (prover/methods/guest-bond/src/main.rs) and the bond-gate contract:
//   member leaf      = sha256(0x00 ‖ id_secret ‖ id_trapdoor)            [reused from DR2 membership]
//   internal node    = sha256(0x01 ‖ left ‖ right)
//   qual commitment  = sha256(0x03 ‖ id_secret ‖ "escrow")              [QUAL_TAG; stored in the lock]
//   nullifier        = sha256(0x02 ‖ id_secret ‖ context)              [context = req_id]
//   NEW-5 holder sig (ed25519, pk == accessor) over "zkorage-bond-access-v1" ‖ context ‖ accessor
// The MEMBER tree (the room's enrolled set) uses the DR2 empty leaf (sha256(0x00‖0‖0)); the QUAL tree
// (qualifying escrow locks) uses an all-zero empty leaf. Both depth 20. Identity stays PRIVATE; only the
// pseudonymous accessor + nullifier + the two roots + the public requirement ever appear on-chain.
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import { StrKey } from "@stellar/stellar-sdk";
import { toHex, fromHex } from "./envelope.js";
import { readContract, scBytes, jsonSafe } from "./chain.js";
import { ESCROW_ID, getLock } from "./escrow.js";
import { TREE_DEPTH, idCommitment, buildEligibleTree, nullifier as nullifierOf } from "./membership.js";
import { buildSparseTree, qualCommitment } from "./tier.js";

// Wire sha512 so @noble/ed25519's synchronous API works (membership.ts already does this on import; set
// again defensively so this module is correct even if imported first).
(ed.etc as { sha512Sync?: (...m: Uint8Array[]) => Uint8Array }).sha512Sync = (...m) =>
  sha512(ed.etc.concatBytes(...m));

// Deployed on testnet by the BA1 build. Override via env.
export const BOND_GATE_ID =
  process.env.BOND_GATE_ID || "CCKX6B7QIE42YA27Y4KTB6CTXRB3OBGR5EW7N2BLAG4AB3V6CFDKXCZU";
export const BOND_IMAGE_ID =
  process.env.BOND_IMAGE_ID ||
  "dc4da02d887b3f388ffee26860a8416b393d4cfea982831183d15d5bfcf1f6c4";
/** Minimum qualifying-set size before the backend will build a proof (anonymity guard; a set of 1
 *  de-anonymizes by elimination). Off-chain by necessity — a Merkle root carries no member count. */
export const BOND_MIN_ANON_SET = Number(process.env.BOND_MIN_ANON_SET || 3);

/** The member set for the STANDALONE Bonded Access page (no Data Room). A user enrolls here, bonds a
 *  qualifying lock for a requirement they pick, and proves membership in THIS set + the bond. Anonymity is
 *  still per req_id (the qualifying-bond crowd), independent of the member set. A fixed 32-byte id keyed
 *  like a DR2 room, distinct from the tier member set. */
export const BOND_STANDALONE_SET_ID = toHex(sha256(new TextEncoder().encode("zkorage-ba-standalone-members")));

export { ESCROW_ID };

const ZERO32 = new Uint8Array(32);
const BOND_SIG_DOMAIN = new TextEncoder().encode("zkorage-bond-access-v1");
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

/** A C-address's 32-byte contract id (the value the guest commits + the gate hashes into req_id). */
export function contractIdBytes(cAddr: string): Uint8Array {
  return new Uint8Array(StrKey.decodeContract(cAddr));
}
export function contractIdHex(cAddr: string): string {
  return toHex(contractIdBytes(cAddr));
}

/** i128 -> 16 big-endian bytes (two's complement; matches Rust `i128::to_be_bytes`). Amounts are positive. */
export function i128be(v: bigint): Uint8Array {
  const u = v & ((1n << 128n) - 1n); // two's complement wrap (no-op for 0 <= v < 2^127)
  const out = new Uint8Array(16);
  let x = u;
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** u64 -> 8 big-endian bytes. */
function u64be(v: bigint | number): Uint8Array {
  let x = BigInt(v) & ((1n << 64n) - 1n);
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/**
 * req_id = sha256(token_contract_id(32) ‖ min_amount(i128 BE 16) ‖ deadline(u64 BE 8)). Identical to the
 * bond-gate's on-chain `sha256(journal[69..125])` and the guest's committed (token ‖ min_amount ‖ deadline).
 * `token` is a SAC/SEP-41 C-address; `minAmount` base units (i128); `deadline` unix seconds.
 */
export function reqId(token: string, minAmount: bigint, deadline: number): Uint8Array {
  return sha256(concat(contractIdBytes(token), i128be(minAmount), u64be(deadline)));
}
export function reqIdHex(token: string, minAmount: bigint, deadline: number): string {
  return toHex(reqId(token, minAmount, deadline));
}

/** NEW-5: the accessor's own ed25519 key (== pk) signs "zkorage-bond-access-v1" ‖ context ‖ accessor. The
 *  context is the req_id (the gate enforces context == req_id), so the consent is bound to THIS requirement. */
export function bondHolderSign(
  holderSeed: Uint8Array,
  context: Uint8Array,
): { accessor: Uint8Array; sig: Uint8Array } {
  const accessor = ed.getPublicKey(need32(holderSeed, "holder_seed"));
  const msg = concat(BOND_SIG_DOMAIN, need32(context, "context"), accessor);
  const sig = ed.sign(msg, holderSeed);
  return { accessor, sig };
}

export interface BondQualLock {
  id: number;
  commitment: string; // 32-byte hex
  amount: string;
  unlock_time: number;
  depositor: string;
}

export interface BondQualSet {
  /** Unique qualifying commitments, in lock-id order (deduped). */
  commitments: string[];
  /** The depth-20 qual-tree root over `commitments`. */
  root: string;
  /** The qualifying locks (for transparency / the UI). */
  locks: BondQualLock[];
  /** Anonymity-set size (== commitments.length). */
  size: number;
}

function isContractError(reason: unknown): boolean {
  return /contract/i.test(String((reason as Error)?.message ?? reason));
}

/**
 * The per-requirement qual-root indexer. Scans the escrow's PUBLIC locks and builds the Merkle root over the
 * commitments of all locks that currently qualify for the requirement (token, minAmount, deadline):
 *   token === requirement.token ∧ amount >= minAmount ∧ unlock_time >= deadline ∧ still-locked ∧
 *   NON-revocable ∧ a non-zero commitment.
 * This root is publicly auditable (anyone reruns it from on-chain state). Commitments are deduped (a member
 * with two qualifying locks of the same commitment is one anonymity member) and ordered by lock id. Fails
 * loudly on a transient (network/RPC) read gap so an under-complete root is never published.
 * CAVEAT (honest): the floor counts DISTINCT COMMITMENTS, not distinct depositors. One wallet could lock N
 * bonds under N fabricated id_secrets to clear the floor without N real members, so the anonymity-set size is
 * an upper bound on the real crowd. Recommend shared, well-populated requirements over bespoke ones.
 */
export async function buildBondQualSet(
  token: string,
  minAmount: bigint,
  deadline: number,
): Promise<BondQualSet> {
  const now = Math.floor(Date.now() / 1000);
  const qualifying: BondQualLock[] = [];
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
        const lockToken = String(l.token);
        const amount = BigInt(String(l.amount));
        const unlock = Number(l.unlock_time);
        const isLocked = !released && now < unlock;
        const isZero = /^0*$/.test(commitment);
        if (
          isLocked &&
          !revocable &&
          lockToken === token &&
          amount >= minAmount &&
          unlock >= deadline &&
          !isZero &&
          !seen.has(commitment)
        ) {
          seen.add(commitment);
          qualifying.push({
            id: ids[i],
            commitment,
            amount: amount.toString(),
            unlock_time: unlock,
            depositor: String(l.depositor),
          });
        }
      } else if (!isContractError(r.reason)) {
        transient = true;
      }
    });
    if (transient) throw new Error("could not reach the network while building the qualifying set");
    if (!anyFound) break;
  }
  qualifying.sort((a, b) => a.id - b.id);
  const commitments = qualifying.map((q) => q.commitment);
  const { root } = buildSparseTree(commitments.map((h) => fromHex(h)), ZERO32);
  return { commitments, root: toHex(root), locks: qualifying, size: commitments.length };
}

/**
 * Build a complete `bond` prover job (the 13 gateway fields) + the public outputs. `memberCommitments` is
 * the ROOM's enrolled set (member at `memberIndex`); the qualifying set is rebuilt live for the requirement.
 * The member's private witness (id_secret/id_trapdoor) must hash to both `memberCommitments[memberIndex]` and
 * a commitment in the qualifying set. `context == req_id` (the gate enforces it). Bond-implies-membership:
 * `member_root` is the room's eligible set, so this single proof proves membership AND the qualifying bond.
 */
export async function buildBondJob(args: {
  idSecret: Uint8Array;
  idTrapdoor: Uint8Array;
  holderSeed: Uint8Array;
  token: string;
  minAmount: bigint;
  deadline: number;
  memberCommitments: Uint8Array[];
  memberIndex: number;
}): Promise<{
  job: Record<string, string | number>;
  memberRoot: string;
  qualRoot: string;
  reqId: string;
  nullifier: string;
  accessor: string;
  qualSize: number;
}> {
  const { idSecret, idTrapdoor, holderSeed, token, minAmount, deadline, memberCommitments, memberIndex } =
    args;
  if (memberIndex < 0 || memberIndex >= 1 << TREE_DEPTH) {
    throw new Error(`memberIndex out of range (must be < 2^${TREE_DEPTH})`);
  }
  if (minAmount <= 0n) throw new Error("minAmount must be positive");
  // The member's secrets must hash to the enrolled commitment at memberIndex (the room's eligible set).
  const leaf = idCommitment(idSecret, idTrapdoor);
  const expected = memberCommitments[memberIndex];
  if (!expected || toHex(expected) !== toHex(leaf)) {
    throw new Error(`id_secret/id_trapdoor do not match the enrolled commitment at index ${memberIndex}`);
  }
  // The qualifying set (live from the escrow, for THIS requirement). The member's qual commitment must be in it.
  const qual = await buildBondQualSet(token, minAmount, deadline);
  if (qual.size < BOND_MIN_ANON_SET) {
    throw new Error(
      `qualifying set too small (${qual.size} < ${BOND_MIN_ANON_SET}); a proof now would weaken anonymity — wait for more qualifying bonds for this requirement`,
    );
  }
  const qc = toHex(qualCommitment(idSecret));
  const qualIndex = qual.commitments.indexOf(qc);
  if (qualIndex < 0) {
    throw new Error(
      "no qualifying bonded lock for this identity — deposit a non-revocable lock with commitment = sha256(0x03‖id_secret‖'escrow'), the required token, amount >= min_amount, unlock_time >= deadline",
    );
  }

  const context = reqId(token, minAmount, deadline);
  const { root: memberRoot, witness: memberWitness } = buildEligibleTree(memberCommitments);
  const m = memberWitness(memberIndex);
  const { witness: qualWitness } = buildSparseTree(qual.commitments.map((h) => fromHex(h)), ZERO32);
  const q = qualWitness(qualIndex);
  const { accessor, sig } = bondHolderSign(holderSeed, context);
  const nf = nullifierOf(idSecret, context);

  return {
    job: {
      kind: "bond",
      sig_hex: toHex(sig),
      pk_hex: toHex(accessor),
      accessor_hex: toHex(accessor),
      id_secret_hex: toHex(idSecret),
      id_trapdoor_hex: toHex(idTrapdoor),
      context_hex: toHex(context),
      token_hex: contractIdHex(token),
      min_amount: minAmount.toString(),
      deadline: String(deadline),
      member_siblings_hex: toHex(m.siblings),
      member_leaf_index: m.leafIndex,
      qual_siblings_hex: toHex(q.siblings),
      qual_leaf_index: q.leafIndex,
    },
    memberRoot: toHex(memberRoot),
    qualRoot: qual.root,
    reqId: toHex(context),
    nullifier: toHex(nf),
    accessor: toHex(accessor),
    qualSize: qual.size,
  };
}

// ---- on-chain reads (key-free; the gate is permissionless to read) ----

function requireGate(): string {
  if (!BOND_GATE_ID) throw new Error("BOND_GATE_ID not configured");
  return BOND_GATE_ID;
}

/** The room-binding decision the DataRoom mirrors: a grant for `req_id` exists, is unexpired, AND was proven
 *  against `member_root` (the room's current eligible_root). */
export async function isBondGrantedFor(
  accessorHex: string,
  reqIdHex: string,
  memberRootHex: string,
): Promise<boolean> {
  const { value } = await readContract(requireGate(), "is_granted_for", [
    scBytes(accessorHex),
    scBytes(reqIdHex),
    scBytes(memberRootHex),
  ]);
  return Boolean(value);
}

/** The member-root-agnostic liveness read (standalone view / debugging). */
export async function isBondGranted(accessorHex: string, reqIdHex: string): Promise<boolean> {
  const { value } = await readContract(requireGate(), "is_granted", [
    scBytes(accessorHex),
    scBytes(reqIdHex),
  ]);
  return Boolean(value);
}

export async function getBondGrant(accessorHex: string, reqIdHex: string): Promise<unknown | null> {
  const { value } = await readContract(requireGate(), "get_grant", [
    scBytes(accessorHex),
    scBytes(reqIdHex),
  ]);
  return value ? jsonSafe(value) : null;
}

export async function isBondNullifierUsed(nullifierHex: string): Promise<boolean> {
  const { value } = await readContract(requireGate(), "is_nullifier_used", [scBytes(nullifierHex)]);
  return Boolean(value);
}

export async function getBondQualRing(reqIdHex: string): Promise<string[]> {
  const { value } = await readContract(requireGate(), "get_qual_ring", [scBytes(reqIdHex)]);
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).map((v) => toHex(new Uint8Array(v as Uint8Array)));
}

export async function getBondConfig(): Promise<unknown> {
  const { value } = await readContract(requireGate(), "get_config");
  return jsonSafe(value);
}

export async function getBondGrantCount(): Promise<number> {
  const { value } = await readContract(requireGate(), "get_count");
  return Number(value ?? 0);
}

// Re-export the bond/qual commitment (= sha256(0x03 ‖ id_secret ‖ "escrow")) the depositor stores in the
// lock for "deposit for access". Identical to the tier commitment by design (a lock can qualify for both).
export { qualCommitment };
export { toHex, fromHex };
