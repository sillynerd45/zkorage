import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Networks } from "@stellar/stellar-sdk";
import { freighter } from "./client";
import { short as shortHex } from "@/lib/format";

// zkorage runs on Stellar testnet — every contract is deployed there. A wallet pointed elsewhere can
// connect, but can't sign our transactions, so we surface a "wrong network" state instead of failing later.
export const EXPECTED_NETWORK = "TESTNET";
export const EXPECTED_PASSPHRASE = Networks.TESTNET;
const LS_KEY = "zkorage.wallet.connected";

export type WalletStatus =
  | "checking" // initial mount, deciding installed/allowed
  | "not-installed" // no Freighter extension in this browser
  | "disconnected" // installed, not connected
  | "connecting" // user prompted, awaiting approval
  | "connected" // connected on the expected network
  | "wrong-network"; // connected but the wallet is not on testnet

export interface WalletState {
  status: WalletStatus;
  /** True only when connected AND on the expected (testnet) network — i.e. safe to sign with. */
  connected: boolean;
  address: string | null;
  /** Truncated address for display, or null. */
  short: string | null;
  network: string | null;
  error: string | null;
  installed: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Sign an XDR with the connected key. Throws if not connected/wrong network or the user rejects. */
  sign: (xdr: string) => Promise<string>;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>("checking");
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  // Read address + network and resolve to connected | wrong-network. Returns the resolved status.
  const refresh = useCallback(async (): Promise<WalletStatus> => {
    const fi = freighter();
    const a = await fi.getAddress();
    if (a.error || !a.address) {
      setAddress(null);
      setNetwork(null);
      return "disconnected";
    }
    const n = await fi.getNetwork();
    setAddress(a.address);
    setNetwork(n.network ?? null);
    return n.network === EXPECTED_NETWORK ? "connected" : "wrong-network";
  }, []);

  // On mount: detect the extension, then silently reconnect if the user connected before and the site
  // is still allowed (Freighter remembers the grant).
  useEffect(() => {
    mounted.current = true;
    (async () => {
      const fi = freighter();
      const conn = await fi.isConnected();
      if (!conn.isConnected) {
        if (mounted.current) setStatus("not-installed");
        return;
      }
      const wanted = typeof localStorage !== "undefined" && localStorage.getItem(LS_KEY) === "1";
      let allowed = false;
      try {
        allowed = (await fi.isAllowed()).isAllowed;
      } catch {
        /* treat as not allowed */
      }
      if (wanted && allowed) {
        const s = await refresh();
        if (mounted.current) setStatus(s);
      } else if (mounted.current) {
        setStatus("disconnected");
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  // Re-validate when the tab regains focus — catches account / network switches made in the extension.
  useEffect(() => {
    const onFocus = async () => {
      if (status !== "connected" && status !== "wrong-network") return;
      const s = await refresh();
      if (mounted.current) setStatus(s);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [status, refresh]);

  const connect = useCallback(async () => {
    setError(null);
    const fi = freighter();
    const conn = await fi.isConnected();
    if (!conn.isConnected) {
      setStatus("not-installed");
      return;
    }
    setStatus("connecting");
    try {
      const r = await fi.requestAccess();
      if (r.error || !r.address) {
        // User declined or the extension errored — fall back to disconnected with a readable reason.
        setError(r.error?.message ?? "Connection was declined.");
        setStatus("disconnected");
        return;
      }
      if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, "1");
      const s = await refresh();
      if (mounted.current) setStatus(s);
    } catch (e) {
      setError((e as Error)?.message ?? "Could not connect to Freighter.");
      setStatus("disconnected");
    }
  }, [refresh]);

  const disconnect = useCallback(() => {
    // Freighter has no programmatic revoke; this is an app-level disconnect (stop using the grant).
    if (typeof localStorage !== "undefined") localStorage.removeItem(LS_KEY);
    setAddress(null);
    setNetwork(null);
    setError(null);
    setStatus("disconnected");
  }, []);

  const sign = useCallback(
    async (xdr: string): Promise<string> => {
      if (!address) throw new Error("Wallet not connected.");
      if (network !== EXPECTED_NETWORK)
        throw new Error(`Switch Freighter to ${EXPECTED_NETWORK} to sign zkorage transactions.`);
      const fi = freighter();
      const r = await fi.signTransaction(xdr, {
        networkPassphrase: EXPECTED_PASSPHRASE,
        address,
      });
      if (r.error || !r.signedTxXdr) throw new Error(r.error?.message ?? "Signing was declined.");
      return r.signedTxXdr;
    },
    [address, network],
  );

  const value: WalletState = {
    status,
    connected: status === "connected",
    address,
    short: address ? shortHex(address, 4) : null,
    network,
    error,
    installed: status !== "not-installed" && status !== "checking",
    connect,
    disconnect,
    sign,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used within <WalletProvider>");
  return v;
}
