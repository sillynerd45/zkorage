// Push / pull the "Your access" list to the wallet-derived encrypted vault. Shared by the Bonded Access page
// (push after a grant lands) and the "Your access" page (pull on a fresh device). The records carry no secret
// (public requirement values), encrypted under the wallet so the backend holds an opaque blob it cannot read.
import { getBondGrantsVault, putBondGrantsVault } from "@/lib/api";
import { encryptBondGrants, decryptBondGrants, deriveBondGrantsVaultId } from "./grantsVault";
import { readBondGrants, recordBondGrant } from "./grants";

/** Encrypt the local grant records for `accessor` under `sig` and store the opaque blob in the vault. */
export async function pushGrantsVault(sig: Uint8Array, accessor: string): Promise<void> {
  const blob = await encryptBondGrants(sig, readBondGrants(accessor));
  await putBondGrantsVault(await deriveBondGrantsVaultId(sig), blob);
}

/** Pull the vault saved by this wallet, decrypt, and merge the records under `accessor`. Returns the count. */
export async function pullGrantsVault(sig: Uint8Array, accessor: string): Promise<number> {
  const res = await getBondGrantsVault(await deriveBondGrantsVaultId(sig));
  if (res.found && res.blob) {
    const recs = await decryptBondGrants(sig, res.blob);
    for (const r of recs) recordBondGrant(accessor, r);
    return recs.length;
  }
  return 0;
}
