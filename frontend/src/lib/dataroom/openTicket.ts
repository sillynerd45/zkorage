// A queued-access ticket persisted per (wallet, room) in this browser, so the "waiting for the batch window"
// state survives leaving and returning to the Open tab. When a member proves membership, the proof is handed
// to the batching relay (M7 timing defense) and lands on-chain only at the next fixed window boundary; that
// wait can be minutes, so we remember the ticket and resume polling on return instead of losing it on unmount.
// Local-only (this browser), so it adds no trust claim beyond what the request-history store already does.

const PREFIX = "zkorage.dr.openticket.";
const ticketKey = (addr: string, roomId: string) => `${PREFIX}${addr}.${roomId.toLowerCase()}`;

export interface OpenTicket {
  roomId: string; // the room whose access is queued (lowercased hex)
  docId: string; // the doc the member set out to open (so we can auto-open once access lands)
  ticket: string; // the relay's batch ticket id (poll /queue-status with it)
  flushAt: number | null; // unix ms the window flushes (display only)
  windowMs: number | null; // window length (for the poll deadline)
  ts: number; // when it was queued
}

export function readOpenTicket(addr: string | null | undefined, roomId: string): OpenTicket | null {
  if (!addr || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(ticketKey(addr, roomId));
    return raw ? (JSON.parse(raw) as OpenTicket) : null;
  } catch {
    return null;
  }
}

export function writeOpenTicket(addr: string | null | undefined, t: OpenTicket): void {
  if (!addr || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(ticketKey(addr, t.roomId), JSON.stringify(t));
  } catch {
    /* ignore quota */
  }
}

export function clearOpenTicket(addr: string | null | undefined, roomId: string): void {
  if (!addr || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(ticketKey(addr, roomId));
  } catch {
    /* ignore */
  }
}

/** The first outstanding ticket for this wallet (any room), so the tab can auto-resume a wait on landing. */
export function findOpenTicket(addr: string | null | undefined): OpenTicket | null {
  if (!addr || typeof localStorage === "undefined") return null;
  try {
    const prefix = `${PREFIX}${addr}.`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) {
        const raw = localStorage.getItem(k);
        if (raw) return JSON.parse(raw) as OpenTicket;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
