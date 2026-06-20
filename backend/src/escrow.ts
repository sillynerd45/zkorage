// Bonded-Proofs escrow (BP1/BP2): read helpers + a lightweight "my locks" indexer. No key custody here
// — writes are built as unsigned XDR for the wallet to sign (server.ts). Lock ids are sequential from 1,
// so "my locks" scans get_lock in early-stopping batches (a fully-empty batch means past the end) and
// filters by owner; is_locked is derived from the record. This is deterministic and age-robust (no event
// retention window), which matters for a wallet view; the escrow stays small for the demo.
import { readContract, scU64, scAddress, jsonSafe } from "./chain.js";

// Deployed on testnet (deployment.testnet.json -> escrow_BP1). Override via env in other environments.
export const ESCROW_ID =
  process.env.ESCROW_CONTRACT_ID || "CAMQKJKAJTOMT66N5N3E3VIRTN5ACDKV6P3Z2HLYVJHLAVRGJKHZFOXC";
export const BOND_TOKEN_ID =
  process.env.BOND_TOKEN_CONTRACT_ID || "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5";

const SCAN_BATCH = 8;
const SCAN_MAX = Number(process.env.ESCROW_MAX_SCAN || 200);

export interface LockView {
  id: number;
  depositor: string;
  claimant: string;
  token: string;
  amount: string; // i128 as a decimal string (base units)
  unlock_time: number; // unix seconds
  commitment: string; // 32-byte hex
  revocable: boolean;
  released: boolean;
  is_locked: boolean;
  /** This wallet's relationship to the lock. */
  role: "depositor" | "claimant" | "self";
}

type LockRecord = Record<string, unknown>;

/** Live read of a single lock's current record (errors with LockNotFound for unknown ids). */
export async function getLock(id: number): Promise<LockRecord | null> {
  const { value } = await readContract(ESCROW_ID, "get_lock", [scU64(id)]);
  return value ? (jsonSafe(value) as LockRecord) : null;
}

/** Live boolean a gate reads on-chain: exists & unreleased & now < unlock_time (LEDGER time). */
export async function isLocked(id: number): Promise<boolean> {
  const { value } = await readContract(ESCROW_ID, "is_locked", [scU64(id)]);
  return Boolean(value);
}

/** The connected wallet's bond-token balance (base units, decimal string). */
export async function bondBalance(owner: string): Promise<string> {
  const { value } = await readContract(BOND_TOKEN_ID, "balance", [scAddress(owner)]);
  return value != null ? String(value) : "0";
}

function toView(id: number, l: LockRecord, owner: string, isLockedVal: boolean): LockView {
  const depositor = String(l.depositor);
  const claimant = String(l.claimant);
  return {
    id,
    depositor,
    claimant,
    token: String(l.token),
    amount: String(l.amount),
    unlock_time: Number(l.unlock_time),
    commitment: String(l.commitment),
    revocable: Boolean(l.revocable),
    released: Boolean(l.released),
    is_locked: isLockedVal,
    role: depositor === claimant ? "self" : depositor === owner ? "depositor" : "claimant",
  };
}

// A rejection from get_lock on a nonexistent id is a CONTRACT error (LockNotFound); a network/RPC failure
// is not. We only treat a fully-not-found batch as "past the end" — a transient error must not truncate
// the scan into a misleading empty list.
function isContractError(reason: unknown): boolean {
  return /contract/i.test(String((reason as Error)?.message ?? reason));
}

/** Return the locks an owner is party to (as depositor or claimant), with CURRENT on-chain state.
 *  Discovery scans get_lock in early-stopping batches; is_locked is then read from the contract (ledger
 *  time) for the owner's few locks, so the status/actions never disagree with what the contract enforces. */
export async function listLocks(owner: string): Promise<LockView[]> {
  const owned: { id: number; rec: LockRecord }[] = [];
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
        const dep = String(r.value.depositor);
        const cl = String(r.value.claimant);
        if (dep === owner || cl === owner) owned.push({ id: ids[i], rec: r.value });
      } else if (!isContractError(r.reason)) {
        transient = true; // a network/RPC error, not "past the end"
      }
    });
    if (transient && !anyFound) throw new Error("could not reach the network while loading your locks");
    if (!anyFound) break; // a fully not-found batch => we are past the highest lock id
  }
  // Authoritative is_locked from the contract (ledger time), only for the owner's locks (few).
  return Promise.all(
    owned.map(async ({ id, rec }) => {
      const locked = await isLocked(id).catch(() => false);
      return toView(id, rec, owner, locked);
    }),
  );
}
