import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { byGroup } from "@/lib/content";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NavCard } from "@/components/app/blocks";

// The app Home. The "How it works" and "Don't trust, verify" asides moved to the Landing page and Docs.
// Here we keep the greeting, quick actions, and the capability cards (Data Room + Bonded Proofs) in one
// row that fills the width. Verify/Explorer/Developer are public surfaces, reached from the footer.
const APP_CARDS = (["dataroom", "bonded"] as const).flatMap((key) => byGroup(key));

export default function Home() {
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

      {/* capability cards: Data Room + Bonded Proofs, side by side so they fill the row */}
      <div className="grid gap-4 sm:grid-cols-2">
        {APP_CARDS.map((c) => (
          <NavCard key={c.key} to={c.to} icon={c.icon} title={c.title} blurb={c.blurb} proves={c.proves} />
        ))}
      </div>
    </div>
  );
}
