import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, CheckCircle2, Clock, FileText, FolderOpen, Info, KeyRound, Loader2, Lock, RefreshCw, ShieldCheck } from "lucide-react";
import { useSharedOpen, type SyncState } from "@/lib/hooks/useSharedOpen";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Verdict } from "@/components/app/blocks";
import { DecryptedFile } from "@/components/app/DecryptedFile";
import { AnonymityMeter, ANON_FLOOR } from "@/components/app/dataroom/AnonymityMeter";
import { BondCount, BOND_FLOOR, Callout, CopyIconButton, SectionLabel } from "@/components/app/dataroom/kit";
import { BondRequirementDetail } from "@/components/app/dataroom/BondRequirementDetail";
import { plainAmount } from "@/lib/bonded/tokens";
import { fmtAmount, toBaseUnits } from "@/lib/api";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";

// A bonded requirement's deadline (unix seconds) as a local date-time string.
function fmtDeadline(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}

const MEMBERSHIP_LINK = "/app/dataroom/membership";

// One helper line per sync state, so the description text changes by state but the box stays a stable height.
const SYNC_HELP: Record<SyncState, string> = {
  off: "Encrypted with your wallet, so your rooms follow you to other devices. The server cannot read it.",
  locked: "Sync is on for this account. Sign in once on this device to load your rooms.",
  syncing: "Signing in and syncing your rooms.",
  synced: "Your rooms are synced and encrypted with your wallet.",
  error: "Could not sync your rooms. Your wallet stays the only key.",
};

