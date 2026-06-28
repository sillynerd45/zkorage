// The unified sync actions. One signature restores + backs up BOTH pillars; disabling stops syncing.
import { getMasterSignature, hasMasterSignature } from "@/lib/wallet/masterSig";
import { pullVault, pushVault, forgetVault } from "@/lib/dataroom/vault";
import { restoreOrBackupBond } from "@/lib/bonded/restore";
import { setSyncPref, emitSyncChanged } from "./prefs";

type Signer = (message: string) => Promise<Uint8Array>;

/**
 * Enable + restore. Takes ONE wallet signature (cached for the rest of the session), then pulls each pillar's
 * encrypted vault down (merged into the local lists) and pushes the local union back up, so a device that
 * already has local data also gets backed up. Throws if the user declines the signature (the caller surfaces it).
 */
export async function syncRestoreAll(address: string, signMessage: Signer): Promise<void> {
  const sig = await getMasterSignature(address, signMessage);
  // Data Room "rooms you can open"
  await pullVault(address, sig);
  await pushVault(address, sig).catch(() => {});
  // Bonded Access handle + "your access" grants
  await restoreOrBackupBond(address, sig).catch(() => {});
  setSyncPref(address, true);
  emitSyncChanged();
}

/**
 * Disable. Stops syncing and deletes the server copy of the rooms list (matching the prior Data Room behavior).
 * The Bonded Access handle backup is intentionally left in place, so toggling a setting never loses the wallet's
 * anonymous credential. Only deletes when the wallet already signed this session, so turning a setting off never
 * pops the wallet. Returns whether the server copy was deleted.
 */
export async function syncDisable(address: string, signMessage: Signer): Promise<boolean> {
  setSyncPref(address, false);
  let deleted = false;
  if (hasMasterSignature(address)) {
    try {
      await forgetVault(await getMasterSignature(address, signMessage));
      deleted = true;
    } catch {
      /* leave the copy; the setting is still off locally */
    }
  }
  emitSyncChanged();
  return deleted;
}
