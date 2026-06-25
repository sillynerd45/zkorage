// Shared access to the standalone Bonded Access handle: the per-wallet localStorage slot and the one-prompt
// wallet signature that keys the handle + grants vaults. Used by both the Bonded Access page (mint / prove)
// and the "Your access" page (display), so a signature taken on one is reused on the other (one prompt per
// session). The handle is stored PER WALLET, so switching accounts in Freighter never shows another wallet's
// handle.
import type { BondIdentity } from "@/lib/api";
import { BOND_HANDLE_VAULT_MESSAGE } from "./handleVault";

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

// One-signature-per-session cache for the bond vault key (the wallet signature is the HKDF input). Held only
// in memory, never persisted, so a page reload re-prompts once. Module-level, so it is shared across pages.
const sigCache = new Map<string, Uint8Array>();

export async function getBondSig(
  address: string | null | undefined,
  signMessage: (message: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (!address) throw new Error("Connect your wallet first.");
  let sig = sigCache.get(address);
  if (!sig) {
    sig = await signMessage(BOND_HANDLE_VAULT_MESSAGE);
    sigCache.set(address, sig);
  }
  return sig;
}

export const hasBondSig = (address?: string | null): boolean => !!address && sigCache.has(address);