// The status of the in-progress Open for one document. Each branch is plain and short; "approved" reads as a
// positive next step, not a denial.
function OpenStatus({ s }: { s: ReturnType<typeof useSharedOpen> }) {
  const retry = () => s.openDocId && s.open(s.openDocId);
  const time = s.flushAt ? new Date(s.flushAt).toLocaleTimeString() : null;

  switch (s.phase) {
    case "checking":
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="access-status-checking">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Checking your access…
        </p>
      );
    case "not-member":
      return (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">You are not on this room's list yet.</p>
          <Link to={MEMBERSHIP_LINK} className={cn(buttonVariants({ size: "sm", variant: "outline" }))} data-testid="access-go-membership">
            Request to join
          </Link>
        </div>
      );
    case "pending":
      return (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Your request to join is waiting for the owner. Check back after they approve it.</p>
          <Button size="sm" variant="outline" onClick={retry} data-testid="access-check-again">Check again</Button>
        </div>
      );
    case "approved":
      return (
        <div className="space-y-2" data-testid="access-approved">
          <p className="text-sm text-foreground">
            You're approved. Set up access once (about a few minutes), then every document in this room opens
            right away.
          </p>
          <p className="text-xs text-muted-foreground">
            This runs a one-time access proof on our self-hosted prover, then records your access on-chain in a
            shuffled batch so the room cannot tell when you acted.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={s.setupAccess} data-testid="access-setup-btn">Set up access</Button>
            <Button size="sm" variant="ghost" onClick={s.dismiss} data-testid="access-dismiss">Not now</Button>
          </div>
        </div>
      );
    case "below-floor":
      return (
        <div className="space-y-2" data-testid="access-below-floor">
          <AnonymityMeter count={s.anonCount} />
          <p className="text-sm text-muted-foreground">
            This room is too small to open privately yet. It needs {ANON_FLOOR} members{s.anonCount !== null ? ` and has ${s.anonCount}` : ""}.
          </p>
          <Button size="sm" variant="outline" onClick={retry} data-testid="access-check-again">Check again</Button>
        </div>
      );
    case "bond-detecting":
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="access-bond-detecting">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Checking this room's bond requirement…
        </p>
      );
    case "bond-not-member":
      return (
        <div className="space-y-2" data-testid="access-bond-not-member">
          <p className="text-sm text-muted-foreground">
            This room needs a bond and you are not on its list yet. Ask to join first, then lock a bond.
          </p>
          <Link to={MEMBERSHIP_LINK} className={cn(buttonVariants({ size: "sm", variant: "outline" }))} data-testid="access-go-membership">
            Request to join
          </Link>
        </div>
      );
    case "bond-deposit":
      return <BondDeposit s={s} />;
    case "bond-below-floor":
      return (
        <div className="space-y-2" data-testid="access-bond-below-floor">
          <BondCount count={s.bondCount} />
          <p className="text-sm text-muted-foreground">
            You have a qualifying bond. The room needs at least {BOND_FLOOR} qualifying bonders before a proof
            is allowed, so no one can be singled out. It has {s.bondCount ?? 0} right now.
          </p>
          <Button size="sm" variant="outline" onClick={() => void s.refreshBond()} data-testid="access-check-again">Check again</Button>
        </div>
      );
    case "bond-ready":
      return (
        <div className="space-y-2" data-testid="access-bond-ready">
          <BondCount count={s.bondCount} />
          <p className="text-sm text-foreground">
            You qualify. Prove access once (about a few minutes), then every document in this room opens right away.
          </p>
          <p className="text-xs text-muted-foreground">
            This runs a one-time setup on our self-hosted prover that proves you hold a qualifying bond and are
            on the room's list, without revealing which bond or which member.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={s.setupBondAccess} data-testid="access-bond-prove">Prove access</Button>
            <Button size="sm" variant="ghost" onClick={s.dismiss} data-testid="access-dismiss">Not now</Button>
          </div>
        </div>
      );
    case "proving":
    case "queuing":
      return (
        <div className="space-y-1" data-testid="access-proving">
          <p className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Setting up your access. This runs once and can take a few minutes.
          </p>
          {s.proveStep && (
            <p className="text-xs text-muted-foreground">
              {s.proveStep}{s.proveBy ? ` (proving on: ${s.proveBy})` : ""}
            </p>
          )}
        </div>
      );
    case "waiting":
      return (
        <div className="space-y-1" data-testid="access-waiting">
          <p className="flex items-center gap-2 text-sm text-foreground">
            <Clock className="size-4" aria-hidden="true" /> Almost there. Your access goes live at the next batch window{time ? `, around ${time}` : ""}.
          </p>
          <p className="text-xs text-muted-foreground">You can leave this page and come back; it keeps going and opens the document once your access lands.</p>
        </div>
      );
    case "opening":
      return (
        <p className="flex items-center gap-2 text-sm text-foreground" data-testid="access-opening">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Getting the key and decrypting in your browser…
        </p>
      );
    case "opened":
      return (
        <div className="space-y-2" data-testid="access-opened">
          <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-500">
            <CheckCircle2 className="size-4" aria-hidden="true" /> Open.
          </p>
          {s.opened?.reconstructed ? (
            <div data-testid="access-plaintext">
              <DecryptedFile plaintext={s.opened.plaintext} plaintextUtf8={s.opened.plaintextUtf8} />
            </div>
          ) : (
            <Verdict ok={false}>The key could not be rebuilt from the released parts.</Verdict>
          )}
        </div>
      );
    case "revoked":
      return (
        <div className="space-y-2">
          <Verdict ok={false}>Your access to this room was removed.</Verdict>
          <Link to={MEMBERSHIP_LINK} className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>Request to join</Link>
        </div>
      );
    case "error":
      return (
        <div className="space-y-2" data-testid="access-error">
          <p className="text-sm text-destructive">That didn't work. {s.flowErr}</p>
          <Button size="sm" variant="outline" onClick={retry} data-testid="access-retry">Try again</Button>
        </div>
      );
    default:
      return null;
  }
}

