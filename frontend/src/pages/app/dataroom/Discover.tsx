import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Clock, Compass, FolderOpen, KeyRound, Search, Settings2, ShieldCheck, UserPlus, Users } from "lucide-react";
import { useDirectory } from "@/lib/hooks/useDirectory";
import { useWallet } from "@/lib/wallet/WalletContext";
import { joinRequestStates } from "@/lib/dataroom/requests";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Callout, CopyIconButton } from "@/components/app/dataroom/kit";
import { BondRequirementDetail } from "@/components/app/dataroom/BondRequirementDetail";
import { getMyRooms, type AnonTier, type DirectoryBond, type EnrollState } from "@/lib/api";

// M5 — the public discovery surface. Wallet NOT required to browse. Visibility is a discovery convenience,
// not the privacy mechanism (that is the membership proof + the k=5 floor + the keepers). The directory shows
// only opt-in "listed" rooms, with coarse member buckets (never exact counts) and never an access feed.
// Split into a submenu (like Documents): Directory (the public list) and Find by id (resolve an exact id).
type DiscTab = "directory" | "find";
const SUBTABS: { key: DiscTab; label: string }[] = [
  { key: "directory", label: "Directory" },
  { key: "find", label: "Find by id" },
];
const tabFromHash = (h: string): DiscTab => (h.replace("#", "") === "find" ? "find" : "directory");

const TIER_DOT: Record<AnonTier, string> = {
  forming: "bg-destructive",
  ok: "bg-amber-500",
  strong: "bg-emerald-500",
};
const TIER_NOTE: Record<AnonTier, string> = {
  forming: "still forming, below the anonymity floor",
  ok: "a usable crowd",
  strong: "a strong crowd",
};
// A short tier word for the compact directory pill (the dot colour also encodes the tier).
const TIER_SHORT: Record<AnonTier, string> = {
  forming: "forming",
  ok: "usable crowd",
  strong: "strong crowd",
};

// A rounded member-count range with a tier colour. Never an exact number. `compact` is the inline directory
// pill (smaller, short tier word, sits on the meta line); the default is the fuller badge in the lookup result.
function BucketBadge({ tier, bucket, compact = false }: { tier: AnonTier; bucket: string; compact?: boolean }) {
  if (compact) {
    return (
      <span
        data-testid="bucket-badge"
        data-tier={tier}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", TIER_DOT[tier])} aria-hidden="true" />
        <Users className="size-3 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-medium text-foreground">{bucket}</span> · {TIER_SHORT[tier]}
        </span>
      </span>
    );
  }
  return (
    <span
      data-testid="bucket-badge"
      data-tier={tier}
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground"
    >
      <span className={cn("size-2 shrink-0 rounded-full", TIER_DOT[tier])} aria-hidden="true" />
      <Users className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        <span className="font-medium text-foreground">{bucket}</span> members · {TIER_NOTE[tier]}
      </span>
    </span>
  );
}

const joinLink = (roomId: string) => `/app/dataroom/membership?room=${roomId}`;
const accessLink = (roomId: string) => `/app/dataroom/documents?room=${roomId}#open`;

// The directory's per-room action reflects your LOCAL request history (this browser, when connected): an
// approved room opens documents, a pending one shows it's already requested, anything else invites you to join.
// The history is a hint as fresh as your last Refresh; the access tab does the authoritative on-chain check.
function JoinButton({
  roomId,
  state,
  variant = "default",
}: {
  roomId: string;
  state?: EnrollState;
  variant?: "default" | "outline";
}) {
  if (state === "eligible") {
    return (
      <Link to={accessLink(roomId)} data-testid="discover-open" className={cn(buttonVariants({ size: "sm", variant }))}>
        <FolderOpen aria-hidden="true" />
        Open
      </Link>
    );
  }
  if (state === "pending") {
    return (
      <Link
        to={joinLink(roomId)}
        data-testid="discover-requested"
        className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
      >
        <Clock aria-hidden="true" />
        Requested
      </Link>
    );
  }
  return (
    <Link to={joinLink(roomId)} data-testid="discover-join" className={cn(buttonVariants({ size: "sm", variant }))}>
      <UserPlus aria-hidden="true" />
      Request to join
    </Link>
  );
}

// When a directory card is the connected wallet's OWN room, this replaces the join action (you cannot join
// your own room). It marks the row as yours and links to Room Management for THIS room (?room= prefill).
function OwnRoomLink({ roomId }: { roomId: string }) {
  return (
    <Link
      to={`/app/dataroom/manage?room=${roomId}`}
      data-testid="discover-own-room"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-success/40 bg-success/5 px-3 py-1.5 text-xs font-medium text-success transition-colors hover:bg-success/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/40"
    >
      <Settings2 className="size-3.5" aria-hidden="true" />
      Your room
    </Link>
  );
}

