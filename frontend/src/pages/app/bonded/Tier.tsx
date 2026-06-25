import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Wallet, ShieldCheck, Loader2, AlertTriangle, RefreshCw, UserPlus, Lock, Users, CalendarClock, Link2, Check } from "lucide-react";
import { useBonded } from "@/lib/hooks/useBonded";
import { useWallet } from "@/lib/wallet/WalletContext";
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
  getBondHandleVault,
  putBondHandleVault,
  getBondGrantsVault,
  putBondGrantsVault,
  fmtAmount,
  toBaseUnits,
  type BondInfo,
  type BondIdentity,
  type BondQualSet,
  type BondStatus,
  type Bundle,
  type LockView,
} from "@/lib/api";
import { loadWalletTokens, plainAmount, type TokenOption } from "@/lib/bonded/tokens";
import { readBondGrants, recordBondGrant, type BondGrantRecord } from "@/lib/bonded/grants";
import { encryptBondGrants, decryptBondGrants, deriveBondGrantsVaultId } from "@/lib/bonded/grantsVault";
import { encryptBondHandle, decryptBondHandle, deriveBondHandleVaultId, BOND_HANDLE_VAULT_MESSAGE, type BondHandle } from "@/lib/bonded/handleVault";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";

// One-signature-per-session cache for the bond-handle vault key (the wallet signature is the HKDF input). Held
// only in memory, never persisted, so a page reload re-prompts once.
const bondSigCache = new Map<string, Uint8Array>();

// A standalone Bonded Access tier is one requirement: a token, a minimum amount, and a deadline. Anyone who
// locks a non-revocable bond that meets it joins the same anonymity set, so the more people who bond the same
// requirement, the stronger the set. The default below gives newcomers one shared requirement to converge on.
const DEFAULT_DEADLINE_UNIX = 1_800_000_000; // ~2027-01-15
const DEFAULT_AMOUNT = "100";
// The anonymous handle is stored PER WALLET, so switching accounts in Freighter never shows the previous
// wallet's handle. An older build used a single global slot (no address suffix); it is migrated to the
// per-wallet slot for the first wallet that connects (see the wallet-change effect).
const IDENTITY_BASE = "zkorage-bond-identity";
const idKey = (addr?: string | null): string => (addr ? `${IDENTITY_BASE}.${addr}` : IDENTITY_BASE);

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

// The display symbol for a lock's token: the native SAC reports "native" (show "XLM"); fall back to a short
// contract id for a token that does not expose a symbol.
const bondSymbol = (l: LockView): string =>
  l.tokenSymbol === "native" ? "XLM" : l.tokenSymbol?.trim() || short(l.token, 4);

// A short calendar date, e.g. "Jan 15, 2027", for a bond chip.
const fmtShortDate = (unix: number): string =>
  new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

// Normalize a 32-byte hex commitment for comparison (lowercase, strip an optional 0x).
const normCommit = (h: string): string => h.toLowerCase().replace(/^0x/, "");
const isZeroCommit = (h: string): boolean => /^0*$/.test(normCommit(h));

function loadIdentityAt(addr?: string | null): BondIdentity | null {
  try {
    const raw = localStorage.getItem(idKey(addr));
    return raw ? (JSON.parse(raw) as BondIdentity) : null;
  } catch {
    return null;
  }
}

