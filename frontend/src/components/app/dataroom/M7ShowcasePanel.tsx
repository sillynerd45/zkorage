import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Callout } from "@/components/app/dataroom/kit";
import { AnonymityMeter, ANON_FLOOR } from "@/components/app/dataroom/AnonymityMeter";
import { getEligible, getGrants, type GrantLogEntry } from "@/lib/api";
import { DEMO_MODELB_SHOWCASE_ROOM } from "zkorage-sdk";
import { ShieldQuestion, Clock } from "lucide-react";
import { short } from "@/lib/format";

// M7 — a read-only, WALLET-FREE demonstration of the timing defense, using a stable showcase room on testnet.
// A visitor sees the room's anonymity meter (a real eligible set) and its on-chain grant log: the accesses
// recorded in one flush window land CLUSTERED in time and SHUFFLED in order, so the public record shows that an
// approved member accessed in a window, not who acted when. All on-chain reads, no wallet, reveals nothing
// private (the accessor + timestamp are public by design).
export function M7ShowcasePanel() {
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [grants, setGrants] = useState<GrantLogEntry[] | null>(null);

  useEffect(() => {
    let live = true;
    getEligible(DEMO_MODELB_SHOWCASE_ROOM)
      .then((r) => { if (live) setMemberCount(r.memberCount); })
      .catch(() => { if (live) setMemberCount(null); });
    getGrants(DEMO_MODELB_SHOWCASE_ROOM, 8)
      .then((r) => { if (live) setGrants(r.grants); })
      .catch(() => { if (live) setGrants(null); });
    return () => { live = false; };
  }, []);

  // Render only when the showcase is fully provisioned: a real anonymity set AND the on-chain access record.
  // The meter count comes from the OFF-CHAIN eligible store (only the serving backend has it); if that store
  // was reset while the grants are still on-chain, memberCount comes back 0. Hiding then is better than showing
  // a contradictory red "below the floor" meter beside a real access log. Below the floor it is not a showcase.
  if (memberCount === null || memberCount < ANON_FLOOR || !grants || grants.length === 0) return null;

  // The most recent batch: the grants share a flush window, so their timestamps cluster. Report the spread.
  const recent = (grants ?? []).slice(-4);
  const times = recent.map((g) => g.timestamp).filter((t) => t > 0);
  const spread = times.length ? Math.max(...times) - Math.min(...times) : 0;
  const fmt = (t: number) => (t > 0 ? new Date(t * 1000).toLocaleTimeString() : "pending");

  return (
    <Card className="rounded-2xl border-brand/40 p-6" data-testid="m7-showcase">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight">Anonymous access, with the timing hidden</h3>
        <span className="text-[11px] uppercase tracking-wide text-brand">live on testnet · no wallet needed</span>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Proving membership hides <b className="text-foreground">which</b> member opened a document. On its own
        that is not enough: a room owner who knows the member list could still watch <b className="text-foreground">when</b>{" "}
        each access lands on-chain and guess. So accesses are not recorded the instant you prove. They are held
        and written to the chain <b className="text-foreground">together, in a shuffled batch, at a fixed window
        boundary</b>, so the public record shows that an approved member accessed in a window, not who or exactly
        when. This is a real room on testnet you can read without a wallet.
      </p>

      <div className="mt-4">
        <AnonymityMeter count={memberCount} />
      </div>

      {recent.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-medium">
            <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
            Recent access record (on-chain)
          </div>
          <div className="overflow-hidden rounded-xl border" data-testid="m7-showcase-grants">
            {recent.map((g) => (
              <div
                key={g.index}
                className="flex items-center justify-between gap-3 border-b border-border/60 px-3.5 py-2 text-[13px] last:border-b-0"
              >
                <span className="font-mono text-xs text-muted-foreground">access #{g.index}</span>
                <span className="font-mono text-xs">{short(g.accessor, 6)}</span>
                <span className="tabular-nums text-muted-foreground">{fmt(g.timestamp)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground" data-testid="m7-showcase-spread">
            These {recent.length} accesses landed within {spread} second{spread === 1 ? "" : "s"} of each other,
            in the order the relay shuffled them, not the order the members acted. The on-chain time and order
            show the window, not who acted when.
          </p>
        </div>
      )}

      <div className="mt-4">
        <Callout icon={ShieldQuestion}>
          Honest about the limits: how well an access hides depends on how many others land in the same window,
          and over many windows a pattern can still narrow. The on-chain record also notes which membership
          snapshot you proved against, so a stable member list gives everyone the same cover. This hides you from
          the room owner, not from the people running the prover. The {memberCount} members here are distinct
          identities set up for the demo, not {memberCount} separate people.
        </Callout>
      </div>
    </Card>
  );
}
