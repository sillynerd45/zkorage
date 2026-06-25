import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Wallet, RefreshCw, AlertTriangle, CalendarClock } from "lucide-react";
import { useBonded } from "@/lib/hooks/useBonded";
import { Panel } from "@/components/app/blocks";
import { Button, buttonVariants } from "@/components/ui/button";
import { fmtAmount, type LockView, type WalletWriteResult } from "@/lib/api";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";

const fmtDay = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtClock = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
// Date and clock on one line, e.g. "Jun 25, 2026 · 3:31 PM".
const fmtWhen = (unix: number) => `${fmtDay(unix)} · ${fmtClock(unix)}`;

// Format a datetime-local value ("2026-06-24T12:05", parsed as local time) for the Extend trigger button.
function fmtExtend(local: string): string {
  if (!local) return "Pick a new time";
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return "Pick a new time";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// Compact relative time, e.g. "in 3 days", "in 5 hours", "2 days ago". Coarsens to the largest sensible unit.
function relTime(unix: number): string {
  const diff = unix * 1000 - Date.now();
  const future = diff >= 0;
  const s = Math.abs(diff) / 1000;
  const units: [number, string][] = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [secs, name] of units) {
    const n = Math.floor(s / secs);
    if (n >= 1) {
      const label = `${n} ${name}${n === 1 ? "" : "s"}`;
      return future ? `in ${label}` : `${label} ago`;
    }
  }
  return future ? "soon" : "just now";
}

// The token unit to show for a lock. The native SAC reports "native"; show "XLM". Fall back to a short
// contract id for a token that does not expose a symbol.
const tokenLabel = (l: LockView): string => {
  const s = l.tokenSymbol?.trim();
  if (!s || s === "native") return s === "native" ? "XLM" : short(l.token, 4);
  return s;
};

// A single-word status pill keeps the card header compact; the unlock block carries the detail.
function statusOf(l: LockView): { label: string; cls: string } {
  if (l.released) return { label: "Released", cls: "bg-muted text-muted-foreground" };
  if (l.is_locked) return { label: "Locked", cls: "bg-brand/10 text-brand" };
  return { label: "Unlocked", cls: "bg-success/10 text-success" };
}

// Sort live funds to the top: Unlocked (withdrawable now) first, then Locked (still committed), then Released
// (done). Within a status, keep creation order (lock id ascending), so the list is stable across refreshes.
function statusRank(l: LockView): number {
  if (l.released) return 2;
  if (l.is_locked) return 1;
  return 0;
}

// The highlighted unlock block's tint, matched to the status pill: Locked = brand, Unlocked = success,
// Released = muted. The status pill carries the state word, so the block has no verb of its own.
function unlockTone(l: LockView): { wrap: string; rel: string } {
  if (l.released) return { wrap: "border-border/70 bg-muted/40", rel: "text-muted-foreground" };
  if (l.is_locked) return { wrap: "border-brand/20 bg-brand/5", rel: "text-brand" };
  return { wrap: "border-success/20 bg-success/5", rel: "text-success" };
}

// Your relationship to the lock, in one or two words for the compact meta line.
const roleLabel = (l: LockView): string => (l.role === "self" ? "self-bond" : l.role);

