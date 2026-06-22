import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Compass, Search, ShieldCheck, UserPlus, Users } from "lucide-react";
import { useDirectory } from "@/lib/hooks/useDirectory";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Callout, CopyIconButton } from "@/components/app/dataroom/kit";
import type { AnonTier } from "@/lib/api";

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

// A rounded member-count range with a tier colour. Never an exact number.
function BucketBadge({ tier, bucket }: { tier: AnonTier; bucket: string }) {
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

function JoinButton({ roomId, variant = "default" }: { roomId: string; variant?: "default" | "outline" }) {
  return (
    <Link to={joinLink(roomId)} data-testid="discover-join" className={cn(buttonVariants({ size: "sm", variant }))}>
      <UserPlus aria-hidden="true" />
      Request to join
    </Link>
  );
}

export default function Discover() {
  const d = useDirectory();
  const { hash } = useLocation();
  const [tab, setTab] = useState<DiscTab>(() => tabFromHash(hash));
  useEffect(() => setTab(tabFromHash(hash)), [hash]);

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
              <div className="space-y-3" data-testid="discover-list">
                {d.rooms.map((r) => (
                  <div
                    key={r.roomId}
                    data-testid="discover-room"
                    className="rounded-xl border p-4 transition-colors hover:border-brand/30 hover:bg-accent/30"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{r.name || "Unnamed room"}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                          {short(r.roomId, 8)}
                          <CopyIconButton value={r.roomId} label="room id" />
                        </div>
                      </div>
                      <JoinButton roomId={r.roomId} />
                    </div>
                    {r.description && (
                      <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{r.description}</p>
                    )}
                    <div className="mt-3">
                      <BucketBadge tier={r.anonTier} bucket={r.memberBucket} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4">
            <Callout icon={ShieldCheck} testId="discover-caveat">
              Listing a room is only about who can find it. It does not change who can get in. Access still needs
              a membership proof, and anonymity still needs a real crowd, so a listed room can be forming below
              the floor until enough members join.
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

          {d.lookupResult && (
            <div
              className="mt-4 rounded-xl border p-4"
              data-testid="discover-lookup-result"
              data-discoverable={String(d.lookupResult.discoverable)}
            >
              {!d.lookupResult.discoverable ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    This id is not discoverable. The room is private, or it does not exist. If the owner shared
                    the id with you directly, you can still request to join it.
                  </p>
                  <JoinButton roomId={d.lookupResult.roomId} variant="outline" />
                </div>
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {d.lookupResult.name || "Unnamed room"}
                      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        {d.lookupResult.listed ? "listed" : "unlisted"}
                      </span>
                    </div>
                    {d.lookupResult.description && (
                      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                        {d.lookupResult.description}
                      </p>
                    )}
                    {d.lookupResult.anonTier && d.lookupResult.memberBucket && (
                      <div className="mt-3">
                        <BucketBadge tier={d.lookupResult.anonTier} bucket={d.lookupResult.memberBucket} />
                      </div>
                    )}
                  </div>
                  <JoinButton roomId={d.lookupResult.roomId} />
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
