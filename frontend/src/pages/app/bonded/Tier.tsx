import { useCallback, useEffect, useRef, useState } from "react";
import { Wallet, ShieldCheck, Loader2, AlertTriangle, RefreshCw, UserPlus, Lock, Users } from "lucide-react";
import { useBonded } from "@/lib/hooks/useBonded";
import { Panel, DataRow } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import {
  getTierInfo,
  enrollTier,
  getTierQualSet,
  proveTier,
  submitTier,
  getTierStatus,
  getProveStatus,
  fmtAmount,
  type TierInfo,
  type TierIdentity,
  type TierQualSet,
  type TierStatus,
  type Bundle,
} from "@/lib/api";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";

// The demo tier: a fixed (threshold, X) so every member shares ONE anonymity set. Bond at least this much,
// locked until this date, and you qualify. X is absolute (not per-deposit) on purpose — a shared deadline is
// what lets the proof hide WHICH member you are.
const TIER_THRESHOLD = "1000000000"; // 100 zkUSD (7 decimals)
const TIER_X = 1_800_000_000; // ~2027-01-15
const IDENTITY_KEY = "zkorage-tier-identity";

const fmtDate = (u: number) => new Date(u * 1000).toLocaleString();
type Phase = "idle" | "proving" | "submitting" | "done" | "error";

// BigInt() throws on a non-numeric string; never let a stray balance crash the render.
const safeBig = (s: string): bigint => {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
};

function loadIdentity(): TierIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as TierIdentity) : null;
  } catch {
    return null;
  }
}

