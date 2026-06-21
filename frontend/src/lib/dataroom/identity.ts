// Frontend orchestration for the sign-to-derive Data Room identity (Model B). Kept dependency-light (only
// zkorage-sdk) so it is unit-testable in Node without React/Vite. The React hook (useDataRoomIdentity) is a
// thin wrapper over deriveRoomIdentity. Determinism + byte-exactness live in the SDK (identity.ts); this file
// is only the wallet-signature plumbing + a one-signature-per-session cache + drift detection.
import { deriveDataRoomIdentity, DATAROOM_IDENTITY_MESSAGE, type DataRoomIdentity } from "zkorage-sdk";

/** Normalize whatever Freighter `signMessage` returns (V3 Buffer, V4 base64 string, or an array-like) into
 *  the raw signature bytes used as HKDF input keying material. SEP-53 V4 returns base64; a pure-hex string is
 *  also accepted (hex digits are a base64 subset, so disambiguate by the hex character set + even length). */
export function toSignatureBytes(signed: unknown): Uint8Array {
  if (signed instanceof Uint8Array) return signed;
  if (Array.isArray(signed)) return Uint8Array.from(signed as number[]);
  // A Node Buffer serialized over the messaging boundary as { type: "Buffer", data: number[] }.
  if (signed && typeof signed === "object" && Array.isArray((signed as { data?: unknown }).data)) {
    return Uint8Array.from((signed as { data: number[] }).data);
  }
  if (typeof signed === "string") {
    const s = signed.trim();
    if (s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) {
      return Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
    }
    const bin = atob(s); // base64 (SEP-53 V4)
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error("unrecognized signMessage result (expected bytes or a base64/hex string)");
}

export interface RoomIdentityResult {
  identity: DataRoomIdentity;
  /** True if the wallet produced a different identity than one previously stored for this (address, room),
   *  i.e. the wallet's signing format drifted — surface it, do not silently mint a new identity. */
  drift: boolean;
}

export interface DeriveRoomIdentityOpts {
  address: string;
  roomId: string;
  /** Signs the fixed identity message with the wallet and returns the raw signature bytes. */
  signMessage: (message: string) => Promise<Uint8Array>;
  /** In-memory cache so the wallet is prompted at most once per session per address (the signature is the
   *  secret IKM; it is never persisted). */
  cache: Map<string, Uint8Array>;
  /** Optional persistent store (window.localStorage) for the DERIVED PUBLIC keys, used only for drift
   *  detection. Never store the signature or any private secret here. */
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
}

/** The drift-detection key for a member's derived public identity in a given room. */
export const driftKey = (address: string, roomId: string) => `zkorage.id.${address}.${roomId}`;

/**
 * Sign once (cached per session), derive the per-room identity via the SDK, and detect signing drift against
 * any previously stored public keys. Pure: no React, no globals; pass the wallet signer, a cache, and a store.
 */
export async function deriveRoomIdentity(opts: DeriveRoomIdentityOpts): Promise<RoomIdentityResult> {
  const { address, roomId, signMessage, cache, storage } = opts;
  if (!address) throw new Error("Connect your wallet to derive your room identity.");

  let sig = cache.get(address);
  if (!sig) {
    sig = await signMessage(DATAROOM_IDENTITY_MESSAGE);
    cache.set(address, sig);
  }
  const identity = deriveDataRoomIdentity(sig, roomId);

  let drift = false;
  if (storage) {
    const key = driftKey(address, identity.roomId);
    const fingerprint = `${identity.accessor}:${identity.recipientPub}`;
    const prev = storage.getItem(key);
    if (prev && prev !== fingerprint) drift = true;
    else if (!prev) storage.setItem(key, fingerprint);
  }
  return { identity, drift };
}
