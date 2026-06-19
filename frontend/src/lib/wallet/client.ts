// Thin, typed wrapper over @stellar/freighter-api (v6). Two reasons it exists:
//  1. It narrows the SDK's response shapes to exactly what the app uses, so the context stays clean.
//  2. It provides ONE seam (`window.__freighterMock`) so Playwright can drive connected / wrong-network
//     states without the real browser extension (which a headless Chrome can't load). In production the
//     mock branch is never taken: the real extension messaging is used.
import {
  isConnected as fiIsConnected,
  isAllowed as fiIsAllowed,
  requestAccess as fiRequestAccess,
  getAddress as fiGetAddress,
  getNetwork as fiGetNetwork,
  signTransaction as fiSignTransaction,
} from "@stellar/freighter-api";

export interface FreighterClient {
  /** Is the Freighter extension installed / reachable in this browser? */
  isConnected(): Promise<{ isConnected: boolean }>;
  /** Has this site already been granted access (so we can silently reconnect)? */
  isAllowed(): Promise<{ isAllowed: boolean }>;
  /** Prompt the user and return the granted address. */
  requestAccess(): Promise<{ address: string; error?: { message: string } }>;
  /** Current address, which is "" until the site has been granted access. */
  getAddress(): Promise<{ address: string; error?: { message: string } }>;
  /** The network the wallet is pointed at (e.g. "TESTNET"). */
  getNetwork(): Promise<{ network: string; networkPassphrase: string; error?: { message: string } }>;
  /** Sign an XDR with the connected key; returns the signed XDR. */
  signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; address?: string },
  ): Promise<{ signedTxXdr: string; error?: { message: string } }>;
}

const real: FreighterClient = {
  isConnected: () => fiIsConnected().then((r) => ({ isConnected: !!r.isConnected })),
  isAllowed: () => fiIsAllowed().then((r) => ({ isAllowed: !!r.isAllowed })),
  requestAccess: () => fiRequestAccess(),
  getAddress: () => fiGetAddress(),
  getNetwork: () => fiGetNetwork(),
  signTransaction: (xdr, opts) => fiSignTransaction(xdr, opts),
};

/** Returns the active Freighter client: the real extension, or a Playwright-injected mock if present. */
export function freighter(): FreighterClient {
  if (typeof window !== "undefined") {
    const mock = (window as unknown as { __freighterMock?: FreighterClient }).__freighterMock;
    if (mock) return mock;
  }
  return real;
}
