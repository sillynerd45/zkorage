import { ExternalLink, BadgeCheck, EyeOff, Files, KeyRound, Lock, Users, UserCheck, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { GlossaryTip } from "@/components/GlossaryTip";
import { Disclosure } from "@/components/Disclosure";
import { DataRow } from "@/components/app/blocks";
import { TaskCard, GroupLabel, type DRCategory } from "@/components/app/dataroom/kit";
import { M7ShowcasePanel } from "@/components/app/dataroom/M7ShowcasePanel";
import { useDataroomInfo } from "@/lib/hooks/useDataroomInfo";
import { short, explorer } from "@/lib/format";

// Task-oriented landing: one featured "Store a document" card, then an even grid of the remaining six
// tasks. Each card carries a category chip (Documents / Access / Share / Authenticity) instead of a
// fragmented section header, so the grid stays a clean 3 rows of 2. The header (title + one-line lead +
// committee pill) lives in the layout, so this page no longer repeats the description.
interface Task {
  to: string;
  label: string;
  blurb: string;
  testid: string;
  icon: LucideIcon;
  category?: DRCategory;
  star?: boolean;
}

const HERO: Task = {
  to: "/app/dataroom/documents#store",
  label: "Store a document",
  blurb: "Encrypt a file and post only a tamper-evident fingerprint. The contents never leave the prover you run.",
  testid: "task-store",
  icon: Lock,
};

const TASKS: Task[] = [
  {
    to: "/app/dataroom/documents#open",
    label: "Open with a key",
    blurb: "Decrypt a file in your browser with the recipient's key. Your key never leaves the page.",
    testid: "task-open",
    icon: KeyRound,
    category: "Documents",
  },
  {
    to: "/app/dataroom/documents#browse",
    label: "Browse documents",
    blurb: "See the rooms you own and the documents you stored. Contents stay encrypted.",
    testid: "task-browse",
    icon: Files,
    category: "Documents",
  },
  {
    to: "/app/dataroom/eligibility",
    label: "Get in anonymously",
    blurb: "Prove you're on the approved list without revealing who you are. Each pass works once.",
    testid: "task-eligibility",
    icon: UserCheck,
    category: "Access",
    star: true,
  },
  {
    to: "/app/dataroom/access",
    label: "Open a document",
    blurb: "Open files from rooms you have access to, decrypted in your browser.",
    testid: "task-access",
    icon: Users,
    category: "Access",
  },
  {
    to: "/app/dataroom/disclosure",
    label: "Share a masked copy",
    blurb: "Prove a fact about a sealed file, then share a redacted copy that's provably the real document.",
    testid: "task-disclosure",
    icon: EyeOff,
    category: "Share",
  },
  {
    to: "/app/dataroom/authenticity",
    label: "Prove a signed fact",
    blurb: 'Prove a fact a third party signed for you (for example "balance ≥ X") without showing the statement.',
    testid: "task-authenticity",
    icon: BadgeCheck,
    category: "Authenticity",
  },
];

function ExLink({ id }: { id: string }) {
  return (
    <a
      href={explorer("contract", id)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-brand hover:underline"
    >
      {short(id, 8)} <ExternalLink className="size-3" />
    </a>
  );
}

export default function DataRoomOverview() {
  const info = useDataroomInfo();
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
              category={t.category}
              star={t.star}
              testid={t.testid}
            />
          ))}
        </div>
      </div>

      {/* M7 — a wallet-free, read-only demonstration of the timing defense on a live showcase room (green meter
          + the on-chain grant log showing batched, shuffled accesses). Hides itself if the room is unreachable. */}
      <M7ShowcasePanel />

      {/* The concept + the on-chain trust anchor, demoted: there when you want them, not blocking the tasks.
          Wrapped in one calm card so they read as a "learn more" footer, matching the task cards above. */}
      <div className="space-y-3">
        <GroupLabel>Learn more</GroupLabel>
        <div className="divide-y divide-border/70 rounded-xl border bg-card px-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <Disclosure
            toggleTestId="overview-what-is"
            summary={
              <>
                New here? <b className="text-foreground">What is a confidential data room?</b>
              </>
            }
          >
            <p className="text-sm leading-relaxed text-muted-foreground">
              It's a shared room of <b className="text-foreground">encrypted</b> documents. The files themselves
              never go on the public record. Only a tamper-evident <b className="text-foreground">fingerprint</b>
              <GlossaryTip term="fingerprint" /> of each does, so anyone can confirm a document wasn't swapped
              out while the contents stay private.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              The hard part is <b className="text-foreground">who gets in</b>. Here you prove you're allowed to
              enter <b className="text-foreground">without revealing who you are</b>, and each pass works once.
              That is the one thing a normal login can't give you, and it's what this room is built around.
            </p>
          </Disclosure>

          <Disclosure
            toggleTestId="overview-onchain"
            summary={
              <>
                Check it on-chain: <b className="text-foreground">the contracts behind this room</b>
              </>
            }
          >
            <p className="mb-2 text-sm leading-relaxed text-muted-foreground">
              These are the live contracts this room runs on. Look them up on the public ledger to re-check any
              result here yourself.
            </p>
            <DataRow k="Network">testnet</DataRow>
            {info?.dataroomId && (
              <DataRow k="DataRoom contract">
                <ExLink id={info.dataroomId} />
              </DataRow>
            )}
            {info?.config?.verifier && (
              <DataRow k="Proof verifier">
                <ExLink id={info.config.verifier} />
              </DataRow>
            )}
            {info && (
              <DataRow k="Document storage" mono={false} testId="storage">
                {info.storage === "r2" ? "Cloudflare R2" : "local stand-in"}
              </DataRow>
            )}
            {info && (
              <DataRow k="Rooms" testId="room-count">
                {info.roomCount}
              </DataRow>
            )}
          </Disclosure>
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
