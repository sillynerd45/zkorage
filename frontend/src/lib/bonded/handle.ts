// Shared access to the standalone Bonded Access handle: the per-wallet localStorage slot and the one-prompt
// wallet signature that keys the handle + grants vaults. Used by the Bonded Access page (mint / prove), the
// "Your access" page (display), and the bond-only room open flow.
//
// The signature is now the app-wide MASTER signature (lib/wallet/masterSig), shared with the Data Room, so a
// user is prompted at most once per session no matter which feature signs first. The handle is stored PER
// WALLET, so switching accounts in Freighter never shows another wallet's handle.
import type { BondIdentity } from "@/lib/api";
import { getMasterSignature, hasMasterSignature } from "@/lib/wallet/masterSig";

export const IDENTITY_BASE = "zkorage-bond-identity";
export const idKey = (addr?: string | null): string => (addr ? `${IDENTITY_BASE}.${addr}` : IDENTITY_BASE);

export function loadIdentityAt(addr?: string | null): BondIdentity | null {
  try {
    const raw = localStorage.getItem(idKey(addr));
    return raw ? (JSON.parse(raw) as BondIdentity) : null;
  } catch {
    return null;
  }
}

/** The wallet signature that keys the bond vaults. Delegates to the shared master signature, so it reuses the
 *  one-prompt-per-session cache shared with the Data Room (no second prompt within a session). */
export async function getBondSig(
  address: string | null | undefined,
  signMessage: (message: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  return getMasterSignature(address, signMessage);
}

export const hasBondSig = (address?: string | null): boolean => hasMasterSignature(address);
