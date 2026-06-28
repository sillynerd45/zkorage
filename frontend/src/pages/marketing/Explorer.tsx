import { useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Search, FolderLock, KeyRound, ArrowRight, BadgeCheck } from "lucide-react";
import { useDirectory } from "@/lib/hooks/useDirectory";
import { fmtAmount, type DirectoryRoom, type RoomMeta } from "@/lib/api";
import { short, explorer as explorerUrl } from "@/lib/format";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader, SectionCard } from "@/components/marketing/blocks";

type Tab = "membership" | "bonded";

const fmtDate = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

// One public room row. Membership rooms show a coarse member bucket and a join action; bonded rooms show the
// bond requirement and an open-with-a-bond action. Both get a "Verify on-chain" link to the public read.
function RoomRow({ room }: { room: DirectoryRoom }) {
  const bond = room.bond ?? null;
  const openTo = bond
    ? `/app/dataroom/documents?room=${room.roomId}&setup=bond#open`
    : `/app/dataroom/membership?room=${room.roomId}`;
  return (
    <li data-testid="room-row" className="rounded-xl border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{room.name || short(room.roomId, 8)}</p>
          {room.description && (
            <p className="mt-0.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{room.description}</p>
          )}
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{short(room.roomId, 10)}</p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
            bond ? "border-warning/40 text-warning" : "border-brand/40 text-brand",
          )}
        >
          {bond ? <KeyRound className="size-3.5" /> : <FolderLock className="size-3.5" />}
          {bond ? "Bonded Access" : "Membership"}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        {bond ? (
          <>
            <span>
              Lock <span className="font-medium text-foreground">{fmtAmount(bond.minAmount, bond.decimals)} {bond.symbol || "token"}</span> to enter
            </span>
            {bond.deadline ? <span>until {fmtDate(bond.deadline)}</span> : null}
          </>
        ) : (
          <span>
            Members: <span className="font-medium text-foreground">{room.memberBucket}</span> · approval by the owner
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          to={`/verify/room/${room.roomId}`}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        >
          <BadgeCheck className="size-3.5" /> Verify on-chain
        </Link>
        <Link
          to={openTo}
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        >
          {bond ? "Open with a bond" : "Request to join"} <ArrowRight className="size-3.5" />
        </Link>
      </div>
    </li>
  );
}

// A room resolved by exact id (the search box). Mirrors a directory row but works for unlisted rooms too.
function LookupResult({ meta }: { meta: RoomMeta }) {
  if (!meta.discoverable && meta.exists !== true) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        No public room for that id. A private room reveals nothing here by design.
      </p>
    );
  }
  const bond = meta.bond ?? null;
  return (
    <ul className="mt-3 space-y-3">
      <RoomRow
        room={{
          roomId: meta.roomId,
          name: meta.name ?? null,
          description: meta.description ?? null,
          memberBucket: meta.memberBucket ?? "private",
          anonTier: meta.anonTier ?? "forming",
          listedAt: null,
          bond,
        }}
      />
    </ul>
  );
}

export default function Explorer() {
  const dir = useDirectory();
  const [tab, setTab] = useState<Tab>("membership");

  const membership = dir.rooms.filter((r) => !r.bond);
  const bonded = dir.rooms.filter((r) => r.bond);
  const active = tab === "membership" ? membership : bonded;

  const TABS: { key: Tab; label: string; count: number }[] = [
    { key: "membership", label: "Membership", count: membership.length },
    { key: "bonded", label: "Bonded Access", count: bonded.length },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Verify & explore"
        title="Explorer"
        lead={
          <>
            Public rooms that opted into the directory. <b>Membership</b> rooms admit approved readers;{" "}
            <b>Bonded Access</b> rooms let anyone who locks a qualifying bond in. You only ever see what an
            owner chose to publish. Member counts are coarse, and there is no record of who opened what.
          </>
        }
      />

      <SectionCard label="Find a room by id">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={dir.lookupId}
            onChange={(e) => dir.setLookupId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && dir.resolve()}
            placeholder="Paste a 64-hex room id"
            spellCheck={false}
            autoComplete="off"
            aria-label="Room id"
            data-testid="explorer-lookup-input"
            className="h-10 w-full rounded-md border border-input bg-card px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={() => dir.resolve()}
            disabled={dir.lookupBusy}
            className={cn(
              buttonVariants({ variant: "outline" }),
              "shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            )}
          >
            <Search className="size-4" /> {dir.lookupBusy ? "Looking…" : "Look up"}
          </button>
        </div>
        {dir.lookupErr && <p className="mt-3 text-sm text-destructive">{dir.lookupErr}</p>}
        {dir.lookupResult && <LookupResult meta={dir.lookupResult} />}
      </SectionCard>

      <SectionCard
        label="Public directory"
        aside={
          <div role="tablist" aria-label="Room type" className="inline-flex rounded-lg border bg-muted p-0.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                data-testid={`explorer-tab-${t.key}`}
                onClick={() => setTab(t.key)}
                className={cn(
                  "rounded-md px-3 py-1 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  tab === t.key
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label} <span className="tabular-nums opacity-70">{t.count}</span>
              </button>
            ))}
          </div>
        }
      >
        {dir.loading && <p className="text-sm text-muted-foreground">Loading public rooms…</p>}
        {dir.error && <p className="text-sm text-destructive">Could not load the directory: {dir.error}</p>}
        {!dir.loading && !dir.error && active.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="explorer-empty">
            {tab === "membership"
              ? "No public membership rooms listed yet."
              : "No public Bonded Access rooms listed yet."}
          </p>
        )}
        {active.length > 0 && (
          <ul className="space-y-3" data-testid={`explorer-list-${tab}`}>
            {active.map((r) => (
              <RoomRow key={r.roomId} room={r} />
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard label="Verify a specific proof">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Looking to re-check a bonded access grant or a Proof-of-Reserves instead of browsing rooms?{" "}
          <Link
            to="/verify"
            className="inline-flex items-center gap-1 rounded-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open Verify <ArrowRight className="size-3.5" />
          </Link>
        </p>
      </SectionCard>

      {dir.dataroomId && (
        <p className="px-1 text-xs text-muted-foreground">
          Reads from the public Data Room contract{" "}
          <a
            href={explorerUrl("contract", dir.dataroomId, "testnet")}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-brand hover:underline"
          >
            {short(dir.dataroomId, 6)} <ExternalLink className="size-3" />
          </a>
          .
        </p>
      )}
    </>
  );
}