export default function OpenShared() {
  const s = useSharedOpen();
  const [openTab, setOpenTab] = useState<"rooms" | "search">("rooms");

  // Deep link from "Open documents" (Membership / Discover): /app/dataroom/documents?room=<id>#open selects it.
  const [params] = useSearchParams();
  const paramRoom = params.get("room");
  useEffect(() => {
    if (paramRoom) s.selectRoom(paramRoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramRoom]);

  if (!s.connected) {
    return (
      <Card className="rounded-2xl border-brand/40 p-6" data-testid="access-connect-prompt">
        <h2 className="text-base font-semibold tracking-tight">Open a document</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Connect your wallet to open a document from a room you have access to. Your room identity is derived
          from your wallet in this browser, so the room never learns who you are.
        </p>
        <div className="mt-4">
          <Button onClick={s.connect} data-testid="access-connect-btn">Connect wallet</Button>
        </div>
      </Card>
    );
  }

  // The selected room's display name (directory name for a listed room, else your local label, else the id) and
  // whether it is a bond-only room (drives the bond-aware panel below).
  const roomMeta = s.room ? s.directory[s.room.toLowerCase()] : undefined;
  const roomName =
    roomMeta?.name ||
    s.openableRooms.find((r) => r.roomId.toLowerCase() === s.room.toLowerCase())?.label ||
    (s.room ? short(s.room, 8) : "");
  const isBondRoom = Boolean(s.roomBond && s.roomBond.token && s.roomBond.minAmount && s.roomBond.deadline);
  // A past deadline can never be satisfied (a qualifying lock needs unlock_time >= deadline AND now < unlock),
  // so a new reader cannot get in; surface it on the panel instead of only after they try.
  const bondDeadlinePassed = isBondRoom && (s.roomBond?.deadline ?? 0) * 1000 <= Date.now();

  return (
    <div data-testid="access-card" className="space-y-5">
      <Card className="rounded-2xl border-brand/40 p-6">
        <h2 className="text-base font-semibold tracking-tight">Open a document</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Open files from rooms you have access to. The file is decrypted in your browser.
        </p>
      </Card>

      {/* Two ways in: the rooms you are already approved for, or a room id someone shared. Both open inline below.
          A LIGHT segmented control (muted track, raised active) so it reads below the filled-pill Documents submenu. */}
      <div className="inline-flex w-fit gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label="Open">
        {([
          { key: "rooms", label: "Rooms you can open" },
          { key: "search", label: "Search room by ID" },
        ] as const).map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={openTab === t.key}
            onClick={() => setOpenTab(t.key)}
            data-testid={`access-subtab-${t.key}`}
            className={cn(
              "whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-muted",
              openTab === t.key
                ? "border border-border bg-card text-foreground shadow-sm"
                : "border border-transparent text-muted-foreground hover:bg-card/40 hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ROOMS YOU CAN OPEN: the wallet's approved rooms (this browser's history, kept current by sync/Refresh). */}
      {openTab === "rooms" && (
        <Card className="rounded-2xl p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold tracking-tight">Rooms you can open</h3>
            <Button variant="outline" size="sm" onClick={s.refreshRooms} disabled={s.refreshing} data-testid="access-refresh">
              <RefreshCw className={cn("size-3.5", s.refreshing && "animate-spin")} aria-hidden="true" />
              {s.refreshing ? "Checking…" : "Refresh"}
            </Button>
          </div>
          {s.openableRooms.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted-foreground" data-testid="access-rooms-empty">
              No approved rooms yet. After an owner approves your request, press Refresh and it appears here. You
              can <Link to={MEMBERSHIP_LINK} className="text-brand hover:underline">request to join in Membership</Link>,
              or look one up under Search room by ID.
            </p>
          ) : (
            <div className="space-y-2" data-testid="access-rooms">
              {s.openableRooms.map((r) => {
                const meta = s.directory[r.roomId.toLowerCase()];
                const name = meta?.name || r.label || short(r.roomId, 8);
                const active = s.room === r.roomId;
                return (
                  <button
                    key={r.roomId}
                    onClick={() => s.selectRoom(r.roomId)}
                    data-testid="access-room-row"
                    aria-pressed={active}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-xl border p-3 text-left transition-colors hover:border-brand/30 hover:bg-accent/40",
                      active && "border-brand/40 bg-accent/40",
                    )}
                  >
                    <div className="text-[13px] font-medium">{name}</div>
                    {meta?.description && (
                      <div className="text-xs leading-relaxed text-muted-foreground">{meta.description}</div>
                    )}
                    <div className="font-mono text-[11px] text-muted-foreground">{short(r.roomId, 8)}</div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Sync across devices: an opt-in toggle. Turning it on signs once and pulls your rooms; while it is
              off the switch carries a gentle attention pulse. The helper block keeps a stable height across all
              states, and a returning device shows a prominent "Sign in to turn on sync" action. */}
          <div className="mt-4 border-t pt-3">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 text-[13px] font-medium">
                <SyncToggle checked={s.syncOn} onChange={s.setSync} />
                Sync across devices
                {s.syncState === "syncing" && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />}
                {s.syncState === "synced" && (
                  <span className="inline-flex items-center gap-1 text-xs font-normal text-emerald-600 dark:text-emerald-400" data-testid="access-sync-state">
                    <CheckCircle2 className="size-3.5" aria-hidden="true" /> Synced
                  </span>
                )}
              </span>
              {s.syncOn && s.syncState === "locked" && (
                <Button
                  onClick={s.unlockSync}
                  data-testid="access-sync-unlock"
                  className="h-8 gap-1.5 bg-brand font-medium text-brand-foreground shadow-sm hover:bg-brand/90 focus-visible:ring-brand"
                >
                  Sign in to turn on sync <ArrowRight className="size-3.5" aria-hidden="true" />
                </Button>
              )}
              {s.syncState === "error" && (
                <Button variant="outline" size="sm" onClick={s.unlockSync} data-testid="access-sync-retry">Retry</Button>
              )}
            </div>
            {/* min-h reserves two helper lines so the box keeps a steady height across off/locked/syncing/
                synced (the longest line wraps to two on a narrow card); the message only renders on
                error/info, a distinct state where a little growth is fine. */}
            <div className="mt-1.5 min-h-[2.75rem] text-xs leading-relaxed text-muted-foreground">
              <p>{SYNC_HELP[s.syncState]}</p>
              {s.syncMsg && (
                <p className="mt-0.5 text-[11px]" data-testid="access-sync-msg">{s.syncMsg}</p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* SEARCH ROOM BY ID: look up any room and open it right here (no reroute). */}
      {openTab === "search" && (
        <Card className="rounded-2xl p-6">
          <h3 className="text-base font-semibold tracking-tight">Search room by ID</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Have a room id someone shared? Open it here. If you are not on its list, you'll be pointed to request
            to join.
          </p>
          <ManualOpen onSubmit={s.selectRoom} />
        </Card>
      )}

      {/* The selected room. For a bond-only room this names it + shows its Bonded Access requirement and a
          room-level set-up action; for a membership room it is the document list with per-document Open. */}
      {s.room && (
        <Card className={cn("rounded-2xl p-6", isBondRoom && "border-success/40")} data-testid="access-room-detail" data-bonded={isBondRoom ? "true" : "false"}>
          {/* Header: the room NAME (so it is never mistaken for one of your already-accessible rooms) + a
              Bonded Access badge for a bond-only room, then the room id. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SectionLabel className="flex-1">
              <span className="inline-flex items-center gap-1.5">
                {isBondRoom ? <KeyRound className="size-4 text-success" aria-hidden="true" /> : <FolderOpen className="size-4" aria-hidden="true" />}
                <span data-testid="access-room-name">{isBondRoom ? `Bonded Access · ${roomName}` : roomName}</span>
              </span>
            </SectionLabel>
            <code className="font-mono text-xs text-muted-foreground" title={s.room}>{short(s.room, 8)}</code>
            <CopyIconButton value={s.room} label="room id" />
          </div>

          {/* Bond-only room: the access panel. The requirement is shown in detail (standout), the live set
              count gates proving, and ONE room-level action runs lock -> wait -> prove -> open. */}
          {isBondRoom && s.roomBond?.token && s.roomBond.minAmount && s.roomBond.deadline && (
            <div className="mb-5 space-y-3" data-testid="access-bond-panel">
              <p className="text-sm leading-relaxed text-muted-foreground">
                This room uses Bonded Access. Lock a qualifying bond to open its documents. No approval, no
                membership, and the owner never learns which bond opened a file.
              </p>
              <div className="rounded-xl border border-success/30 bg-success/5 p-4">
                <BondRequirementDetail
                  token={s.roomBond.token}
                  minAmount={s.roomBond.minAmount}
                  deadline={s.roomBond.deadline}
                  meta={s.roomBondMeta}
                  metaLoading={s.roomBondMetaLoading}
                  idPrefix="access-bond-req"
                />
              </div>
              {s.phase === "idle" ? (
                <div className="space-y-2.5">
                  <BondCount count={s.roomBondCount} />
                  {bondDeadlinePassed && (
                    <p className="text-sm text-warning" data-testid="access-bond-expired">
                      This room's bond deadline has passed, so a new qualifying bond can no longer be locked. Ask
                      the room owner to update the requirement.
                    </p>
                  )}
                  <Button onClick={s.setupRoomAccess} disabled={s.roomDocs.length === 0 || bondDeadlinePassed} data-testid="access-bond-setup">
                    <KeyRound aria-hidden="true" /> Set up access
                  </Button>
                </div>
              ) : (
                <div className="rounded-xl border border-border/70 bg-accent/20 px-3.5 py-3" data-testid="access-status" data-phase={s.phase}>
                  <OpenStatus s={s} />
                </div>
              )}
            </div>
          )}

          {s.docsLoading && s.roomDocs.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="access-docs-loading">Loading documents…</p>
          ) : s.roomDocs.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="access-no-docs">This room has no documents yet.</p>
          ) : (
            <>
              {isBondRoom && (
                <SectionLabel className="mb-2">
                  <span className="inline-flex items-center gap-1.5">
                    <FolderOpen className="size-4" aria-hidden="true" />
                    Documents in this room
                  </span>
                </SectionLabel>
              )}
              <div className="divide-y divide-border/70 rounded-xl border" data-testid="access-doc-list">
                {s.roomDocs.map((d) => {
                  const active = s.openDocId === d.doc_id;
                  return (
                    <div key={d.doc_id} data-testid="access-doc-row">
                      <div className="flex items-center gap-3 px-3 py-2.5">
                        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-xs">{short(d.doc_id, 8)}</div>
                          <div className="truncate text-[11px] text-muted-foreground">fingerprint {short(d.content_hash, 6)}</div>
                        </div>
                        <Button size="sm" onClick={() => s.open(d.doc_id)} data-testid="access-open" disabled={active && s.phase !== "idle" && s.phase !== "opened" && s.phase !== "error"}>
                          {active && s.phase === "opened" ? "Opened" : "Open"}
                        </Button>
                      </div>
                      {/* For a bond-only room the live status shows at the room level above (one place for the
                          flow); for a membership / legacy room it shows inline under the document. */}
                      {!isBondRoom && active && s.phase !== "idle" && (
                        <div className="border-t border-border/70 bg-accent/20 px-3 py-3" data-testid="access-status" data-phase={s.phase}>
                          <OpenStatus s={s} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Card>
      )}

      {/* How this stays private: one compact, plain-language note (bond-aware: a bonded room admits by a bond,
          not by approved membership). */}
      <Callout icon={ShieldCheck} testId="access-privacy">
        {isBondRoom
          ? "Anyone who locks a qualifying bond can open this room's files, with no approval, and the owner never learns which bond opened one. The key is split across the keepers and reassembled in your browser."
          : "Only members the owner approved can open these files, and the owner never learns which member opened one. The key is split across the keepers and reassembled in your browser."}
      </Callout>

      {s.drift && (
        <p className="text-sm text-amber-600 dark:text-amber-500" data-testid="access-drift">
          Your wallet produced a different identity than before. If you enrolled earlier with a different wallet
          or signing format, access tied to the old identity may not match.
        </p>
      )}
    </div>
  );
}

// A small on/off capsule for the cross-device sync setting.
function SyncToggle({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Sync across devices"
      onClick={() => onChange(!checked)}
      data-testid="access-sync-toggle"
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked
          ? "bg-brand"
          : "bg-muted-foreground/40 animate-sync-attn hover:animate-none focus-visible:animate-none",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

// The inline "deposit a qualifying bond" step (BA5). Shown when the reader is an approved member of a bonded
// room but has no qualifying lock yet. Locks a NON-revocable self-bond of the required token (>= the minimum,
// until the deadline) with the access commitment set, then re-resolves the bond phase. Local amount state so
// typing doesn't churn the hook.
function BondDeposit({ s }: { s: ReturnType<typeof useSharedOpen> }) {
  const req = s.bondReq;
  const meta = s.bondTokenMeta;
  const minBase = req?.minAmount ?? "0";
  const [amount, setAmount] = useState("");
  // Prefill the field to the minimum once the token's decimals are known (meta loads async). Until then the
  // step shows a loading state and the lock is blocked, so the human->base conversion never guesses a scale.
  useEffect(() => { if (meta) setAmount(plainAmount(minBase, meta.decimals)); }, [minBase, meta]);
  if (!req || !req.token || !req.deadline) return null;
  if (!meta) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="access-bond-deposit">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Reading the token details…
      </p>
    );
  }
  const decimals = meta.decimals;
  const symbol = meta.symbol;
  const base = toBaseUnits(amount, decimals);
  const enough = !!base && BigInt(base) >= BigInt(minBase);
  const below = s.bondCount !== null && s.bondCount < BOND_FLOOR;
  return (
    <div className="space-y-3" data-testid="access-bond-deposit">
      {/* For a bond-only room the requirement is already shown in detail in the room-level panel above; for a
          legacy bonded room (no room panel) show it here, in the same detailed standout card. */}
      {!s.roomBond && (
        <div className="rounded-xl border border-success/30 bg-success/5 p-3">
          <p className="mb-1 text-[13px] font-medium">This room requires a bond:</p>
          <BondRequirementDetail token={req.token} minAmount={minBase} deadline={req.deadline} meta={meta} idPrefix="access-deposit" />
        </div>
      )}

      <div>
        <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
          Amount to lock ({symbol})
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-48" data-testid="access-bond-amount" />
        </label>
        {!enough && <p className="mt-1 text-xs text-destructive">Lock at least {fmtAmount(minBase, decimals)} {symbol}.</p>}
        <p className="mt-1 text-xs text-muted-foreground">
          This lock cannot be released until {fmtDeadline(req.deadline)}. It is tied to you anonymously: the room
          never learns it is yours.
        </p>
      </div>

      <BondCount count={s.bondCount} />
      {below && (
        <p className="text-xs text-muted-foreground">
          Only {s.bondCount ?? 0} qualifying bonder{(s.bondCount ?? 0) === 1 ? "" : "s"} so far. The room needs{" "}
          {BOND_FLOOR} before anyone can prove. Your deposit counts toward that.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => base && void s.lockBond(base)} disabled={!enough || s.bondLocking} data-testid="access-bond-lock">
          {s.bondLocking ? "Locking…" : "Lock bond and continue"}
        </Button>
        <Button size="sm" variant="ghost" onClick={s.dismiss} data-testid="access-bond-dismiss">Not now</Button>
      </div>

      <Callout icon={Info}>
        Locking is public: your wallet, the token, and the amount show on-chain. Opening a document later is
        private: the proof hides which bond is yours.
      </Callout>
    </div>
  );
}

// The manual "open by room id" input. Local state so typing doesn't churn the hook until submit.
function ManualOpen({ onSubmit }: { onSubmit: (roomId: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
        Room id (32-byte hex)
        <Input
          className="font-mono text-xs"
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="64 hex chars"
          aria-label="open room id"
          data-testid="access-manual-input"
        />
      </label>
      <Button variant="outline" onClick={() => onSubmit(v)} disabled={!v.trim()} data-testid="access-manual-btn">
        <Lock aria-hidden="true" />
        Open this room
      </Button>
    </div>
  );
}
