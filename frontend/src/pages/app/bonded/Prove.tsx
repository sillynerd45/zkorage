import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Wallet, ShieldCheck, ShieldX, Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import { useBonded } from "@/lib/hooks/useBonded";
import { Panel, DataRow } from "@/components/app/blocks";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  proveSolvency,
  getProveStatus,
  submitSolvency,
  getSolvencyStatus,
  fmtAmount,
  type SolvencyStatus,
  type Bundle,
  type LockView,
} from "@/lib/api";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";

const fmtDate = (u: number) => new Date(u * 1000).toLocaleString();
type Phase = "idle" | "proving" | "submitting" | "done" | "error";

export default function BondedProve() {
  const b = useBonded();
  const [status, setStatus] = useState<SolvencyStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState("");
  const [workingLock, setWorkingLock] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Live status polling — re-reads the gate's is_granted (which itself re-reads the escrow lock), so the
  // badge flips ACTIVE -> VOID on its own the moment the bond is released. This is the self-void.
  const refreshStatus = useCallback(async () => {
    if (!b.address) {
      setStatus(null);
      return;
    }
    try {
      const s = await getSolvencyStatus(b.address);
      if (alive.current) setStatus(s);
    } catch {
      /* transient read error — keep the last known status */
    }
  }, [b.address]);

  useEffect(() => {
    void refreshStatus();
    const iv = setInterval(() => void refreshStatus(), 5000);
    return () => clearInterval(iv);
  }, [refreshStatus]);

  // Drop a stale flow message when the wallet switches.
  useEffect(() => {
    setPhase("idle");
    setMsg("");
  }, [b.address]);

  const provable = b.locks.filter((l) => l.role === "self" && l.revocable && l.is_locked && !l.released);
  const granted = Boolean(status?.is_granted);
  const hadProof = Boolean(status?.record);
  const boundLock = status?.record ? Number(status.record.lock_id) : null;
  const busyFlow = phase === "proving" || phase === "submitting";

  const prove = async (lock: LockView) => {
    if (!b.signer) {
      setPhase("error");
      setMsg("Connect your wallet on testnet first.");
      return;
    }
    setWorkingLock(lock.id);
    setPhase("proving");
    setMsg("Attesting reserves and proving on the self-hosted prover. This takes a few seconds.");
    try {
      const { jobId } = await proveSolvency(lock.id);
      let bundle: Bundle | undefined;
      for (let i = 0; i < 75 && alive.current; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const st = await getProveStatus(jobId);
        if (st.status === "done" && st.bundle) {
          bundle = st.bundle;
          break;
        }
        if (st.status === "error") throw new Error(st.error || "proving failed");
      }
      if (!bundle) throw new Error("proving timed out, please try again");
      setPhase("submitting");
      setMsg("Proof ready. Submitting it to the gate. Approve the signature in your wallet.");
      const r = await submitSolvency(bundle, b.signer);
      if (!r.ok) throw new Error(r.error || "submit was declined");
      setPhase("done");
      setMsg(`Solvent. The proof stays live while lock #${lock.id} is bonded. Pull the collateral and it dies.`);
      await refreshStatus();
    } catch (e) {
      setPhase("error");
      setMsg((e as Error)?.message ?? "something went wrong");
    } finally {
      setWorkingLock(null);
    }
  };

  const release = async (lockId: number) => {
    setPhase("idle");
    setMsg("");
    const r = await b.unbond(lockId); // refreshes the lock list
    await refreshStatus(); // flips the badge to VOID
    if (!r.ok) {
      setPhase("error");
      setMsg(r.error ?? "release failed");
    }
  };

  if (!b.connected) {
    return (
      <Panel title="Prove Solvency">
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-[14px] text-muted-foreground">
            Connect your Freighter wallet on testnet to prove solvency against one of your bonded locks.
          </p>
          <Button variant="brand" onClick={() => void b.connect()} data-testid="solvency-connect">
            <Wallet className="size-4" /> Connect wallet
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <div className="grid gap-4" data-testid="bonded-prove">
      {/* What this is — the inverted model, stated plainly. */}
      <Panel title="A proof that dies when you pull your collateral">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          You prove that your reserves cover the circulating supply, without revealing the reserve figure.
          The proof is tied to a revocable lock in the escrow. The gate reads that lock on every check, so
          the proof counts as live only while the bond stays locked. The moment you release the collateral,
          the proof goes void in the same breath. Your identity is public here; the zero-knowledge part hides
          the reserve composition, not who you are.
        </p>
      </Panel>

      {/* The live badge — ACTIVE while bonded, VOID once released. */}
      <Panel
        title="Live status"
        aside={
          <Button variant="outline" size="sm" onClick={() => void refreshStatus()} data-testid="solvency-refresh">
            <RefreshCw className="size-4" /> Re-check
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-3" data-testid="solvency-badge" data-state={granted ? "active" : hadProof ? "void" : "none"}>
          {granted ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1.5 text-[13px] font-semibold text-success">
              <ShieldCheck className="size-4" /> Solvent — bonded
            </span>
          ) : hadProof ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-1.5 text-[13px] font-semibold text-destructive">
              <ShieldX className="size-4" /> Void — collateral released
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-[13px] font-medium text-muted-foreground">
              No live solvency proof yet
            </span>
          )}
          <span className="font-mono text-[12px] text-muted-foreground">{b.address ? short(b.address, 5) : ""}</span>
        </div>

        {status?.record && (
          <div className="mt-3 grid gap-0.5">
            <DataRow k="Bonded lock">#{status.record.lock_id}</DataRow>
            <DataRow k="Reserves cover">{fmtAmount(status.record.supply)} zUSD supply</DataRow>
            <DataRow k="At least bonded">{fmtAmount(status.record.min_amount)} zkUSD</DataRow>
          </div>
        )}

        {granted && boundLock != null && (
          <div className="mt-4">
            <Button
              variant="destructive"
              disabled={b.busy === `unbond-${boundLock}`}
              onClick={() => void release(boundLock)}
              data-testid={`release-collateral-${boundLock}`}
            >
              {b.busy === `unbond-${boundLock}` ? <Loader2 className="size-4 animate-spin" /> : <AlertTriangle className="size-4" />}
              Release collateral now
            </Button>
            <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <AlertTriangle className="size-3.5" /> This pulls lock #{boundLock} and voids this proof immediately.
            </p>
          </div>
        )}
      </Panel>

      {/* Provable locks. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">Your revocable, still-locked bonds</p>
        <Button variant="outline" size="sm" onClick={() => void b.refresh()} disabled={b.loading} data-testid="solvency-refresh-locks">
          <RefreshCw className={cn("size-4", b.loading && "animate-spin")} /> Refresh locks
        </Button>
      </div>

      {provable.length === 0 && (
        <Panel>
          <div className="flex flex-col items-start gap-3 py-2" data-testid="solvency-empty">
            <p className="text-[14px] text-muted-foreground">
              You have no revocable, still-locked bonds to prove against. A solvency bond must be revocable
              (so you can pull it) and still locked.
            </p>
            <Link to="/app/bonded/deposit" className={buttonVariants({ variant: "brand" })}>
              Lock a revocable bond
            </Link>
          </div>
        </Panel>
      )}

      {provable.map((l) => (
        <Panel key={l.id} title={`Lock #${l.id}`} aside={<span className="rounded-full bg-brand/10 px-2.5 py-1 text-[11px] font-medium text-brand">Revocable bond</span>}>
          <div className="grid gap-0.5">
            <DataRow k="Amount">{fmtAmount(l.amount)} zkUSD</DataRow>
            <DataRow k="Locked until">{fmtDate(l.unlock_time)}</DataRow>
          </div>
          <div className="mt-4">
            <Button
              variant="brand"
              disabled={busyFlow}
              onClick={() => void prove(l)}
              data-testid={`prove-solvency-${l.id}`}
            >
              {busyFlow && workingLock === l.id ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              Prove solvency with this bond
            </Button>
          </div>
        </Panel>
      ))}

      {msg && (
        <p
          className={cn("break-all text-[13px]", phase === "error" ? "text-destructive" : phase === "done" ? "text-success" : "text-muted-foreground")}
          data-testid="solvency-phase"
        >
          {busyFlow && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />}
          {msg}
        </p>
      )}
    </div>
  );
}
