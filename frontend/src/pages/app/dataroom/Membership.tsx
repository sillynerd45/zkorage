import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { FolderOpen, RefreshCw, Settings, ShieldCheck, UserPlus, Users } from "lucide-react";
import { useEnroll } from "@/lib/hooks/useEnroll";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EnrollState } from "@/lib/api";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";
import { Callout, CopyIconButton, SectionLabel } from "@/components/app/dataroom/kit";

// Membership is split into a submenu (like Documents): Join (request to join + your pending requests) and
// Approve (owner approves members of rooms they own + sets discovery). One sub-tab shows at a time.
type MemberTab = "join" | "approve";
const SUBTABS: { key: MemberTab; label: string }[] = [
  { key: "join", label: "Join" },
  { key: "approve", label: "Approve" },
];
const tabFromHash = (h: string): MemberTab => (h.replace("#", "") === "approve" ? "approve" : "join");

// A small status pill for a join request (pending / approved / not requested).
function StatePill({ state }: { state: EnrollState }) {
  const meta: Record<EnrollState, { label: string; cls: string }> = {
    eligible: { label: "Approved", cls: "border-success/50 text-success" },
    pending: { label: "Pending", cls: "border-amber-500/50 text-amber-600 dark:text-amber-500" },
    none: { label: "Not requested", cls: "border-input text-muted-foreground" },
  };
  const m = meta[state];
  return (
    <span
      data-testid="request-state-pill"
      data-state={state}
      className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", m.cls)}
    >
      {m.label}
    </span>
  );
}

