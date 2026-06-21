import { useCallback, useState } from "react";
import { type DataRoomIdentity } from "zkorage-sdk";
import { useWallet } from "@/lib/wallet/WalletContext";
import { deriveRoomIdentity } from "@/lib/dataroom/identity";

// One-signature-per-session cache, shared across hook instances. The signature is the secret IKM and is held
// only in memory (never persisted), so a page reload re-prompts the wallet once.
const sigCache = new Map<string, Uint8Array>();

/**
 * React access to the sign-to-derive Data Room identity. `derive(roomId)` prompts the wallet once per
 * session, derives the per-room identity in the browser, and flags drift if the wallet's signing format
 * changed since last time. The private secrets stay in the returned object and in this browser only.
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

  return { derive, busy, drift, error };
}
