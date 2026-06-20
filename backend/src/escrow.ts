// Bonded-Proofs escrow (BP1/BP2): read helpers + a lightweight "my locks" indexer. No key custody here
// — writes are built as unsigned XDR for the wallet to sign (server.ts). Lock ids are sequential from 1,
// so "my locks" scans get_lock in early-stopping batches (a fully-empty batch means past the end) and
// filters by owner; is_locked is derived from the record. This is deterministic and age-robust (no event
// retention window), which matters for a wallet view; the escrow stays small for the demo.
import { readContract, scU64, jsonSafe } from "./chain.js";

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

/** Live boolean a gate reads on-chain: exists & unreleased & now < unlock_time. */
export async function isLocked(id: number): Promise<boolean> {
  const { value } = await readContract(ESCROW_ID, "is_locked", [scU64(id)]);
  return Boolean(value);
}

function toView(id: number, l: LockRecord, owner: string): LockView | null {
  const depositor = String(l.depositor);
  const claimant = String(l.claimant);
  if (depositor !== owner && claimant !== owner) return null;
  const released = Boolean(l.released);
  const unlock = Number(l.unlock_time);
  return {
    id,
    depositor,
    claimant,
    token: String(l.token),
    amount: String(l.amount),
    unlock_time: unlock,
    commitment: String(l.commitment),
    revocable: Boolean(l.revocable),
    released,
    is_locked: !released && Math.floor(Date.now() / 1000) < unlock,
    role: depositor === claimant ? "self" : depositor === owner ? "depositor" : "claimant",
  };
}

/** Return the locks an owner is party to (as depositor or claimant), with current state. */
export async function listLocks(owner: string): Promise<LockView[]> {
  const out: LockView[] = [];
  for (let start = 1; start <= SCAN_MAX; start += SCAN_BATCH) {
    const ids: number[] = [];
    for (let i = 0; i < SCAN_BATCH && start + i <= SCAN_MAX; i++) ids.push(start + i);
    const settled = await Promise.allSettled(ids.map((id) => getLock(id)));
    let anyFound = false;
    settled.forEach((r, i) => {
      if (r.status !== "fulfilled" || !r.value) return; // LockNotFound (past the end) or transient
      anyFound = true;
      const v = toView(ids[i], r.value, owner);
      if (v) out.push(v);
    });
    if (!anyFound) break; // a fully-empty batch => we are past the highest lock id
  }
  return out;
}
