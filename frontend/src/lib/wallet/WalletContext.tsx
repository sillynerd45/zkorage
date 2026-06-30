import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Networks } from "@stellar/stellar-sdk";
import { freighter } from "./client";
import { short as shortHex } from "@/lib/format";
import { toSignatureBytes } from "@/lib/dataroom/identity";
import { clearMasterSignature } from "@/lib/wallet/masterSig";
import type { TxSigner } from "@/lib/api";

// zkorage runs on Stellar testnet, where every contract is deployed. A wallet pointed elsewhere can
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
  /** True only when connected AND on the expected (testnet) network, meaning it is safe to sign with. */
  connected: boolean;
  address: string | null;
  /** Truncated address for display, or null. */
  short: string | null;
  network: string | null;
  error: string | null;
  installed: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Sign an XDR with the connected key. Throws if not connected, on the wrong network, or the user rejects. */
  sign: (xdr: string) => Promise<string>;
  /** Sign a fixed message (SEP-53) and return the raw signature bytes, for sign-to-derive identity. Throws if
   *  not connected, on the wrong network, or the user rejects. Never used to authorize a transaction. */
  signMessage: (message: string) => Promise<Uint8Array>;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>("checking");
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // The user's INTENT to be connected, separate from the live wallet status. Set on a successful connect /
  // silent reconnect, cleared on disconnect. Background reconcilers gate every state write on this, so an
  // in-flight read that resolves after Disconnect cannot revive the wallet (Freighter keeps returning the
  // address after an app-level disconnect, since it has no programmatic revoke).
  const wantConnected = useRef(false);

  // Read the live Freighter address + network and resolve to a status. PURE: writes no React state, so a read
  // that resolves after the user disconnects (or after unmount) cannot revive anything. Goes through
  // freighter(), so the Playwright __freighterMock seam drives it too.
  const readWallet = useCallback(async (): Promise<{
    status: WalletStatus;
    address: string | null;
    network: string | null;
  }> => {
    const fi = freighter();
    const a = await fi.getAddress();
    if (a.error || !a.address) return { status: "disconnected", address: null, network: null };
    const n = await fi.getNetwork();
    return {
      status: n.network === EXPECTED_NETWORK ? "connected" : "wrong-network",
      address: a.address,
      network: n.network ?? null,
    };
  }, []);

  // A background re-check: read the live wallet and apply it, but ONLY while the user still intends to be
  // connected and the provider is mounted. Intent is re-checked AFTER the await, so a reconcile in flight when
  // the user clicks Disconnect drops its result instead of repopulating address/status.
  const reconcile = useCallback(async () => {
    if (!wantConnected.current) return;
    const r = await readWallet();
    if (!mounted.current || !wantConnected.current) return;
    setStatus(r.status);
    setAddress(r.address);
    setNetwork(r.network);
  }, [readWallet]);

  // Used by the explicit connect / silent-reconnect flows (which set the intent just before calling): apply
  // address + network and return the status for the caller to set.
  const refresh = useCallback(async (): Promise<WalletStatus> => {
    const r = await readWallet();
    setAddress(r.address);
    setNetwork(r.network);
    return r.status;
  }, [readWallet]);

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
        wantConnected.current = true;
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

  // Re-validate when the tab regains focus: catches an account / network switch (or an extension unlock) made
  // while this tab was backgrounded. reconcile() no-ops unless the user intends to be connected.
  useEffect(() => {
    const onFocus = () => void reconcile();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reconcile]);

  // Poll for a change made WITH this tab focused: an account / network switch, an extension lock, or recovery
  // from one. Freighter exposes no change event, and the focus handler only fires on a refocus, so a switch made
  // while the user stays on the page would otherwise go unnoticed (stale My Balances, a missed "you already hold
  // this bond" check, a stale sync toggle). The interval lives for the provider's lifetime but no-ops unless the
  // user intends to be connected, so it also keeps trying through an extension lock and recovers on unlock
  // instead of stranding the app in "disconnected" until a reload. It skips a hidden tab (the focus handler
  // covers refocus) to keep extension chatter down; reconcile() only re-renders when something changed.
  useEffect(() => {
    let inFlight = false;
    const id = setInterval(() => {
      if (inFlight || !wantConnected.current) return;
      if (typeof document !== "undefined" && document.hidden) return;
      inFlight = true;
      void reconcile().finally(() => {
        inFlight = false;
      });
    }, 2000);
    return () => clearInterval(id);
  }, [reconcile]);

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
        // User declined or the extension errored. Fall back to disconnected with a readable reason.
        setError(r.error?.message ?? "Connection was declined.");
        setStatus("disconnected");
        return;
      }
      if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, "1");
      wantConnected.current = true;
      const s = await refresh();
      if (mounted.current) setStatus(s);
    } catch (e) {
      setError((e as Error)?.message ?? "Could not connect to Freighter.");
      setStatus("disconnected");
    }
  }, [refresh]);

  const disconnect = useCallback(() => {
    // Drop the connect intent FIRST, so any reconcile already in flight sees it after its await and drops its
    // result instead of repopulating the wallet we are about to clear.
    wantConnected.current = false;
    // Freighter has no programmatic revoke; this is an app-level disconnect (stop using the grant).
    if (typeof localStorage !== "undefined") localStorage.removeItem(LS_KEY);
    // Drop the in-memory master signature (the HKDF input keying material for both pillars), so a later
    // connect re-derives only after a fresh prompt.
    clearMasterSignature();
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

  const signMessage = useCallback(
    async (message: string): Promise<Uint8Array> => {
      if (!address) throw new Error("Wallet not connected.");
      if (network !== EXPECTED_NETWORK)
        throw new Error(`Switch Freighter to ${EXPECTED_NETWORK} to derive your room identity.`);
      const fi = freighter();
      const r = await fi.signMessage(message, { networkPassphrase: EXPECTED_PASSPHRASE, address });
      if (r.error || r.signedMessage == null)
        throw new Error(r.error?.message ?? "Message signing was declined.");
      return toSignatureBytes(r.signedMessage);
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
    signMessage,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used within <WalletProvider>");
  return v;
}

/** A stable TxSigner for the api write helpers when the wallet is connected on testnet, else undefined.
 *  Pass it to submit()/grantAccess()/etc. to route a write through Freighter instead of the server relay. */
export function useTxSigner(): TxSigner | undefined {
  const w = useWallet();
  return useMemo(
    () => (w.connected && w.address ? { address: w.address, sign: w.sign } : undefined),
    [w.connected, w.address, w.sign],
  );
}
