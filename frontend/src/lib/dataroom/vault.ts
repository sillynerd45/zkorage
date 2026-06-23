// Automatic cross-device sync for the "rooms you can open" list, via the encrypted vault. The list is not a
// secret (access is re-derived from the wallet), but it is stored as ciphertext under a wallet-derived
// pseudonym so the backend holds a blob it cannot read and cannot link to your wallet. This is the alternative
// to server-side {wallet -> rooms} sync (which would re-create cross-room correlation) and to a manual file.
//
// pull/push need the wallet signature (the HKDF input). Callers pass it from useDataRoomIdentity.getSignature
// so we reuse the one-prompt-per-session cache and never pop the wallet just to load a page.
import { exportRoomsBackup, importRoomsBackup, mergeJoinRequests, deriveVaultHandle } from "./roomsBackup";
import { readJoinRequests, writeJoinRequests, type JoinRequest } from "./requests";
import { getRoomsVault, putRoomsVault, deleteRoomsVault } from "@/lib/api";

// Per-wallet sync preference (this browser). Default OFF; only an explicit "1" (the user turned it on) enables
// it, so cross-device sync is opt-in and we never sign on page load unless the user asked for sync before.
export const vaultSyncKey = (addr: string) => `zkorage.dr.vaultSync.${addr}`;
export function isVaultSyncOn(addr: string | null | undefined): boolean {
  if (!addr || typeof localStorage === "undefined") return false;
  return localStorage.getItem(vaultSyncKey(addr)) === "1";
}
export function setVaultSyncOn(addr: string, on: boolean): void {
  try {
    localStorage.setItem(vaultSyncKey(addr), on ? "1" : "0");
  } catch {
    /* ignore quota */
  }
}

/** Pull the remote vault (if any), merge into the local list, persist, and return the merged list. A foreign
 *  or corrupt blob (wrong wallet, tamper) is ignored so it can never wipe the local list. */
export async function pullVault(address: string, sig: Uint8Array): Promise<JoinRequest[]> {
  const handle = await deriveVaultHandle(sig);
  const res = await getRoomsVault(handle);
  const local = readJoinRequests(address);
  if (!res.found || !res.blob) return local;
  let incoming: JoinRequest[] = [];
  try {
    incoming = await importRoomsBackup(sig, res.blob);
  } catch {
    return local; // not ours / corrupt -> leave the local list untouched
  }
  const merged = mergeJoinRequests(local, incoming);
  writeJoinRequests(address, merged);
  return merged;
}

/** Encrypt the current local list and store it in the vault (overwrites the prior copy). */
export async function pushVault(address: string, sig: Uint8Array): Promise<void> {
  const handle = await deriveVaultHandle(sig);
  const blob = await exportRoomsBackup(sig, readJoinRequests(address));
  await putRoomsVault(handle, blob);
}

/** Delete the server-side copy (called when the user turns sync off). */
export async function forgetVault(sig: Uint8Array): Promise<void> {
  const handle = await deriveVaultHandle(sig);
  await deleteRoomsVault(handle);
}
