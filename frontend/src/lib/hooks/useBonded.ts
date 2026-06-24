import { useCallback, useEffect, useState } from "react";
import { useWallet, useTxSigner } from "@/lib/wallet/WalletContext";
import {
  listEscrowLocks,
  getBondBalance,
  escrowFaucet,
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

// An in-memory snapshot of the last-loaded locks per wallet, keyed by address. It is module-level so it
// survives leaving and returning to the page within one app session (a full browser reload clears it). We
// seed the view from it on mount, so a return visit redisplays at once while a background refresh runs and
// swaps in any change. It only ever holds public on-chain data, never a key or a secret.
type BondedSnapshot = { locks: LockView[]; balance: string };
const snapshotCache = new Map<string, BondedSnapshot>();

// A no-op background refresh should not re-render the list, so compare before swapping. LockView is a flat
// record of primitives, so a stable-shape JSON compare is sufficient here.
const sameLocks = (a: LockView[], b: LockView[]) =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

// Bonded Proofs (BP2): the connected wallet's locks + the write actions, all wallet-signed. `busy` is the
// key of the action in flight (e.g. "deposit", "withdraw-3") so a row can show its own spinner.
export function useBonded() {
  const { connected, address, status, connect } = useWallet();
  const signer = useTxSigner();
  // Seed from the cache so a return visit paints instantly instead of flashing a loader.
  const seed = address ? snapshotCache.get(address) : undefined;
  const [locks, setLocks] = useState<LockView[]>(seed?.locks ?? []);
  const [balance, setBalance] = useState<string>(seed?.balance ?? "0"); // bond-token base units
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) {
      setLocks([]);
      setBalance("0");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [r, bal] = await Promise.all([
        listEscrowLocks(address),
        getBondBalance(address).catch(() => ({ balance: "0" })),
      ]);
      snapshotCache.set(address, { locks: r.locks, balance: bal.balance });
      // Only swap in changed data, so a background refresh that found nothing new does not re-render.
      setLocks((prev) => (sameLocks(prev, r.locks) ? prev : r.locks));
      setBalance((prev) => (prev === bal.balance ? prev : bal.balance));
    } catch (e) {
      setError((e as Error)?.message ?? "could not load your locks");
    } finally {
      setLoading(false);
    }
  }, [address]);

  // On mount and whenever the wallet changes, show the cached snapshot at once (instant on a return visit),
  // then refresh in the background.
  useEffect(() => {
    const snap = address ? snapshotCache.get(address) : undefined;
    setLocks(snap?.locks ?? []);
    setBalance(snap?.balance ?? "0");
    void refresh();
  }, [address, refresh]);

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

  const fundFaucet = useCallback(async (): Promise<WalletWriteResult> => {
    if (!address) return { ok: false, error: "Connect your wallet first." };
    setBusy("faucet");
    try {
      const r = await escrowFaucet(address);
      if (r.ok) await refresh();
      return r;
    } finally {
      setBusy(null);
    }
  }, [address, refresh]);

  return {
    connected,
    address,
    status,
    connect,
    signer,
    locks,
    balance,
    loading,
    error,
    busy,
    refresh,
    fundFaucet,
    deposit: (req: DepositReq) => run("deposit", (s) => escrowDeposit(req, s)),
    withdraw: (id: number) => run(`withdraw-${id}`, (s) => escrowWithdraw(id, s)),
    unbond: (id: number) => run(`unbond-${id}`, (s) => escrowUnbond(id, s)),
    claim: (id: number) => run(`claim-${id}`, (s) => escrowClaim(id, s)),
    setTimelock: (id: number, t: number) => run(`relock-${id}`, (s) => escrowSetTimelock(id, t, s)),
  };
}
