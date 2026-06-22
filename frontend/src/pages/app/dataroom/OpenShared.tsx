import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, Clock, Download, FileText, FolderOpen, Loader2, Lock, RefreshCw, Upload } from "lucide-react";
import { useSharedOpen } from "@/lib/hooks/useSharedOpen";
import { Disclosure, Hex } from "@/components/Disclosure";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Verdict } from "@/components/app/blocks";
import { DecryptedFile } from "@/components/app/DecryptedFile";
import { AnonymityMeter, ANON_FLOOR } from "@/components/app/dataroom/AnonymityMeter";
import { CopyIconButton, SectionLabel } from "@/components/app/dataroom/kit";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";

const MEMBERSHIP_LINK = "/app/dataroom/membership";

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
            This runs a one-time membership proof on our self-hosted prover, then records your access on-chain in
            a shuffled batch so the room cannot tell when you acted.
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
  const importInputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div data-testid="access-card" className="space-y-5">
      <Card className="rounded-2xl border-brand/40 p-6">
        <h2 className="text-base font-semibold tracking-tight">Open a document</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Open files from rooms you have access to. The file is decrypted in your browser.
        </p>
      </Card>

      {/* Rooms you can open: the wallet's approved rooms (from this browser's request history). Refresh
          re-checks each room's status so a just-approved room appears without re-requesting. Names come from
          the public directory (listed rooms), falling back to your own label. */}
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
            No approved rooms yet. After a room owner approves your request, press Refresh and it shows up here.
            You can <Link to={MEMBERSHIP_LINK} className="text-brand hover:underline">request to join in Membership</Link>,
            or open a room by id below.
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

        {/* Cross-device: your room list is encrypted with your wallet and synced so it follows you to other
            devices. The server keeps a copy it cannot read; the room owner never sees it. A manual file export
            stays as a no-server-copy fallback. */}
        <div className="mt-4 space-y-2 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium">Sync across devices</span>
            {s.syncState === "syncing" && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="access-sync-state">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Syncing…
              </span>
            )}
            {s.syncState === "synced" && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400" data-testid="access-sync-state">
                <CheckCircle2 className="size-3.5" aria-hidden="true" /> Synced
              </span>
            )}
            {s.syncState === "locked" && (
              <Button variant="outline" size="sm" onClick={s.unlockSync} data-testid="access-sync-unlock">
                <RefreshCw className="size-3.5" aria-hidden="true" /> Sync my rooms
              </Button>
            )}
            {s.syncState === "error" && (
              <span className="inline-flex items-center gap-2 text-xs text-destructive" data-testid="access-sync-state">
                Couldn't sync
                <Button variant="outline" size="sm" onClick={s.unlockSync} data-testid="access-sync-retry">Retry</Button>
              </span>
            )}
            {s.syncOn ? (
              <Button variant="ghost" size="sm" onClick={() => s.setSync(false)} data-testid="access-sync-toggle">
                Turn off
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => s.setSync(true)} data-testid="access-sync-toggle">
                Turn on
              </Button>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Your room list is encrypted with your wallet and saved so it follows you to other devices. The server
            keeps a copy it cannot read, and the room owner never sees it.
          </p>
          {s.syncMsg && (
            <p className="text-xs text-muted-foreground" data-testid="access-sync-msg">
              {s.syncMsg}
            </p>
          )}

          {/* Manual file fallback (keeps nothing on the server). */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-xs text-muted-foreground">Or use a file:</span>
            <Button variant="outline" size="sm" onClick={s.exportRooms} disabled={s.backupBusy} data-testid="access-export">
              <Download className="size-3.5" aria-hidden="true" />
              Export
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => importInputRef.current?.click()}
              disabled={s.backupBusy}
              data-testid="access-import"
            >
              <Upload className="size-3.5" aria-hidden="true" />
              Import
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              data-testid="access-import-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) s.importRooms(f);
                e.target.value = "";
              }}
            />
          </div>
          {s.backupMsg && (
            <p className="text-xs text-muted-foreground" data-testid="access-backup-msg">
              {s.backupMsg}
            </p>
          )}
        </div>
      </Card>

      {/* The selected room: its documents, each with one Open button + the live status of the active Open. */}
      {s.room && (
        <Card className="rounded-2xl p-6" data-testid="access-room-detail">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SectionLabel className="flex-1">
              <span className="inline-flex items-center gap-1.5">
                <FolderOpen className="size-4" aria-hidden="true" />
                Documents in this room
              </span>
            </SectionLabel>
            <code className="font-mono text-xs text-muted-foreground" title={s.room}>{short(s.room, 8)}</code>
            <CopyIconButton value={s.room} label="room id" />
          </div>

          {s.docsLoading && s.roomDocs.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="access-docs-loading">Loading documents…</p>
          ) : s.roomDocs.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="access-no-docs">This room has no documents yet.</p>
          ) : (
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
                    {active && s.phase !== "idle" && (
                      <div className="border-t border-border/70 bg-accent/20 px-3 py-3" data-testid="access-status" data-phase={s.phase}>
                        <OpenStatus s={s} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* Open by room id: the fallback for a room not in your list (or on a fresh device), collapsed by default. */}
      <Card className="rounded-2xl p-6">
        <Disclosure toggleTestId="access-manual-toggle" detailsLabel="Open by room id" summary={null}>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Have a room id someone shared? Open it here. If you are not on its list, you'll be pointed to request
            to join.
          </p>
          <ManualOpen onSubmit={s.selectRoom} />
        </Disclosure>
      </Card>

      {/* How this stays private: the keepers + the honest caveats, demoted out of the main flow. */}
      <Card className="rounded-2xl p-6">
        <Disclosure toggleTestId="access-privacy-toggle" detailsLabel="How this stays private" summary={null}>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Your identity for a room is derived from your wallet in this browser, so the room learns that an
            approved member opened a document, never which one. The file's key is split across{" "}
            {s.committee ? `${s.committee.online}/${s.committee.n}` : "3"} keepers; any 2 release their part to
            your wallet-derived key and the file rebuilds here. The one-time membership proof is the only step
            where a private witness leaves this browser, and it goes only to our self-hosted prover.
          </p>
          {s.committeeDoc?.content_hash && (
            <div className="mt-2">
              <Hex label="Document fingerprint" value={s.committeeDoc.content_hash} chars={8} />
            </div>
          )}
        </Disclosure>
      </Card>

      {s.drift && (
        <p className="text-sm text-amber-600 dark:text-amber-500" data-testid="access-drift">
          Your wallet produced a different identity than before. If you enrolled earlier with a different wallet
          or signing format, access tied to the old identity may not match.
        </p>
      )}
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
