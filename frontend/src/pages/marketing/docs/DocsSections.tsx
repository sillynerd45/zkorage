import { Link } from "react-router-dom";
import { Check, X, FileSignature, Cpu, BadgeCheck, ArrowRight } from "lucide-react";
import { CAPABILITIES, DATAROOM_TABS } from "@/lib/content";
import { GLOSSARY } from "@/lib/glossary";
import { useDeveloperDemo, DEV_CHECKS } from "@/lib/hooks/useDeveloperDemo";
import { CopyButton } from "@/components/Disclosure";
import { VerdictMark } from "@/components/StatusBadge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SectionCard, DataRow } from "@/components/marketing/blocks";

// ── Overview / concepts ───────────────────────────────────────────────────────
const ENGINE = [
  { icon: FileSignature, t: "Attest", d: "A trusted source signs the private data with an ed25519 claim envelope — a custodian, KYC provider, or bank. The signature is the data-authenticity anchor; without it a proof would be hollow." },
  { icon: Cpu, t: "Prove (self-hosted)", d: "A RISC Zero zkVM you run verifies the signed claim and asserts the predicate (e.g. reserves ≥ supply), then wraps the result to a Groth16 proof. The private data never leaves the prover you control — ZK protects the verifier, not the prover." },
  { icon: BadgeCheck, t: "Verify (on-chain)", d: "A bare Groth16 verifier on Soroban checks the proof via native BN254 host functions; a policy contract binds it to on-chain facts and records the result. Anyone re-checks it — no account, no trust in our server." },
];

