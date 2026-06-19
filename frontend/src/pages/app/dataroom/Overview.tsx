import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { GlossaryTip } from "@/components/GlossaryTip";
import { Disclosure } from "@/components/Disclosure";

// Task-oriented landing: lead with "what do you want to do?", grouped by the user's actual goals, each
// linking straight to the right page (the document tasks deep-link to sections of /dataroom/documents).
// The conceptual "what is this?" is demoted behind an expander — available, but not what greets a user.
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
        blurb: "Encrypt a file and post only a tamper-evident fingerprint — the contents never leave the prover you run.",
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
        blurb: "List every file in a room. Anyone can read the record; the contents stay hidden.",
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
        blurb: "Prove you're on the approved list without revealing who you are — and only once.",
        testid: "task-eligibility",
        star: true,
      },
      {
        to: "/app/dataroom/policy",
        label: "Meet all conditions",
        blurb: "Be admitted only if you satisfy every rule at once (e.g. member, KYC'd, and accredited).",
        testid: "task-policy",
      },
    ],
  },
  {
    title: "Release & share",
    tasks: [
      {
        to: "/app/dataroom/release",
        label: "Release the key",
        blurb: "No single server holds a file's key — it takes 2 of 3 separate keepers to release it.",
        testid: "task-release",
      },
      {
        to: "/app/dataroom/disclosure",
        label: "Share a masked copy",
        blurb: "Prove a fact about a sealed file and share a redacted copy that's provably the real document.",
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
        blurb: 'Prove a fact a third party signed for you (e.g. "balance ≥ X") without showing the statement.',
        testid: "task-authenticity",
      },
    ],
  },
];

export default function DataRoomOverview() {
  return (
    <div data-testid="dataroom-overview" className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">What do you want to do?</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          A private place to keep sensitive files and control exactly who can open them. Pick a task — each
          one is its own page.
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

      {/* The concept, demoted — there when you want it, not blocking the tasks. */}
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
          never go on the public record — only a tamper-evident{" "}
          <b className="text-foreground">fingerprint</b>
          <GlossaryTip term="fingerprint" /> of each does, so anyone can confirm a document wasn't swapped
          out, while the contents stay private.
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The hard part is <b className="text-foreground">who gets in</b>. Here you prove you're{" "}
          <b className="text-foreground">allowed to enter — without revealing who you are</b>, and each pass
          works <b className="text-foreground">once</b>. That's the one thing only a{" "}
          <b className="text-foreground">private proof</b>
          <GlossaryTip term="private proof" /> can give you, and it's what this room is built around.
        </p>
      </Disclosure>

      <p className="text-sm text-muted-foreground" data-testid="overview-verify-note">
        Don't take our word for it: every result here is{" "}
        <b className="text-foreground">checkable by anyone</b>, directly on the public record — no wallet, no
        account.{" "}
        <Link to="/verify" className="text-brand hover:underline">
          Verify it yourself →
        </Link>
      </p>
    </div>
  );
}
