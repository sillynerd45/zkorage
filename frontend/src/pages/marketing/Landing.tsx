import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  FileSignature,
  Cpu,
  BadgeCheck,
  Compass,
  FolderLock,
  Lock,
  Check,
  ChevronDown,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Reveal } from "@/components/marketing/Reveal";
import { useContracts } from "@/lib/hooks/useContracts";
import { getCommitteeInfo, type CommitteeInfoResp } from "@/lib/api";
import { short, explorer } from "@/lib/format";
import { cn } from "@/lib/utils";

const ring =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

// Accurate to BOTH products (the old "Attest / Prove / Verify" strip wrongly implied a third-party attester
// for everything; the two pillars anchor on-chain instead).
const STEPS = [
  { icon: FileSignature, t: "Anchor", d: "Seal a document or lock a bond on-chain. A document is encrypted first, so no one can read it." },
  { icon: Cpu, t: "Prove", d: "A self-hosted zkVM proves the fact. The data never leaves the prover you run." },
  { icon: BadgeCheck, t: "Verify", d: "Anyone re-checks the result on Stellar and gets the same answer. No wallet, no account." },
];

const PILLARS = [
  {
    testid: "pillar-dataroom",
    eyebrow: "Data Room",
    title: "Data Room",
    icon: FolderLock,
    what: "Share sealed documents and admit readers anonymously.",
    problem:
      "Sharing sensitive files today means trusting a host with your documents and leaking who is looking at what.",
    bullets: [
      "Files stay encrypted. Only a tamper-evident fingerprint goes on-chain.",
      "A reader proves they are an approved member, or that they hold a qualifying bond, without revealing who they are.",
      "The access decision is recorded on the public ledger, so it can be re-checked later.",
    ],
    appTo: "/app/dataroom",
    docsTo: "/docs/data-room",
    cta: "Open the Data Room",
  },
  {
    testid: "pillar-bonded",
    eyebrow: "Bonded Proofs",
    title: "Bonded Proofs",
    icon: Lock,
    what: "Lock tokens until a time you choose, then prove a fact that holds only while the bond stays locked.",
    problem: "Proving skin in the game or proof of funds normally means showing your wallet and your balance.",
    bullets: [
      "Prove you meet a requirement without showing your wallet or the amount.",
      "The proof dies the moment you pull your collateral, so it cannot be faked after the fact.",
      "Use a bond to enter a gated room, or to back a claim that anyone can re-check.",
    ],
    appTo: "/app/bonded",
    docsTo: "/docs/bonded-proofs",
    cta: "Open Bonded Proofs",
  },
];

const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: "Is my data revealed?",
    a: "No. The data stays with you. A self-hosted prover reads it to produce a proof, and only the proof and a fingerprint are published. Documents in a Data Room are encrypted before they leave your browser.",
  },
  {
    q: "Do I need a wallet to verify a result?",
    a: "No. Verifying reads the public ledger, so anyone can re-check a result with no wallet and no account. You only need a wallet to create a room, lock a bond, or store a document.",
  },
  {
    q: "Who can see who accessed what?",
    a: "A reader proves they are eligible without revealing who they are. The room owner sees that an approved reader got in, not which person. The access decision is on-chain; the identity behind it is not.",
  },
  {
    q: "What actually goes on-chain?",
    a: "A tamper-evident fingerprint of a sealed document or a locked bond, the proof, and the result of checking it. The document contents and the private values behind a claim never go on-chain.",
  },
];

// Ambient backdrop: soft blue to emerald glow + a faint grid, concentrated behind the hero and masked to fade
// out down the page. Decorative only (aria-hidden + pointer-events-none, scoped to the page's -z-10 layer).
function AuroraBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 -z-10 w-screen -translate-x-1/2 overflow-hidden">
      {/* Full-bleed so the glow reaches the viewport edges, not just the padded content column (which read as
          a rectangle). Soft radial glows behind the hero; each fades to transparent on its own (closest-side),
          so the backdrop dissolves into the page with no hard edge or rectangular band. */}
      <div className="absolute -left-40 -top-48 h-[600px] w-[600px] rounded-full blur-3xl motion-safe:animate-aurora-one bg-[radial-gradient(closest-side,hsl(var(--brand)/0.20),transparent)]" />
      <div className="absolute -right-36 -top-40 h-[560px] w-[560px] rounded-full blur-3xl motion-safe:animate-aurora-two bg-[radial-gradient(closest-side,hsl(var(--success)/0.16),transparent)]" />
      <div className="absolute left-1/2 top-24 h-[520px] w-[820px] -translate-x-1/2 rounded-full blur-3xl motion-safe:animate-aurora-one bg-[radial-gradient(closest-side,hsl(var(--brand)/0.10),transparent)]" />
      {/* Faint grid, masked to a soft ellipse from the top (see .aurora-grid in index.css), so it has no edge. */}
      <div className="aurora-grid absolute inset-x-0 top-0 h-[620px] opacity-50 dark:opacity-30" />
    </div>
  );
}

