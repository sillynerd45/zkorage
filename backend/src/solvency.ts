// Bonded Proofs (BP3) — the solvency gate: read helpers + the prove-job binding. The gate verifies a
// `reserves >= supply` Groth16 proof (reserves PRIVATE) bound to a bonded escrow lock, then reads that
// lock LIVE so the grant self-voids on unbond. No key custody here — the submit is built as unsigned XDR
// for the lock owner's wallet to sign (server.ts), and `is_granted` is a permissionless read.
import { readContract, scAddress, jsonSafe } from "./chain.js";
import { StrKey } from "@stellar/stellar-sdk";
import { ESCROW_ID, BOND_TOKEN_ID, getLock } from "./escrow.js";

// Deployed on testnet. Override via env in other environments.
export const SOLVENCY_GATE_ID =
  process.env.SOLVENCY_GATE_ID || "CDHUG4NFTDIO4HX2MZH3PR77EKYUAU47HVKH4UO2WG7GSKDEF4ABWMLA";
export const SOLVENCY_IMAGE_ID =
  process.env.SOLVENCY_IMAGE_ID ||
  "d0a2f137812e05084aa79d0f7353d3fb7785da25facadd140494b94bed10e267";
// The supply/liability token the gate binds the proven supply to (the W2 zUSD supply-tracking token).
export const SOLVENCY_SUPPLY_TOKEN_ID =
  process.env.SOLVENCY_SUPPLY_TOKEN_ID || "CC3JKNC4EKALMT7WALUMCTVBSH73ZZSP3AC4B7IQUAZ7UYYZCEIISQLA";

export { ESCROW_ID, BOND_TOKEN_ID };

/** A C-address's 32-byte contract id as hex — exactly what the guest commits + the gate binds. */
export function contractIdHex(cAddr: string): string {
  return Buffer.from(StrKey.decodeContract(cAddr)).toString("hex");
}

/** The supply token's live circulating supply (base units, decimal string) — the figure the proof binds. */
export async function supplyTokenSupply(): Promise<bigint> {
  const { value } = await readContract(SOLVENCY_SUPPLY_TOKEN_ID, "total_supply");
  return BigInt(String(value ?? "0"));
}

/** The live solvency decision: re-reads the escrow lock + supply, flips false the instant you unbond. */
export async function isSolvencyGranted(depositor: string): Promise<boolean> {
  const { value } = await readContract(SOLVENCY_GATE_ID, "is_granted", [scAddress(depositor)]);
  return Boolean(value);
}

export async function getSolvencyRecord(depositor: string): Promise<unknown | null> {
  const { value } = await readContract(SOLVENCY_GATE_ID, "get_record", [scAddress(depositor)]);
  return value ? jsonSafe(value) : null;
}

export async function getSolvencyConfig(): Promise<unknown> {
  const { value } = await readContract(SOLVENCY_GATE_ID, "get_config");
  return jsonSafe(value);
}

export interface LockGuard {
  ok: boolean;
  reason?: string;
  amount?: string;
  unlock_time?: number;
  depositor?: string;
}

/** Pre-flight a lock before proving: it must be a live, revocable, bond-token lock (else the gate rejects
 *  the proof at submit). Surfaced as a friendly reason so the UI never spends a proof on a doomed lock. */
export async function guardLock(lockId: number): Promise<LockGuard> {
  let lock: Record<string, unknown> | null;
  try {
    lock = await getLock(lockId);
  } catch (e) {
    return { ok: false, reason: `lock ${lockId} not found` };
  }
  if (!lock) return { ok: false, reason: `lock ${lockId} not found` };
  if (Boolean(lock.released)) return { ok: false, reason: "lock already released" };
  if (!Boolean(lock.revocable)) return { ok: false, reason: "lock is not revocable (solvency bonds must be revocable)" };
  if (String(lock.token) !== BOND_TOKEN_ID) return { ok: false, reason: "lock holds a different token than the bond token" };
  const now = Math.floor(Date.now() / 1000);
  if (Number(lock.unlock_time) <= now) return { ok: false, reason: "lock has passed its unlock time" };
  return {
    ok: true,
    amount: String(lock.amount),
    unlock_time: Number(lock.unlock_time),
    depositor: String(lock.depositor),
  };
}

/** Build the gateway prove-job body for kind=solvency: the reserve attestation + the five public
 *  escrow-binding values the gate enforces on-chain. `threshold` = the supply the proof binds. */
export function buildSolvencyJob(args: {
  envelope_hex: string;
  signature_hex: string;
  issuer_pubkey_hex: string;
  supply: bigint;
  lockId: number;
  minAmount: bigint;
}): Record<string, string> {
  return {
    kind: "solvency",
    envelope_hex: args.envelope_hex,
    signature_hex: args.signature_hex,
    issuer_pubkey_hex: args.issuer_pubkey_hex,
    threshold: args.supply.toString(),
    escrow_hex: contractIdHex(ESCROW_ID),
    lock_id: String(args.lockId),
    min_amount: args.minAmount.toString(),
    bond_token_hex: contractIdHex(BOND_TOKEN_ID),
    supply_token_hex: contractIdHex(SOLVENCY_SUPPLY_TOKEN_ID),
  };
}
