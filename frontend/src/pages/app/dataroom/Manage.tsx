import { useCallback, useEffect, useState } from "react";
import { Compass, Globe, KeyRound, Lock, ShieldCheck, Users } from "lucide-react";
import { useEnroll } from "@/lib/hooks/useEnroll";
import { useTxSigner } from "@/lib/wallet/WalletContext";
import { clearBondRequirement, getBondRequirementApi, type RoomVisibility } from "@/lib/api";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Callout, CopyIconButton, SectionLabel } from "@/components/app/dataroom/kit";
import { OwnerBondSection } from "@/components/app/dataroom/OwnerBondSection";

// Room Management — the owner's settings for a room they own, kept apart from the member-facing
// Join/Approve. The room uses ONE access model, mutually exclusive:
//   • Membership — the owner approves who can join; readers prove membership anonymously. No bond.
//   • Bonded Access — anyone who locks a qualifying bond gets in. NO approval, NO member list.
// Plus discovery visibility (who can find the room).

const VIS_TIERS: { key: RoomVisibility; label: string; desc: string; icon: typeof Lock }[] = [
  { key: "private", label: "Private", desc: "Reachable only by a link or id you share.", icon: Lock },
  { key: "unlisted", label: "Unlisted", desc: "Resolvable by exact id, not in the directory.", icon: KeyRound },
  { key: "listed", label: "Listed", desc: "Shown in the public directory.", icon: Globe },
];

type AccessModel = "membership" | "bond";

