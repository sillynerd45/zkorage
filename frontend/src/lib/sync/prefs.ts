// The app-wide "Sync across devices" preference.
//
// One signature now restores BOTH pillars (the Data Room "rooms you can open" list and the Bonded Access handle
// + its grants), so the preference is app-wide, not Data-Room-only as before.
//
//  - pref is PER WALLET: a choice you made for this account ("on" / "off"). Default off (opt-in).
//  - dontAsk is DEVICE-LEVEL: a returning user who does not want the connect dialog again on this machine.
//    This matches "do not show again": it skips the dialog for every wallet on this device, and the saved
//    per-wallet pref is then applied silently.
//
// These are preferences, not secrets, so plain localStorage is fine.

const PREF = (addr: string) => `zkorage.sync.pref.${addr}`;
const LEGACY_DR = (addr: string) => `zkorage.dr.vaultSync.${addr}`; // the old Data-Room-only flag
const DONT_ASK = "zkorage.sync.dontAsk";

/** Is sync enabled for this wallet? Migrates the legacy Data-Room-only flag so a user who had DR sync on keeps it. */
export function getSyncPref(addr: string | null | undefined): boolean {
  if (!addr || typeof localStorage === "undefined") return false;
  const v = localStorage.getItem(PREF(addr));
  if (v === "1") return true;
  if (v === "0") return false;
  return localStorage.getItem(LEGACY_DR(addr)) === "1";
}

export function setSyncPref(addr: string, on: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PREF(addr), on ? "1" : "0");
  } catch {
    /* ignore quota */
  }
}

/** Device-level: has the user asked not to see the connect dialog again? */
export function isDontAsk(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(DONT_ASK) === "1";
}

export function setDontAsk(on: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(DONT_ASK, on ? "1" : "0");
  } catch {
    /* ignore quota */
  }
}

/** Fired after a restore so any mounted page can re-read the freshly synced local state. */
export const SYNC_EVENT = "zkorage:sync";
export function emitSyncChanged(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(SYNC_EVENT));
  } catch {
    /* no-op */
  }
}
