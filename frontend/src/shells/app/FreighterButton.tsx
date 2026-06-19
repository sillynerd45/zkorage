import { useCallback, useEffect, useRef, useState } from "react";
import {
  Wallet,
  ChevronDown,
  Copy,
  Check,
  ExternalLink,
  LogOut,
  AlertTriangle,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/wallet/WalletContext";
import { explorer } from "@/lib/format";

const FREIGHTER_INSTALL = "https://www.freighter.app/";
const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";

// funded === true → account exists (show its XLM balance, hide friendbot); false → not created yet
// (offer friendbot); null → unknown (Horizon unreachable → keep friendbot as a safe fallback).
type Acct = { funded: boolean; balance: string } | null;

function fmtXlm(b: string): string {
  return Number(b).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// App-shell top-right wallet control. Real Freighter integration: connect / show address / network
// check / disconnect (see lib/wallet/WalletContext). When connected the app routes on-chain writes
// through the wallet (the user signs + pays gas); with no wallet the backend relays — every flow works
// either way.
export function FreighterButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [funding, setFunding] = useState<null | "busy" | "done" | "error">(null);
  const [acct, setAcct] = useState<Acct>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Look up the account on testnet so the menu can show its balance and only offer friendbot when the
  // account hasn't been created yet (a 404). Runs on connect and whenever the menu is opened.
  const refreshAcct = useCallback(async () => {
    if (!w.address) return;
    try {
      const r = await fetch(`${HORIZON}/accounts/${w.address}`);
      if (r.ok) {
        const j = (await r.json()) as { balances?: { asset_type: string; balance: string }[] };
        const native = j.balances?.find((b) => b.asset_type === "native");
        setAcct({ funded: true, balance: native?.balance ?? "0" });
      } else if (r.status === 404) {
        setAcct({ funded: false, balance: "0" });
      } else {
        setAcct(null);
      }
    } catch {
      setAcct(null);
    }
  }, [w.address]);

  useEffect(() => {
    if (w.status === "connected" && w.address) refreshAcct();
    else setAcct(null);
  }, [w.status, w.address, refreshAcct]);

  useEffect(() => {
    if (!open) return;
    if (w.status === "connected") refreshAcct(); // refresh balance each time the menu opens
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const copy = async () => {
    if (!w.address) return;
    try {
      await navigator.clipboard.writeText(w.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  const fund = async () => {
    if (!w.address) return;
    setFunding("busy");
    try {
      const r = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(w.address)}`);
      // friendbot returns 400 if the account is already funded — treat that as success-ish.
      setFunding(r.ok || r.status === 400 ? "done" : "error");
      await refreshAcct(); // flip the menu to the balance view
    } catch {
      setFunding("error");
    }
  };

  // ── Not installed: point the user at the extension ───────────────────────────────────────────
  if (w.status === "not-installed") {
    return (
      <a
        href={FREIGHTER_INSTALL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        data-testid="freighter-connect"
      >
        <Download className="size-4" />
        <span className="hidden sm:inline">Install Freighter</span>
        <span className="sm:hidden">Install</span>
      </a>
    );
  }

  // ── Disconnected / checking / connecting: a plain connect button ─────────────────────────────
  if (w.status !== "connected" && w.status !== "wrong-network") {
    return (
      <div className="relative" ref={popRef}>
        <Button
          variant="outline"
          size="sm"
          onClick={w.connect}
          disabled={w.status === "checking" || w.status === "connecting"}
          data-testid="freighter-connect"
        >
          <Wallet className="size-4" />
          <span className="hidden sm:inline">
            {w.status === "connecting" ? "Connecting…" : "Connect Freighter"}
          </span>
          <span className="sm:hidden">{w.status === "connecting" ? "…" : "Connect"}</span>
        </Button>
        {w.error && (
          <div
            role="alert"
            className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 animate-fade-in rounded-lg border bg-popover p-3 text-xs text-muted-foreground shadow-lg"
            data-testid="wallet-error"
          >
            {w.error}
          </div>
        )}
      </div>
    );
  }

  const wrong = w.status === "wrong-network";

  // ── Connected (or wrong network): address pill + dropdown ────────────────────────────────────
  return (
    <div className="relative" ref={popRef}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="freighter-connect"
        className={wrong ? "border-amber-500/60 text-amber-600 dark:text-amber-400" : ""}
      >
        {wrong ? <AlertTriangle className="size-4" /> : <Wallet className="size-4" />}
        <span className="font-mono text-xs" data-testid="wallet-address">
          {wrong ? "Wrong network" : w.short}
        </span>
        <ChevronDown className="size-3.5 opacity-60" />
      </Button>

      {open && (
        <div
          role="menu"
          aria-label="Wallet"
          data-testid="wallet-menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-72 animate-fade-in rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg"
        >
          {/* network row */}
          <div className="flex items-center justify-between px-2 py-1.5 text-xs">
            <span className="text-muted-foreground">Network</span>
            <span
              className={
                wrong
                  ? "rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400"
                  : "rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-600 dark:text-emerald-400"
              }
              data-testid="wallet-network"
            >
              {w.network ?? "—"}
            </span>
          </div>

          {wrong ? (
            <p className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
              zkorage runs on <b>Testnet</b>. Switch the network in Freighter to sign transactions here.
              You can still browse and verify everything without signing.
            </p>
          ) : (
            <>
              {/* address row */}
              <div className="mt-1 break-all rounded-md bg-muted/50 px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                {w.address}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1">
                <MenuBtn onClick={copy} testid="wallet-copy">
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </MenuBtn>
                <a
                  href={explorer("account", w.address!, "testnet")}
                  target="_blank"
                  rel="noreferrer"
                  role="menuitem"
                  className="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
                >
                  <ExternalLink className="size-3.5" /> Explorer
                </a>
              </div>
              {acct?.funded ? (
                // Already funded → show the balance, no friendbot needed.
                <div className="flex items-center justify-between px-2 py-1.5 text-xs">
                  <span className="text-muted-foreground">Balance</span>
                  <span className="font-mono" data-testid="wallet-balance">
                    {fmtXlm(acct.balance)} XLM
                  </span>
                </div>
              ) : (
                // Not created yet (or status unknown) → offer friendbot.
                <MenuBtn onClick={fund} testid="wallet-fund" full disabled={funding === "busy"}>
                  <Download className="size-3.5" />
                  {funding === "busy"
                    ? "Funding…"
                    : funding === "error"
                      ? "Fund failed — retry"
                      : "Fund testnet account"}
                </MenuBtn>
              )}
            </>
          )}

          <div className="my-1 h-px bg-border" />
          <MenuBtn
            onClick={() => {
              w.disconnect();
              setOpen(false);
            }}
            testid="wallet-disconnect"
            full
            danger
          >
            <LogOut className="size-3.5" /> Disconnect
          </MenuBtn>
        </div>
      )}
    </div>
  );
}

function MenuBtn({
  children,
  onClick,
  testid,
  full,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  testid?: string;
  full?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      className={[
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
        full ? "w-full justify-start" : "justify-center",
        danger ? "text-destructive hover:bg-destructive/10" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
