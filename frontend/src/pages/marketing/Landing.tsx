import { Link } from "react-router-dom";
import { ArrowRight, FileSignature, Cpu, BadgeCheck, Compass, Terminal } from "lucide-react";
import { byGroup, capability } from "@/lib/content";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FeatureCard } from "@/components/marketing/blocks";

const STEPS = [
  { icon: FileSignature, t: "Attest", d: "A trusted source signs the private data (custodian, KYC provider, bank)." },
  { icon: Cpu, t: "Prove", d: "A self-hosted zkVM proves the fact. The data never leaves the prover you run." },
  { icon: BadgeCheck, t: "Verify", d: "Anyone re-checks the proof on Stellar and gets the same answer. No account needed." },
];

export default function Landing() {
  const dataroom = capability("dataroom");
  return (
    <div data-testid="overview">
      {/* hero */}
      <section className="mb-12">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand">
          zkorage · verifiable claims on Stellar
        </p>
        <h1 className="mt-2 max-w-3xl text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
          Prove a private fact. <span className="text-muted-foreground">Verify it on-chain.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
          zkorage proves a fact about private, attested data such as reserves, identity, income, or eligibility.
          Anyone can re-check it on the public ledger, without ever revealing the data behind it.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link to="/app" className={cn(buttonVariants({ size: "lg" }))} data-testid="hero-open-app">
            Open app <ArrowRight className="size-4" />
          </Link>
          <Link to="/docs" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>
            Read the docs
          </Link>
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" /> Stellar testnet
          </span>
        </div>

        <div className="mt-9 grid gap-3 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.t} className="rounded-xl border bg-card p-5">
              <div className="flex items-center gap-2.5">
                <span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <s.icon className="size-4" />
                </span>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {i + 1} · {s.t}
                </span>
              </div>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* marquee data room */}
      {dataroom && (
        <section className="mb-11">
          <Link to={dataroom.to} className="group block focus-visible:outline-none">
            <div className="overflow-hidden rounded-2xl border bg-card shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-ring">
              <div className="grid gap-6 p-7 sm:grid-cols-[1fr_auto] sm:items-center">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">Featured</p>
                  <h2 className="mt-1.5 text-2xl font-bold tracking-tight">{dataroom.title}</h2>
                  <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
                    {dataroom.blurb}
                  </p>
                </div>
                <span className={cn(buttonVariants({ size: "lg" }), "pointer-events-none w-full sm:w-auto")}>
                  Open in app <ArrowRight className="size-4" />
                </span>
              </div>
            </div>
          </Link>
        </section>
      )}

      {/* what you can prove */}
      <section className="mb-12">
        <div className="mb-4">
          <h2 className="text-lg font-semibold tracking-tight">What you can prove</h2>
          <p className="text-sm text-muted-foreground">
            Each is a self-contained proof. Open one in the app to run it against the live testnet.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {byGroup("prove").map((c) => (
            <FeatureCard key={c.key} to={c.to} icon={c.icon} title={c.title} blurb={c.blurb} proves={c.proves} />
          ))}
        </div>
      </section>

      {/* don't trust. verify */}
      <section className="mb-12">
        <div className="rounded-2xl border bg-card p-7">
          <h2 className="text-lg font-semibold tracking-tight">Don't trust. Verify.</h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
            Every claim zkorage publishes is checkable by anyone, directly on the public ledger. There is no
            wallet, no account, and no need to trust our server. Re-check a single proof, or browse every verified record.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link to="/verify" className={cn(buttonVariants())}>
              <BadgeCheck className="size-4" /> Verify a proof
            </Link>
            <Link to="/explorer" className={cn(buttonVariants({ variant: "outline" }))}>
              <Compass className="size-4" /> Open Explorer
            </Link>
          </div>
        </div>
      </section>

      {/* for developers */}
      <section className="mb-4">
        <div className="flex flex-col gap-3 rounded-2xl border bg-card p-7 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
              <Terminal className="size-5" />
            </span>
            <div>
              <h2 className="text-lg font-semibold tracking-tight">For developers</h2>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
                A read-only TypeScript SDK, an MCP server, and a REST API. Query and re-verify any claim
                from your own code, with no keys and no need to trust our server.
              </p>
            </div>
          </div>
          <Link to="/docs/developers" className={cn(buttonVariants({ variant: "outline" }), "shrink-0")}>
            Developer docs <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