export function DocsOverview() {
  return (
    <div className="space-y-5">
      <SectionCard label="What zkorage is">
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          zkorage is a programmable-compliance engine on Stellar. A data owner proves a quantitative or
          boolean fact about private, attested data — "reserves ≥ circulating supply", "KYC passed and not
          sanctioned", "income ≥ a threshold" — <b className="text-foreground">without revealing the data</b>,
          and a verifier trusts it via an on-chain Soroban verifier.
        </p>
      </SectionCard>

      <SectionCard label="How the engine works">
        <ol className="space-y-4">
          {ENGINE.map((s, i) => (
            <li key={s.t} className="flex gap-3.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
                <s.icon className="size-5" />
              </span>
              <div>
                <p className="text-sm font-semibold">
                  {i + 1}. {s.t}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard label="ZK is load-bearing">
        <p className="text-sm leading-relaxed text-muted-foreground">
          The zero-knowledge proof is the only thing that lets a verifier be certain of a fact without seeing
          the data or trusting our server. If an access list plus encryption — or just reading the public
          chain — would do the same job, ZK would be theatre. Here it isn't: the verifier learns one fact and
          nothing else, and re-checks it independently.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          This is a hackathon demo on Stellar testnet. The verifier is the bare Groth16 verifier (no
          governance stack) and is <b className="text-foreground">unaudited</b> — not for production funds.
        </p>
      </SectionCard>
    </div>
  );
}

// ── Capabilities (concise) ────────────────────────────────────────────────────
export function DocsCapabilities() {
  const prove = CAPABILITIES.filter((c) => c.group === "prove");
  const dataroom = DATAROOM_TABS.filter((t) => t.slug && t.slug !== "demo");
  return (
    <div className="space-y-5">
      <SectionCard label="Proofs">
        <ul className="divide-y divide-border/70">
          {prove.map((c) => (
            <li key={c.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
                <c.icon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={c.to} className="font-semibold tracking-tight hover:text-brand">
                    {c.title}
                  </Link>
                  <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {c.proves}
                  </span>
                </div>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{c.blurb}</p>
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard
        label="Data Room"
        aside={
          <Link to="/app/dataroom" className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
            Open <ArrowRight className="size-3.5" />
          </Link>
        }
      >
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          A sealed room for sensitive documents. You prove you're allowed in without revealing who you are,
          files stay encrypted, and only a tamper-evident fingerprint goes on the public record.
        </p>
        <ul className="divide-y divide-border/70">
          {dataroom.map((t) => (
            <li key={t.slug} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-center gap-1.5">
                <Link to={`/app/dataroom/${t.slug}`} className="text-sm font-medium hover:text-brand">
                  {t.label}
                </Link>
                {t.star && <span aria-hidden="true">⭐</span>}
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">{t.blurb}</p>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}

// ── Verify it yourself ────────────────────────────────────────────────────────
export function DocsVerify() {
  return (
    <div className="space-y-5">
      <SectionCard label="Don't trust — verify">
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          Every claim zkorage publishes is checkable by anyone, directly on the public ledger — no wallet, no
          account, no trust in our server. The verify page recomputes the journal hash, checks the proving
          program is the pinned one, and asks the <b className="text-foreground">public</b> Soroban contracts
          to confirm the Groth16 proof and the on-chain binding. Private inputs are never revealed in any of it.
        </p>
        <Link to="/verify" className={cn(buttonVariants(), "mt-4")}>
          Open the verify page <ArrowRight className="size-4" />
        </Link>
      </SectionCard>

      <SectionCard label="Reproduce it from the command line">
        <p className="text-sm leading-relaxed text-muted-foreground">
          The verify page also prints the exact CLI recipe — read the persisted result on-chain, list the
          verified-results history, and re-verify the Groth16 proof against the public RPC, with no zkorage
          server in the trust path. Open a specific claim at <code className="font-mono text-xs">/verify/&lt;issuer&gt;</code>{" "}
          or browse them all in the <Link to="/explorer" className="text-brand hover:underline">Explorer</Link>.
        </p>
      </SectionCard>
    </div>
  );
}

// ── Developers (live SDK demo + snippets) ─────────────────────────────────────
const SDK_SNIPPET = `import { ZkorageClient } from "zkorage-sdk";

const z = new ZkorageClient();                       // testnet defaults baked in, no keys
const a = await z.isReservesGteSupply();             // on-chain-verified answer + freshness
// { answer: true, boundSupply, liveSupply, fresh, result }

const audit = await z.getAuditBundle();              // proof bundle (via REST)
const v = await z.verifyBundle(audit.proof!);        // full Groth16 re-verify vs the public chain
// v.verdict === true, v.checklist = { ...9 checks }`;

const MCP_SNIPPET = `{
  "mcpServers": {
    "zkorage": {
      "command": "node",
      "args": ["<repo>/mcp/dist/server.js"],
      "env": { "ZKORAGE_API_BASE": "http://localhost:8787" }
    }
  }
}
// then ask: "Using zkorage, is the latest issuer's reserves >= supply?"`;

function Snippet({ title, note, code }: { title: string; note?: string; code: string }) {
  return (
    <SectionCard label={title}>
      {note && <p className="mb-2 text-sm text-muted-foreground">{note}</p>}
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        usage <CopyButton text={code} label="copy" />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground">
        {code}
      </pre>
    </SectionCard>
  );
}

export function DocsDevelopers() {
  const d = useDeveloperDemo();
  return (
    <div className="space-y-5">
      <SectionCard label="Build on zkorage">
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          A read-only TypeScript SDK and an MCP server let any developer — or any AI agent — query and{" "}
          <b className="text-foreground">re-verify</b> a claim straight against the public chain, with no keys
          and no trust in our server. The demo below runs the SDK <b className="text-foreground">in this
          browser</b>.
        </p>
      </SectionCard>

      <SectionCard
        label="Live SDK demo"
        aside={<span className="text-[11px] uppercase tracking-wide text-muted-foreground">in-browser · public RPC</span>}
      >
        <div data-testid="dev-demo">
          <Button onClick={d.run} disabled={d.state === "running"} data-testid="dev-run">
            {d.state === "running" ? "Running…" : "Run isReservesGteSupply() + verifyBundle()"}
          </Button>
          {d.state === "error" && <p className="mt-3 text-sm text-destructive">{d.err}</p>}
          {d.answer && (
            <div
              data-testid="dev-answer"
              data-answer={d.answer.answer}
              className={cn(
                "mt-4 flex items-center gap-3 rounded-xl border p-3 text-sm font-semibold",
                d.answer.answer ? "border-success/40 bg-success/5 text-success" : "border-destructive/40 bg-destructive/5 text-destructive",
              )}
            >
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full border",
                  d.answer.answer ? "border-success/50 bg-success/10" : "border-destructive/50 bg-destructive/10",
                )}
              >
                <VerdictMark ok={!!d.answer.answer} />
              </span>
              <span>
                reserves ≥ supply: {String(d.answer.answer)}
                {d.answer.fresh ? "" : " (supply stale)"}
              </span>
            </div>
          )}
          {d.answer && (
            <div className="mt-3">
              <DataRow k="bound supply">{d.answer.boundSupply}</DataRow>
              <DataRow k="live supply">{d.answer.liveSupply}</DataRow>
            </div>
          )}
          {d.checklist && (
            <ul className="mt-4 grid gap-1.5 sm:grid-cols-2" data-testid="dev-checklist">
              {DEV_CHECKS.map((c) => {
                const ok = d.checklist![c.key];
                return (
                  <li
                    key={c.key}
                    data-testid={`dev-check-${c.key}`}
                    data-ok={ok}
                    className="flex items-center gap-2 text-sm"
                  >
                    <span className={ok ? "text-success" : "text-destructive"}>
                      {ok ? <Check className="size-4" /> : <X className="size-4" />}
                    </span>
                    <span className={ok ? "" : "text-muted-foreground"}>{c.label}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SectionCard>

      <Snippet
        title="TypeScript SDK · zkorage-sdk"
        note="Trust-minimized reads + full Groth16 re-verify. Node + browser. No keys."
        code={SDK_SNIPPET}
      />
      <Snippet
        title="MCP server · read-only, no key custody"
        note="Wire the read-only MCP server into Claude Desktop / Claude Code (stdio) and ask it to verify a claim."
        code={MCP_SNIPPET}
      />

      <SectionCard label="REST API">
        <DataRow k="OpenAPI spec" mono={false}>
          <a href="/api/openapi.yaml" target="_blank" rel="noreferrer" className="text-brand hover:underline">
            /api/openapi.yaml ↗
          </a>
        </DataRow>
        <DataRow k="Swagger UI" mono={false}>
          served by the backend at <code className="font-mono text-xs">/docs</code>
        </DataRow>
      </SectionCard>
    </div>
  );
}

// ── Glossary ──────────────────────────────────────────────────────────────────
export function DocsGlossary() {
  const terms = Object.entries(GLOSSARY);
  return (
    <SectionCard label="Plain-language glossary">
      <dl className="divide-y divide-border/70">
        {terms.map(([term, def]) => (
          <div key={term} className="py-3 first:pt-0 last:pb-0">
            <dt className="text-sm font-semibold capitalize">{term}</dt>
            <dd className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{def}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}