function PillarCard({
  eyebrow,
  title,
  what,
  problem,
  bullets,
  appTo,
  docsTo,
  cta,
  testid,
  icon: Icon,
  index,
}: {
  eyebrow: string;
  title: string;
  what: string;
  problem: string;
  bullets: string[];
  appTo: string;
  docsTo: string;
  cta: string;
  testid: string;
  icon: LucideIcon;
  index: number;
}) {
  return (
    <Reveal as="article" index={index} step={120} className="flex flex-col rounded-2xl border bg-card p-7 shadow-sm" data-testid={testid}>
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-lg bg-brand/10 text-brand">
          <Icon className="size-5" />
        </span>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">{eyebrow}</p>
      </div>
      <h3 className="mt-3 text-2xl font-bold tracking-tight">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{what}</p>
      <p className="mt-4 text-sm leading-relaxed">
        <span className="font-medium text-foreground">The problem. </span>
        <span className="text-muted-foreground">{problem}</span>
      </p>
      <ul className="mt-4 space-y-2.5">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-2.5 text-sm leading-relaxed text-muted-foreground">
            <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6 flex flex-wrap gap-3 pt-1">
        <Link to={appTo} className={cn(buttonVariants(), "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card")}>
          {cta} <ArrowRight className="size-4" />
        </Link>
        <Link to={docsTo} className={cn(buttonVariants({ variant: "ghost" }), "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card")}>
          Learn more
        </Link>
      </div>
    </Reveal>
  );
}

