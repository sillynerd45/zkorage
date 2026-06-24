import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Wallet, ShieldCheck, Loader2, AlertTriangle, RefreshCw, UserPlus, Lock, Users, CalendarClock } from "lucide-react";
import { useBonded } from "@/lib/hooks/useBonded";
import { Panel, DataRow } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getBondInfo,
  enrollBond,
  getBondQualSet,
  proveBond,
  submitBond,
  getBondStatus,
  getProveStatus,
  fmtAmount,
  toBaseUnits,
  type BondInfo,
  type BondIdentity,
  type BondQualSet,
  type BondStatus,
  type Bundle,
} from "@/lib/api";
import { loadWalletTokens, plainAmount, type TokenOption } from "@/lib/bonded/tokens";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";

// A standalone Bonded Access tier is one requirement: a token, a minimum amount, and a deadline. Anyone who
// locks a non-revocable bond that meets it joins the same anonymity set, so the more people who bond the same
// requirement, the stronger the set. The default below gives newcomers one shared requirement to converge on.
const DEFAULT_DEADLINE_UNIX = 1_800_000_000; // ~2027-01-15
const DEFAULT_AMOUNT = "100";
const IDENTITY_KEY = "zkorage-bond-identity";

type Phase = "idle" | "proving" | "submitting" | "done" | "error";

const safeBig = (s: string): bigint => {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
};

// A datetime-local string ("2026-06-24T12:05", local time) from a unix timestamp, and back to a display.
function toLocalInput(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDeadline(local: string): string {
  if (!local) return "Pick a deadline";
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return "Pick a deadline";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function loadIdentity(): BondIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as BondIdentity) : null;
  } catch {
    return null;
  }
}

