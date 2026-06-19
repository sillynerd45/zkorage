import { Link } from "react-router-dom";
import { ChevronRight, ExternalLink } from "lucide-react";
import { GlossaryTip } from "@/components/GlossaryTip";
import { Disclosure } from "@/components/Disclosure";
import { DataRow } from "@/components/app/blocks";
import { useDataroomInfo } from "@/lib/hooks/useDataroomInfo";
import { short, explorer } from "@/lib/format";

// Task-oriented landing: lead with "what do you want to do?", grouped by the user's actual goals, each
// linking straight to the right page (the document tasks deep-link to sections of /dataroom/documents).
// The concept and the on-chain addresses are demoted behind expanders, not what greets a new user.
interface Task {
  to: string;
  label: string;
  blurb: string;
  testid: string;
  star?: boolean;
}
interface Group {
  title: string;
  tasks: Task[];
}

const GROUPS: Group[] = [
  {
    title: "Your documents",
    tasks: [
      {
        to: "/app/dataroom/documents#store",
        label: "Store a document",
        blurb: "Encrypt a file and post only a tamper-evident fingerprint. The contents never leave the prover you run.",
        testid: "task-store",
      },
      {
        to: "/app/dataroom/documents#open",
        label: "Open a document",
        blurb: "Decrypt a file in your browser with the recipient's key. Your key never leaves the page.",
        testid: "task-open",
      },
      {
        to: "/app/dataroom/documents#browse",
        label: "Browse documents",
        blurb: "See the rooms you own and the documents you stored. Contents stay encrypted.",
        testid: "task-browse",
      },
    ],
  },
  {
    title: "Who gets in",
    tasks: [
      {
        to: "/app/dataroom/eligibility",
        label: "Get in anonymously",
        blurb: "Prove you're on the approved list without revealing who you are. Each pass works once.",
        testid: "task-eligibility",
        star: true,
      },
      {
        to: "/app/dataroom/access",
        label: "Open a shared document",
        blurb: "Prove a document's conditions (member, KYC'd, accredited), then its keepers release the key to you.",
        testid: "task-access",
      },
    ],
  },
  {
    title: "Share",
    tasks: [
      {
        to: "/app/dataroom/disclosure",
        label: "Share a masked copy",
        blurb: "Prove a fact about a sealed file, then share a redacted copy that's provably the real document.",
        testid: "task-disclosure",
      },
    ],
  },
  {
    title: "Authenticity",
    tasks: [
      {
        to: "/app/dataroom/authenticity",
        label: "Prove a signed fact",
        blurb: 'Prove a fact a third party signed for you (for example "balance ≥ X") without showing the statement.',
        testid: "task-authenticity",
      },
    ],
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
      <div>
        <h2 className="text-lg font-semibold tracking-tight">What do you want to do?</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          A private place to keep sensitive files and decide who can open them. Pick a task. Each one is its
          own page.
        </p>
      </div>

      <div className="space-y-5">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {g.title}
            </h3>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {g.tasks.map((t) => (
                <Link
                  key={t.to}
                  to={t.to}
                  data-testid={t.testid}
                  className="group block focus-visible:outline-none"
                >
                  <div className="flex h-full items-start gap-3 rounded-2xl border bg-card p-4 transition-colors hover:border-brand/30 hover:bg-accent/40 group-focus-visible:ring-2 group-focus-visible:ring-ring">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <h4 className="font-semibold tracking-tight">{t.label}</h4>
                        {t.star && <span aria-hidden="true">⭐</span>}
                      </div>
                      <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{t.blurb}</p>
                    </div>
                    <ChevronRight className="size-5 shrink-0 self-center text-muted-foreground transition-colors group-hover:text-brand" />
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* The concept, demoted: there when you want it, not blocking the tasks. */}
      <Disclosure
        toggleTestId="overview-what-is"
        summary={
          <>
            New here? <b className="text-foreground">What is a confidential data room?</b>
          </>
        }
      >
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          It's a shared room of <b className="text-foreground">encrypted</b> documents. The files themselves
          never go on the public record. Only a tamper-evident <b className="text-foreground">fingerprint</b>
          <GlossaryTip term="fingerprint" /> of each does, so anyone can confirm a document wasn't swapped
          out while the contents stay private.
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The hard part is <b className="text-foreground">who gets in</b>. Here you prove you're allowed to
          enter <b className="text-foreground">without revealing who you are</b>, and each pass works once.
          That is the one thing a normal login can't give you, and it's what this room is built around.
        </p>
      </Disclosure>

      {/* The trust anchor: the live contracts, so a skeptic can re-check everything. One place, explained. */}
      <Disclosure
        toggleTestId="overview-onchain"
        summary={
          <>
            Check it on-chain: <b className="text-foreground">the contracts behind this room</b>
          </>
        }
      >
        <p className="mb-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
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