export default function RoomManagement() {
  const e = useEnroll();
  const signer = useTxSigner();

  // The room's on-chain access model (bond-only or membership), plus the owner's current pick (which drives
  // what shows). `bondOpen === null` while loading. `picked` syncs to the chain model on room change, then the
  // owner can switch it.
  const [bondOpen, setBondOpen] = useState<boolean | null>(null);
  const [picked, setPicked] = useState<AccessModel>("membership");
  const [reqRefresh, setReqRefresh] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [clearErr, setClearErr] = useState<string | null>(null);

  useEffect(() => {
    if (!e.ownerRoom) {
      setBondOpen(null);
      return;
    }
    let live = true;
    setBondOpen(null);
    getBondRequirementApi(e.ownerRoom)
      .then((r) => {
        if (!live) return;
        const open = Boolean(r.bondOpen);
        setBondOpen(open);
        setPicked(open ? "bond" : "membership");
      })
      .catch(() => {
        if (live) {
          setBondOpen(false);
          setPicked("membership");
        }
      });
    return () => {
      live = false;
    };
  }, [e.ownerRoom, reqRefresh]);

  const switchToMembership = useCallback(async () => {
    if (!e.ownerRoom || !signer) {
      setClearErr("Connect your wallet on testnet first.");
      return;
    }
    setClearErr(null);
    setClearing(true);
    try {
      const r = await clearBondRequirement(e.ownerRoom.trim(), signer);
      if (!r.ok) {
        setClearErr(r.error ?? "Could not switch to membership.");
        return;
      }
      setReqRefresh((x) => x + 1);
    } catch (err) {
      setClearErr(String((err as Error).message ?? err));
    } finally {
      setClearing(false);
    }
  }, [e.ownerRoom, signer]);

  if (!e.connected) {
    return (
      <Card className="rounded-2xl p-6" data-testid="manage-connect-prompt">
        <h2 className="text-base font-semibold tracking-tight">Room Management</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Connect your wallet to manage a room you own. Here you choose how readers get in (approved
          membership, or a bond anyone can lock) and who can find the room.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5" data-testid="manage-card">
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">Room Management</h2>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">rooms you own</span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Pick a room, then choose its access model and visibility. The access model is one or the other:
          approve members, or let anyone with a qualifying bond in.
        </p>

        {e.myRooms.length === 0 ? (
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground" data-testid="manage-no-rooms">
            You don't own any rooms yet. Create one in Documents, then manage it here.
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2" data-testid="manage-my-rooms">
            {e.myRooms.map((r) => (
              <button
                key={r.roomId}
                onClick={() => e.selectOwnerRoom(r.roomId)}
                data-testid="manage-owner-room"
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
        )}
      </Card>

      {e.ownerRoom && (
        <>
          {/* ── Access model (Membership XOR Bonded Access) ── */}
          <Card className="rounded-2xl p-6" data-testid="manage-access-model">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground" data-testid="manage-room-id">
              <Users className="size-4" aria-hidden="true" />
              <span>{e.memberCount} approved member{e.memberCount === 1 ? "" : "s"}</span>
              <span className="mx-1">·</span>
              <span>Room id</span>
              <code className="font-mono text-xs text-foreground" title={e.ownerRoom}>{short(e.ownerRoom, 10)}</code>
              <CopyIconButton value={e.ownerRoom} label="room id" />
            </div>

            <SectionLabel withRule>
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="size-4" aria-hidden="true" />
                How readers get in
              </span>
            </SectionLabel>

            <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="access model">
              {(
                [
                  {
                    key: "membership" as AccessModel,
                    title: "Membership",
                    icon: Users,
                    desc: "You approve who can join. Readers prove membership anonymously. No bond.",
                  },
                  {
                    key: "bond" as AccessModel,
                    title: "Bonded Access",
                    icon: KeyRound,
                    desc: "Anyone who locks a qualifying bond gets in. No approval, no member list.",
                  },
                ]
              ).map((m) => {
                const active = picked === m.key;
                const isCurrent = (bondOpen ? "bond" : "membership") === m.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setPicked(m.key)}
                    data-testid={`manage-model-${m.key}`}
                    className={cn(
                      "rounded-xl border p-3.5 text-left transition-colors hover:border-brand/30 hover:bg-accent/40",
                      active && "border-brand/50 bg-accent/50",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-[13px] font-medium">
                        <m.icon className="size-4" aria-hidden="true" />
                        {m.title}
                      </div>
                      {bondOpen !== null && isCurrent && (
                        <span className="rounded-full border border-success/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success" data-testid={`manage-model-current-${m.key}`}>
                          Current
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{m.desc}</div>
                  </button>
                );
              })}
            </div>

            {/* Membership picked. If the room is currently bond-only, offer the switch (clears the bond). */}
            {picked === "membership" && (
              <div className="mt-4" data-testid="manage-membership-panel">
                {bondOpen ? (
                  <div className="space-y-3">
                    <Callout icon={ShieldCheck}>
                      This room currently uses Bonded Access. Switching to membership clears the bond
                      requirement, and readers will need your approval again.
                    </Callout>
                    <Button variant="outline" onClick={() => void switchToMembership()} disabled={clearing} data-testid="manage-switch-membership">
                      {clearing ? "Switching…" : "Switch to membership"}
                    </Button>
                    {clearErr && <p className="text-sm text-destructive" data-testid="manage-clear-error">{clearErr}</p>}
                  </div>
                ) : (
                  <Callout icon={Users}>
                    This room uses approved membership. Approve people who ask to join in the Membership tab.
                    Approving a member lets them prove their way in anonymously.
                  </Callout>
                )}
              </div>
            )}

            {/* Bonded Access picked. Show the requirement editor (set / replace / clear). */}
            {picked === "bond" && (
              <div className="mt-4" data-testid="manage-bond-panel">
                <OwnerBondSection roomId={e.ownerRoom} onChanged={() => setReqRefresh((x) => x + 1)} />
              </div>
            )}
          </Card>

          {/* ── Who can find this room (discovery visibility) ── */}
          <Card className="rounded-2xl p-6" data-testid="manage-visibility">
            <SectionLabel withRule>
              <span className="inline-flex items-center gap-1.5">
                <Compass className="size-4" aria-hidden="true" />
                Who can find this room
              </span>
            </SectionLabel>
            <div className="mt-3 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="room visibility">
              {VIS_TIERS.map((t) => {
                const active = e.vis === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => e.setVis(t.key)}
                    data-testid={`vis-${t.key}`}
                    className={cn(
                      "rounded-xl border p-3 text-left transition-colors hover:border-brand/30 hover:bg-accent/40",
                      active && "border-brand/50 bg-accent/50",
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-[13px] font-medium">
                      <t.icon className="size-4" aria-hidden="true" />
                      {t.label}
                    </div>
                    <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.desc}</div>
                  </button>
                );
              })}
            </div>

            {e.vis !== "private" && (
              <div className="mt-3 space-y-3">
                <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
                  Public name (optional)
                  <Input
                    value={e.visName}
                    onChange={(ev) => e.setVisName(ev.target.value)}
                    placeholder="e.g. Series A data room"
                    aria-label="room public name"
                    data-testid="vis-name"
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
                  Public description (optional)
                  <Input
                    value={e.visDescription}
                    onChange={(ev) => e.setVisDescription(ev.target.value)}
                    placeholder="One line about the room"
                    aria-label="room public description"
                    data-testid="vis-description"
                  />
                </label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  A name alone can hint that a deal exists, so this is off by default. Leave it blank to stay
                  anonymous in the directory.
                </p>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button onClick={e.saveVisibility} disabled={e.visBusy || !e.visDirty} data-testid="vis-save">
                {e.visBusy ? "Saving…" : "Save visibility"}
              </Button>
              {e.visSaved && !e.visDirty && (
                <span className="text-sm text-emerald-600 dark:text-emerald-500" data-testid="vis-saved">
                  Saved.
                </span>
              )}
            </div>

            <div className="mt-3">
              <Callout icon={ShieldCheck}>
                Visibility only changes who can find the room. It does not change who can get in. The directory
                shows a rounded member range, never the exact count, and never who accessed.
              </Callout>
            </div>

            {e.visErr && <p className="mt-2 text-sm text-destructive" data-testid="vis-error">{e.visErr}</p>}
          </Card>
        </>
      )}

      {e.ownerErr && (
        <p className="text-sm text-destructive" data-testid="manage-owner-error">
          {e.ownerErr}
        </p>
      )}
    </div>
  );
}
