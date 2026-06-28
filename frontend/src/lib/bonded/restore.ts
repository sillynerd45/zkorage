// Headless Bonded Access restore/backup, shared by the unified sync orchestrator (and mirrors what Tier.tsx's
// restoreHandle/backupHandle do, minus the React state). Given the master signature, it either restores the
// wallet's handle from its vault, or (if the vault is empty but this browser already has a local handle) backs
// the local handle up so it follows the wallet. No prompt of its own: the caller passes the cached signature.
import { getBondHandleVault, putBondHandleVault } from "@/lib/api";
import { loadIdentityAt, idKey } from "./handle";
import {
  decryptBondHandle,
  encryptBondHandle,
  deriveBondHandleVaultId,
  type BondHandle,
} from "./handleVault";
import { pullGrantsVault, pushGrantsVault } from "./grantsSync";

/** Restore the handle from the vault, or back up a local-only handle. Returns the handle in effect, or null. */
export async function restoreOrBackupBond(address: string, sig: Uint8Array): Promise<BondHandle | null> {
  const vaultId = await deriveBondHandleVaultId(sig);
  const res = await getBondHandleVault(vaultId);
  if (res.found && res.blob) {
    const h = await decryptBondHandle(sig, res.blob);
    try {
      localStorage.setItem(idKey(address), JSON.stringify(h));
    } catch {
      /* private mode / quota: the in-memory handle still works this session */
    }
    // Pull the "your access" list for this handle too, so a fresh device has it.
    await pullGrantsVault(sig, h.accessor).catch(() => {});
    return h;
  }
  // The vault has no handle. If this browser holds one (minted here, never backed up), push it up now.
  const local = loadIdentityAt(address) as BondHandle | null;
  if (local && local.accessor) {
    try {
      await putBondHandleVault(vaultId, await encryptBondHandle(sig, local));
    } catch {
      /* best-effort; the local copy is intact regardless */
    }
    await pushGrantsVault(sig, local.accessor).catch(() => {});
    return local;
  }
  return null;
}
