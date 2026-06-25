// A local record, per handle accessor, of bond proofs that have been STARTED in the background and have not
// landed on-chain yet. Proving runs on the self-hosted prover and the backend submits the result, so the user
// can leave; this record lets the page show "proof in progress" (even across a reload) and record the grant
// into "Your access" once is_granted lands. It carries the requirement's display fields so the grant can be
// labelled without re-deriving them. No secret, keyed by the anonymous accessor.

export interface BondPending {
  reqId: string; // 32-byte hex
  startedAt: number; // epoch ms (for the stale/timeout window)
  deadline: number; // unix seconds (the requirement deadline)
  tokenSymbol: string;
  minAmount: string; // base units
  decimals: number;
}

const KEY = (accessor: string) => `zkorage-bond-pending.${accessor}`;
const MAX = 50;
const isHex64 = (s: unknown): s is string => typeof s === "string" && /^[0-9a-fA-F]{64}$/.test(s);

function sanitize(p: unknown): BondPending | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if (!isHex64(o.reqId)) return null;
  if (typeof o.tokenSymbol !== "string" || !o.tokenSymbol) return null;
  if (typeof o.minAmount !== "string" || !/^\d{1,40}$/.test(o.minAmount)) return null;
  const startedAt = Number(o.startedAt);
  const deadline = Number(o.deadline);
  const decimals = Number(o.decimals);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  if (!Number.isFinite(deadline) || deadline <= 0) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  return { reqId: (o.reqId as string).toLowerCase(), startedAt, deadline, tokenSymbol: (o.tokenSymbol as string).slice(0, 16), minAmount: o.minAmount as string, decimals };
}

export function readPending(accessor?: string | null): BondPending[] {
  if (!accessor) return [];
  try {
    const raw = localStorage.getItem(KEY(accessor));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(sanitize).filter((p): p is BondPending => p !== null);
  } catch {
    return [];
  }
}

export function addPending(accessor: string, p: BondPending): void {
  const clean = sanitize(p);
  if (!accessor || !clean) return;
  try {
    const list = readPending(accessor).filter((x) => x.reqId !== clean.reqId);
    list.unshift(clean);
    localStorage.setItem(KEY(accessor), JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* storage unavailable; the in-progress display is a convenience, not load-bearing */
  }
}

export function removePending(accessor: string, reqId: string): void {
  if (!accessor) return;
  try {
    const list = readPending(accessor).filter((x) => x.reqId !== reqId.toLowerCase());
    if (list.length) localStorage.setItem(KEY(accessor), JSON.stringify(list));
    else localStorage.removeItem(KEY(accessor));
  } catch {
    /* ignore */
  }
}