export default function BondedTier() {
  const b = useBonded();
  const [info, setInfo] = useState<BondInfo | null>(null);
  const [identity, setIdentity] = useState<BondIdentity | null>(() => loadIdentityAt(null));

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
  const { signMessage } = useWallet();
  const [sync, setSync] = useState<"idle" | "syncing" | "synced" | "error">("idle");
  const [syncMsg, setSyncMsg] = useState("");
  // The handle's bonded-access grants, recorded locally per accessor (the on-chain grant carries no token /
  // amount label) and live-checked on-chain. `active` is null while the check is in flight.
  const [grantRows, setGrantRows] = useState<{ rec: BondGrantRecord; active: boolean | null }[]>([]);
  // Backup state for the "Your access" list vault (its own, so the hint never claims "synced" when only the
  // handle made it). It rides the handle's signature, so it never prompts on its own.
  const [accessSync, setAccessSync] = useState<"idle" | "syncing" | "synced" | "error">("idle");
  // The req_id whose share link was just copied (for the brief "Copied" feedback on that row).
  const [copiedReq, setCopiedReq] = useState<string | null>(null);
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

  // Re-validate the displayed handle whenever the connected wallet changes. Each wallet has its OWN handle
  // slot, so switching accounts in Freighter must drop the previous wallet's handle (the bug this fixes). A
  // one-time migration adopts an older single-slot handle for the first wallet that connects, then removes it.
  useEffect(() => {
    const addr = b.address;
    let next = loadIdentityAt(addr);
    if (!next && addr) {
      const legacy = loadIdentityAt(null);
      if (legacy) {
        localStorage.setItem(idKey(addr), JSON.stringify(legacy));
        localStorage.removeItem(idKey(null));
        next = legacy;
      }
    }
    setIdentity(next);
    setSync("idle");
    setSyncMsg("");
  }, [b.address]);

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

  // The handle's recorded grants, each live-checked on-chain (is_granted folds in the deadline, so it is the
  // authoritative "still active" signal; a network gap falls back to the recorded deadline).
  const refreshGrants = useCallback(async () => {
    const acc = identity?.accessor;
    if (!acc) {
      setGrantRows([]);
      return;
    }
    const recs = readBondGrants(acc);
    // This interim set is for the accessor of the current render (the callback is rebuilt per accessor), so it
    // is correct without an extra guard; only the post-await set below needs the stale-accessor check.
    setGrantRows(recs.map((rec) => ({ rec, active: null })));
    const now = Math.floor(Date.now() / 1000);
    const rows = await Promise.all(
      recs.map(async (rec) => {
        try {
          const s = await getBondStatus(acc, rec.reqId);
          return { rec, active: Boolean(s.is_granted) };
        } catch {
          return { rec, active: now < rec.deadline };
        }
      }),
    );
    if (alive.current && identity?.accessor === acc) setGrantRows(rows);
  }, [identity?.accessor]);
  useEffect(() => {
    void refreshGrants();
  }, [refreshGrants]);

  const minSet = qual?.minAnonSet ?? info?.minAnonSet ?? 3;
  const anonSize = qual?.anonSetSize ?? 0;
  const belowMin = anonSize < minSet;
  const granted = Boolean(status?.is_granted);
  const hasIdentity = Boolean(identity?.accessor);
  const busyFlow = phase === "proving" || phase === "submitting";
  const expired = deadlineUnix > 0 && Date.now() >= deadlineUnix * 1000;

  // The wallet's own bonds that can serve as a qualifying bond for some requirement: still locked,
  // non-revocable, with a real (non-zero) commitment. These are the bonds you can load to check their set.
  const myBonds = b.locks.filter(
    (l) => !l.released && l.is_locked && !l.revocable && !isZeroCommit(l.commitment),
  );

  // True when the form's requirement already equals this bond's (token, amount, deadline), so the chip can
  // show which bond is loaded. The deadline round-trips through the minute-precision picker, so compare the
  // bond's unlock at minute precision too.
  const bondReqEq = (l: LockView): boolean =>
    Boolean(selected) &&
    minAmountBase !== null &&
    selected!.contractId === l.token &&
    safeBig(minAmountBase) === safeBig(l.amount) &&
    deadlineUnix === Math.floor(new Date(toLocalInput(l.unlock_time)).getTime() / 1000);

  // Load a bond you already hold into the requirement, so the anonymity set, the already-held check, and
  // proving all target it. If the bond's token is not in the wallet picker (e.g. the trustline is gone), add
  // a synthetic option so it stays selectable.
  const loadBond = (l: LockView) => {
    const dec = l.tokenDecimals || 7;
    let key = tokens.find((t) => t.contractId === l.token)?.key;
    if (!key) {
      key = `lock:${l.token}`;
      const synth: TokenOption = { key, symbol: bondSymbol(l), contractId: l.token, decimals: dec, balanceBase: "0", kind: "custom" };
      setTokens((prev) => (prev.some((t) => t.contractId === l.token) ? prev : [...prev, synth]));
    }
    setTokenKey(key);
    setAmount(plainAmount(l.amount, dec));
    setDeadlineAt(toLocalInput(l.unlock_time));
  };

  // The id of the held bond whose (token, amount, deadline) currently matches the form, so the dropdown shows
  // it as selected; empty when the requirement has been edited away from every held bond.
  const loadedBondId = String(myBonds.find((l) => bondReqEq(l))?.id ?? "");

  // "Your access": active (or still-checking) grants first, lapsed ones grouped below.
  const accessActive = grantRows.filter((r) => r.active !== false);
  const accessExpired = grantRows.filter((r) => r.active === false);
  const hasShareable = accessActive.some((r) => r.active === true) && Boolean(identity?.accessor);

  // A verification link for a grant: the public /verify/bond page live-reads is_granted from the gate. It
  // carries the anonymous handle id + the public requirement, never the wallet.
  const shareLink = (rec: BondGrantRecord): string => {
    const u = new URL("/verify/bond", window.location.origin);
    u.searchParams.set("accessor", identity?.accessor ?? "");
    u.searchParams.set("req", rec.reqId);
    if (rec.tokenSymbol) u.searchParams.set("symbol", rec.tokenSymbol);
    u.searchParams.set("amount", rec.minAmount);
    u.searchParams.set("decimals", String(rec.decimals));
    u.searchParams.set("deadline", String(rec.deadline));
    return u.toString();
  };
  const shareGrant = async (rec: BondGrantRecord) => {
    try {
      await navigator.clipboard.writeText(shareLink(rec));
      setCopiedReq(rec.reqId);
      setTimeout(() => {
        if (alive.current) setCopiedReq((c) => (c === rec.reqId ? null : c));
      }, 1500);
    } catch {
      /* clipboard blocked; nothing to do */
    }
  };

  const renderAccessRow = ({ rec, active }: { rec: BondGrantRecord; active: boolean | null }) => {
    const isLoaded = !!reqId && rec.reqId === reqId.toLowerCase();
    return (
      <div
        key={rec.reqId}
        data-testid="tier-access-row"
        className={cn(
          "flex items-center justify-between gap-4 border-b border-border/70 py-2.5 last:border-0",
          isLoaded && "-mx-2 rounded-md bg-brand/5 px-2",
        )}
      >
        <span className="text-[13px]">
          <span className="font-medium tabular-nums">{fmtAmount(rec.minAmount, rec.decimals)}</span> {rec.tokenSymbol}
          {isLoaded && <span className="ml-2 text-[11px] text-brand">loaded</span>}
        </span>
        <span className="flex items-center gap-2 text-[12px]">
          {active === null ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> checking
            </span>
          ) : active ? (
            <span className="text-success">active until {fmtShortDate(rec.deadline)}</span>
          ) : Math.floor(Date.now() / 1000) >= rec.deadline ? (
            <span className="text-muted-foreground">expired {fmtShortDate(rec.deadline)}</span>
          ) : (
            // is_granted is false but the deadline has not passed: the chain has no live grant for it.
            <span className="text-muted-foreground">not active</span>
          )}
          {active === true && identity?.accessor && (
            copiedReq === rec.reqId ? (
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
            )
          )}
        </span>
      </div>
    );
  };

  // A bond the wallet holds that satisfies the CURRENT requirement AND is tagged with the current handle, so
  // it is provable now. This mirrors the prover's qualifying check (token + amount >= min + unlock >= deadline
  // + non-revocable + still locked + commitment == this handle's qual tag), so we only claim "already held"
  // when proving would actually succeed. `unlock_time > now` is checked live (not via the cached is_locked
  // snapshot) so the claim never outlives the lock; `!expired` is required because the gate rejects a past
  // requirement deadline, so a provable claim would be false once it passes.
  const nowUnix = Math.floor(Date.now() / 1000);
  const myQualBond =
    identity && selected && minAmountBase && !expired
      ? b.locks.find(
          (l) =>
            !l.released &&
            l.unlock_time > nowUnix &&
            !l.revocable &&
            l.token === selected.contractId &&
            safeBig(l.amount) >= safeBig(minAmountBase) &&
            l.unlock_time >= deadlineUnix &&
            normCommit(l.commitment) === normCommit(identity.qualCommitment),
        )
      : undefined;

  const openDeadlinePicker = () => {
    const el = deadlineRef.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };

  // The wallet signature that keys the handle vault (one prompt per session, cached, never persisted).
  const getBondSig = useCallback(async (): Promise<Uint8Array> => {
    const addr = b.address;
    if (!addr) throw new Error("Connect your wallet first.");
    let sig = bondSigCache.get(addr);
    if (!sig) {
      sig = await signMessage(BOND_HANDLE_VAULT_MESSAGE);
      bondSigCache.set(addr, sig);
    }
    return sig;
  }, [b.address, signMessage]);

  // Back up the "Your access" list to its own wallet vault (encrypted, opaque), so the list follows the wallet.
  // Best-effort and silent (rides the cached handle signature, so it never prompts on its own).
  const backupGrants = useCallback(async (accessorOverride?: string) => {
    const acc = accessorOverride ?? identity?.accessor;
    if (!b.connected || !acc) return;
    setAccessSync("syncing");
    try {
      const sig = await getBondSig();
      const blob = await encryptBondGrants(sig, readBondGrants(acc));
      await putBondGrantsVault(await deriveBondGrantsVaultId(sig), blob);
      if (alive.current) setAccessSync("synced");
    } catch {
      if (alive.current) setAccessSync("error");
    }
  }, [b.connected, identity?.accessor, getBondSig]);

  // Pull the access list saved by THIS wallet and merge it into the local records under `accessor` (the records
  // belong to that handle). Takes the signature + accessor explicitly so it can run during a handle restore,
  // before the identity state has updated. The accessor-change effect then refreshes the live view.
  const restoreGrants = useCallback(async (sig: Uint8Array, accessor: string) => {
    setAccessSync("syncing");
    try {
      const res = await getBondGrantsVault(await deriveBondGrantsVaultId(sig));
      if (res.found && res.blob) {
        const recs = await decryptBondGrants(sig, res.blob);
        for (const r of recs) recordBondGrant(accessor, r);
      }
      if (alive.current) setAccessSync("synced");
    } catch {
      if (alive.current) setAccessSync("error");
    }
  }, []);

  // Encrypt the handle under the wallet signature and store the opaque blob in the vault, so it follows the
  // wallet to other devices. Non-fatal: a decline or error leaves the local handle usable; the user can retry.
  const backupHandle = useCallback(async (h: BondHandle) => {
    if (!alive.current) return;
    setSync("syncing");
    setSyncMsg("");
    try {
      const sig = await getBondSig();
      const blob = await encryptBondHandle(sig, h);
      await putBondHandleVault(await deriveBondHandleVaultId(sig), blob);
      if (alive.current) setSync("synced");
    } catch (e) {
      if (alive.current) {
        setSync("error");
        setSyncMsg((e as Error)?.message ?? "could not back up the handle");
      }
    }
  }, [getBondSig]);

  // Restore a handle saved by THIS wallet on another device: sign, derive the vault id, pull + decrypt.
  // `userInitiated` is false for the silent auto-restore, so a returning user is not shown an unsolicited hint.
  const restoreHandle = useCallback(async (userInitiated = true) => {
    setSync("syncing");
    setSyncMsg("");
    try {
      const sig = await getBondSig();
      const res = await getBondHandleVault(await deriveBondHandleVaultId(sig));
      if (!res.found || !res.blob) {
        if (alive.current) {
          setSync("idle");
          if (userInitiated) setSyncMsg("No saved handle for this wallet yet. Use Create a handle to make one.");
        }
        return;
      }
      const h = await decryptBondHandle(sig, res.blob);
      localStorage.setItem(idKey(b.address), JSON.stringify(h));
      // Pull the access list for this handle too, so it lands before the accessor-change refresh runs.
      await restoreGrants(sig, h.accessor);
      if (alive.current) {
        setIdentity(h);
        setSync("synced");
      }
    } catch (e) {
      if (alive.current) {
        setSync("error");
        setSyncMsg((e as Error)?.message ?? "could not restore the handle");
      }
    }
  }, [getBondSig, b.address, restoreGrants]);

  // No local handle but the wallet already signed this session: restore silently (no extra prompt, no hint).
  useEffect(() => {
    if (!b.connected || identity || !b.address || !bondSigCache.has(b.address)) return;
    void restoreHandle(false);
  }, [b.connected, b.address, identity, restoreHandle]);

  const createIdentity = async () => {
    setPhase("idle");
    setMsg("");
    setSync("idle");
    setSyncMsg("");
    try {
      const r = await enrollBond();
      if (!r.minted) throw new Error("enroll did not return an identity");
      localStorage.setItem(idKey(b.address), JSON.stringify(r.minted));
      setIdentity(r.minted);
      // Back it up to the wallet so it follows you to other devices (one signature). Best-effort.
      if (b.connected) {
        void backupHandle(r.minted);
        // Overwrite the access-list vault for the NEW handle (empty here), so a re-minted handle never
        // inherits a previous handle's stale records when restored on another device.
        void backupGrants(r.minted.accessor);
      }
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
    // Capture the requirement being proven (the user may edit the form while proving runs).
    const provedDeadlineAt = deadlineAt;
    const provedToken = selected;
    const provedMin = minAmountBase;
    const provedDeadline = deadlineUnix;
    const provedAccessor = identity.accessor;
    try {
      const { jobId, error, reqId: provedReqId } = await proveBond({
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
      // Record the grant locally (the chain stores no token / amount label) so it shows in "Your access".
      if (provedReqId) {
        recordBondGrant(provedAccessor, {
          reqId: provedReqId,
          tokenSymbol: provedToken.symbol,
          minAmount: provedMin,
          decimals: provedToken.decimals,
          deadline: provedDeadline,
        });
      }
      await refreshStatus();
      void refreshGrants();
      void backupGrants(); // push the updated list to the wallet vault (best-effort)
    } catch (e) {
      if (!alive.current) return;
      setPhase("error");
      setMsg((e as Error)?.message ?? "something went wrong");
    }
  };

  const tokenSym = selected?.symbol ?? "token";
  const selectCls =
    "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  // The anonymous-handle panel. It LEADS the page while no handle exists (creating it is the first action),
  // and moves to the bottom as a reference once it exists, so the requirement + proving take focus. Rendered
  // in one of two slots below, guarded by hasIdentity.
  const handlePanel = (
    <Panel title={hasIdentity ? "Your anonymous handle" : "Create an anonymous handle"}>
      {hasIdentity ? (
        <div className="grid gap-0.5" data-testid="tier-identity">
          <DataRow k="Your handle">
            <span className="font-mono text-[12px]">{short(identity!.accessor, 6)}</span>
          </DataRow>
          <DataRow k="Bond tag">
            <span className="font-mono text-[12px]">{short(identity!.qualCommitment, 6)}</span>
          </DataRow>
          {/* Backup status: the handle is encrypted under your wallet and stored as an opaque blob, so it
              follows your wallet to other devices. */}
          <div className="flex flex-wrap items-center gap-3 pt-2" data-testid="tier-sync">
            {sync === "synced" ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-success">
                <ShieldCheck className="size-3.5" /> Backed up to your wallet
              </span>
            ) : sync === "syncing" ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Backing up…
              </span>
            ) : b.connected ? (
              <button type="button" onClick={() => identity && void backupHandle(identity)} className="text-[12px] text-brand hover:underline" data-testid="tier-backup">
                Back up to your wallet
              </button>
            ) : (
              <span className="text-[12px] text-muted-foreground">Connect your wallet to back this handle up.</span>
            )}
            <button type="button" onClick={() => void createIdentity()} className="text-[12px] text-brand hover:underline" data-testid="tier-regen-identity">
              Regenerate handle
            </button>
          </div>
          {sync === "error" && syncMsg && <p className="text-[12px] text-destructive" data-testid="tier-sync-msg">{syncMsg}</p>}
          <p className="pt-2 text-[12px] text-muted-foreground">
            Your handle's secret stays in your browser. When you back it up, it is encrypted under your
            wallet and stored as an opaque blob, so only your wallet can restore it on another device.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3 py-1">
          <p className="text-[13px] text-muted-foreground">
            Make an anonymous handle, or restore the one this wallet already saved. It is not tied to your
            wallet address, so the grant it earns cannot be traced to you.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="brand" onClick={() => void createIdentity()} data-testid="tier-create-identity">
              <UserPlus className="size-4" /> Create a handle
            </Button>
            {b.connected && (
              <Button variant="outline" onClick={() => void restoreHandle()} disabled={sync === "syncing"} data-testid="tier-restore">
                {sync === "syncing" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Restore from your wallet
              </Button>
            )}
          </div>
          {syncMsg && <p className={cn("text-[12px]", sync === "error" ? "text-destructive" : "text-muted-foreground")} data-testid="tier-sync-msg">{syncMsg}</p>}
        </div>
      )}
    </Panel>
  );

  return (
    <div className="grid gap-4" data-testid="bonded-tier">
      <Panel title="Bonded Access">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Prove you hold a qualifying bond without showing which wallet locked it or how much. Pick a
          requirement, lock the bond, then prove it once your anonymity set is large enough.
        </p>
      </Panel>

      {/* The handle leads while it is not made yet; once it exists it moves to the bottom (rendered below). */}
      {!hasIdentity && handlePanel}

      {/* The requirement (token, amount, deadline) plus locking a qualifying bond, in one panel. */}
      <Panel title="Pick a requirement and lock your bond">
        {!b.connected ? (
          <div className="flex flex-col items-start gap-3 py-1">
            <p className="text-[13px] text-muted-foreground">Connect your wallet on testnet to pick a token to bond.</p>
            <Button variant="brand" onClick={() => void b.connect()} data-testid="tier-connect">
              <Wallet className="size-4" /> Connect wallet
            </Button>
          </div>
        ) : (
          <div className="grid gap-4">
            {/* Optional shortcut: a tinted sub-card, set a step below the panel surface so it reads as
                supplementary, not a required input. Picking a held bond fills the inputs below. */}
            {myBonds.length > 0 && (
              <div className="rounded-lg border border-border bg-muted/40 p-3" data-testid="tier-mybonds">
                <div className="mb-1 flex items-center gap-1.5">
                  <Wallet className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="text-[12px] font-medium text-foreground">Use a bond you already hold</span>
                  <span className="text-[12px] text-muted-foreground">(optional)</span>
                </div>
                <p className="mb-2 text-[12px] text-muted-foreground">
                  Load one of your locked bonds to fill in the token, amount, and deadline below.
                </p>
                <select
                  value={loadedBondId}
                  onChange={(e) => {
                    const l = myBonds.find((x) => String(x.id) === e.target.value);
                    if (l) loadBond(l);
                  }}
                  className={selectCls}
                  data-testid="tier-mybonds-select"
                  aria-label="Use a bond you already hold"
                >
                  <option value="">Load a locked bond…</option>
                  {myBonds.map((l) => (
                    <option key={l.id} value={String(l.id)}>
                      {`${fmtAmount(l.amount, l.tokenDecimals || 7)} ${bondSymbol(l)} · until ${fmtShortDate(l.unlock_time)}`}
                    </option>
                  ))}
                </select>
              </div>
            )}
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

            {/* Lock it: the action moved here from the old separate panel (it was only a button). */}
            <div className="mt-1 flex items-center gap-3">
              <span className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Lock it</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            {myQualBond ? (
              <div className="flex flex-col items-start gap-3 py-1" data-testid="tier-bond-have">
                <p className="text-[13px] text-success">
                  You already hold a qualifying bond for this requirement (escrow lock #{myQualBond.id},{" "}
                  {fmtAmount(myQualBond.amount, myQualBond.tokenDecimals || 7)} {bondSymbol(myQualBond)} until{" "}
                  {fmtShortDate(myQualBond.unlock_time)}). You do not need to lock another to prove.
                </p>
                <p className="text-[13px] text-muted-foreground">
                  Locking another adds one more bond to the set.
                </p>
                <Button
                  variant="outline"
                  disabled={!reqValid || expired || b.busy === "deposit"}
                  onClick={() => void bondQualifying()}
                  data-testid="tier-bond-again"
                >
                  {b.busy === "deposit" ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
                  Lock another {amount} {tokenSym}
                </Button>
                <Link to="/app/bonded/balances" className="text-[12px] text-brand hover:underline">
                  See it in My Balances
                </Link>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-3 py-1">
                <p className="text-[13px] text-muted-foreground">
                  Lock {amount} {tokenSym} until {fmtDeadline(deadlineAt)}, tagged with your handle. The lock
                  itself is public. The privacy comes at the proving step, where you prove without pointing at
                  this lock.
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
          </div>
        )}
      </Panel>

      {/* The anonymity set: the count, and the honest warning. */}
      {/* Prove anonymously. The anonymity-set state is folded in here, because the set gates this button. */}
      <Panel
        title="Prove access"
        aside={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refreshQual();
              void refreshStatus();
            }}
            data-testid="tier-anonset-refresh"
          >
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

        <span className="mt-3 block h-px w-full bg-border" />

        <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="tier-badge" data-state={granted ? "active" : status?.grant ? "expired" : "none"}>
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
            disabled={!hasIdentity || !reqValid || !info?.standaloneSetId || busyFlow || belowMin || expired || granted}
            onClick={() => void prove()}
            data-testid="tier-prove"
          >
            {busyFlow ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            {granted ? "You already have access" : "Prove access"}
          </Button>
          {busyFlow && (
            <div className="mt-2 grid gap-1" data-testid="tier-prove-async">
              <p className="text-[12px] text-muted-foreground">
                Proving runs on the self-hosted prover. This takes a few seconds on the GPU, or a few minutes on
                the fallback. You do not need to wait here. The result appears on its own when it is ready.
              </p>
              <p className="inline-flex items-start gap-1.5 text-[12px] text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                Keep this tab open until it finishes. The check runs in this tab, so leaving the page stops a
                proof that is still in progress.
              </p>
            </div>
          )}
          {granted && !busyFlow && (
            <p className="mt-2 text-[12px] text-muted-foreground" data-testid="tier-granted-help">
              This handle already has access for this requirement, valid until {fmtDeadline(deadlineAt)}. Each
              requirement can be proven once per handle.
            </p>
          )}
          {belowMin && hasIdentity && !expired && !granted && !busyFlow && (
            <p className="mt-2 text-[12px] text-muted-foreground">Proving stays locked until the set reaches {minSet}.</p>
          )}
        </div>
      </Panel>

      {/* The handle's active grants. The list is recorded locally per accessor and live-checked on-chain. */}
      {hasIdentity && (
        <Panel
          title="Your access"
          aside={
            <Button variant="outline" size="sm" onClick={() => void refreshGrants()} data-testid="tier-access-refresh">
              <RefreshCw className="size-4" /> Refresh
            </Button>
          }
        >
          <div data-testid="tier-access">
            {grantRows.length === 0 ? (
              <p className="text-[13px] text-muted-foreground" data-testid="tier-access-empty">
                No access yet for this handle. Prove a requirement above, and the grant it earns shows up here.
              </p>
            ) : (
              <div className="grid gap-0.5">
                {accessActive.map(renderAccessRow)}
                {accessExpired.length > 0 && (
                  <div className="mt-2 flex items-center gap-3 pt-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Inactive</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                {accessExpired.map(renderAccessRow)}
              </div>
            )}
            <div className="grid gap-1.5 pt-3">
              <p className="text-[12px] text-muted-foreground">
                The token and amount come from this browser's record of what you proved. The on-chain grant
                stores only the requirement hash and the deadline, so it cannot label itself.
              </p>
              {hasShareable && (
                <p className="text-[12px] text-muted-foreground" data-testid="tier-access-share-note">
                  A share link carries your anonymous handle id and the requirement, never your wallet.
                </p>
              )}
              {accessSync === "synced" ? (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-success" data-testid="tier-access-sync">
                  <ShieldCheck className="size-3.5" /> This list is encrypted under your wallet, so it follows you to other devices.
                </span>
              ) : accessSync === "syncing" ? (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground" data-testid="tier-access-sync">
                  <Loader2 className="size-3.5 animate-spin" /> Saving this list to your wallet…
                </span>
              ) : (
                <span className="text-[12px] text-muted-foreground" data-testid="tier-access-sync">
                  Once your wallet backs up your handle, this list rides along to your other devices.
                </span>
              )}
            </div>
          </div>
        </Panel>
      )}

      {/* Once the handle exists it lives here, at the bottom, as a reference. */}
      {hasIdentity && handlePanel}

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
