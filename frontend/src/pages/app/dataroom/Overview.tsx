import { Compass, Files, FolderOpen, Lock, UserPlus, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { TaskCard, GroupLabel } from "@/components/app/dataroom/kit";

// Task-oriented landing: one featured "Store a document" card, then a grid of the remaining tasks. Each card
// maps to a real place in the Data Room nav (Documents > Open / Store / My files, plus Membership and
// Discover), so "All tasks" mirrors the actual menu. The header (title + one-line lead + committee pill)
// lives in the layout, so this page does not repeat the description. The concept explainer and the on-chain
// contract list moved off this page (to Documentation and to the Contracts reference page).
interface Task {
  to: string;
  label: string;
  blurb: string;
  testid: string;
  icon: LucideIcon;
}

const HERO: Task = {
  to: "/app/dataroom/documents#store",
  label: "Store a document",
  blurb: "Encrypt a file in your browser and post only a tamper-evident fingerprint. The file and its key never reach our server.",
  testid: "task-store",
  icon: Lock,
};

const TASKS: Task[] = [
  {
    to: "/app/dataroom/documents#open",
    label: "Open a document",
    blurb: "Open files from a room you have been approved for. They are decrypted in your browser.",
    testid: "task-access",
    icon: FolderOpen,
  },
  {
    to: "/app/dataroom/documents#mine",
    label: "My files",
    blurb: "See the rooms you own and the documents you stored. Contents stay encrypted.",
    testid: "task-browse",
    icon: Files,
  },
  {
    to: "/app/dataroom/membership",
    label: "Membership",
    blurb: "Request to join a room, or approve people who asked to join a room you own.",
    testid: "task-membership",
    icon: UserPlus,
  },
  {
    to: "/app/dataroom/discover",
    label: "Discover",
    blurb: "Browse rooms that listed themselves publicly, or look one up by its id.",
    testid: "task-discover",
    icon: Compass,
  },
];

export default function DataRoomOverview() {
  return (
    <div data-testid="dataroom-overview" className="space-y-6">
      {/* The primary action, full width. */}
      <TaskCard
        to={HERO.to}
        icon={HERO.icon}
        title={HERO.label}
        blurb={HERO.blurb}
        testid={HERO.testid}
        featured
      />

      <div className="space-y-3">
        <GroupLabel>All tasks</GroupLabel>
        <div className="grid gap-3 sm:grid-cols-2">
          {TASKS.map((t) => (
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

      <p className="text-sm text-muted-foreground" data-testid="overview-verify-note">
        Every result here is <b className="text-foreground">checkable by anyone</b>, directly on the public
        record. No wallet, no account.{" "}
        <Link to="/verify" className="text-brand hover:underline">
          Verify it yourself →
        </Link>
      </p>
    </div>
  );
}
