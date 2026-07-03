import { getEnrollStatus, type EnrollState } from "@/lib/api";

// A local "your requests" history entry (per wallet, this browser only). It records which rooms a wallet asked
// to join + the last-known status, so the UI can show pending requests and reflect status (e.g. relabel the
// Discover join button) WITHOUT re-deriving an identity or sending the wallet address anywhere. Written by
// useEnroll (on request + on Refresh); read by useEnroll and Discover.
//
// `commitment` is the PUBLIC per-room id_commitment (a sha256 hash) captured when the request was filed. It is
// already sent to the backend on request and pinned on-chain, so storing it locally leaks nothing, and it lets
// the status be re-checked (getEnrollStatus) with NO wallet signature. That is what powers the automatic
// pending -> approved refresh. It is optional so history written before this field still loads.
export type JoinRequest = { roomId: string; label?: string; state: EnrollState; ts: number; commitment?: string };

export const requestsKey = (addr: string) => `zkorage.dr.requests.${addr}`;

/** Read the local join-request history for a wallet (this browser). Returns [] if none or unparseable. */
export function readJoinRequests(addr: string | null | undefined): JoinRequest[] {
  if (!addr || typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(requestsKey(addr));
    return raw ? (JSON.parse(raw) as JoinRequest[]) : [];
  } catch {
    return [];
  }
}

/** Overwrite the local join-request history for a wallet (used by a Refresh that re-checks statuses). */
export function writeJoinRequests(addr: string | null | undefined, list: JoinRequest[]): void {
  if (!addr || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(requestsKey(addr), JSON.stringify(list));
  } catch {
    /* ignore quota */
  }
}

/** Map of lowercased roomId -> last-known state, for quick status lookups (e.g. the Discover directory). The
 *  state is only as fresh as the last write/Refresh, so it is a hint; the authoritative check is on-chain. */
export function joinRequestStates(addr: string | null | undefined): Record<string, EnrollState> {
  const m: Record<string, EnrollState> = {};
  for (const r of readJoinRequests(addr)) m[r.roomId.toLowerCase()] = r.state;
  return m;
}

/**
 * Silently re-check the live on-chain status of every locally-tracked join request that carries a stored public
 * commitment, and persist the result. It needs NO wallet signature: the commitment is public and already
 * stored, so no identity derivation and no prompt. This is what lets Discover / Membership / Open promote a
 * just-approved request from Pending to Approved automatically. Entries with no stored commitment (older
 * history) are left untouched here; the manual Refresh re-derives those.
 *
 * Read-modify-write is done against a fresh disk read at write time (not the snapshot taken before the async
 * status calls) so a request the user filed during the network window is not clobbered. Returns whether
 * anything actually changed, so a caller can skip a needless re-render.
 */
export async function refreshJoinRequestStatuses(
  addr: string | null | undefined,
): Promise<{ changed: boolean }> {
  if (!addr) return { changed: false };
  const base = readJoinRequests(addr);
  const fresh = new Map<string, EnrollState>(); // lowercased roomId -> new state
  for (const r of base) {
    if (!r.commitment) continue; // no signature-free way to check; leave it to the manual Refresh
    const s = await getEnrollStatus(r.roomId, r.commitment).catch(() => null);
    if (s && s.state !== r.state) fresh.set(r.roomId.toLowerCase(), s.state);
  }
  if (fresh.size === 0) return { changed: false };
  // Re-read at write time and apply only the changed states, so any entry added meanwhile survives.
  const merged = readJoinRequests(addr).map((r) => {
    const ns = fresh.get(r.roomId.toLowerCase());
    return ns ? { ...r, state: ns } : r;
  });
  writeJoinRequests(addr, merged);
  return { changed: true };
}
