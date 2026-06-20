import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { GROUPS, byGroup } from "@/lib/content";
import { useHomeStats } from "@/lib/hooks/useHomeStats";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NavCard, StatTile } from "@/components/app/blocks";

// The app Home. The "How it works" and "Don't trust, verify" asides moved to the Landing page and Docs.
// Here we keep the greeting, quick actions, lightweight live stats, and the grouped capability cards
// (Data Room first, then the proofs). Verify/Explorer/Developer are public surfaces, reached from the footer.
const APP_GROUPS = ["dataroom", "prove"].map((key) => GROUPS.find((g) => g.key === key)!);

export default function Home() {
  const stats = useHomeStats();
  const num = (n: number | null) => (n == null ? "–" : n.toLocaleString());

  return (
    <div data-testid="dashboard">
      {/* greeting */}
      <div className="mb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand">Welcome to zkorage</p>
        <h1 className="mt-1.5 text-3xl font-bold tracking-tight">Prove a private fact. Verify it on-chain.</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
          Pick a capability below, or start with the Data Room. Every result here is re-checkable by
          anyone on Stellar. No wallet, no account.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link to="/app/dataroom" className={cn(buttonVariants())}>
            Open the Data Room <ArrowRight className="size-4" />
          </Link>
          <Link to="/verify" className={cn(buttonVariants({ variant: "outline" }))}>
            Verify a proof
          </Link>
        </div>
      </div>

      {/* live stats */}
      <div className="mb-8 grid gap-3 sm:grid-cols-3" data-testid="home-stats">
        <StatTile label="Verified records" value={num(stats.verifiedRecords)} hint="Proof-of-Reserves on-chain" />
        <StatTile label="Data rooms" value={num(stats.rooms)} hint="created on this engine" />
        <StatTile label="Capabilities" value="6" hint="5 proofs + the Data Room" />
      </div>

      {/* grouped capability cards */}
      <div className="space-y-7">
        {APP_GROUPS.map((g) => (
          <section key={g.key}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {g.label}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {byGroup(g.key).map((c) => (
                <NavCard key={c.key} to={c.to} icon={c.icon} title={c.title} blurb={c.blurb} proves={c.proves} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
