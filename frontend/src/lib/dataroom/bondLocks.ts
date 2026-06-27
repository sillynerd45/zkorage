// A local (this-browser, per-wallet) marker that you locked a qualifying bond for a room's CURRENT bond
// requirement, so the Open page can show a "you've already locked a bond, continue" hint on re-landing without
// a wallet signature. It is a HINT only: the authoritative check (deriving your per-room identity + reading the
// live qualifying-bond set) still runs when you click "Set up access". The reqId at lock time is stored, so if
// the owner changes the requirement the stale marker no longer matches and the hint silently disappears.
//
// Local-only, so it adds no trust claim. A different device shows no hint until the on-chain check runs (which
// then re-marks it). Never holds a secret.

const PREFIX = "zkorage.dr.bondlocked.";
const key = (addr: string) => `${PREFIX}${addr}`;
type Marks = Record<string, string>; // roomId (lowercased) -> reqId (lowercased) at lock time

function read(addr: string): Marks {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(key(addr)) || "{}") as Marks;
  } catch {
    return {};
  }
}

function write(addr: string, m: Marks): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key(addr), JSON.stringify(m));
  } catch {
    /* ignore quota */
  }
}

/** Remember that this wallet locked a qualifying bond for `roomId` under requirement `reqId`. */
export function markBondLocked(addr: string | null | undefined, roomId: string, reqId: string | undefined): void {
  if (!addr || !reqId) return;
  const m = read(addr);
  m[roomId.trim().toLowerCase()] = reqId.toLowerCase();
  write(addr, m);
}

/** Forget the marker for this wallet + room (e.g. the live check found no qualifying bond). */
export function clearBondLocked(addr: string | null | undefined, roomId: string): void {
  if (!addr) return;
  const m = read(addr);
  if (delete m[roomId.trim().toLowerCase()]) write(addr, m);
}

/** True only if this wallet has a marker for `roomId` whose stored reqId matches the room's CURRENT reqId. */
export function hasBondLockedFor(addr: string | null | undefined, roomId: string, reqId: string | undefined): boolean {
  if (!addr || !reqId) return false;
  return read(addr)[roomId.trim().toLowerCase()] === reqId.toLowerCase();
}
