// Wallet stub. The unified app ships a NON-FUNCTIONAL "Connect Freighter" placeholder (top-right in the
// app shell) — real wallet wiring is a later pass. Keeping the surface behind this one hook means the
// future change is a single file: swap the body for @stellar/freighter-api
// (isConnected / getPublicKey / signTransaction) and decide any gating then.
import { useState } from "react";

export interface WalletState {
  connected: boolean;
  address: string | null;
  /** Placeholder connect — flips a local "coming soon" flag; performs no real wallet handshake yet. */
  connect: () => void;
  comingSoon: boolean;
  dismiss: () => void;
}

export function useWallet(): WalletState {
  const [comingSoon, setComingSoon] = useState(false);
  return {
    connected: false,
    address: null,
    connect: () => setComingSoon(true),
    comingSoon,
    dismiss: () => setComingSoon(false),
  };
}
