import { Link } from "react-router-dom";
import { ShieldCheck, Users, Coins, Wallet, type LucideIcon } from "lucide-react";
import { TaskCard, GroupLabel } from "@/components/app/dataroom/kit";

// Action-first landing, mirroring the Data Room Overview. The two flagship proofs lead as co-equal featured
// cards, then the two utility actions (lock, view) sit below. Each card maps to a real Bonded Proofs tab, so
// this page is a launcher, not an explainer. The header (title + one-line lead) lives in the layout, and the
// escrow concept + "why it is called a bond" text moved to the public Docs > Capabilities > Bonded Proofs.
interface Task {
  to: string;
  label: string;
  blurb: string;
  testid: string;
  icon: LucideIcon;
}

// The two ZK products built on the escrow. They lead the page.
const PROOFS: Task[] = [
  {
    to: "/app/bonded/prove",
    label: "Prove Solvency",
    blurb: "Prove your reserves cover supply, tied to a lock you can pull anytime.",
    testid: "bonded-task-prove",
    icon: ShieldCheck,
  },
  {
    to: "/app/bonded/tier",
    label: "Anonymous Tier",
    blurb: "Prove you bonded enough for a tier, without showing which wallet or how much.",
    testid: "bonded-task-tier",
    icon: Users,
  },
];

// The escrow itself: lock tokens, then read the locks you can act on.
const MANAGE: Task[] = [
  {
    to: "/app/bonded/deposit",
    label: "Lock tokens",
    blurb: "Lock tokens in escrow until a time you choose.",
    testid: "bonded-task-deposit",
    icon: Coins,
  },
  {
    to: "/app/bonded/balances",
    label: "My Balances",
    blurb: "The locks your connected wallet can act on.",
    testid: "bonded-task-balances",
    icon: Wallet,
  },
];

export default function BondedOverview() {
  return (
    <div data-testid="bonded-overview" className="space-y-6">
      {/* Two flagship proofs, co-equal. */}
      <div className="grid gap-3 sm:grid-cols-2">
        {PROOFS.map((t) => (
          <TaskCard
            key={t.to}
            to={t.to}
            icon={t.icon}
            title={t.label}
            blurb={t.blurb}
            testid={t.testid}
            featured
            tag="ZK proof"
          />
        ))}
      </div>

      <div className="space-y-3">
        <GroupLabel>Manage your bond</GroupLabel>
        <div className="grid gap-3 sm:grid-cols-2">
          {MANAGE.map((t) => (
            <TaskCard
              key={t.to}
              to={t.to}
              icon={t.icon}
              title={t.label}
              blurb={t.blurb}
              testid={t.testid}
            />
          ))}
        </div>
      </div>

      <p className="text-sm text-muted-foreground" data-testid="bonded-verify-note">
        Every proof and lock here is recorded on the public chain, <b className="text-foreground">checkable
        by anyone</b>.{" "}
        <Link to="/verify" className="text-brand hover:underline">
          Check it yourself →
        </Link>
      </p>
    </div>
  );
}
