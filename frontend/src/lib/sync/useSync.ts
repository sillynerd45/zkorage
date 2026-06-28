import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/lib/wallet/WalletContext";
import { getSyncPref, SYNC_EVENT } from "./prefs";
import { syncRestoreAll, syncDisable } from "./orchestrator";

/**
 * Shared "Sync across devices" control. Reads the app-wide preference for the connected wallet and exposes
 * enable / disable that run the unified one-signature restore. Used by the connect dialog, the wallet menu, the
 * Data Room toggle, and the Bonded Access page, so they all stay in step and never trigger a second signature.
 */
export function useSync() {
  const { address, connected, signMessage } = useWallet();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(() => setOn(getSyncPref(connected ? address : null)), [connected, address]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  // Re-read when any other surface changes the preference (the restore orchestrator fires this).
  useEffect(() => {
    const h = () => refresh();
    window.addEventListener(SYNC_EVENT, h);
    return () => window.removeEventListener(SYNC_EVENT, h);
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!address) return;
    setBusy(true);
    setMsg(null);
    try {
      await syncRestoreAll(address, signMessage);
      setOn(true);
    } catch (e) {
      setMsg(String((e as Error)?.message ?? e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [address, signMessage]);

  const disable = useCallback(async () => {
    if (!address) return;
    setBusy(true);
    setMsg(null);
    try {
      const deleted = await syncDisable(address, signMessage);
      setOn(false);
      setMsg(deleted ? "Sync off. Your saved copy was deleted." : "Sync off on this device.");
    } finally {
      setBusy(false);
    }
  }, [address, signMessage]);

  const toggle = useCallback(() => (on ? disable() : enable()), [on, enable, disable]);

  return { on, busy, msg, enable, disable, toggle };
}
