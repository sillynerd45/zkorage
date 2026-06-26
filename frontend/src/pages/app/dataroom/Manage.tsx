import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Compass, Globe, KeyRound, Lock, ShieldCheck, Users } from "lucide-react";
import { useEnroll } from "@/lib/hooks/useEnroll";
import { useTxSigner } from "@/lib/wallet/WalletContext";
import { clearBondRequirement, getBondRequirementApi, type RoomVisibility } from "@/lib/api";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Callout, CopyIconButton, CurrentBadge, RefreshBar, RoomChipsSkeleton, SectionLabel } from "@/components/app/dataroom/kit";
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

// Module-level cache of each room's bond state, so returning to Room Management (or re-selecting a room)
// repaints the access model at once instead of flashing the cold/null state, then a background refresh
// confirms it. Survives the unmount within one app session; only holds public on-chain flags.
const bondReqCache = new Map<string, { found: boolean; bondOpen: boolean }>();

// The selected-room detail skeleton, shown on the COLD path (the room's access model + member count have not
// loaded yet, and nothing is cached). It mirrors the access-model card (meta row + two option tiles) and the
// visibility card (three tiles + a Save button), so the swap to the real cards does not shift layout. The
// static section headings render as real text, which reads as "this section is loading".
function ManageDetailSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" data-testid="manage-detail-skeleton">
      <span className="sr-only" role="status">Loading room settings</span>
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="h-3.5 w-24 rounded" />
          <Skeleton className="h-3.5 w-44 rounded" />
        </div>
        <SectionLabel withRule>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="size-4" aria-hidden="true" />
            How readers get in
          </span>
        </SectionLabel>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={`am-${i}`} className="rounded-xl border border-border/70 bg-muted/40 p-3.5">
              <Skeleton className="h-4 w-24 rounded" />
              <Skeleton className="mt-2 h-3 w-full rounded" />
              <Skeleton className="mt-1.5 h-3 w-3/4 rounded" />
            </div>
          ))}
        </div>
      </Card>
      <Card className="rounded-2xl p-6">
        <SectionLabel withRule>
          <span className="inline-flex items-center gap-1.5">
            <Compass className="size-4" aria-hidden="true" />
            Who can find this room
          </span>
        </SectionLabel>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={`vis-${i}`} className="rounded-xl border border-border/70 bg-muted/40 p-3">
              <Skeleton className="h-4 w-16 rounded" />
              <Skeleton className="mt-2 h-3 w-full rounded" />
            </div>
          ))}
        </div>
        <div className="mt-3">
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </Card>
    </div>
  );
}