function VerifyCta() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    // Forward the raw paste to the Verify page, which auto-detects the type and routes to the right read.
    navigate(`/verify?q=${encodeURIComponent(v)}`);
  }
  return (
    <section className="mb-16 sm:mb-20" data-testid="verify-cta">
      <Reveal className="rounded-2xl border bg-card p-7">
        <h2 className="text-xl font-semibold tracking-tight">Don't trust. Verify.</h2>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
          Every result zkorage publishes is checkable by anyone, on the public ledger. No wallet, no account,
          no need to trust our server.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <form onSubmit={onSubmit} className="rounded-xl border bg-background p-5">
            <label htmlFor="verify-cta-input" className="text-sm font-medium text-foreground">
              Check a specific proof
            </label>
            <p id="verify-cta-hint" className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Paste a verify link or a proof id.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                id="verify-cta-input"
                data-testid="verify-cta-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                aria-describedby="verify-cta-hint"
                placeholder="Paste a verify link or id"
                spellCheck={false}
                autoComplete="off"
                className="h-10 w-full rounded-md border border-input bg-card px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="submit"
                className={cn(buttonVariants({ variant: "brand" }), "shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background")}
              >
                <BadgeCheck className="size-4" /> Check
              </button>
            </div>
          </form>
          <div className="flex flex-col justify-between rounded-xl border bg-background p-5">
            <div>
              <p className="text-sm font-medium text-foreground">Browse public rooms</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                See the rooms owners opted into the directory, by membership or bonded access.
              </p>
            </div>
            <Link
              to="/explorer"
              data-testid="verify-cta-explorer"
              className={cn(buttonVariants({ variant: "outline" }), "mt-3 w-fit", ring)}
            >
              <Compass className="size-4" /> Open Explorer
            </Link>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function ContractStat({ label, id, loading }: { label: string; id: string | null; loading: boolean }) {
  return (
    <div className="rounded-xl border bg-background p-4">
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 text-sm">
        {!id ? (
          <span className="text-muted-foreground">{loading ? "Loading…" : "unavailable"}</span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <code className="font-mono text-xs text-muted-foreground">{short(id, 4)}</code>
            <a
              href={explorer("contract", id, "testnet")}
              target="_blank"
              rel="noreferrer"
              aria-label={`View the ${label} contract on the explorer`}
              className={cn("rounded-sm text-muted-foreground transition-colors hover:text-foreground", ring)}
            >
              <ExternalLink className="size-4" />
            </a>
          </span>
        )}
      </dd>
    </div>
  );
}

function LiveStatus() {
  const [info, setInfo] = useState<CommitteeInfoResp | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(true);
  const c = useContracts();
  useEffect(() => {
    let live = true;
    getCommitteeInfo()
      .then((i) => live && setInfo(i))
      .catch(() => live && setErr(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);
  const online = info ? info.online >= info.n : false;
  return (
    <section className="mb-16 sm:mb-20" data-testid="live-status">
      <Reveal className="rounded-2xl border bg-card p-7">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">Live on testnet</h2>
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" aria-hidden /> Stellar testnet
          </span>
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The contracts and the key-release committee this site points at right now.
        </p>
        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border bg-background p-4">
            <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Committee</dt>
            <dd className="mt-1.5 text-sm">
              {loading ? (
                <span className="text-muted-foreground">Checking…</span>
              ) : err || !info ? (
                <span className="text-muted-foreground">Status unavailable</span>
              ) : (
                <span className="inline-flex items-center gap-2 font-medium">
                  <span className={cn("size-2 rounded-full", online ? "bg-success" : "bg-warning")} aria-hidden />
                  {info.online} of {info.n} keepers online
                </span>
              )}
            </dd>
          </div>
          <ContractStat label="Data Room" id={c.dataroomId} loading={c.loading} />
          <ContractStat label="Escrow" id={c.escrowId} loading={c.loading} />
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          These are unaudited demo contracts on Stellar testnet, not for production funds.
        </p>
      </Reveal>
    </section>
  );
}

function FaqItem({ q, a }: { q: string; a: ReactNode }) {
  return (
    <details className="group rounded-xl border bg-card px-5 [&_summary::-webkit-details-marker]:hidden [&_summary]:list-none">
      <summary className={cn("flex cursor-pointer items-center justify-between gap-4 rounded-md py-4 text-sm font-medium text-foreground", ring)}>
        <span>{q}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" aria-hidden />
      </summary>
      <div className="pb-4 pr-8 text-sm leading-relaxed text-muted-foreground">{a}</div>
    </details>
  );
}

export default function Landing() {
  return (
    <div data-testid="overview" className="relative isolate">
      <AuroraBackdrop />

      {/* hero */}
      <section className="mb-16 pt-6 sm:mb-20 sm:pt-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand">
          zkorage · verifiable claims on Stellar
        </p>
        <h1 className="mt-3 max-w-3xl text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
          Prove a private fact. <span className="text-muted-foreground">Verify it on Stellar.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
          zkorage seals sensitive documents and proves facts about private data, so a verifier learns one fact
          and nothing else. Anyone can re-check the result on the public ledger, with no account and no access
          to the data.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link to="/app" data-testid="hero-open-app" className={cn(buttonVariants({ size: "lg" }), ring)}>
            Open app <ArrowRight className="size-4" />
          </Link>
          <Link to="/docs" className={cn(buttonVariants({ variant: "outline", size: "lg" }), ring)}>
            Read the docs
          </Link>
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-card/70 px-2.5 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
            <span className="size-1.5 rounded-full bg-success" aria-hidden /> Running on Stellar testnet
          </span>
        </div>
      </section>

      {/* how it works */}
      <section className="mb-16 sm:mb-20" data-testid="how-it-works">
        <Reveal className="mb-5">
          <h2 className="text-xl font-semibold tracking-tight">How it works</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            The same three steps power both products.
          </p>
        </Reveal>
        <div className="grid gap-3 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <Reveal key={s.t} index={i} className="rounded-xl border bg-card p-5">
              <div className="flex items-center gap-2.5">
                <span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <s.icon className="size-4" />
                </span>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {i + 1} · {s.t}
                </span>
              </div>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* the two pillars */}
      <section className="mb-16 sm:mb-20" data-testid="pillars">
        <Reveal className="mb-5">
          <h2 className="text-xl font-semibold tracking-tight">Two products on one engine</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Both run against the live testnet. Open either in the app.
          </p>
        </Reveal>
        <div className="grid gap-5 lg:grid-cols-2">
          {PILLARS.map((p, i) => (
            <PillarCard key={p.testid} index={i} {...p} />
          ))}
        </div>
      </section>

      {/* don't trust. verify */}
      <VerifyCta />

      {/* live on testnet */}
      <LiveStatus />

      {/* faq */}
      <section className="mb-16 sm:mb-20" data-testid="faq">
        <Reveal className="mb-5">
          <h2 className="text-xl font-semibold tracking-tight">Questions</h2>
        </Reveal>
        <Reveal className="space-y-3">
          {FAQS.map((f) => (
            <FaqItem key={f.q} q={f.q} a={f.a} />
          ))}
        </Reveal>
      </section>

      {/* closing cta */}
      <section className="mb-4" data-testid="closing-cta">
        <Reveal className="overflow-hidden rounded-2xl border bg-gradient-to-br from-brand/10 via-card to-success/10 p-8 text-center sm:p-10">
          <h2 className="text-2xl font-bold tracking-tight">See it run on testnet</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Open a room, lock a bond, or re-check a published result. Everything runs against the live Stellar
            testnet.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link to="/app" data-testid="closing-cta-open-app" className={cn(buttonVariants({ size: "lg" }), ring)}>
              Open app <ArrowRight className="size-4" />
            </Link>
            <Link to="/docs" className={cn(buttonVariants({ variant: "outline", size: "lg" }), ring)}>
              Read the docs
            </Link>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
