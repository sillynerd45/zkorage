import type { EnrollState } from "@/lib/api";

// A local "your requests" history entry (per wallet, this browser only). It records which rooms a wallet asked
// to join + the last-known status, so the UI can show pending requests and reflect status (e.g. relabel the
// Discover join button) WITHOUT re-deriving an identity or sending the wallet address anywhere. Written by
// useEnroll (on request + on Refresh); read by useEnroll and Discover.
export type JoinRequest = { roomId: string; label?: string; state: EnrollState; ts: number };

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

/** Map of lowercased roomId -> last-known state, for quick status lookups (e.g. the Discover directory). The
 *  state is only as fresh as the last write/Refresh, so it is a hint; the authoritative check is on-chain. */
export function joinRequestStates(addr: string | null | undefined): Record<string, EnrollState> {
  const m: Record<string, EnrollState> = {};
  for (const r of readJoinRequests(addr)) m[r.roomId.toLowerCase()] = r.state;
  return m;
}
