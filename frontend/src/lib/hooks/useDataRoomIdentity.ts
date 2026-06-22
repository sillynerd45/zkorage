import { useCallback, useState } from "react";
import { type DataRoomIdentity, DATAROOM_IDENTITY_MESSAGE } from "zkorage-sdk";
import { useWallet } from "@/lib/wallet/WalletContext";
import { deriveRoomIdentity } from "@/lib/dataroom/identity";

// One-signature-per-session cache, shared across hook instances. The signature is the secret IKM and is held
// only in memory (never persisted), so a page reload re-prompts the wallet once.
const sigCache = new Map<string, Uint8Array>();

/**
 * React access to the sign-to-derive Data Room identity. `derive(roomId)` prompts the wallet once per
 * session, derives the per-room identity in the browser, and flags drift if the wallet's signing format
 * changed since last time. The private secrets stay in this browser; the only time any leave is the one-time
 * membership proof, when the witness goes to the self-hosted prover (which must see it to build the proof),
 * never to a third party.
 */
export function useDataRoomIdentity() {
  const { address, signMessage } = useWallet();
  const [busy, setBusy] = useState(false);
  const [drift, setDrift] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const derive = useCallback(
    async (roomId: string): Promise<DataRoomIdentity | null> => {
      setBusy(true);
      setError(null);
      setDrift(false);
      try {
        const res = await deriveRoomIdentity({
          address: address ?? "",
          roomId,
          signMessage,
          cache: sigCache,
          storage: typeof localStorage !== "undefined" ? localStorage : undefined,
        });
        setDrift(res.drift);
        return res.identity;
      } catch (e) {
        setError(String((e as Error).message ?? e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [address, signMessage],
  );

  // The raw wallet signature (cached per session), used as HKDF input keying material for non-identity keys
  // such as the encrypted rooms backup. It is the SAME signature that derives the room identity, so this never
  // adds a second wallet prompt within a session, and the secret bytes stay in memory (never persisted).
  const getSignature = useCallback(async (): Promise<Uint8Array> => {
    if (!address) throw new Error("Connect your wallet first.");
    let sig = sigCache.get(address);
    if (!sig) {
      sig = await signMessage(DATAROOM_IDENTITY_MESSAGE);
      sigCache.set(address, sig);
    }
    return sig;
  }, [address, signMessage]);

  // True if this address already signed this session (so a caller can sync silently without popping the wallet).
  const hasSignature = useCallback((addr?: string | null) => sigCache.has(addr ?? address ?? ""), [address]);

  return { derive, getSignature, hasSignature, busy, drift, error };
}
