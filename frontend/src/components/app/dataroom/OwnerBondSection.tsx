import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, Info, KeyRound, Loader2, ShieldCheck } from "lucide-react";
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
import { short, explorer } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TokenOption } from "@/lib/bonded/tokens";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { DataRow } from "@/components/app/blocks";
import { BondTokenPicker } from "@/components/app/dataroom/BondTokenPicker";
import { BondCount, Callout, CopyIconButton, CurrentBadge, SectionLabel } from "@/components/app/dataroom/kit";

// Room Management — TRUE bond-only (no-approval) Bonded Access. The owner sets ONE room-level requirement: a
// token, a minimum amount, and a deadline. Anyone who locks a qualifying bond (and proves it anonymously)
// opens the room's documents, with NO approval and NO member list. Self-contained: reads the current
// requirement + the live qualifying-bonder count, resolves the token three ways (wallet / paste / classic
// asset), and writes via the wallet (room-owner auth) using the bond-only path (mode "open").
//
// When a requirement is set, the section is a submenu (the current requirement, or an editor to replace it),
// so it does not stack both at once. With NO requirement set, the editor is the only thing shown.

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

// A blocking progress dialog shown while a set/clear is in flight, so the owner does not close the tab while
// the change is being recorded on-chain. The Freighter signing popup appears over it. The bar is an
// indeterminate sweep (we do not have fine-grained progress), the step line updates at the coarse boundaries
// we control (signing -> publishing -> finishing).
function BondProgressDialog({ proc }: { proc: { kind: "set" | "clear"; step: string } | null }) {
  // Move focus into the dialog when it opens so a keyboard/screen-reader user lands on the modal (and its
  // "do not close this tab" label) rather than a control behind the backdrop. Keyed on `kind` so a step
  // update does not re-grab focus. Full focus-trap/inert is a shared concern with the Store dialog.
  const ref = useRef<HTMLDivElement>(null);
  const kind = proc?.kind;
  useEffect(() => { if (kind) ref.current?.focus(); }, [kind]);
  if (!proc) return null;
  const title = proc.kind === "set" ? "Setting up Bonded Access" : "Clearing Bonded Access";
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-5 backdrop-blur-sm" data-testid="bond-progress-backdrop">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-busy="true"
        aria-labelledby="bond-progress-title"
        data-testid="bond-progress"
        className="w-full max-w-[440px] animate-fade-in rounded-xl border bg-card p-6 text-card-foreground shadow-xl focus:outline-none"
      >
        <div className="flex items-center gap-2.5">
          <Loader2 className="size-4 animate-spin text-brand" aria-hidden="true" />
          <h2 id="bond-progress-title" className="text-base font-semibold tracking-tight">{title}</h2>
        </div>
        <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuetext="Working">
          <div className="absolute inset-y-0 w-2/5 rounded-full bg-brand motion-safe:animate-indeterminate" />
        </div>
        <p className="mt-4 text-[13px] text-foreground" role="status" aria-live="polite" data-testid="bond-progress-step">
          {proc.step}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Do not close this tab. We are recording the change on-chain, which takes a moment.
        </p>
      </div>
    </div>,
    document.body,
  );
}

// Shown on the COLD path, while the first requirement read for a room is in flight, so a room that already
// has a requirement does not briefly flash the empty "Set Bonded Access" editor before its Current card. It
// roughly matches the editor's box (a select, two side-by-side inputs, a button), so the swap does not jump.
function BondSectionSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" data-testid="bond-section-skeleton">
      <span className="sr-only" role="status">Loading the bond requirement</span>
      <Skeleton className="h-10 w-full max-w-xs rounded-md" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-16 rounded-md" />
        <Skeleton className="h-16 rounded-md" />
      </div>
      <Skeleton className="h-9 w-40 rounded-md" />
    </div>
  );
}

