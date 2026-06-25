import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, Loader2, RefreshCw, Link2, Check } from "lucide-react";
import { Panel } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { fmtAmount, getBondStatus } from "@/lib/api";
import { readBondGrants, type BondGrantRecord } from "@/lib/bonded/grants";
import { getBondSig, hasBondSig } from "@/lib/bonded/handle";
import { pullGrantsVault } from "@/lib/bonded/grantsSync";

const fmtShortDate = (unix: number): string =>
  new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

type Row = { rec: BondGrantRecord; active: boolean | null };

// The handle's bonded-access grants: recorded locally per accessor (the on-chain grant carries no token /
// amount label), live-checked on-chain, and shareable. Active grants sort soonest-expiring first; ended ones
// group below. The list follows the wallet via the encrypted grants vault (pulled here on a known device).
export default function AccessList({
  accessor,
  connected,
  address,
  signMessage,
}: {
  accessor: string | null;
  connected: boolean;
  address: string | null;
  signMessage: (m: string) => Promise<Uint8Array>;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [sync, setSync] = useState<"idle" | "syncing" | "synced" | "error">("idle");
  const [copiedReq, setCopiedReq] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Each recorded grant, live-checked on-chain (is_granted folds in the deadline). `active` is null while in
  // flight; a network gap falls back to the recorded deadline.
  const refresh = useCallback(async () => {
    if (!accessor) {
      setRows([]);
      return;
    }
    const recs = readBondGrants(accessor);
    setRows(recs.map((rec) => ({ rec, active: null })));
    if (recs.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    const out = await Promise.all(
      recs.map(async (rec) => {
        try {
          const s = await getBondStatus(accessor, rec.reqId);
          return { rec, active: Boolean(s.is_granted) };
        } catch {
          return { rec, active: now < rec.deadline };
        }
      }),
    );
    if (alive.current && accessor) setRows(out);
  }, [accessor]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pull the list from the wallet vault. Auto-runs silently if the wallet already signed this session; the
  // button lets a fresh device sign once and pull.
  const pull = useCallback(
    async (userInitiated: boolean) => {
      if (!connected || !accessor) return;
      setSync("syncing");
      try {
        const sig = await getBondSig(address, signMessage);
        await pullGrantsVault(sig, accessor);
        if (alive.current) {
          setSync("synced");
          await refresh();
        }
      } catch {
        if (alive.current) setSync(userInitiated ? "error" : "idle");
      }
    },
    [connected, accessor, address, signMessage, refresh],
  );
  useEffect(() => {
    if (connected && accessor && hasBondSig(address)) void pull(false);
  }, [connected, accessor, address, pull]);

  const shareGrant = async (rec: BondGrantRecord) => {
    if (!accessor) return;
    const u = new URL("/verify/bond", window.location.origin);
    u.searchParams.set("accessor", accessor);
    u.searchParams.set("req", rec.reqId);
    if (rec.tokenSymbol) u.searchParams.set("symbol", rec.tokenSymbol);
    u.searchParams.set("amount", rec.minAmount);
    u.searchParams.set("decimals", String(rec.decimals));
    u.searchParams.set("deadline", String(rec.deadline));
    try {
      await navigator.clipboard.writeText(u.toString());
      setCopiedReq(rec.reqId);
      setTimeout(() => {
        if (alive.current) setCopiedReq((c) => (c === rec.reqId ? null : c));
      }, 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const active = rows
    .filter((r) => r.active !== false)
    .sort((a, b) => a.rec.deadline - b.rec.deadline); // soonest-expiring first
  const ended = rows
    .filter((r) => r.active === false)
    .sort((a, b) => b.rec.deadline - a.rec.deadline); // most recently ended first
  const hasShareable = active.some((r) => r.active === true);

  const row = ({ rec, active: a }: Row) => (
    <div
      key={rec.reqId}
      data-testid="tier-access-row"
      className="flex items-center justify-between gap-4 border-b border-border/70 py-2.5 last:border-0"
    >
      <span className="text-[13px]">
        <span className="font-medium tabular-nums">{fmtAmount(rec.minAmount, rec.decimals)}</span> {rec.tokenSymbol}
      </span>
      <span className="flex items-center gap-2 text-[12px]">
        {a === null ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> checking
          </span>
        ) : a ? (
          <span className="text-success">active until {fmtShortDate(rec.deadline)}</span>
        ) : Math.floor(Date.now() / 1000) >= rec.deadline ? (
          <span className="text-muted-foreground">expired {fmtShortDate(rec.deadline)}</span>
        ) : (
          <span className="text-muted-foreground">not active</span>
        )}
        {a === true &&
          (copiedReq === rec.reqId ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-success" data-testid="tier-access-share">
              <Check className="size-3.5" /> Copied
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void shareGrant(rec)}
              aria-label="Copy a verification link for this grant"
              data-testid="tier-access-share"
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Link2 className="size-3.5" />
            </button>
          ))}
      </span>
    </div>
  );

  if (!accessor) {
    return (
      <Panel title="Active access">
        <p className="text-[13px] text-muted-foreground" data-testid="tier-access-empty">
          Mint a handle on the{" "}
          <Link to="/app/bonded/tier" className="text-brand hover:underline">
            Bonded Access
          </Link>{" "}
          tab to start.
        </p>
      </Panel>
    );
  }

  return (
    <div className="grid gap-4" data-testid="tier-access">
      <Panel
        title="Active access"
        aside={
          <Button variant="outline" size="sm" onClick={() => void refresh()} data-testid="tier-access-refresh">
            <RefreshCw className="size-4" /> Refresh
          </Button>
        }
      >
        {active.length === 0 ? (
          <p className="text-[13px] text-muted-foreground" data-testid="tier-access-empty">
            No access yet. Prove a bond on the{" "}
            <Link to="/app/bonded/tier" className="text-brand hover:underline">
              Bonded Access
            </Link>{" "}
            tab and it shows up here.
          </p>
        ) : (
          <div className="grid gap-0.5">{active.map(row)}</div>
        )}
      </Panel>

      {ended.length > 0 && (
        <Panel title="Ended">
          <div className="grid gap-0.5">{ended.map(row)}</div>
        </Panel>
      )}

      <div className="grid gap-1.5">
        {hasShareable && (
          <p className="text-[12px] text-muted-foreground" data-testid="tier-access-share-note">
            A share link carries your anonymous handle id and the requirement, never your wallet.
          </p>
        )}
        {sync === "synced" ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-success" data-testid="tier-access-sync">
            <ShieldCheck className="size-3.5" /> This list is encrypted under your wallet, so it follows you to other devices.
          </span>
        ) : sync === "syncing" ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground" data-testid="tier-access-sync">
            <Loader2 className="size-3.5 animate-spin" /> Syncing this list with your wallet…
          </span>
        ) : connected ? (
          <span className="inline-flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground" data-testid="tier-access-sync">
            This list is recorded in this browser.
            <button type="button" onClick={() => void pull(true)} className="text-brand hover:underline" data-testid="tier-access-pull">
              Sync from your wallet
            </button>
          </span>
        ) : (
          <span className="text-[12px] text-muted-foreground" data-testid="tier-access-sync">
            Once your wallet backs up your handle, this list rides along to your other devices.
          </span>
        )}
        <p className="text-[12px] text-muted-foreground">
          The token and amount come from this browser's record of what you proved. The on-chain grant stores
          only the requirement hash and the deadline, so it cannot label itself.
        </p>
      </div>
    </div>
  );
}
