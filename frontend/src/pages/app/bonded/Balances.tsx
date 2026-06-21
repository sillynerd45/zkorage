import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Wallet, RefreshCw, AlertTriangle } from "lucide-react";
import { useBonded } from "@/lib/hooks/useBonded";
import { Panel, DataRow } from "@/components/app/blocks";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtAmount, type LockView, type WalletWriteResult } from "@/lib/api";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";

const fmtDate = (unix: number) => new Date(unix * 1000).toLocaleString();

function statusOf(l: LockView): { label: string; cls: string } {
  if (l.released) return { label: "Released", cls: "bg-muted text-muted-foreground" };
  if (l.is_locked) return { label: `Locked until ${fmtDate(l.unlock_time)}`, cls: "bg-brand/10 text-brand" };
  return { label: "Unlocked", cls: "bg-success/10 text-success" };
}

export default function BondedBalances() {
  const b = useBonded();
  const [extendId, setExtendId] = useState<number | null>(null);
  const [extendAt, setExtendAt] = useState("");
  const [result, setResult] = useState<{ id: number; r: WalletWriteResult } | null>(null);

  // Drop a stale action result when the wallet switches.
  useEffect(() => setResult(null), [b.address]);

  const act = async (id: number, p: Promise<WalletWriteResult>) => {
    setResult(null);
    setResult({ id, r: await p });
  };

  if (!b.connected) {
    return (
      <Panel title="My Balances">
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-[14px] text-muted-foreground">
            Connect your Freighter wallet on testnet to see the locks you can act on.
          </p>
          <Button variant="brand" onClick={() => void b.connect()} data-testid="bonded-connect">
            <Wallet className="size-4" /> Connect wallet
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <div className="grid gap-4" data-testid="bonded-balances">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          Locks for <span className="font-mono">{b.address ? short(b.address, 5) : ""}</span>
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void b.refresh()} disabled={b.loading} data-testid="bonded-refresh">
            <RefreshCw className={cn("size-4", b.loading && "animate-spin")} /> Refresh
          </Button>
          <Link to="/app/bonded/deposit" className={buttonVariants({ variant: "brand", size: "sm" })}>
            Lock tokens
          </Link>
        </div>
      </div>

      {b.error && (
        <Panel>
          <p className="text-[13px] text-destructive">{b.error}</p>
        </Panel>
      )}

      {b.loading && b.locks.length === 0 && (
        <Panel>
          <p className="text-[13px] text-muted-foreground">Loading your locks…</p>
        </Panel>
      )}

      {!b.loading && b.locks.length === 0 && !b.error && (
        <Panel>
          <div className="flex flex-col items-start gap-3 py-2" data-testid="bonded-empty">
            <p className="text-[14px] text-muted-foreground">No locks on this address yet.</p>
            <Link to="/app/bonded/deposit" className={buttonVariants({ variant: "brand" })}>
              Lock your first tokens
            </Link>
          </div>
        </Panel>
      )}

      {b.locks.map((l) => {
        const st = statusOf(l);
        const isSelf = l.role === "self";
        const isDepositor = isSelf || l.role === "depositor";
        const canUnbond = !l.released && l.is_locked && l.revocable && isSelf;
        const canExtend = !l.released && l.is_locked && isDepositor;
        const canWithdraw = !l.released && !l.is_locked && isSelf;
        const canClaim = !l.released && !l.is_locked && l.role === "claimant";
        const awaiting = !l.released && !l.is_locked && l.role === "depositor";
        const busyKey = (k: string) => b.busy === k;
        return (
          <Panel
            key={l.id}
            title={`Lock #${l.id}`}
            aside={<span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium", st.cls)}>{st.label}</span>}
          >
            <div className="grid gap-0.5">
              <DataRow k="Amount">{fmtAmount(l.amount)} zkUSD</DataRow>
              <DataRow k="Unlocks">{fmtDate(l.unlock_time)}</DataRow>
              <DataRow k="You are" mono={false}>
                {l.role === "self" ? "depositor (self-bond)" : l.role}
              </DataRow>
              <DataRow k="Revocable" mono={false}>
                {l.revocable ? "yes, can pull early" : "no, one-way until unlock"}
              </DataRow>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {canWithdraw && (
                <Button size="sm" variant="brand" disabled={busyKey(`withdraw-${l.id}`)} onClick={() => void act(l.id, b.withdraw(l.id))} data-testid={`withdraw-${l.id}`}>
                  Withdraw
                </Button>
              )}
              {canClaim && (
                <Button size="sm" variant="brand" disabled={busyKey(`claim-${l.id}`)} onClick={() => void act(l.id, b.claim(l.id))} data-testid={`claim-${l.id}`}>
                  Claim
                </Button>
              )}
              {canUnbond && (
                <Button size="sm" variant="destructive" disabled={busyKey(`unbond-${l.id}`)} onClick={() => void act(l.id, b.unbond(l.id))} data-testid={`unbond-${l.id}`}>
                  Release collateral now
                </Button>
              )}
              {canExtend && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setExtendId(extendId === l.id ? null : l.id);
                    setExtendAt("");
                  }}
                  data-testid={`extend-${l.id}`}
                >
                  Extend
                </Button>
              )}
              {awaiting && <span className="text-[13px] text-muted-foreground">Claimable by {short(l.claimant, 4)}</span>}
              {l.released && <span className="text-[13px] text-muted-foreground">This lock has been released.</span>}
            </div>

            {canUnbond && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <AlertTriangle className="size-3.5" /> Releasing now returns the funds and voids any proof backed by this lock.
              </p>
            )}

            {extendId === l.id && (
              <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border bg-muted/30 p-3">
                <label className="text-[12px] text-muted-foreground">
                  New unlock time (must be later)
                  <Input
                    type="datetime-local"
                    value={extendAt}
                    onChange={(e) => setExtendAt(e.target.value)}
                    className="mt-1 w-60"
                    data-testid={`extend-input-${l.id}`}
                  />
                </label>
                <Button
                  size="sm"
                  disabled={!extendAt || busyKey(`relock-${l.id}`)}
                  onClick={async () => {
                    const t = Math.floor(new Date(extendAt).getTime() / 1000);
                    if (!t || t <= l.unlock_time) {
                      setResult({ id: l.id, r: { ok: false, error: "Pick a time later than the current unlock." } });
                      return;
                    }
                    await act(l.id, b.setTimelock(l.id, t));
                    setExtendId(null);
                  }}
                >
                  Confirm extend
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setExtendId(null)}>
                  Cancel
                </Button>
              </div>
            )}

            {result?.id === l.id && (
              <p className={cn("mt-2 break-all text-[12px]", result.r.ok ? "text-success" : "text-destructive")} data-testid={`result-${l.id}`}>
                {result.r.ok ? `Done. tx ${result.r.txHash ? short(result.r.txHash, 6) : ""}` : result.r.error}
              </p>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
