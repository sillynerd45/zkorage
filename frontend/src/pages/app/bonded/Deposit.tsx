import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Wallet, Eye } from "lucide-react";
import { useBonded } from "@/lib/hooks/useBonded";
import { Panel } from "@/components/app/blocks";
import { Callout } from "@/components/app/dataroom/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtAmount, toBaseUnits, getTokenBalance } from "@/lib/api";
import { loadWalletTokens, plainAmount, type TokenOption } from "@/lib/bonded/tokens";
import { cn } from "@/lib/utils";

// now + 1 hour, formatted for a datetime-local input (local time, minute precision).
function defaultUnlock(): string {
  const d = new Date(Date.now() + 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PASTE = "__paste__";

// Module-level, in-memory: the loaded token list + the picked token per wallet, so returning to Deposit
// paints the picker instantly instead of re-reading Horizon. Cleared on a full reload. Public data only.
type TokenSnapshot = { tokens: TokenOption[]; selectedKey: string };
const tokenCache = new Map<string, TokenSnapshot>();
const sameTokens = (a: TokenOption[], c: TokenOption[]) =>
  a.length === c.length && JSON.stringify(a) === JSON.stringify(c);

export default function BondedDeposit() {
  const b = useBonded();
  const nav = useNavigate();
  const seedTokens = b.address ? tokenCache.get(b.address) : undefined;
  const [tokens, setTokens] = useState<TokenOption[]>(seedTokens?.tokens ?? []);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [selectedKey, setSelectedKey] = useState(seedTokens?.selectedKey ?? "");
  const [pasteValue, setPasteValue] = useState("");
  const [pasteToken, setPasteToken] = useState<TokenOption | null>(null);
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);
  const [amount, setAmount] = useState("100");
  const [unlockAt, setUnlockAt] = useState(defaultUnlock);
  const [mode, setMode] = useState<"bond" | "send">("bond");
  const [revocable, setRevocable] = useState(true);
  const [recipient, setRecipient] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const unlockUnix = useMemo(() => Math.floor(new Date(unlockAt).getTime() / 1000), [unlockAt]);

  const reloadTokens = useCallback(async () => {
    if (!b.address) return;
    setLoadingTokens(true);
    try {
      const list = await loadWalletTokens(b.address);
      // Only swap in a changed list so a no-op background refresh does not re-render the picker.
      setTokens((prev) => (sameTokens(prev, list) ? prev : list));
      // Keep the user's pick if it still resolves (or is the paste path); otherwise fall back to the first.
      setSelectedKey((prev) => {
        if (prev === PASTE) return prev;
        if (prev && list.some((t) => t.key === prev)) return prev;
        return list[0]?.key ?? "";
      });
    } finally {
      setLoadingTokens(false);
    }
  }, [b.address]);

  // On mount and whenever the wallet changes, show the cached picker at once (instant on a return visit),
  // then refresh the token list in the background.
  useEffect(() => {
    const snap = b.address ? tokenCache.get(b.address) : undefined;
    setTokens(snap?.tokens ?? []);
    setSelectedKey(snap?.selectedKey ?? "");
    void reloadTokens();
  }, [b.address, reloadTokens]);

  // Persist the loaded list + the current pick so the next visit seeds from it. Never cache the paste path:
  // the pasted token is not cached, so restoring it would land on an empty picker. Fall back to the first.
  useEffect(() => {
    if (b.address && tokens.length > 0) {
      const key = selectedKey === PASTE ? tokens[0]?.key ?? "" : selectedKey;
      tokenCache.set(b.address, { tokens, selectedKey: key });
    }
  }, [b.address, tokens, selectedKey]);

  const isPaste = selectedKey === PASTE;
  const selected: TokenOption | null = isPaste ? pasteToken : tokens.find((t) => t.key === selectedKey) ?? null;

  const resolvePaste = async () => {
    setPasteErr(null);
    setPasteToken(null);
    const c = pasteValue.trim().toUpperCase();
    if (!/^C[A-Z2-7]{55}$/.test(c)) {
      setPasteErr("Enter a valid contract address (C…).");
      return;
    }
    setPasteBusy(true);
    try {
      const t = await getTokenBalance(b.address!, c);
      setPasteToken({
        key: PASTE,
        symbol: t.symbol || "token",
        contractId: c,
        decimals: t.decimals,
        balanceBase: t.balance,
        kind: "custom",
      });
    } catch (e) {
      setPasteErr((e as Error)?.message ?? "Could not read that token.");
    } finally {
      setPasteBusy(false);
    }
  };

  if (!b.connected) {
    return (
      <Panel title="Deposit">
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-[14px] text-muted-foreground">Connect your Freighter wallet on testnet to lock tokens.</p>
          <Button variant="brand" onClick={() => void b.connect()} data-testid="bonded-connect">
            <Wallet className="size-4" /> Connect wallet
          </Button>
        </div>
      </Panel>
    );
  }

  const submit = async () => {
    setErr(null);
    setOk(null);
    if (!selected) return setErr("Pick a token to lock.");
    const base = toBaseUnits(amount, selected.decimals);
    if (!base) return setErr(`Enter a valid amount (up to ${selected.decimals} decimals).`);
    if (BigInt(base) > BigInt(selected.balanceBase || "0"))
      return setErr(`You only have ${fmtAmount(selected.balanceBase, selected.decimals)} ${selected.symbol}.`);
    if (!unlockUnix || unlockUnix <= Math.floor(Date.now() / 1000)) return setErr("Pick an unlock time in the future.");
    const claimant = mode === "send" ? recipient.trim() : b.address!;
    const rev = mode === "send" ? false : revocable;
    if (mode === "send" && !/^G[A-Z2-7]{55}$/.test(claimant)) return setErr("Enter a valid recipient address (G…).");
    const r = await b.deposit({ amount: base, unlock_time: unlockUnix, revocable: rev, claimant, token: selected.contractId });
    if (r.ok) {
      setOk(`Locked. tx ${r.txHash ?? ""}`);
      setTimeout(() => nav("/app/bonded/balances"), 900);
    } else {
      setErr(r.error ?? "deposit failed");
    }
  };

  const busy = b.busy === "deposit";
  const selectCls =
    "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <Panel title="Lock tokens" className="max-w-2xl">
      <div className="grid gap-4" data-testid="bonded-deposit">
        {/* Token: pick any token your wallet holds (the escrow holds any SEP-41 token). */}
        <div>
          <Label htmlFor="token" className="mb-1.5 block">Token</Label>
          <select
            id="token"
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            className={selectCls}
            data-testid="deposit-token"
            disabled={loadingTokens && tokens.length === 0}
          >
            {tokens.length === 0 && <option value="">Loading your tokens…</option>}
            {tokens.map((t) => (
              <option key={t.key} value={t.key}>
                {t.symbol} · {plainAmount(t.balanceBase, t.decimals)}
              </option>
            ))}
            <option value={PASTE}>Paste a contract address…</option>
          </select>

          {isPaste && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Input
                value={pasteValue}
                onChange={(e) => {
                  // Editing the address invalidates a previously loaded token, so clear it. The submit button
                  // disables on !selected, which forces a fresh Load before a deposit (no stale-token lock).
                  setPasteValue(e.target.value);
                  setPasteToken(null);
                  setPasteErr(null);
                }}
                placeholder="C…"
                className="min-w-0 flex-1 font-mono text-[13px]"
                data-testid="deposit-token-paste"
              />
              <Button type="button" variant="outline" size="sm" disabled={pasteBusy} onClick={() => void resolvePaste()} data-testid="deposit-token-load">
                {pasteBusy ? "Loading…" : "Load token"}
              </Button>
            </div>
          )}
          {isPaste && pasteErr && <p className="mt-1 text-[12px] text-destructive">{pasteErr}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted-foreground" data-testid="deposit-balance">
              Balance: {selected ? `${fmtAmount(selected.balanceBase, selected.decimals)} ${selected.symbol}` : "…"}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">Any token your wallet holds works.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="amt">Amount ({selected?.symbol ?? "token"})</Label>
              {selected && BigInt(selected.balanceBase || "0") > 0n && (
                <button
                  type="button"
                  className="text-[12px] text-brand hover:underline"
                  onClick={() => setAmount(plainAmount(selected.balanceBase, selected.decimals))}
                  data-testid="deposit-max"
                >
                  Max
                </button>
              )}
            </div>
            <Input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full" data-testid="deposit-amount" />
          </div>

          <div>
            <Label htmlFor="unlock" className="mb-1.5 block">Unlock time</Label>
            <Input id="unlock" type="datetime-local" value={unlockAt} onChange={(e) => setUnlockAt(e.target.value)} className="w-full" data-testid="deposit-unlock" />
          </div>
        </div>
        <p className="text-[12px] text-muted-foreground">
          Funds release at this time. Extend it later on{" "}
          <Link to="/app/bonded/balances" className="text-brand hover:underline">My Balances</Link>. You cannot shorten it.
        </p>

        <div>
          <Label className="mb-1.5 block">Type</Label>
          <div className="flex w-fit gap-1 rounded-xl border bg-card p-1" role="radiogroup" aria-label="Lock type">
            {(["bond", "send"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                data-testid={`mode-${m}`}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                  mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {m === "bond" ? "Bond (to yourself)" : "One-way send"}
              </button>
            ))}
          </div>
        </div>

        {mode === "bond" ? (
          <label className="flex items-start gap-2 text-[13px] leading-relaxed">
            <input type="checkbox" checked={revocable} onChange={(e) => setRevocable(e.target.checked)} className="mt-0.5" data-testid="deposit-revocable" />
            <span>Allow early release (revocable). Unchecked keeps it locked until the unlock time.</span>
          </label>
        ) : (
          <div>
            <Label htmlFor="rcpt" className="mb-1.5 block">Recipient (G…)</Label>
            <Input id="rcpt" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="G…" className="font-mono text-[13px]" data-testid="deposit-recipient" />
            <p className="mt-1 text-[12px] text-muted-foreground">Only this address can claim it, and only after the unlock time. A send cannot be pulled back.</p>
          </div>
        )}

        {err && <p className="text-[13px] text-destructive" data-testid="deposit-error">{err}</p>}
        {ok && <p className="break-all text-[13px] text-success" data-testid="deposit-ok">{ok}</p>}

        <div>
          <Button variant="brand" disabled={busy || !selected} onClick={() => void submit()} data-testid="deposit-submit">
            {busy ? "Confirm in Freighter…" : "Lock tokens"}
          </Button>
        </div>

        <Callout icon={Eye} testId="deposit-privacy">
          This lock is public. The chain shows your wallet, the token, the amount, and the unlock time. To hide
          which wallet holds a bond, use the{" "}
          <Link to="/app/bonded/tier" className="text-brand hover:underline">Bonded Access proof</Link>.
        </Callout>
      </div>
    </Panel>
  );
}
