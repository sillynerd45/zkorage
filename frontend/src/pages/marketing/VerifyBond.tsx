import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { fmtAmount } from "@/lib/api";
import { short, explorer } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/Disclosure";
import { PageHeader, SectionCard, DataRow, Verdict } from "@/components/marketing/blocks";
import { useVerifyBond, parseBondVerifyParams } from "@/lib/hooks/useVerifyBond";

const fmtDate = (unix: number) =>
  new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

const VERDICT_COPY: Record<string, { ok: boolean; text: string }> = {
  verified: { ok: true, text: "Active grant, confirmed on-chain. This anonymous handle holds a qualifying bond for the requirement below." },
  expired: { ok: false, text: "This grant is past its deadline. The handle held a qualifying bond, but the access window has closed." },
  "not-found": { ok: false, text: "No live grant for this handle and requirement. Either it was never proven, or the requirement does not match." },
  invalid: { ok: false, text: "This link is missing or malformed. A verification link needs the handle, the requirement hash, and the bond terms." },
};

export default function VerifyBond() {
  const [sp] = useSearchParams();
  const params = useMemo(() => parseBondVerifyParams(sp), [sp]);
  const v = useVerifyBond(params);
  const verdict = VERDICT_COPY[v.verdict] ?? VERDICT_COPY.invalid;

  return (
    <>
      <PageHeader
        eyebrow="Verify & explore"
        title="Verify a bonded grant"
        lead={
          <>
            <b>No wallet, and no need to trust our server.</b> This page asks the public Soroban bond gate
            whether this anonymous handle holds a live grant for the requirement below. Anyone can run the same
            read. The wallet behind the handle is never shown.
          </>
        }
      />

      <SectionCard>
        {v.state === "checking" && <p className="text-sm text-muted-foreground">Reading the bond gate on-chain…</p>}
        {v.state === "error" && <Verdict ok={false}>{v.err}</Verdict>}
        {v.state === "done" && (
          <div data-testid="verify-bond-verdict" data-state={v.verdict}>
            <Verdict ok={verdict.ok}>{verdict.text}</Verdict>
            {params && (
              <p className="mt-3 border-t pt-3 text-xs leading-relaxed text-muted-foreground" data-testid="verify-bond-trust">
                Checked by reading is_granted on the public bond gate. Our server was not in the trust path. You
                can re-run the read with the contract link below.
              </p>
            )}
          </div>
        )}
      </SectionCard>

      {params && (
        <SectionCard label="The claim">
          <DataRow k="claim" mono={false}>Bonded access</DataRow>
          {params.amount && (
            <DataRow k="bond amount (minimum)" mono={false} testId="bond-amount">
              {fmtAmount(params.amount, params.decimals)} {params.symbol ?? "token"}
            </DataRow>
          )}
          {params.deadline && (
            <DataRow k="valid until" mono={false}>{fmtDate(params.deadline)}</DataRow>
          )}
          <DataRow k="handle">{short(params.accessor, 8)}</DataRow>
          <DataRow k="requirement hash">{short(params.reqId, 8)}</DataRow>
          <DataRow k="wallet" variant="private">private, never revealed</DataRow>
        </SectionCard>
      )}

      {v.gateId && (
        <SectionCard
          label="On-chain contract"
          aside={<span className="text-[11px] uppercase tracking-wide text-muted-foreground">read it yourself</span>}
        >
          <DataRow k="bond gate">
            <a
              href={explorer("contract", v.gateId, "testnet")}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-brand hover:underline"
            >
              {short(v.gateId, 8)} <ExternalLink className="size-3" />
            </a>
          </DataRow>
        </SectionCard>
      )}

      {params && v.gateId && (
        <SectionCard label="Verify it yourself">
          <p className="mb-2 text-sm text-muted-foreground">Run the same read against the public RPC, no zkorage server involved.</p>
          <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            Read is_granted on the bond gate <CopyButton text={`stellar contract invoke --network testnet --id ${v.gateId} --send=no -- is_granted --accessor ${params.accessor} --req_id ${params.reqId}`} label="copy" />
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground">
            {`stellar contract invoke --network testnet --id ${v.gateId} --send=no -- is_granted --accessor ${params.accessor} --req_id ${params.reqId}`}
          </pre>
        </SectionCard>
      )}

      <SectionCard label="What this proves">
        <p className="text-sm text-muted-foreground">
          It proves an anonymous holder locked a bond that meets this requirement, and that the grant is live
          on-chain right now.
        </p>
        <p className="mt-2 text-sm text-muted-foreground" data-testid="verify-bond-scope">
          It does not reveal which wallet locked the bond, or how much was locked beyond the minimum shown.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          The token, amount, and deadline above are read from the link. The grant is bound on-chain to the
          requirement hash, so check that hash matches the terms you expect.
        </p>
        <div className="mt-4">
          <Button variant="outline" onClick={() => void v.run()} data-testid="reverify-bond">
            Re-check on-chain
          </Button>
        </div>
      </SectionCard>
    </>
  );
}
