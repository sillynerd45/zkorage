import { KeyRound, ShieldCheck, UserPlus, Users } from "lucide-react";
import { useEnroll } from "@/lib/hooks/useEnroll";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";
import { Callout, CopyIconButton, SectionLabel } from "@/components/app/dataroom/kit";

// M1 — request-then-approve enrollment (Model B). Members request to join a room with a commitment derived
// from their wallet (sign-to-derive); the room owner approves, which pins the eligible-set root on-chain.
// Joining is identified (the owner sees who they approve); getting in later stays anonymous (the membership
// proof hides which member acts).
export default function Membership() {
  const e = useEnroll();

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
      {/* ── Member: request to join ── */}
      <Card className="rounded-2xl border-brand/40 p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">Request to join a room</h2>
          <span className="text-[11px] uppercase tracking-wide text-brand">identified join</span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Your membership ID for this room is derived from your wallet, so the same wallet rebuilds it on any
          device and nothing is stored. You hand the room owner only this public ID. Getting in later stays
          anonymous: the proof hides which member you are.
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
          <Button onClick={e.deriveCommitment} disabled={e.memberBusy} data-testid="enroll-derive">
            <KeyRound aria-hidden="true" />
            {e.memberBusy ? "Working…" : "Derive my membership ID"}
          </Button>
        </div>

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
            Your wallet produced a different membership ID than before. If you enrolled earlier with a different
            ID, access tied to the old one may be affected.
          </p>
        )}

        {e.commitment && (
          <div className="mt-4">
            <Button
              variant="outline"
              onClick={e.requestJoin}
              disabled={e.memberBusy || e.memberState === "eligible"}
              data-testid="enroll-request"
            >
              <UserPlus aria-hidden="true" />
              {e.memberState === "eligible" ? "Already a member" : "Request to join"}
            </Button>
            {e.memberState && (
              <p className="mt-3" data-testid="enroll-state" data-state={e.memberState}>
                {e.memberState === "eligible" ? (
                  <Verdict ok>Approved: you are on this room's list. You can now prove your way in.</Verdict>
                ) : e.memberState === "pending" ? (
                  <span className="text-sm text-muted-foreground">
                    Request sent. Waiting for the room owner to approve.
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">Not requested yet.</span>
                )}
              </p>
            )}
          </div>
        )}

        <div className="mt-4">
          <Callout icon={ShieldCheck}>
            You only ever send your public membership ID. The secrets that prove it stay in this browser.
          </Callout>
        </div>

        {e.memberErr && (
          <p className="mt-3 text-sm text-destructive" data-testid="enroll-member-error">
            {e.memberErr}
          </p>
        )}
      </Card>

      {/* ── Owner: approve members ── */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">Approve members</h3>
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
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-[13px] text-muted-foreground" data-testid="enroll-member-count">
                  <Users className="size-4" aria-hidden="true" />
                  {e.memberCount} approved member{e.memberCount === 1 ? "" : "s"}
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
                            {p.label || "unnamed member"}
                          </div>
                          <div className="truncate font-mono text-xs text-muted-foreground" title={p.commitment}>
                            {short(p.commitment, 8)}
                            {p.requester ? ` · ${short(p.requester, 4)}` : ""}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => e.approve(p.commitment)}
                          disabled={e.acting === p.commitment}
                          data-testid="enroll-approve"
                        >
                          {e.acting === p.commitment ? "Working…" : "Approve"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => e.reject(p.commitment)}
                          disabled={e.acting === p.commitment}
                          data-testid="enroll-reject"
                        >
                          Reject
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
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
    </div>
  );
}