export default function RoomManagement() {
  const e = useEnroll();
  const signer = useTxSigner();

  // Arriving from a Discover "Your room" link (?room=<id>): auto-select that room once it shows up in the
  // owner's list, overriding any restored selection. Guarded by `ownerRoom !== paramRoom` so it runs once.
  const [params] = useSearchParams();
  const paramRoom = params.get("room");
  useEffect(() => {
    if (paramRoom && e.ownerRoom !== paramRoom && e.myRooms.some((r) => r.roomId === paramRoom)) {
      e.selectOwnerRoom(paramRoom);
    }
  }, [paramRoom, e.myRooms, e.ownerRoom, e.selectOwnerRoom]);

  // The room's on-chain bond state: `found` = any bond requirement is set, `bondOpen` = it is TRUE bond-only
  // (no approval); both null only while the first (cold) read is in flight. `picked` is the owner's choice of
  // which panel to show. All three seed from the module cache so a restored room repaints at once.
  const cachedBond = e.ownerRoom ? bondReqCache.get(e.ownerRoom) : undefined;
  const [found, setFound] = useState<boolean | null>(cachedBond ? cachedBond.found : null);
  const [bondOpen, setBondOpen] = useState<boolean | null>(cachedBond ? cachedBond.bondOpen : null);
  const [picked, setPicked] = useState<AccessModel>(cachedBond ? (cachedBond.found ? "bond" : "membership") : "membership");
  const [bondRefreshing, setBondRefreshing] = useState(false); // a background refresh of an already-painted room
  const [reqRefresh, setReqRefresh] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [clearErr, setClearErr] = useState<string | null>(null);
  // syncedRoom: the room whose `picked` has been synced to the chain model (so a reqRefresh after a set/clear
  // updates the markers but never yanks the owner's pick). shownRoom: the room currently displayed, so a
  // reqRefresh bump for the SAME room refreshes silently (keeps the current values) instead of flashing the
  // cold state. Both seed to the restored room when it is already cached.
  const syncedRoom = useRef<string | null>(cachedBond ? e.ownerRoom : null);
  const shownRoom = useRef<string | null>(cachedBond ? e.ownerRoom : null);

  // The current on-chain model: any bond requirement (bond-only OR a legacy bond-implies-membership one) reads
  // as the "bond" model; no bond requirement reads as "membership"; null only while the first read is in flight.
  const currentModel: AccessModel | null = found === null ? null : found ? "bond" : "membership";

  // The selected room's core data is on its first (cold) load with nothing cached: show the detail skeleton.
  // Once found is known (read or restored) and the member count has loaded, the real cards render.
  const detailLoading = e.ownerRoom !== "" && (found === null || e.ownerBusy);

  useEffect(() => {
    if (!e.ownerRoom) {
      setFound(null);
      setBondOpen(null);
      setBondRefreshing(false);
      syncedRoom.current = null;
      shownRoom.current = null;
      return;
    }
    let live = true;
    // A different room: paint the cached value at once when we have one, else show the cold/null state
    // (skeleton). A reqRefresh bump for the SAME room keeps the current values and refreshes silently.
    if (shownRoom.current !== e.ownerRoom) {
      const cached = bondReqCache.get(e.ownerRoom);
      if (cached) {
        setFound(cached.found);
        setBondOpen(cached.bondOpen);
        if (syncedRoom.current !== e.ownerRoom) {
          setPicked(cached.found ? "bond" : "membership");
          syncedRoom.current = e.ownerRoom;
        }
      } else {
        setFound(null);
        setBondOpen(null);
      }
      shownRoom.current = e.ownerRoom;
    }
    setBondRefreshing(true);
    getBondRequirementApi(e.ownerRoom)
      .then((r) => {
        if (!live) return;
        const f = Boolean(r.found);
        const bo = Boolean(r.bondOpen);
        bondReqCache.set(e.ownerRoom, { found: f, bondOpen: bo });
        setFound(f);
        setBondOpen(bo);
        // Sync the owner's pick to the chain model only on the FIRST read for this room; later refreshes
        // (after a set/clear) update the markers but leave the owner's pick alone.
        if (syncedRoom.current !== e.ownerRoom) {
          setPicked(f ? "bond" : "membership");
          syncedRoom.current = e.ownerRoom;
        }
      })
      .catch(() => {
        if (!live) return;
        // A refresh error keeps the last values; only a first-ever read (nothing shown yet) fails closed.
        setFound((prev) => (prev === null ? false : prev));
        setBondOpen((prev) => (prev === null ? false : prev));
        if (syncedRoom.current !== e.ownerRoom) {
          setPicked("membership");
          syncedRoom.current = e.ownerRoom;
        }
      })
      .finally(() => {
        if (live) setBondRefreshing(false);
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
      // Optimistically reflect the cleared requirement (membership) so the markers flip at once, then confirm
      // it with a background refresh.
      bondReqCache.set(e.ownerRoom, { found: false, bondOpen: false });
      setFound(false);
      setBondOpen(false);
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
          <span className="inline-flex items-center text-[11px] uppercase tracking-wide text-muted-foreground">
            rooms you own
            <RefreshBar active={e.myRoomsRefreshing} />
          </span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Pick a room, then choose its access model and visibility. The access model is one or the other:
          approve members, or let anyone with a qualifying bond in.
        </p>

        {e.myRoomsLoading ? (
          <div className="mt-4">
            <RoomChipsSkeleton testId="manage-my-rooms-skeleton" label="Loading the rooms you own" />
          </div>
        ) : e.myRooms.length === 0 ? (
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground" data-testid="manage-no-rooms">
            You don't own any rooms yet. Create one in Documents, then manage it here.
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2" data-testid="manage-my-rooms">
            {e.myRooms.map((r) => (
              <button
                key={r.roomId}
                type="button"
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

      {e.ownerRoom && (detailLoading ? (
        <ManageDetailSkeleton />
      ) : (
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
              <RefreshBar active={e.pendingRefreshing || bondRefreshing} />
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
                const isCurrent = currentModel === m.key;
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
                      {currentModel !== null && isCurrent && (
                        <CurrentBadge testId={`manage-model-current-${m.key}`} />
                      )}
                    </div>
                    <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{m.desc}</div>
                  </button>
                );
              })}
            </div>

            {/* Membership picked. If the room currently has a bond requirement (bond-only, or a legacy
                bond-implies-membership one set before Room Management), offer the switch, which clears it. */}
            {picked === "membership" && (
              <div className="mt-4" data-testid="manage-membership-panel">
                {found ? (
                  <div className="space-y-3">
                    <Callout icon={ShieldCheck}>
                      {bondOpen
                        ? "This room currently uses Bonded Access. Switching to membership clears the bond requirement, and readers will need your approval again."
                        : "This room has a bond requirement that also requires membership (set before Room Management). Switching to membership clears it, and readers get in by your approval alone."}
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
                // "Current" marks the tier actually saved (the live setting), independent of what is selected
                // to edit; it stays put on the saved tile while the owner previews another, like the access model.
                const isCurrent = e.savedVis === t.key;
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
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-[13px] font-medium">
                        <t.icon className="size-4" aria-hidden="true" />
                        {t.label}
                      </div>
                      {isCurrent && <CurrentBadge testId={`vis-current-${t.key}`} />}
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
      ))}

      {e.ownerErr && (
        <p className="text-sm text-destructive" data-testid="manage-owner-error">
          {e.ownerErr}
        </p>
      )}
    </div>
  );
}
