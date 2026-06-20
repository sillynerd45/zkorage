import { useCallback, useEffect, useState } from "react";
import { useWallet, useTxSigner } from "@/lib/wallet/WalletContext";
import {
  listEscrowLocks,
  escrowDeposit,
  escrowWithdraw,
  escrowUnbond,
  escrowClaim,
  escrowSetTimelock,
  type LockView,
  type DepositReq,
  type WalletWriteResult,
  type TxSigner,
} from "@/lib/api";

// Bonded Proofs (BP2): the connected wallet's locks + the write actions, all wallet-signed. `busy` is the
// key of the action in flight (e.g. "deposit", "withdraw-3") so a row can show its own spinner.
export function useBonded() {
  const { connected, address, status, connect } = useWallet();
  const signer = useTxSigner();
  const [locks, setLocks] = useState<LockView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) {
      setLocks([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await listEscrowLocks(address);
      setLocks(r.locks);
    } catch (e) {
      setError((e as Error)?.message ?? "could not load your locks");
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (key: string, fn: (s: TxSigner) => Promise<WalletWriteResult>): Promise<WalletWriteResult> => {
      if (!signer) return { ok: false, error: "Connect your wallet on testnet first." };
      setBusy(key);
      try {
        const r = await fn(signer);
        if (r.ok) await refresh();
        return r;
      } finally {
        setBusy(null);
      }
    },
    [signer, refresh],
  );

  return {
    connected,
    address,
    status,
    connect,
    signer,
    locks,
    loading,
    error,
    busy,
    refresh,
    deposit: (req: DepositReq) => run("deposit", (s) => escrowDeposit(req, s)),
    withdraw: (id: number) => run(`withdraw-${id}`, (s) => escrowWithdraw(id, s)),
    unbond: (id: number) => run(`unbond-${id}`, (s) => escrowUnbond(id, s)),
    claim: (id: number) => run(`claim-${id}`, (s) => escrowClaim(id, s)),
    setTimelock: (id: number, t: number) => run(`relock-${id}`, (s) => escrowSetTimelock(id, t, s)),
  };
}
