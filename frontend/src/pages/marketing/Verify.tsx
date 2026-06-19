import { useParams } from "react-router-dom";
import { ExternalLink, Check, X } from "lucide-react";
import { useVerify, CHECKS } from "@/lib/hooks/useVerify";
import { fmtAmount } from "@/lib/api";
import { short, explorer } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/Disclosure";
import { PageHeader, SectionCard, DataRow, Verdict } from "@/components/marketing/blocks";

export default function Verify() {
  const { issuer } = useParams();
  const v = useVerify(issuer);
  const net = v.bundle?.network ?? "testnet";
  const dj = v.dj;

  return (
    <>
      <PageHeader
        eyebrow="Verify & explore"
        title="Verify it yourself"
        lead={
          <>
            <b>No wallet, no trust in our server.</b> This page recomputes the journal hash, checks the
            image-id pin, and asks the <b>public</b> Soroban contracts to confirm the Groth16 proof and the
            supply binding — exactly what anyone can reproduce with the CLI below. Reserves are never revealed.
          </>
        }
      />

      <SectionCard>
        {v.state === "loading" && <p className="text-sm text-muted-foreground">Loading claim…</p>}
        {v.state === "checking" && <p className="text-sm text-muted-foreground">Re-verifying against the chain…</p>}
        {v.state === "error" && <Verdict ok={false}>{v.err}</Verdict>}
        {v.state === "done" && (
          <div data-testid="verify-verdict" data-state={v.verdict ? "verified" : "rejected"}>
            <Verdict ok={v.verdict}>
              {v.verdict ? "Reserves ≥ Supply — independently verified on-chain" : "Not verified — a check failed below"}
            </Verdict>
            <p className="mt-3 border-t pt-3 text-xs leading-relaxed text-muted-foreground" data-testid="trust-mode">
              {v.trust === "public-rpc"
                ? `Checked directly against the public RPC (${v.bundle?.rpc}) — our server was not in the trust path.`
                : "Public RPC was unreachable from this browser, so the checks ran via the zkorage API (it performs the same public reads). For a fully trustless check, run the CLI commands below."}
            </p>
          </div>
        )}
      </SectionCard>

      {v.checklist && (
        <SectionCard label="Verification checklist">
          <ul className="space-y-0">
            {CHECKS.map((c) => {
              const ok = v.checklist![c.key];
              return (
                <li
                  key={c.key}
                  data-testid={`check-${c.key}`}
                  data-ok={ok}
                  className="flex items-start gap-2.5 border-b border-border/70 py-2.5 text-sm last:border-0"
                >
                  <span className={ok ? "text-success" : "text-destructive"}>
                    {ok ? <Check className="size-4" /> : <X className="size-4" />}
                  </span>
                  <span className={ok ? "" : "text-muted-foreground"}>{c.label}</span>
                </li>
              );
            })}
          </ul>
          {v.notes.length > 0 && (
            <div className="mt-3 space-y-1">
              {v.notes.map((n, i) => (
                <p key={i} className="font-mono text-[11px] leading-relaxed text-destructive">
                  • {n}
                </p>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {dj && v.bundle && (
        <SectionCard label="The claim">
          <DataRow k="claim" mono={false}>Proof-of-Reserves</DataRow>
          <DataRow k="bound supply" mono={false} testId="bound-supply">
            {fmtAmount(String(dj.supply ?? "0"), v.bundle.decimals)} zUSD
          </DataRow>
          {v.liveSupply && <DataRow k="live total_supply" mono={false}>{fmtAmount(v.liveSupply, v.bundle.decimals)} zUSD</DataRow>}
          <DataRow k="reserves" variant="private">private — never revealed</DataRow>
          <DataRow k="issuer">{short(String(dj.issuerId ?? ""), 8)}</DataRow>
          <DataRow k="image_id">{short(v.bundle.canonicalImageId ?? "", 8)}</DataRow>
          {v.recomputed && <DataRow k="journal sha256">{short(v.recomputed, 8)}</DataRow>}
        </SectionCard>
      )}

      {v.bundle && (
        <SectionCard
          label="On-chain contracts"
          aside={<span className="text-[11px] uppercase tracking-wide text-muted-foreground">read them yourself</span>}
        >
          {(
            [
              ["policy", v.bundle.contracts.policy],
              ["verifier", v.bundle.contracts.verifier],
              ["token", v.bundle.contracts.token],
            ] as const
          ).map(([k, id]) =>
            id ? (
              <DataRow k={k} key={k}>
                <a
                  href={explorer("contract", id, net)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-brand hover:underline"
                >
                  {short(id, 8)} <ExternalLink className="size-3" />
                </a>
              </DataRow>
            ) : null,
          )}
        </SectionCard>
      )}

      {v.bundle?.recipe && (
        <SectionCard label="Verify it yourself · CLI">
          <p className="mb-2 text-sm text-muted-foreground">
            Reproduce every check above with the public RPC — no zkorage server involved.
          </p>
          <div data-testid="cli-recipe" className="space-y-3">
            {[
              { t: "Read the persisted result on-chain", c: v.bundle.recipe.readLatestOnChain },
              { t: "List the verified-results history", c: v.bundle.recipe.readHistoryOnChain },
              { t: "Re-verify the Groth16 proof", c: v.bundle.recipe.reVerifyProof },
            ].map((row, i) => (
              <div key={i}>
                <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                  {row.t} <CopyButton text={row.c} label="copy" />
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground">
                  {row.c}
                </pre>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <SectionCard label="Share">
        <DataRow k="link">
          <span className="inline-flex items-center gap-2">
            {v.shareLink} <CopyButton text={v.shareLink} />
          </span>
        </DataRow>
        <div className="my-3">
          <img src={v.badge} alt="zkorage Proof-of-Reserves badge" data-testid="badge-img" className="max-w-full rounded-md" />
        </div>
        <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          Embed this badge <CopyButton text={v.embedSnippet} label="copy" />
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground">
          {v.embedSnippet}
        </pre>
        <div className="mt-4">
          <Button variant="outline" onClick={v.run} data-testid="reverify">
            Re-verify
          </Button>
        </div>
      </SectionCard>
    </>
  );
}