export default function BondedTier() {
  const b = useBonded();
  const [info, setInfo] = useState<BondInfo | null>(null);
  const [identity, setIdentity] = useState<BondIdentity | null>(loadIdentity());

  // The requirement (token, amount, deadline).
  const [tokens, setTokens] = useState<TokenOption[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [tokenKey, setTokenKey] = useState("");
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [deadlineAt, setDeadlineAt] = useState(toLocalInput(DEFAULT_DEADLINE_UNIX));
  const deadlineRef = useRef<HTMLInputElement>(null);

  const [qual, setQual] = useState<BondQualSet | null>(null);
  const [status, setStatus] = useState<BondStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState("");
  const alive = useRef(true);
  // Bumped whenever the requirement changes, so a read started for an OLD requirement that resolves late is
  // ignored (it would otherwise re-show a stale anon-set / grant for a different requirement).
  const reqSeq = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const selected: TokenOption | null = tokens.find((t) => t.key === tokenKey) ?? null;
  const minAmountBase = selected ? toBaseUnits(amount, selected.decimals) : null;
  const deadlineUnix = Math.floor(new Date(deadlineAt).getTime() / 1000);
  const reqValid = Boolean(selected && minAmountBase && deadlineUnix > Math.floor(Date.now() / 1000));

  useEffect(() => {
    getBondInfo().then(setInfo).catch(() => {});
  }, []);

  // Load the wallet's tokens once connected (these are what you can bond).
  const reloadTokens = useCallback(async () => {
    if (!b.address) return;
    setLoadingTokens(true);
    try {
      const list = await loadWalletTokens(b.address);
      if (!alive.current) return;
      setTokens(list);
      setTokenKey((prev) => (prev && list.some((t) => t.key === prev) ? prev : list[0]?.key ?? ""));
    } finally {
      if (alive.current) setLoadingTokens(false);
    }
  }, [b.address]);
  useEffect(() => {
    void reloadTokens();
  }, [reloadTokens]);

  // When the requirement changes, drop the previous set + decision so the UI fails closed (gated, no grant)
  // until the fresh reads for the new requirement land. Without this, a grant or anon-set from a DIFFERENT
  // requirement could linger and mislead (e.g. an "Access granted" badge after switching tokens).
  useEffect(() => {
    reqSeq.current++;
    setQual(null);
    setStatus(null);
  }, [tokenKey, amount, deadlineAt]);

  // The live qualifying set for the current requirement (anonymity-set size + the derived req_id).
  const refreshQual = useCallback(async () => {
    if (!selected || !minAmountBase || !Number.isFinite(deadlineUnix) || deadlineUnix <= 0) {
      setQual(null);
      return;
    }
    const seq = reqSeq.current;
    try {
      const q = await getBondQualSet(selected.contractId, minAmountBase, deadlineUnix);
      if (alive.current && seq === reqSeq.current) setQual(q);
    } catch {
      /* transient read error; keep the last known set */
    }
  }, [selected, minAmountBase, deadlineUnix]);
  useEffect(() => {
    void refreshQual();
    const iv = setInterval(() => void refreshQual(), 8000);
    return () => clearInterval(iv);
  }, [refreshQual]);

  // The live decision for this handle on the current requirement.
  const reqId = qual?.reqId ?? null;
  const refreshStatus = useCallback(async () => {
    if (!identity?.accessor || !reqId) {
      setStatus(null);
      return;
    }
    const seq = reqSeq.current;
    try {
      const s = await getBondStatus(identity.accessor, reqId);
      if (alive.current && seq === reqSeq.current) setStatus(s);
    } catch {
      /* keep the last known status */
    }
  }, [identity?.accessor, reqId]);
  useEffect(() => {
    void refreshStatus();
    const iv = setInterval(() => void refreshStatus(), 6000);
    return () => clearInterval(iv);
  }, [refreshStatus]);

  const minSet = qual?.minAnonSet ?? info?.minAnonSet ?? 3;
  const anonSize = qual?.anonSetSize ?? 0;
  const belowMin = anonSize < minSet;
  const granted = Boolean(status?.is_granted);
  const hasIdentity = Boolean(identity?.accessor);
  const busyFlow = phase === "proving" || phase === "submitting";
  const expired = deadlineUnix > 0 && Date.now() >= deadlineUnix * 1000;

  const openDeadlinePicker = () => {
    const el = deadlineRef.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };

  const createIdentity = async () => {
    setPhase("idle");
    setMsg("");
    try {
      const r = await enrollBond();
      if (!r.minted) throw new Error("enroll did not return an identity");
      localStorage.setItem(IDENTITY_KEY, JSON.stringify(r.minted));
      setIdentity(r.minted);
    } catch (e) {
      setPhase("error");
      setMsg((e as Error)?.message ?? "could not create an identity");
    }
  };

  const bondQualifying = async () => {
    if (!identity || !selected || !minAmountBase) return;
    setPhase("idle");
    setMsg("");
    const r = await b.deposit({
      amount: minAmountBase,
      unlock_time: deadlineUnix,
      revocable: false, // non-revocable, so a future deadline is enough to show the funds are still locked
      commitment: identity.qualCommitment,
      token: selected.contractId,
    });
    if (!r.ok) {
      setPhase("error");
      setMsg(r.error ?? "bond failed");
      return;
    }
    await refreshQual();
  };

  const prove = async () => {
    if (!identity || !selected || !minAmountBase || !info?.standaloneSetId) return;
    if (belowMin) {
      setPhase("error");
      setMsg(`Only ${anonSize} bond${anonSize === 1 ? "" : "s"} in this set. Wait until at least ${minSet} are in it, or your proof would point back at you.`);
      return;
    }
    setPhase("proving");
    setMsg("Building the proof on the self-hosted prover. This is usually a few seconds.");
    const provedDeadlineAt = deadlineAt; // capture: the user may edit the deadline while proving runs
    try {
      const { jobId, error } = await proveBond({
        roomId: info.standaloneSetId,
        idSecret: identity.idSecret,
        idTrapdoor: identity.idTrapdoor,
        holderSeed: identity.holderSeed,
        token: selected.contractId,
        minAmount: minAmountBase,
        deadline: deadlineUnix,
      });
      if (!jobId) throw new Error(error || "could not start proving");
      let bundle: Bundle | undefined;
      // Poll generously: the GPU worker is ~seconds, the VM CPU fallback can take minutes. ~15 min covers it.
      for (let i = 0; i < 225 && alive.current; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const st = await getProveStatus(jobId);
        if (st.status === "done" && st.bundle) {
          bundle = st.bundle;
          break;
        }
        if (st.status === "error") throw new Error(st.error || "proving failed");
      }
      if (!alive.current) return;
      if (!bundle) throw new Error("still proving on the fallback prover. Leave this tab open and re-check in a minute");
      setPhase("submitting");
      setMsg("Proof ready. Recording the anonymous grant.");
      const r = await submitBond(bundle);
      if (!r.ok) throw new Error(r.error || "the gate rejected the proof");
      setPhase("done");
      setMsg(`Access granted to your anonymous handle, valid until ${fmtDeadline(provedDeadlineAt)}. The record does not say which wallet or how much.`);
      await refreshStatus();
    } catch (e) {
      if (!alive.current) return;
      setPhase("error");
      setMsg((e as Error)?.message ?? "something went wrong");
    }
  };

  const tokenSym = selected?.symbol ?? "token";
  const selectCls =
    "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="grid gap-4" data-testid="bonded-tier">
      <Panel title="Bonded Access">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Prove you hold a qualifying bond without showing which wallet locked it or how much. Pick a
          requirement, lock the bond, then prove it once your anonymity set is large enough. The steps below
          walk you through it.
        </p>
      </Panel>

      {/* The requirement: any token your wallet holds, an amount, and a deadline. */}
      <Panel title="Choose what to bond">
        {!b.connected ? (
          <div className="flex flex-col items-start gap-3 py-1">
            <p className="text-[13px] text-muted-foreground">Connect your wallet on testnet to pick a token to bond.</p>
            <Button variant="brand" onClick={() => void b.connect()} data-testid="tier-connect">
              <Wallet className="size-4" /> Connect wallet
            </Button>
          </div>
        ) : (
          <div className="grid gap-4">
            <div>
              <Label htmlFor="tier-token" className="mb-1.5 block">Token</Label>
              <select
                id="tier-token"
                value={tokenKey}
                onChange={(e) => setTokenKey(e.target.value)}
                className={selectCls}
                data-testid="tier-token"
                disabled={loadingTokens && tokens.length === 0}
              >
                {tokens.length === 0 && <option value="">Loading your tokens…</option>}
                {tokens.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.symbol} · {plainAmount(t.balanceBase, t.decimals)}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="tier-amount" className="mb-1.5 block">Amount ({tokenSym})</Label>
                <Input id="tier-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full" data-testid="tier-amount" />
              </div>
              <div>
                <Label id="tier-deadline-label" className="mb-1.5 block">Deadline</Label>
                <div className="relative">
                  <button
                    id="tier-deadline-trigger"
                    type="button"
                    onClick={openDeadlinePicker}
                    aria-labelledby="tier-deadline-label tier-deadline-trigger"
                    data-testid="tier-deadline-trigger"
                    className={cn(
                      "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-left text-sm shadow-sm transition-colors",
                      "focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                    )}
                  >
                    <span className={cn("tabular-nums", !deadlineAt && "text-muted-foreground")}>{fmtDeadline(deadlineAt)}</span>
                    <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                  <input
                    ref={deadlineRef}
                    type="datetime-local"
                    value={deadlineAt}
                    onChange={(e) => setDeadlineAt(e.target.value)}
                    data-testid="tier-deadline"
                    tabIndex={-1}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0 top-0 h-0 w-0 overflow-hidden opacity-0"
                  />
                </div>
              </div>
            </div>

            {selected && (
              <div className="text-[12px] text-muted-foreground" data-testid="tier-req">
                Balance: <span className="tabular-nums">{fmtAmount(selected.balanceBase, selected.decimals)}</span> {selected.symbol}
              </div>
            )}
            <p className="text-[12px] text-muted-foreground">A bigger set hides you better. Use a token, amount, and deadline others already bond.</p>
          </div>
        )}
      </Panel>

      {/* Step 1: an anonymous handle, generated and held in this browser. */}
      <Panel title="1. Create an anonymous handle">
        {hasIdentity ? (
          <div className="grid gap-0.5" data-testid="tier-identity">
            <DataRow k="Your handle">
              <span className="font-mono text-[12px]">{short(identity!.accessor, 6)}</span>
            </DataRow>
            <DataRow k="Bond tag">
              <span className="font-mono text-[12px]">{short(identity!.qualCommitment, 6)}</span>
            </DataRow>
            <p className="pt-2 text-[12px] text-muted-foreground">
              Demo only. The secret for this handle stays in your browser. In a real setup you would keep it
              yourself and register only the public tag.
            </p>
            <button
              type="button"
              onClick={() => void createIdentity()}
              className="mt-1 w-fit text-[12px] text-brand hover:underline"
              data-testid="tier-regen-identity"
            >
              Regenerate handle
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3 py-1">
            <p className="text-[13px] text-muted-foreground">
              Make an anonymous handle. It is not tied to your wallet, so the grant it earns cannot be traced to
              you.
            </p>
            <Button variant="brand" onClick={() => void createIdentity()} data-testid="tier-create-identity">
              <UserPlus className="size-4" /> Create a handle
            </Button>
          </div>
        )}
      </Panel>

      {/* Step 2: bond a qualifying lock (wallet-signed, public on purpose; the proof hides which one is yours). */}
      <Panel title="2. Lock a qualifying bond">
        {!b.connected ? (
          <p className="text-[13px] text-muted-foreground">Connect your wallet above to lock a qualifying bond.</p>
        ) : (
          <div className="flex flex-col items-start gap-3 py-1">
            <p className="text-[13px] text-muted-foreground">
              Lock {amount} {tokenSym} until {fmtDeadline(deadlineAt)}, tagged with your handle. The lock itself
              is public. The privacy comes at the proving step, where you prove without pointing at this lock.
            </p>
            <Button
              variant="brand"
              disabled={!hasIdentity || !reqValid || expired || b.busy === "deposit"}
              onClick={() => void bondQualifying()}
              data-testid="tier-bond"
            >
              {b.busy === "deposit" ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
              Lock {amount} {tokenSym}
            </Button>
            {!hasIdentity && <p className="text-[12px] text-muted-foreground">Create your handle first.</p>}
            {selected && minAmountBase && safeBig(selected.balanceBase) < safeBig(minAmountBase) && (
              <p className="text-[12px] text-warning">You only have {fmtAmount(selected.balanceBase, selected.decimals)} {selected.symbol}.</p>
            )}
            {expired && <p className="text-[12px] text-warning" data-testid="tier-expired">The deadline is in the past. Pick a later deadline.</p>}
          </div>
        )}
      </Panel>

      {/* The anonymity set: the count, and the honest warning. */}
      <Panel
        title="Anonymity set"
        aside={
          <Button variant="outline" size="sm" onClick={() => void refreshQual()} data-testid="tier-anonset-refresh">
            <RefreshCw className="size-4" /> Re-check
          </Button>
        }
      >
        <div className="flex items-center gap-2 text-[14px]" data-testid="tier-anonset">
          <Users className="size-4 text-muted-foreground" />
          <span className="font-semibold">{anonSize}</span>
          <span className="text-muted-foreground">bond{anonSize === 1 ? "" : "s"} in this set (need at least {minSet})</span>
        </div>
        {belowMin && (
          <p className="mt-2 inline-flex items-start gap-1.5 text-[12px] text-warning" data-testid="tier-anonset-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            A set this small can give you away. A set of one points straight at you. Wait until at least {minSet}
            bonds are in this set before you prove.
          </p>
        )}
      </Panel>

      {/* Step 3: prove anonymously. */}
      <Panel title="3. Prove access, anonymously">
        <div className="flex flex-wrap items-center gap-3" data-testid="tier-badge" data-state={granted ? "active" : status?.grant ? "expired" : "none"}>
          {granted ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1.5 text-[13px] font-semibold text-success">
              <ShieldCheck className="size-4" /> Access granted, valid until {fmtDeadline(deadlineAt)}
            </span>
          ) : status?.grant ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-[13px] font-medium text-muted-foreground">
              Grant expired (past the deadline)
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-[13px] font-medium text-muted-foreground">
              No grant yet
            </span>
          )}
        </div>
        <div className="mt-4">
          <Button
            variant="brand"
            disabled={!hasIdentity || !reqValid || !info?.standaloneSetId || busyFlow || belowMin || expired}
            onClick={() => void prove()}
            data-testid="tier-prove"
          >
            {busyFlow ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            Prove access
          </Button>
          {belowMin && hasIdentity && !expired && (
            <p className="mt-2 text-[12px] text-muted-foreground">Proving stays locked until the set reaches {minSet}.</p>
          )}
        </div>
      </Panel>

      {msg && (
        <p
          className={cn("break-words text-[13px]", phase === "error" ? "text-destructive" : phase === "done" ? "text-success" : "text-muted-foreground")}
          data-testid="tier-phase"
        >
          {busyFlow && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />}
          {msg}
        </p>
      )}

      <p className="text-[12px] text-muted-foreground">
        To gate a whole room with a bond requirement, set it once in{" "}
        <Link to="/app/dataroom" className="text-brand hover:underline">the Data Room</Link>.
      </p>
    </div>
  );
}