export default function BondedTier() {
  const b = useBonded();
  const [info, setInfo] = useState<TierInfo | null>(null);
  const [identity, setIdentity] = useState<TierIdentity | null>(loadIdentity());
  const [qual, setQual] = useState<TierQualSet | null>(null);
  const [status, setStatus] = useState<TierStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refreshQual = useCallback(async () => {
    try {
      const q = await getTierQualSet(TIER_THRESHOLD, TIER_X);
      if (alive.current) setQual(q);
    } catch {
      /* transient read error — keep the last known set */
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!identity?.accessor) {
      setStatus(null);
      return;
    }
    try {
      const s = await getTierStatus(identity.accessor);
      if (alive.current) setStatus(s);
    } catch {
      /* keep the last known status */
    }
  }, [identity?.accessor]);

  useEffect(() => {
    getTierInfo().then(setInfo).catch(() => {});
  }, []);

  useEffect(() => {
    void refreshQual();
    const iv = setInterval(() => void refreshQual(), 8000);
    return () => clearInterval(iv);
  }, [refreshQual]);

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
  // This demo tier has a FIXED deadline. Past it, no lock can qualify (the escrow rejects a past unlock time
  // and the indexer requires unlock_time >= X), so disable bonding + proving with a clear note rather than
  // letting the user hit confusing errors. A production tier would publish its active deadline from the gate.
  const tierExpired = Date.now() >= TIER_X * 1000;

  const createIdentity = async () => {
    setPhase("idle");
    setMsg("");
    try {
      const r = await enrollTier();
      if (!r.minted) throw new Error("enroll did not return an identity");
      localStorage.setItem(IDENTITY_KEY, JSON.stringify(r.minted));
      setIdentity(r.minted);
    } catch (e) {
      setPhase("error");
      setMsg((e as Error)?.message ?? "could not create an identity");
    }
  };

  const bondQualifying = async () => {
    if (!identity) return;
    setPhase("idle");
    setMsg("");
    const r = await b.deposit({
      amount: TIER_THRESHOLD,
      unlock_time: TIER_X,
      revocable: false, // anonymous-tier locks are non-revocable — that is what makes now < X mean "still funded"
      commitment: identity.qualCommitment,
    });
    if (!r.ok) {
      setPhase("error");
      setMsg(r.error ?? "bond failed");
      return;
    }
    await refreshQual();
  };

  const prove = async () => {
    if (!identity) return;
    if (belowMin) {
      setPhase("error");
      setMsg(`Only ${anonSize} qualifying bond${anonSize === 1 ? "" : "s"}. Wait until at least ${minSet} exist, or your proof would point back at you.`);
      return;
    }
    setPhase("proving");
    setMsg("Building the witness and proving on the self-hosted prover. This is usually seconds on the GPU prover.");
    try {
      const { jobId } = await proveTier({
        idSecret: identity.idSecret,
        idTrapdoor: identity.idTrapdoor,
        holderSeed: identity.holderSeed,
        threshold: TIER_THRESHOLD,
        unlock_after: TIER_X,
      });
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
      if (!bundle) throw new Error("still proving on the fallback prover — leave this tab open and re-check in a minute");
      setPhase("submitting");
      setMsg("Proof ready. Recording the anonymous grant.");
      const r = await submitTier(bundle);
      if (!r.ok) throw new Error(r.error || "the gate rejected the proof");
      setPhase("done");
      setMsg(`Tier granted to your anonymous handle, valid until ${fmtDate(TIER_X)}. The record does not say which wallet or how much.`);
      await refreshStatus();
    } catch (e) {
      setPhase("error");
      setMsg((e as Error)?.message ?? "something went wrong");
    }
  };

  return (
    <div className="grid gap-4" data-testid="bonded-tier">
      <Panel title="An anonymous tier, bonded until a deadline">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          You prove two things at once: you are an enrolled member, and you control a bonded lock worth at
          least the tier floor, locked until the tier deadline. The proof never says which wallet you used or
          how much you bonded. Anyone watching sees one more anonymous grant, not who earned it. The bonds are
          non-revocable, so a date in the future is enough to prove the funds are still committed, with no
          per-lock lookup that would give you away.
        </p>
        <div className="mt-3 grid gap-0.5">
          <DataRow k="Tier floor">{fmtAmount(TIER_THRESHOLD)} zkUSD</DataRow>
          <DataRow k="Locked until">{fmtDate(TIER_X)}</DataRow>
        </div>
      </Panel>

      {/* Step 1 — an anonymous handle, generated and held in this browser. */}
      <Panel title="1. Your tier identity">
        {hasIdentity ? (
          <div className="grid gap-0.5" data-testid="tier-identity">
            <DataRow k="Anonymous handle">
              <span className="font-mono text-[12px]">{short(identity!.accessor, 6)}</span>
            </DataRow>
            <DataRow k="Bond tag">
              <span className="font-mono text-[12px]">{short(identity!.qualCommitment, 6)}</span>
            </DataRow>
            <p className="pt-2 text-[12px] text-muted-foreground">
              Demo only. The secret behind this handle lives in your browser. In a real deployment you would
              hold it yourself and register only the public tag.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3 py-1">
            <p className="text-[13px] text-muted-foreground">
              Generate an anonymous handle. It is not linked to your wallet, so the grant it earns cannot be
              traced back to you.
            </p>
            <Button variant="brand" onClick={() => void createIdentity()} data-testid="tier-create-identity">
              <UserPlus className="size-4" /> Create a tier identity
            </Button>
          </div>
        )}
      </Panel>

      {/* Step 2 — bond a qualifying lock (wallet-signed, public on purpose; the proof hides which one is yours). */}
      <Panel title="2. Bond a qualifying lock">
        {!b.connected ? (
          <div className="flex flex-col items-start gap-3 py-1">
            <p className="text-[13px] text-muted-foreground">
              Connect your wallet on testnet to bond a qualifying lock. The deposit is public; the anonymity
              comes later, when you prove without pointing at this lock.
            </p>
            <Button variant="brand" onClick={() => void b.connect()} data-testid="tier-connect">
              <Wallet className="size-4" /> Connect wallet
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3 py-1">
            <p className="text-[13px] text-muted-foreground">
              Lock {fmtAmount(TIER_THRESHOLD)} zkUSD until {fmtDate(TIER_X)}, tagged with your handle. This is
              non-revocable, so the funds stay committed until the deadline.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="brand"
                disabled={!hasIdentity || tierExpired || b.busy === "deposit"}
                onClick={() => void bondQualifying()}
                data-testid="tier-bond"
              >
                {b.busy === "deposit" ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
                Bond {fmtAmount(TIER_THRESHOLD)} zkUSD
              </Button>
              {safeBig(b.balance) < safeBig(TIER_THRESHOLD) && (
                <Button variant="outline" disabled={b.busy === "faucet"} onClick={() => void b.fundFaucet()} data-testid="tier-faucet">
                  {b.busy === "faucet" ? <Loader2 className="size-4 animate-spin" /> : null} Get test zkUSD
                </Button>
              )}
            </div>
            {!hasIdentity && <p className="text-[12px] text-muted-foreground">Create a tier identity first.</p>}
            <p className="text-[12px] text-muted-foreground">Balance: {fmtAmount(b.balance)} zkUSD</p>
          </div>
        )}
      </Panel>

      {/* The anonymity set — the count, and the honest warning. */}
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
          <span className="text-muted-foreground">qualifying bond{anonSize === 1 ? "" : "s"} (minimum {minSet})</span>
        </div>
        {belowMin && (
          <p className="mt-2 inline-flex items-start gap-1.5 text-[12px] text-warning" data-testid="tier-anonset-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            A set this small can reveal you by elimination. A set of one points straight at you. Wait until at
            least {minSet} qualifying bonds exist before you prove.
          </p>
        )}
      </Panel>

      {/* Step 3 — prove anonymously. */}
      <Panel title="3. Prove the tier, anonymously">
        <div className="flex flex-wrap items-center gap-3" data-testid="tier-badge" data-state={granted ? "active" : status?.grant ? "expired" : "none"}>
          {granted ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1.5 text-[13px] font-semibold text-success">
              <ShieldCheck className="size-4" /> Tier granted — valid until {fmtDate(TIER_X)}
            </span>
          ) : status?.grant ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-[13px] font-medium text-muted-foreground">
              Grant expired (past the deadline)
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-[13px] font-medium text-muted-foreground">
              No tier grant yet
            </span>
          )}
        </div>
        <div className="mt-4">
          <Button
            variant="brand"
            disabled={!hasIdentity || busyFlow || belowMin || tierExpired}
            onClick={() => void prove()}
            data-testid="tier-prove"
          >
            {busyFlow ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            Prove anonymous tier
          </Button>
          {tierExpired ? (
            <p className="mt-2 text-[12px] text-warning" data-testid="tier-expired">This demo tier has passed its deadline. Nothing more can qualify for it.</p>
          ) : belowMin && hasIdentity ? (
            <p className="mt-2 text-[12px] text-muted-foreground">Proving is held until the anonymity set reaches {minSet}.</p>
          ) : null}
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
    </div>
  );
}
