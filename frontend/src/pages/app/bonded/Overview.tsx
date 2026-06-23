import { Link } from "react-router-dom";
import { KeyRound, Coins, Wallet, type LucideIcon } from "lucide-react";
import { TaskCard, GroupLabel } from "@/components/app/dataroom/kit";

// Action-first landing, mirroring the Data Room Overview. Bonded Access (the anonymous bond proof) leads as
// the single featured card; the two escrow utilities (lock, view) sit below. Prove Solvency is dropped from
// the pillar (it needs an off-chain attester, out of scope for the no-attester focus); its route stays live.
interface Task {
  to: string;
  label: string;
  blurb: string;
  testid: string;
  icon: LucideIcon;
}

// The flagship proof: lock a bond, prove access anonymously.
const HERO: Task = {
  to: "/app/bonded/tier",
  label: "Bonded Access",
  blurb: "Lock a bond to gain access, then prove it without revealing which wallet or how much.",
  testid: "bonded-task-tier",
  icon: KeyRound,
};

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
      {/* The flagship proof, full width. */}
      <TaskCard
        to={HERO.to}
        icon={HERO.icon}
        title={HERO.label}
        blurb={HERO.blurb}
        testid={HERO.testid}
        featured
        tag="ZK proof"
      />

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