export function OwnerBondSection({ roomId, onChanged, onCleared }: { roomId: string; onChanged?: () => void; onCleared?: () => void }) {
  const { address } = useWallet();
  const signer = useTxSigner();

  const [req, setReq] = useState<BondRequirement | null>(null);
  const [reqMeta, setReqMeta] = useState<{ symbol: string; decimals: number; issuer: string | null } | null>(null);
  const [reqMetaLoading, setReqMetaLoading] = useState(false); // the token symbol/issuer read is in flight
  const [count, setCount] = useState<number | null>(null);
  // Whether the FIRST requirement read for this room (mount or room switch) has settled. Until it has, show a
  // skeleton instead of the editor, so a bonded room does not flash the empty editor before its Current card.
  // Not reset on a later reload (after a set), so that path swaps smoothly without a skeleton blink.
  const [loaded, setLoaded] = useState(false);

  const [token, setToken] = useState<TokenOption | null>(null);
  const [amount, setAmount] = useState("100");
  const [deadline, setDeadline] = useState(defaultDeadline);

  // Which view of an active requirement to show: the read-only "current" card, or the editor that replaces it.
  // Defaults to "current" so a just-set or already-set requirement shows its summary, not the empty editor.
  const [view, setView] = useState<"current" | "new">("current");

  const [busy, setBusy] = useState(false);
  // The blocking progress dialog: `kind` drives the title, `step` is the live sub-line. Non-null only while a
  // set/clear write is in flight.
  const [proc, setProc] = useState<{ kind: "set" | "clear"; step: string } | null>(null);
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

  // Load the current requirement + the live qualifying-bonder count + the token's symbol/decimals/issuer.
  const loadReq = useCallback(async () => {
    setReqMeta(null);
    setReqMetaLoading(true);
    setCount(null);
    const r = await getBondRequirementApi(roomId).catch(() => ({ found: false }) as BondRequirement);
    if (r.found && r.token && r.minAmount && r.deadline) {
      setReq(r);
      getBondQualSet(r.token, r.minAmount, r.deadline).then((q) => setCount(q.anonSetSize)).catch(() => setCount(null));
      if (address) {
        getTokenBalance(address, r.token)
          .then((t) => setReqMeta({ symbol: t.symbol, decimals: t.decimals, issuer: t.issuer ?? null }))
          .catch(() => setReqMeta(null)) // e.g. the token's SAC is not deployed: the row reads "unavailable"
          .finally(() => setReqMetaLoading(false));
      } else {
        setReqMetaLoading(false); // no wallet -> cannot read the token meta
      }
    } else {
      setReq(null);
      setReqMetaLoading(false);
    }
    setLoaded(true);
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
    setProc({ kind: "set", step: "Confirm the change in your wallet, then we save it on-chain." });
    try {
      const r = await setBondRequirement(roomId, { token: token.contractId, minAmount: base, deadline: deadlineUnix }, signer, "open");
      if (!r.ok) {
        setErr(r.error ?? "Could not set the requirement.");
        return;
      }
      // Best-effort: publish the qualifying-set root now. It refuses below the anonymity floor, which is
      // expected at first (no readers have bonded yet); the root forms as readers deposit + prove.
      setProc({ kind: "set", step: "Publishing the qualifying set." });
      try {
        const p = await publishBondQualRoot(token.contractId, base, deadlineUnix);
        if (!p.ok) setPubFailed(true);
      } catch {
        setPubFailed(true);
      }
      setProc({ kind: "set", step: "Loading the new requirement." });
      setMsg("Bonded Access set. Anyone who locks a qualifying bond can open this room, with no approval needed.");
      await loadReq();
      setView("current"); // show the new requirement summary, not the editor + its button
      onChanged?.();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
      setProc(null);
    }
  }, [token, amount, deadline, signer, roomId, loadReq, onChanged]);

  const onClear = useCallback(async () => {
    setErr(null);
    setMsg(null);
    setPubFailed(false);
    if (!signer) return setErr("Connect your wallet on testnet first.");
    setBusy(true);
    setProc({ kind: "clear", step: "Confirm the change in your wallet." });
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
      onCleared?.(); // let the parent move off the bond panel to the membership panel
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
      setProc(null);
    }
  }, [signer, roomId, onChanged, onCleared]);

  // The editor (set a new requirement, or replace the current one). The two short inputs (minimum amount and
  // deadline) sit side by side on wider screens, so the form fills the width instead of running as a single
  // narrow column; they stack on phones.
  const editor = (
    <div className="space-y-4" data-testid="bond-editor">
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
        {busy ? "Setting…" : req ? "Replace requirement" : "Set Bonded Access"}
      </Button>
    </div>
  );

  // The current requirement, in a standout (success-tinted) card so it reads as the live setting, distinct
  // from the surrounding "How readers get in" section. The token shows its contract AND its classic issuer,
  // each a Stellar Expert link.
  const currentCard = req && req.token && req.minAmount && req.deadline ? (
    <div className="space-y-1 rounded-xl border border-success/30 bg-success/5 p-4" data-testid="bond-current">
      <div className="flex items-center justify-between gap-2 pb-1">
        <SectionLabel>Current requirement</SectionLabel>
        <CurrentBadge testId="bond-current-badge" />
      </div>
      <DataRow k="token" testId="bond-current-token">
        <span className="font-mono">{reqMeta?.symbol ?? short(req.token, 6)}</span>
      </DataRow>
      <DataRow k="contract" mono={false}>
        <span className="inline-flex items-center gap-1.5">
          <a href={explorer("contract", req.token)} target="_blank" rel="noreferrer" className="font-mono text-brand hover:underline" title={req.token}>
            {short(req.token, 6)} ↗
          </a>
          <CopyIconButton value={req.token} label="token contract" />
        </span>
      </DataRow>
      <DataRow k="issuer" mono={false} testId="bond-current-issuer">
        {reqMetaLoading ? (
          <span className="text-muted-foreground">…</span>
        ) : reqMeta ? (
          reqMeta.issuer ? (
            <a href={explorer("account", reqMeta.issuer)} target="_blank" rel="noreferrer" className="font-mono text-brand hover:underline" title={reqMeta.issuer}>
              {short(reqMeta.issuer, 6)} ↗
            </a>
          ) : (
            <span className="text-muted-foreground">no classic issuer</span>
          )
        ) : (
          <span className="text-muted-foreground">unavailable</span>
        )}
      </DataRow>
      <DataRow k="minimum">
        {reqMeta
          ? `${fmtAmount(req.minAmount, reqMeta.decimals)}${reqMeta.symbol ? ` ${reqMeta.symbol}` : ""}`
          : reqMetaLoading
            ? "…"
            : `${req.minAmount} base units`}
      </DataRow>
      <DataRow k="locked until" mono={false}>
        {fmtDeadline(req.deadline)} <span className="text-muted-foreground">(or later)</span>
      </DataRow>
      <DataRow k="bonders" mono={false}>
        <BondCount count={count} />
      </DataRow>
      <div className="pt-2">
        <Button variant="outline" size="sm" onClick={() => void onClear()} disabled={busy} data-testid="bond-clear">
          Clear requirement
        </Button>
      </div>
    </div>
  ) : null;

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

      {!loaded ? (
        <BondSectionSkeleton />
      ) : req ? (
        <div className="space-y-3">
          {/* Submenu: the current requirement, or the editor to replace it. Keeps both off the screen at once
              so the section does not run tall. Shown only when a requirement exists. */}
          <div className="inline-flex w-fit gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label="Bonded Access requirement">
            {([
              { key: "current", label: "Current requirement" },
              { key: "new", label: "Set a new requirement" },
            ] as const).map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={view === t.key}
                onClick={() => setView(t.key)}
                disabled={busy}
                data-testid={`bond-view-${t.key}`}
                className={cn(
                  "whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-muted",
                  view === t.key
                    ? "border border-border bg-card text-foreground shadow-sm"
                    : "border border-transparent text-muted-foreground hover:bg-card/40 hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {view === "current" ? currentCard : editor}
        </div>
      ) : (
        editor
      )}

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

      <BondProgressDialog proc={proc} />
    </div>
  );
}
