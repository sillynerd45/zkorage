import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, Info, KeyRound, ShieldCheck } from "lucide-react";
import { useWallet, useTxSigner } from "@/lib/wallet/WalletContext";
import {
  getBondRequirementApi,
  getBondQualSet,
  setBondRequirement,
  clearBondRequirement,
  publishBondQualRoot,
  getTokenBalance,
  toBaseUnits,
  fmtAmount,
  type BondRequirement,
} from "@/lib/api";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TokenOption } from "@/lib/bonded/tokens";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataRow } from "@/components/app/blocks";
import { BondTokenPicker } from "@/components/app/dataroom/BondTokenPicker";
import { BondCount, Callout, CopyIconButton, SectionLabel } from "@/components/app/dataroom/kit";

// Room Management — TRUE bond-only (no-approval) Bonded Access. The owner sets ONE room-level requirement: a
// token, a minimum amount, and a deadline. Anyone who locks a qualifying bond (and proves it anonymously)
// opens the room's documents, with NO approval and NO member list. Self-contained: reads the current
// requirement + the live qualifying-bonder count, resolves the token three ways (wallet / paste / classic
// asset), and writes via the wallet (room-owner auth) using the bond-only path (mode "open").

// now + 30 days, formatted for a datetime-local input (local time, minute precision).
function defaultDeadline(): string {
  const d = new Date(Date.now() + 30 * 24 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDeadline(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}

// Format the editor's datetime-local string for the picker trigger (matches the standalone Bonded Access page).
function fmtLocalDeadline(local: string): string {
  if (!local) return "Pick a deadline";
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return "Pick a deadline";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function OwnerBondSection({ roomId, onChanged }: { roomId: string; onChanged?: () => void }) {
  const { address } = useWallet();
  const signer = useTxSigner();

  const [req, setReq] = useState<BondRequirement | null>(null);
  const [reqMeta, setReqMeta] = useState<{ symbol: string; decimals: number } | null>(null);
  const [count, setCount] = useState<number | null>(null);

  const [token, setToken] = useState<TokenOption | null>(null);
  const [amount, setAmount] = useState("100");
  const [deadline, setDeadline] = useState(defaultDeadline);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pubFailed, setPubFailed] = useState(false);

  // The deadline uses a picker-only trigger (no manual typing): a button shows the formatted date and opens
  // the native datetime picker, with the real input hidden. This matches the standalone Bonded Access page.
  const deadlineRef = useRef<HTMLInputElement>(null);
  const openDeadlinePicker = () => {
    const el = deadlineRef.current;
    if (!el) return;
    try { el.showPicker(); } catch { el.focus(); }
  };

  // Load the current requirement + the live qualifying-bonder count + the token's symbol/decimals for display.
  const loadReq = useCallback(async () => {
    setReqMeta(null);
    setCount(null);
    const r = await getBondRequirementApi(roomId).catch(() => ({ found: false }) as BondRequirement);
    if (r.found && r.token && r.minAmount && r.deadline) {
      setReq(r);
      getBondQualSet(r.token, r.minAmount, r.deadline).then((q) => setCount(q.anonSetSize)).catch(() => setCount(null));
      if (address) getTokenBalance(address, r.token).then((t) => setReqMeta({ symbol: t.symbol, decimals: t.decimals })).catch(() => setReqMeta(null));
    } else {
      setReq(null);
    }
  }, [roomId, address]);

  useEffect(() => { void loadReq(); }, [loadReq]);

  const onSet = useCallback(async () => {
    setErr(null);
    setMsg(null);
    setPubFailed(false);
    if (!token) return setErr("Pick a token to require.");
    const base = toBaseUnits(amount, token.decimals);
    if (!base) return setErr(`Enter a minimum amount (up to ${token.decimals} decimals).`);
    const deadlineUnix = Math.floor(new Date(deadline).getTime() / 1000);
    if (!deadlineUnix || deadlineUnix <= Math.floor(Date.now() / 1000)) return setErr("Pick a deadline in the future.");
    if (!signer) return setErr("Connect your wallet on testnet first.");
    setBusy(true);
    try {
      const r = await setBondRequirement(roomId, { token: token.contractId, minAmount: base, deadline: deadlineUnix }, signer, "open");
      if (!r.ok) {
        setErr(r.error ?? "Could not set the requirement.");
        return;
      }
      // Best-effort: publish the qualifying-set root now. It refuses below the anonymity floor, which is
      // expected at first (no readers have bonded yet); the root forms as readers deposit + prove.
      try {
        const p = await publishBondQualRoot(token.contractId, base, deadlineUnix);
        if (!p.ok) setPubFailed(true);
      } catch {
        setPubFailed(true);
      }
      setMsg("Bonded Access set. Anyone who locks a qualifying bond can open this room, with no approval needed.");
      await loadReq();
      onChanged?.();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }, [token, amount, deadline, signer, roomId, loadReq, onChanged]);

  const onClear = useCallback(async () => {
    setErr(null);
    setMsg(null);
    setPubFailed(false);
    if (!signer) return setErr("Connect your wallet on testnet first.");
    setBusy(true);
    try {
      const r = await clearBondRequirement(roomId, signer);
      if (!r.ok) {
        setErr(r.error ?? "Could not clear the requirement.");
        return;
      }
      setMsg("Cleared. This room is back to approved membership.");
      setReq(null);
      setCount(null);
      setReqMeta(null);
      onChanged?.();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }, [signer, roomId, onChanged]);

  return (
    <div className="space-y-3" data-testid="bond-section">
      <SectionLabel withRule>
        <span className="inline-flex items-center gap-1.5">
          <KeyRound className="size-4" aria-hidden="true" />
          Bond to enter
        </span>
      </SectionLabel>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Anyone who locks a qualifying on-chain bond can open this room's documents, with no approval and no
        member list. The reader proves the bond anonymously, so you never see which reader opened a file.
      </p>

      {/* The current requirement, if one is set. */}
      {req && req.token && req.minAmount && req.deadline && (
        <div className="space-y-2 rounded-xl border p-3.5" data-testid="bond-current">
          <SectionLabel>Current requirement</SectionLabel>
          <DataRow k="token" testId="bond-current-token">
            <span className="font-mono">{reqMeta?.symbol ?? short(req.token, 6)}</span>
            <CopyIconButton value={req.token} label="token contract" />
          </DataRow>
          <DataRow k="minimum">
            {reqMeta ? `${fmtAmount(req.minAmount, reqMeta.decimals)} ${reqMeta.symbol}` : `${req.minAmount} base units`}
          </DataRow>
          <DataRow k="locked until" mono={false}>
            {fmtDeadline(req.deadline)} <span className="text-muted-foreground">(or later)</span>
          </DataRow>
          <DataRow k="bonders" mono={false}>
            <BondCount count={count} />
          </DataRow>
          <Button variant="outline" size="sm" onClick={() => void onClear()} disabled={busy} data-testid="bond-clear">
            Clear requirement
          </Button>
        </div>
      )}

      {/* The editor (set a new requirement, or replace the current one). The two short inputs (minimum amount
          and deadline) sit side by side on wider screens, so the form fills the width instead of running as a
          single narrow column; they stack on phones. */}
      <div className="space-y-4">
        {req && <SectionLabel>Set a new requirement</SectionLabel>}
        <div>
          <Label>Token to bond</Label>
          <div className="mt-1">
            <BondTokenPicker address={address} onResolved={setToken} />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="bond-min" className="mb-1.5 block">Minimum amount{token ? ` (${token.symbol})` : ""}</Label>
            <Input id="bond-min" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full" data-testid="bond-min" />
            <p className="mt-1 text-[12px] text-muted-foreground">The smallest bond that qualifies. A reader may lock more, never less.</p>
          </div>

          <div>
            <Label id="bond-deadline-label" className="mb-1.5 block">Locked until at least</Label>
            <div className="relative">
              <button
                id="bond-deadline-trigger"
                type="button"
                onClick={openDeadlinePicker}
                aria-labelledby="bond-deadline-label bond-deadline-trigger"
                data-testid="bond-deadline-trigger"
                className={cn(
                  "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-left text-sm shadow-sm transition-colors",
                  "focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                )}
              >
                <span className={cn("tabular-nums", !deadline && "text-muted-foreground")}>{fmtLocalDeadline(deadline)}</span>
                <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
              <input
                ref={deadlineRef}
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                data-testid="bond-deadline"
                tabIndex={-1}
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 h-0 w-0 overflow-hidden opacity-0"
              />
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">A qualifying bond cannot be released before this time. Pick a date that outlives the access you are granting.</p>
          </div>
        </div>

        <Button onClick={() => void onSet()} disabled={busy || !token} data-testid="bond-set">
          {busy ? "Setting…" : "Set bonded access"}
        </Button>
      </div>

      {msg && (
        <div className="text-sm text-emerald-600 dark:text-emerald-500" data-testid="bond-set-done">
          <p>{msg}</p>
          {pubFailed && <p className="text-xs text-muted-foreground">The qualifying set will refresh on the next reader proof.</p>}
        </div>
      )}

      <Callout icon={Info} testId="bond-consequence">
        With Bonded Access on, the bond is the only gate: anyone who locks a qualifying bond opens this room,
        and nobody needs your approval. Clearing it returns the room to approved membership.
      </Callout>

      <Callout icon={ShieldCheck} testId="bond-privacy">
        The lock itself is public on-chain: anyone can see the wallet, token, and amount. The proof that opens a
        document is private: it shows a qualifying bond exists without revealing which one, as long as at least
        three qualifying bonders exist.
      </Callout>

      {err && <p className="text-sm text-destructive" data-testid="bond-error">{err}</p>}
    </div>
  );
}
