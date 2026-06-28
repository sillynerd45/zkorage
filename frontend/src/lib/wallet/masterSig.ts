// The single wallet signature that seeds EVERY sign-to-derive feature in zkorage.
//
// Before this, two features each prompted their own SEP-53 signature (the Data Room identity message and a
// separate Bonded Access message), so a user could be asked to sign twice in one session. Now both derive from
// ONE signature over ONE fixed message, cached once per session, so the wallet is prompted at most once no
// matter which feature asks first.
//
// The message is anchored on the Data Room identity message on purpose: that signature already derives every
// member's on-chain identity, so reusing it (instead of inventing a new message) keeps existing identities and
// memberships byte-identical. The bonded vaults just move onto the same signature; their HKDF salt/info already
// domain-separate them, so one signature yields independent keys per subsystem (RFC 5869).
import { DATAROOM_IDENTITY_MESSAGE } from "zkorage-sdk";

/** The fixed message the wallet signs. The raw signature bytes are the HKDF input keying material. */
export const MASTER_SIGN_MESSAGE = DATAROOM_IDENTITY_MESSAGE;

// One in-memory cache keyed by wallet address, shared across the whole app (module-level). The signature is the
// secret IKM and is NEVER persisted, so a page reload re-prompts the wallet once. Exported so the Data Room
// identity derivation can pass it as its cache and stay coherent with getMasterSignature (same message, so the
// same bytes either way).
export const masterSigCache = new Map<string, Uint8Array>();

/** Sign the master message once (cached per session) and return the raw signature bytes. */
export async function getMasterSignature(
  address: string | null | undefined,
  signMessage: (message: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (!address) throw new Error("Connect your wallet first.");
  let sig = masterSigCache.get(address);
  if (!sig) {
    sig = await signMessage(MASTER_SIGN_MESSAGE);
    masterSigCache.set(address, sig);
  }
  return sig;
}

/** True if this address already signed this session, so a caller can sync silently without a second prompt. */
export function hasMasterSignature(address?: string | null): boolean {
  return !!address && masterSigCache.has(address);
}

/** Drop the cached signature (e.g. on disconnect). With no address, clears the whole cache. */
export function clearMasterSignature(address?: string | null): void {
  if (address) masterSigCache.delete(address);
  else masterSigCache.clear();
}