// A bond-only room admits readers by a qualifying bond, with NO approval and no member list, so the directory
// must show what that bond is (which token, how much, until when), NOT a request-to-join. The token contract
// and its classic issuer link to Stellar Expert; the box uses the same success tint as the owner's "Current
// requirement" card. Amounts are 7 dp on Stellar. The deadline shows the date AND time (a lock cannot be
// released before that exact moment, so the time matters). Renders the shared BondRequirementDetail (compact).
function BondRequirementBox({ bond }: { bond: DirectoryBond }) {
  return (
    <div className="mt-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2" data-testid="discover-bond-req">
      <BondRequirementDetail
        token={bond.token}
        minAmount={bond.minAmount}
        deadline={bond.deadline}
        meta={{ symbol: bond.symbol, decimals: bond.decimals, issuer: bond.issuer }}
        compact
        idPrefix="discover-bond"
      />
    </div>
  );
}

// The "Bond to enter" pill that replaces the member bucket on a bond-only card (a bond-only room has no
// approved members, so a member count would be misleading).
function BondToEnterPill() {
  return (
    <span
      data-testid="discover-bond-pill"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-success/40 px-2 py-0.5 text-[11px] text-success"
    >
      <KeyRound className="size-3 shrink-0" aria-hidden="true" />
      Bond to enter
    </span>
  );
}

// A bond-only room's action. It routes to Documents > Open, the single flow that handles a bonded room: it
// shows the requirement, locks a qualifying bond (deposit auto-filled to the minimum), proves access, and
// opens, OR opens straight away if this wallet already has access. The label is "Create Bonded Access" (not
// "Open"), because a visitor without a bond yet must set one up first; the standalone Bonded Access page is a
// different system and cannot grant room access, so it is intentionally not the destination.
function BondCreateLink({ roomId }: { roomId: string }) {
  return (
    <Link to={accessLink(roomId)} data-testid="discover-bond-create" className={cn(buttonVariants({ size: "sm" }))}>
      <KeyRound aria-hidden="true" />
      Create Bonded Access
    </Link>
  );
}

