import { Users } from "lucide-react";
import { cn } from "@/lib/utils";

// M4: the anonymity meter for Model B rooms. Anonymity is only real with a crowd: a member's proof hides
// WHICH member acted, but only among the room's eligible set. Below the floor the set is too small to hide in,
// so access is disabled. N = the room's eligible-set size.
export const ANON_FLOOR = 5; // hard floor: access disabled below this many members
const STRONG = 20; // target: green at/above this

type Tier = "red" | "amber" | "green";

export function anonTier(count: number): Tier {
  if (count < ANON_FLOOR) return "red";
  if (count < STRONG) return "amber";
  return "green";
}

const COPY: Record<Tier, { label: string; note: string }> = {
  red: { label: "Below the floor", note: `access is disabled below ${ANON_FLOOR} members` },
  amber: { label: "Limited anonymity", note: `aim for ${STRONG}+ to hide in a real crowd` },
  green: { label: "Strong anonymity", note: "a large set to hide in" },
};

const DOT: Record<Tier, string> = {
  red: "bg-destructive",
  amber: "bg-amber-500",
  green: "bg-emerald-500",
};

const RING: Record<Tier, string> = {
  red: "border-destructive/40 bg-destructive/5",
  amber: "border-amber-500/40 bg-amber-500/5",
  green: "border-emerald-500/40 bg-emerald-500/5",
};

/** Show a room's anonymity strength from its eligible-set size. `count` null = unknown (room not resolved). */
export function AnonymityMeter({ count }: { count: number | null }) {
  if (count === null) return null;
  const tier = anonTier(count);
  const c = COPY[tier];
  return (
    <div
      data-testid="anon-meter"
      data-tier={tier}
      className={cn("flex items-center gap-3 rounded-xl border px-3.5 py-2.5", RING[tier])}
    >
      <span className={cn("size-2.5 shrink-0 rounded-full", DOT[tier])} aria-hidden="true" />
      <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 text-[13px]">
        <span className="font-medium">{c.label}</span>
        <span className="text-muted-foreground">
          {" · "}
          <span data-testid="anon-meter-count">{count}</span> member{count === 1 ? "" : "s"} · {c.note}
        </span>
      </div>
    </div>
  );
}