// M1 — request-then-approve enrollment (Model B). Members request to join a room with a commitment derived
// from their wallet (sign-to-derive); the room owner approves, which pins the eligible-set root on-chain.
// Joining sends only the public commitment + an optional self-chosen label (never the wallet address);
// getting in later stays anonymous (the membership proof hides which member acts).
export default function Membership() {
  const e = useEnroll();
  const { hash } = useLocation();
  const [tab, setTab] = useState<MemberTab>(() => tabFromHash(hash));
  useEffect(() => setTab(tabFromHash(hash)), [hash]);

  // Prefill the join field when arriving from a directory "Request to join" link (?room=<id>), and land on Join.
  const [params] = useSearchParams();
  const paramRoom = params.get("room");
  useEffect(() => {
    if (paramRoom) {
      e.setJoinRoom(paramRoom);
      setTab("join");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramRoom]);

  if (!e.connected) {
    return (
      <Card className="rounded-2xl p-6" data-testid="enroll-connect-prompt">
        <h2 className="text-base font-semibold tracking-tight">Membership</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Connect your wallet to request to join a room, or to approve members of a room you own. Your identity
          for a room is derived from your wallet, so you can take it to any device.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5" data-testid="enroll-card">
      {/* Submenu (Join / Approve), styled like the Documents sub-tabs. */}
      <div
        className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-2xl border bg-card p-1.5"
        role="tablist"
        aria-label="Membership"
      >
        {SUBTABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            data-testid={`member-subtab-${t.key}`}
            className={cn(
              "rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors",
              tab === t.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── JOIN: request to join + your requests ── */}
      {tab === "join" && (
        <>
          <Card className="rounded-2xl border-brand/40 p-6">
            <h2 className="text-base font-semibold tracking-tight">Request to join a room</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Your membership ID for this room is derived from your wallet, so the same wallet rebuilds it on any
              device and nothing is stored. You send the owner this public ID and an optional label you choose.
              Your wallet address is never sent. Getting in later stays anonymous: the proof hides which member
              you are.
            </p>

            <div className="mt-5 space-y-3">
              <SectionLabel withRule>The room</SectionLabel>
              <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
                Room id (32-byte hex)
                <Input
                  className="font-mono text-xs"
                  value={e.joinRoom}
                  onChange={(ev) => e.setJoinRoom(ev.target.value)}
                  placeholder="The room you want to join (64 hex chars)"
                  aria-label="join room"
                  data-testid="enroll-join-room"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
                Label (optional)
                <Input
                  value={e.joinLabel}
                  onChange={(ev) => e.setJoinLabel(ev.target.value)}
                  placeholder="A name the owner will see, e.g. Alice from Acme"
                  aria-label="join label"
                  data-testid="enroll-label"
                />
                <span className="text-xs text-muted-foreground">
                  A name the owner sees to recognize your request. Leave it blank to stay just an ID.
                </span>
              </label>
              <Button
                onClick={e.requestToJoin}
                disabled={e.memberBusy || e.joinDone}
                data-testid="enroll-request"
              >
                <UserPlus aria-hidden="true" />
                {e.memberBusy
                  ? "Working…"
                  : e.memberState === "eligible"
                    ? "Already approved"
                    : e.joinDone
                      ? "Request sent"
                      : "Request to join"}
              </Button>
            </div>

            {e.memberState && (
              <div className="mt-4" data-testid="enroll-state" data-state={e.memberState} aria-live="polite">
                {e.memberState === "eligible" ? (
                  <Verdict ok>Approved: you are on this room's list. You can now prove your way in.</Verdict>
                ) : e.memberState === "pending" ? (
                  <p className="text-sm text-muted-foreground">Request sent. Waiting for the room owner to approve.</p>
                ) : (
                  <p className="text-sm text-muted-foreground">Not requested yet.</p>
                )}
              </div>
            )}

            {e.commitment && (
              <div className="mt-4">
                <DataRow k="your membership ID" testId="enroll-commitment">
                  <span className="font-mono">{short(e.commitment, 8)}</span>
                  <CopyIconButton value={e.commitment} label="membership id" />
                </DataRow>
                {e.accessor && (
                  <DataRow k="your stand-in ID" testId="enroll-accessor">{short(e.accessor, 8)}</DataRow>
                )}
                <DataRow k="your identity" variant="private">
                  never leaves this browser. The owner approves your ID, not your name.
                </DataRow>
              </div>
            )}

            {e.drift && (
              <p className="mt-3 text-sm text-amber-600 dark:text-amber-500" data-testid="enroll-drift">
                Your wallet produced a different membership ID than before. If you enrolled earlier with a
                different ID, access tied to the old one may be affected.
              </p>
            )}

            <div className="mt-4">
              <Callout icon={ShieldCheck}>
                You only ever send your public membership ID and the optional label. Your wallet address and the
                secrets that prove your ID stay in this browser.
              </Callout>
            </div>

            {e.memberErr && (
              <p className="mt-3 text-sm text-destructive" data-testid="enroll-member-error">
                {e.memberErr}
              </p>
            )}
          </Card>

          {/* Your requests: a local (this-browser, per-wallet) history of rooms you've asked to join + their
              last-known status. Refresh re-checks each live (one wallet signature, then cached). */}
          <Card className="rounded-2xl p-6" data-testid="your-requests-card">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold tracking-tight">Your requests</h3>
              {e.myRequests.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={e.refreshRequests}
                  disabled={e.requestsBusy}
                  data-testid="requests-refresh"
                >
                  <RefreshCw className={cn("size-3.5", e.requestsBusy && "animate-spin")} aria-hidden="true" />
                  {e.requestsBusy ? "Checking…" : "Refresh"}
                </Button>
              )}
            </div>
            {e.myRequests.length === 0 ? (
              <p className="text-sm leading-relaxed text-muted-foreground" data-testid="requests-empty">
                Rooms you ask to join show up here with their status, so you can see what is still pending. This
                list is kept only in this browser.
              </p>
            ) : (
              <div className="divide-y divide-border/70 rounded-xl border" data-testid="requests-list">
                {e.myRequests.map((r) => (
                  <div key={r.roomId} className="flex items-center gap-3 px-3 py-2.5" data-testid="request-row">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{r.label || "Unnamed request"}</div>
                      <div className="flex items-center gap-1.5 truncate font-mono text-xs text-muted-foreground">
                        {short(r.roomId, 8)}
                        <CopyIconButton value={r.roomId} label="room id" />
                      </div>
                    </div>
                    <StatePill state={r.state} />
                    {/* Approved -> go open the room's documents (the next step). Pending has nothing to open
                        yet, so no action: the status pill says it all and the room id is copyable above. */}
                    {r.state === "eligible" && (
                      <Link
                        to={`/app/dataroom/documents?room=${r.roomId}#open`}
                        data-testid="request-open"
                        className={cn(buttonVariants({ size: "sm", variant: "outline" }), "shrink-0")}
                      >
                        <FolderOpen aria-hidden="true" />
                        Open documents
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {/* ── APPROVE: owner approves members of rooms they own + sets discovery ── */}
      {tab === "approve" && (
        <Card className="rounded-2xl p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold tracking-tight">Approve members</h2>
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">rooms you own</span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Approving a member adds their ID to the room's list and re-pins the list on-chain. Your wallet signs
            that change. Anonymity needs a real group, so grow the list before relying on it.
          </p>

          {e.myRooms.length === 0 ? (
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground" data-testid="enroll-no-rooms">
              You don't own any rooms yet. Create one in Documents, then members can ask to join it here.
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-2" data-testid="enroll-my-rooms">
                {e.myRooms.map((r) => (
                  <button
                    key={r.roomId}
                    onClick={() => e.selectOwnerRoom(r.roomId)}
                    data-testid="enroll-owner-room"
                    aria-pressed={e.ownerRoom === r.roomId}
                    className={cn(
                      "rounded-xl border px-3.5 py-2 text-left text-[13px] transition-colors hover:border-brand/30 hover:bg-accent/40",
                      e.ownerRoom === r.roomId && "border-brand/40 bg-accent/40",
                    )}
                  >
                    <div className="font-medium">{r.label || short(r.roomId, 8)}</div>
                    <div className="text-xs text-muted-foreground">{short(r.roomId, 6)}</div>
                  </button>
                ))}
              </div>

              {e.ownerRoom && (
                <div className="space-y-5">
                  {/* The selected room's facts: approved-member count + the exact id to copy and share with
                      people you want to invite (they paste it into "Request to join", or you send a Discover link). */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-[13px] text-muted-foreground" data-testid="enroll-member-count">
                      <Users className="size-4" aria-hidden="true" />
                      {e.memberCount} approved member{e.memberCount === 1 ? "" : "s"}
                    </div>
                    <div
                      className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground"
                      data-testid="enroll-room-id"
                    >
                      <span>Room id</span>
                      <code className="font-mono text-xs text-foreground" title={e.ownerRoom}>{short(e.ownerRoom, 10)}</code>
                      <CopyIconButton value={e.ownerRoom} label="room id" />
                    </div>
                  </div>

                  {/* ── Pending requests ── (its own labeled section, parallel to the visibility one below) */}
                  <div className="space-y-3" data-testid="enroll-requests-section">
                    <div className="flex items-center gap-3">
                      <SectionLabel withRule className="flex-1">
                        <span className="inline-flex items-center gap-1.5">
                          <UserPlus className="size-4" aria-hidden="true" />
                          Pending requests
                        </span>
                      </SectionLabel>
                      {/* Approve everyone waiting in ONE signature (one root re-pin), instead of one at a time. */}
                      {e.pending.length > 1 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={e.approveAll}
                          disabled={e.approvingAll || e.acting !== null}
                          data-testid="enroll-approve-all"
                        >
                          {e.approvingAll ? "Approving…" : `Approve all (${e.pending.length})`}
                        </Button>
                      )}
                    </div>
                    {e.ownerBusy ? (
                      <p className="text-sm text-muted-foreground">Loading requests…</p>
                    ) : e.pending.length === 0 ? (
                      <p className="text-sm text-muted-foreground" data-testid="enroll-no-pending">
                        No pending requests for this room.
                      </p>
                    ) : (
                      <div className="divide-y divide-border/70 rounded-xl border" data-testid="enroll-pending">
                        {e.pending.map((p) => (
                          <div
                            key={p.commitment}
                            data-testid="enroll-pending-row"
                            className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13px] font-medium">
                                {p.label || "Unnamed member"}
                              </div>
                              <div className="truncate font-mono text-xs text-muted-foreground" title={p.commitment}>
                                {short(p.commitment, 8)}
                              </div>
                            </div>
                            <Button
                              size="sm"
                              onClick={() => e.approve(p.commitment)}
                              disabled={e.acting === p.commitment || e.approvingAll}
                              data-testid="enroll-approve"
                            >
                              {e.acting === p.commitment ? "Working…" : "Approve"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => e.reject(p.commitment)}
                              disabled={e.acting === p.commitment || e.approvingAll}
                              data-testid="enroll-reject"
                            >
                              Reject
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Room settings (access model + visibility + bonded access) moved to Room Management. */}
                  <Callout icon={Settings}>
                    Looking for visibility or Bonded Access? Those moved to the Room Management tab. Approving
                    members here only matters when the room uses approved membership.
                  </Callout>
                </div>
              )}
            </div>
          )}

          {e.ownerErr && (
            <p className="mt-3 text-sm text-destructive" data-testid="enroll-owner-error">
              {e.ownerErr}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