export default function BondedBalances() {
  const b = useBonded();
  const [extendId, setExtendId] = useState<number | null>(null);
  const [extendAt, setExtendAt] = useState("");
  const [result, setResult] = useState<{ id: number; r: WalletWriteResult } | null>(null);
  // One shared ref: only one extend form is open at a time (extendId is a single value).
  const extendRef = useRef<HTMLInputElement>(null);

  // Drop a stale action result when the wallet switches.
  useEffect(() => setResult(null), [b.address]);

  // Open the native date-time picker for the Extend field (matches the Deposit pattern). showPicker() is the
  // modern path; some engines throw, so fall back to focusing the real input. No manual spinner typing.
  const openExtendPicker = () => {
    const el = extendRef.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };

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
          {b.loading && b.locks.length > 0 && (
            <span className="ml-2 text-[12px] text-muted-foreground" data-testid="bonded-refreshing">
              · refreshing…
            </span>
          )}
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
          <div className="flex flex-col items-start gap-4 py-2" data-testid="bonded-empty">
            <div>
              <p className="text-[14px] text-muted-foreground">
                Your locks and their actions appear here. Here is the lifecycle.
              </p>
              <ol className="mt-3 space-y-2 text-[13px] leading-relaxed text-muted-foreground">
                <li>
                  <b className="text-foreground">1. Lock.</b> Pick a token and an unlock time on the Deposit
                  page. The tokens move into escrow.
                </li>
                <li>
                  <b className="text-foreground">2. While locked.</b> Extend the unlock time here anytime. If
                  you marked the bond revocable, you can release it early.
                </li>
                <li>
                  <b className="text-foreground">3. After unlock.</b> Withdraw your tokens here. For a one-way
                  send, the recipient claims them.
                </li>
              </ol>
            </div>
            <Link to="/app/bonded/deposit" className={buttonVariants({ variant: "brand" })}>
              Lock your first tokens
            </Link>
          </div>
        </Panel>
      )}

      {[...b.locks].sort((a, c) => statusRank(a) - statusRank(c) || a.id - c.id).map((l) => {
        const st = statusOf(l);
        const ut = unlockTone(l);
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
            className="p-4"
            title={
              <span className="text-[15px] font-semibold tabular-nums">
                {fmtAmount(l.amount, l.tokenDecimals || 7)} {tokenLabel(l)}
              </span>
            }
            aside={<span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium", st.cls)}>{st.label}</span>}
          >
            {/* items-stretch makes both columns the same height so the action row can bottom-align. */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch sm:gap-4">
              {/* Left: escrow meta at the top, actions pinned to the bottom via mt-auto. */}
              <div className="flex min-w-0 flex-1 flex-col">
                <p className="text-[12px] text-muted-foreground" data-testid={`lock-${l.id}`}>
                  Escrow lock #{l.id} · {roleLabel(l)} · {l.revocable ? "revocable" : "one-way"}
                </p>

                <div className="mt-auto pt-3">
                  <div className="flex flex-wrap items-center gap-2">
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
                </div>
              </div>

              {/* Right: the unlock block. Two lines: "date · time" then the highlighted relative time. */}
              <div
                className={cn("flex shrink-0 flex-col justify-center rounded-xl border px-3.5 py-2.5 sm:min-w-[170px] sm:text-right", ut.wrap)}
                data-testid={`unlock-${l.id}`}
              >
                <p className="text-[13px] font-semibold tabular-nums text-foreground">{fmtWhen(l.unlock_time)}</p>
                <p className={cn("mt-0.5 text-[12px] font-medium tabular-nums", ut.rel)}>{relTime(l.unlock_time)}</p>
              </div>
            </div>

            {extendId === l.id && (
              <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border bg-muted/30 p-3">
                <div className="flex flex-col gap-1">
                  <span id={`extend-label-${l.id}`} className="text-[12px] text-muted-foreground">
                    New unlock time (must be later)
                  </span>
                  <div className="relative w-60 max-w-full">
                    <button
                      id={`extend-trigger-${l.id}`}
                      type="button"
                      onClick={openExtendPicker}
                      aria-labelledby={`extend-label-${l.id} extend-trigger-${l.id}`}
                      data-testid={`extend-trigger-${l.id}`}
                      className={cn(
                        "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-left text-sm shadow-sm transition-colors",
                        "focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                      )}
                    >
                      <span className={cn("tabular-nums", !extendAt && "text-muted-foreground")}>{fmtExtend(extendAt)}</span>
                      <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                    <input
                      ref={extendRef}
                      type="datetime-local"
                      value={extendAt}
                      onChange={(e) => setExtendAt(e.target.value)}
                      data-testid={`extend-input-${l.id}`}
                      tabIndex={-1}
                      aria-hidden="true"
                      className="pointer-events-none absolute left-0 top-0 h-0 w-0 overflow-hidden opacity-0"
                    />
                  </div>
                </div>
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
