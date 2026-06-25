// A local record, per handle accessor, of the bonded-access grants this browser has proven. The on-chain
// grant stores only the requirement hash (req_id) and the deadline, so it cannot label itself with the token
// and amount; we keep that label here so the "Your access" list can show "2,500 TUSD until ...". The record
// holds NO secret (it is the same public requirement the user picked), so it is safe in localStorage; it is
// never sent anywhere. Keyed by accessor so it follows the handle, not the wallet address.

export interface BondGrantRecord {
  reqId: string; // 32-byte hex, the requirement id the grant is keyed by
  tokenSymbol: string; // display symbol, e.g. "TUSD" / "XLM"
  minAmount: string; // base units, decimal string (formatted with `decimals` for display)
  decimals: number;
  deadline: number; // unix seconds
}

const KEY = (accessor: string) => `zkorage-bond-grants.${accessor}`;
const MAX = 100; // a sane cap so the list cannot grow without bound

const isHex = (s: unknown, len: number): boolean => typeof s === "string" && new RegExp(`^[0-9a-fA-F]{${len}}$`).test(s);

function sanitize(rec: unknown): BondGrantRecord | null {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  if (!isHex(r.reqId, 64)) return null;
  if (typeof r.tokenSymbol !== "string" || !r.tokenSymbol) return null;
  if (typeof r.minAmount !== "string" || !/^\d{1,40}$/.test(r.minAmount)) return null;
  const decimals = Number(r.decimals);
  const deadline = Number(r.deadline);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  if (!Number.isFinite(deadline) || deadline <= 0) return null;
  return {
    reqId: (r.reqId as string).toLowerCase(),
    tokenSymbol: (r.tokenSymbol as string).slice(0, 16),
    minAmount: r.minAmount as string,
    decimals,
    deadline,
  };
}

/** Read the recorded grants for a handle accessor (validated; junk rows are dropped). */
export function readBondGrants(accessor?: string | null): BondGrantRecord[] {
  if (!accessor) return [];
  try {
    const raw = localStorage.getItem(KEY(accessor));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(sanitize).filter((r): r is BondGrantRecord => r !== null);
  } catch {
    return [];
  }
}

/** Record (or update) a grant for a handle accessor, deduped by req_id (the latest record wins). */
export function recordBondGrant(accessor: string, rec: BondGrantRecord): void {
  const clean = sanitize(rec);
  if (!accessor || !clean) return;
  try {
    const list = readBondGrants(accessor).filter((r) => r.reqId !== clean.reqId);
    list.unshift(clean);
    localStorage.setItem(KEY(accessor), JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* storage full or unavailable; the list is a convenience, not load-bearing */
  }
}