export default function Discover() {
  const d = useDirectory();
  const { hash } = useLocation();
  const [tab, setTab] = useState<DiscTab>(() => tabFromHash(hash));
  useEffect(() => setTab(tabFromHash(hash)), [hash]);

  // Reflect this wallet's local request history (this browser) on the per-room buttons. No new signature and
  // no wallet address is sent; we only read what was stored when you requested/refreshed in Membership.
  const { connected, address } = useWallet();
  const statusByRoom = useMemo(() => (connected ? joinRequestStates(address) : {}), [connected, address]);

  // Mark a directory card that is one of YOUR rooms by cross-referencing the wallet's owned room ids. Unlike
  // the local request-history read above, this DOES send your address to the backend (to read the rooms you
  // own). It reads only your own rooms and changes nothing in the public directory.
  const [ownedRooms, setOwnedRooms] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!connected || !address) {
      setOwnedRooms(new Set());
      return;
    }
    let live = true;
    getMyRooms(address)
      .then((r) => { if (live) setOwnedRooms(new Set(r.rooms.map((x) => x.roomId.toLowerCase()))); })
      .catch(() => { if (live) setOwnedRooms(new Set()); });
    return () => { live = false; };
  }, [connected, address]);

  return (
    <div className="space-y-5" data-testid="discover-card">
      {/* Submenu (Directory / Find by id), styled like the Documents sub-tabs. */}
      <div
        className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-2xl border bg-card p-1.5"
        role="tablist"
        aria-label="Discover"
      >
        {SUBTABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            data-testid={`discover-subtab-${t.key}`}
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

      {/* ── Public directory ── */}
      {tab === "directory" && (
        <Card className="rounded-2xl border-brand/40 p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
              <Compass className="size-5 text-brand" aria-hidden="true" />
              Public directory
            </h2>
            <span className="text-[11px] uppercase tracking-wide text-brand">opt-in</span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            A room appears here only if its owner chose to list it. Member counts are shown as rounded ranges,
            never exact numbers, and the directory never shows who opened a document or when.
          </p>

          <div className="mt-5">
            {d.loading ? (
              <p className="text-sm text-muted-foreground" data-testid="discover-loading">
                Loading the directory…
              </p>
            ) : d.error ? (
              <p className="text-sm text-destructive" data-testid="discover-error">
                {d.error}
              </p>
            ) : d.rooms.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="discover-empty">
                No rooms are listed yet. A room owner can list a room from the Membership tab.
              </p>
            ) : (
              <div className="space-y-2.5" data-testid="discover-list">
                {d.rooms.map((r) => {
                  const isOwn = ownedRooms.has(r.roomId.toLowerCase());
                  // A TRUE bond-only room: show the bond requirement + a "Create Bonded Access" action instead
                  // of a member bucket + request-to-join. Owners still see "Your room".
                  const bond = r.bond && r.bond.bondOpen ? r.bond : null;
                  return (
                    <div
                      key={r.roomId}
                      data-testid="discover-room"
                      data-own={isOwn ? "true" : "false"}
                      data-bonded={bond ? "true" : "false"}
                      className="rounded-xl border px-4 py-3 transition-colors hover:border-brand/30 hover:bg-accent/30"
                    >
                      {/* One row on sm+ (compact, action right-aligned); stacked on phones so the name is not
                          truncated and the id does not wrap under the button. */}
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{r.name || "Unnamed room"}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                              {short(r.roomId, 8)}
                              <CopyIconButton value={r.roomId} label="room id" />
                            </span>
                            {bond ? <BondToEnterPill /> : <BucketBadge tier={r.anonTier} bucket={r.memberBucket} compact />}
                          </div>
                          {r.description && (
                            <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
                              {r.description}
                            </p>
                          )}
                          {bond && <BondRequirementBox bond={bond} />}
                        </div>
                        <div className="shrink-0 self-start">
                          {isOwn ? (
                            <OwnRoomLink roomId={r.roomId} />
                          ) : bond ? (
                            <BondCreateLink roomId={r.roomId} />
                          ) : (
                            <JoinButton roomId={r.roomId} state={statusByRoom[r.roomId.toLowerCase()]} />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4">
            <Callout icon={ShieldCheck} testId="discover-caveat">
              Listing a room is only about who can find it. It does not change who can get in. Access still needs
              a proof, by approved membership or a qualifying bond. Anonymity needs a real crowd, so a room can be
              forming below the floor until enough people qualify.
            </Callout>
          </div>
        </Card>
      )}

      {/* ── Find a room by exact id ── */}
      {tab === "find" && (
        <Card className="rounded-2xl p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold tracking-tight">Find a room by id</h2>
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">exact id</span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Know a room's id? Look it up. A room that chose to stay private will not resolve here, even with the
            right id. If the owner shared the id with you, you can still ask to join from Membership.
          </p>

          <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
              Room id (32-byte hex)
              <Input
                className="font-mono text-xs"
                value={d.lookupId}
                onChange={(ev) => d.setLookupId(ev.target.value)}
                placeholder="64 hex chars"
                aria-label="lookup room id"
                data-testid="discover-lookup-input"
              />
            </label>
            <Button onClick={d.resolve} disabled={d.lookupBusy} data-testid="discover-lookup-btn">
              <Search aria-hidden="true" />
              {d.lookupBusy ? "Looking…" : "Look up"}
            </Button>
          </div>

          {d.lookupErr && (
            <p className="mt-3 text-sm text-destructive" data-testid="discover-lookup-error">
              {d.lookupErr}
            </p>
          )}

          {d.lookupResult && (() => {
            const lr = d.lookupResult;
            // A bond-only room resolved by id shows its requirement + "Create Bonded Access", same as the
            // directory; an own room shows "Your room". A private id stays dark (no bond info revealed).
            const lbond = lr.bond && lr.bond.bondOpen ? lr.bond : null;
            const lisOwn = ownedRooms.has(lr.roomId.toLowerCase());
            return (
              <div
                className="mt-4 rounded-xl border p-4"
                data-testid="discover-lookup-result"
                data-discoverable={String(lr.discoverable)}
                data-bonded={lbond ? "true" : "false"}
              >
                {!lr.discoverable ? (
                  lisOwn ? (
                    // A private room the connected wallet owns: it stays dark to discovery, but the owner can
                    // still manage it. Point there instead of inviting them to "request to join" their own room.
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        This is your room. It stays private, so it does not appear in the directory.
                      </p>
                      <OwnRoomLink roomId={lr.roomId} />
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        This id is not discoverable. The room is private, or it does not exist. If the owner shared
                        the id with you directly, you can still request to join it.
                      </p>
                      <JoinButton
                        roomId={lr.roomId}
                        state={statusByRoom[lr.roomId.toLowerCase()]}
                        variant="outline"
                      />
                    </div>
                  )
                ) : (
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {lr.name || "Unnamed room"}
                        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {lr.listed ? "listed" : "unlisted"}
                        </span>
                        {lbond && <BondToEnterPill />}
                      </div>
                      {lr.description && (
                        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                          {lr.description}
                        </p>
                      )}
                      {lbond ? (
                        <BondRequirementBox bond={lbond} />
                      ) : (
                        lr.anonTier && lr.memberBucket && (
                          <div className="mt-3">
                            <BucketBadge tier={lr.anonTier} bucket={lr.memberBucket} />
                          </div>
                        )
                      )}
                    </div>
                    {lisOwn ? (
                      <OwnRoomLink roomId={lr.roomId} />
                    ) : lbond ? (
                      <BondCreateLink roomId={lr.roomId} />
                    ) : (
                      <JoinButton roomId={lr.roomId} state={statusByRoom[lr.roomId.toLowerCase()]} />
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </Card>
      )}
    </div>
  );
}
