import { Link } from "react-router-dom";
import { Clock, Coins, KeyRound } from "lucide-react";
import { Panel } from "@/components/app/blocks";
import { buttonVariants } from "@/components/ui/button";

const STEPS = [
  {
    icon: Clock,
    title: "Choose an unlock time",
    body: "Lock an amount of the test token until a future moment. You can extend the lock later, but never shorten it.",
  },
  {
    icon: Coins,
    title: "Funds stay locked",
    body: "Until the unlock time, the tokens cannot move. If you mark the lock revocable, you can pull them back early.",
  },
  {
    icon: KeyRound,
    title: "Release when it unlocks",
    body: "After the unlock time, withdraw a self-bond, or let a named recipient claim a one-way send.",
  },
];

export default function BondedOverview() {
  return (
    <div className="grid gap-4" data-testid="bonded-overview">
      <Panel title="What this is">
        <p className="max-w-3xl text-[14px] leading-relaxed text-muted-foreground">
          A time-locked escrow on Stellar. You lock tokens until a time you choose, and until then the
          funds cannot move. The lock is the bond behind the time-bound proofs we are building next: a proof
          a verifier should trust only while real money stays locked, and which you can void by pulling the
          bond. There is no ZK here yet; this tab is the escrow and your balances.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link to="/app/bonded/deposit" className={buttonVariants({ variant: "brand" })}>
            Lock tokens
          </Link>
          <Link to="/app/bonded/balances" className={buttonVariants({ variant: "outline" })}>
            View my balances
          </Link>
        </div>
      </Panel>

      <div className="grid gap-4 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <Panel key={s.title}>
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
                <s.icon className="size-4" />
              </span>
              <div>
                <h3 className="text-[13px] font-semibold">
                  {i + 1}. {s.title}
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
            </div>
          </Panel>
        ))}
      </div>

      <Panel title="A note on the name">
        <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
          A bond is the opposite of most locks you know. Here the proof built on a lock is valid while the
          balance stays locked, and stops being valid the moment the balance frees up. So a lock that is
          still locked is the useful state, not the finished one.
        </p>
      </Panel>
    </div>
  );
}
