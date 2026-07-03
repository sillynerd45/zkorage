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
const NO_PROMPT = "zkorage.sync.noPrompt";

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

/**
 * Has the user made an EXPLICIT sync choice for this wallet (on or off, incl. the migrated legacy flag)? This
 * distinguishes a wallet the user already decided on from a brand-new one. The connect dialog asks whenever a
 * wallet has NO recorded choice, so switching to a fresh wallet always prompts, even on a device where the user
 * ticked "don't ask again" (that opt-out is about not re-asking DECIDED wallets, not silently defaulting a new
 * wallet to off).
 */
export function hasSyncPref(addr: string | null | undefined): boolean {
  if (!addr || typeof localStorage === "undefined") return false;
  const v = localStorage.getItem(PREF(addr));
  if (v === "1" || v === "0") return true;
  return localStorage.getItem(LEGACY_DR(addr)) === "1";
}

/** Device-level: has the user asked not to see the connect dialog again? With this set, a wallet that already
 *  has a saved preference is applied silently; a wallet with NO saved preference is still asked (see the dialog
 *  and [[hasSyncPref]]). */
export function isDontAsk(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(DONT_ASK) === "1";
}

/** Device-level HARD opt-out: never show the connect dialog for any wallet; just apply each wallet's saved
 *  preference silently. This is NOT set by the UI (the "don't ask again" checkbox uses [[isDontAsk]], which still
 *  prompts for a wallet with no saved preference). It exists as a programmatic / automated-test "never prompt"
 *  setup, so it must stay independent of the per-wallet consent above. */
export function isNoPrompt(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(NO_PROMPT) === "1";
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
