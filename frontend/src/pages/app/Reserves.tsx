import { Link } from "react-router-dom";
import { ExternalLink, Landmark } from "lucide-react";
import { useReserves, DECIMALS } from "@/lib/hooks/useReserves";
import { fmtAmount } from "@/lib/api";
import { short, explorer } from "@/lib/format";
import { humanError } from "@/lib/errors";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProofStatusBadge, ProveWait } from "@/components/StatusBadge";
import { ConfirmModal } from "@/components/ConfirmModal";
import { cn } from "@/lib/utils";
import { PageHeader, Panel, DataRow, Verdict, StatTile } from "@/components/app/blocks";

function ExLink({ id, net }: { id: string; net: string }) {
  return (
    <a
      href={explorer("contract", id, net)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-brand hover:underline"
    >
      {short(id, 8)} <ExternalLink className="size-3" />
    </a>
  );
}

export default function Reserves() {
  const r = useReserves();
  const net = r.info?.network ?? "testnet";
  const j = r.journal;

  return (
    <>
      <PageHeader
        icon={Landmark}
        title="Proof-of-Reserves"
        lead={
          <>
            An issuer proves <b>reserves ≥ circulating supply</b> without revealing the reserve figure. The
            supply is tied to a real token's total supply. The proof is checked and recorded on the public
            record. Reserves never leave the prover you run.
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
        {/* left rail: supply + demo + engine */}
        <div className="space-y-4">
          <StatTile
            label="Circulating supply (zUSD)"
            value={<span data-testid="supply">{r.supply ? fmtAmount(r.supply, DECIMALS) : "…"}</span>}
            hint="on-chain liability anchor"
          />
          <Panel title="Demo controls">
            <p className="text-xs text-muted-foreground">Change the supply, then re-verify to see the binding react.</p>
            <Input
              type="number"
              className="mt-2.5"
              value={r.demoWhole}
              onChange={(e) => r.setDemoWhole(e.target.value)}
              aria-label="demo amount"
            />
            <div className="mt-2.5 flex gap-2.5">
              <Button variant="outline" className="flex-1" onClick={() => r.setPending("mint")} disabled={r.busy} data-testid="mint">
                + Mint
              </Button>
              <Button variant="outline" className="flex-1 text-destructive" onClick={() => r.setPending("burn")} disabled={r.busy} data-testid="burn">
                − Burn
              </Button>
            </div>
          </Panel>
          <Panel title="Engine">
            <DataRow k="Network">{r.info?.network ?? "…"}</DataRow>
            {r.info?.tokenId && <DataRow k="SEP-41 token"><ExLink id={r.info.tokenId} net={net} /></DataRow>}
            {r.info?.policyId && <DataRow k="PoR policy"><ExLink id={r.info.policyId} net={net} /></DataRow>}
            {r.info?.verifierId && <DataRow k="Verifier"><ExLink id={r.info.verifierId} net={net} /></DataRow>}
          </Panel>
        </div>

        {/* right: the proof + verdict + record */}
        <div className="space-y-4">
          <Panel title="Proof-of-Reserves claim" aside={<ProofStatusBadge state={r.state} />}>
            {j ? (
              <>
                <DataRow k="claim" mono={false}>{j.claimType === 2 ? "Proof-of-Reserves" : `type ${j.claimType}`}</DataRow>
                <DataRow k="proven supply (bound)" mono={false}>{fmtAmount(j.threshold, DECIMALS)} zUSD</DataRow>
                <DataRow k="reserves" variant="private" testId="reserves-private">private, never revealed</DataRow>
                <DataRow k="issuer (custodian)">{short(j.issuerId, 8)}</DataRow>
                <DataRow k="image_id">{short(r.bundle!.image_id, 8)}</DataRow>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No proof loaded yet. Generate one below (self-hosted proving, ~minutes on CPU).
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-end gap-2.5">
              <Button onClick={() => r.onSubmit()} disabled={!r.bundle || r.busy} data-testid="verify">
                {r.state === "verifying" ? "Verifying…" : "Verify on-chain"}
              </Button>
              <div className="flex flex-col gap-1.5">
                <label className="text-[13px] text-muted-foreground" htmlFor="reserves-input">
                  reserves (zUSD)
                </label>
                <Input
                  id="reserves-input"
                  type="number"
                  className="max-w-[170px]"
                  value={r.reservesWhole}
                  onChange={(e) => r.setReservesWhole(e.target.value)}
                  aria-label="reserves"
                />
              </div>
              <Button variant="outline" onClick={r.onGenerate} disabled={r.busy} data-testid="generate">
                Generate new proof
              </Button>
            </div>
            <ProveWait state={r.state} proveBy={r.proveBy} />
          </Panel>

          {r.resp && (
            <div data-testid="verdict-card">
              {r.resp.ok ? (
                <Panel>
                  <Verdict ok>Reserves ≥ Supply, verified on Stellar</Verdict>
                  <div className="mt-3">
                    {r.resp.txHash && (
                      <DataRow k="tx">
                        <a
                          href={explorer("tx", r.resp.txHash, net)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-brand hover:underline"
                        >
                          {short(r.resp.txHash, 8)} <ExternalLink className="size-3" />
                        </a>
                      </DataRow>
                    )}
                    {r.resp.cost?.minResourceFee && <DataRow k="resource fee">{r.resp.cost.minResourceFee} stroops</DataRow>}
                    {r.resp.result && <DataRow k="bound supply" mono={false}>{fmtAmount(r.resp.result.supply, DECIMALS)} zUSD</DataRow>}
                  </div>
                </Panel>
              ) : (
                <Panel>
                  <Verdict ok={false}>Rejected</Verdict>
                  <p className="mt-3 text-sm text-destructive" data-testid="reject-reason">
                    {humanError(r.resp.error, "reserves")}
                  </p>
                </Panel>
              )}
            </div>
          )}

          <Panel
            title="On-chain verified record"
            aside={<span className="text-[11px] uppercase tracking-wide text-muted-foreground">anyone can re-verify</span>}
          >
            {r.stored ? (
              <>
                <DataRow k="result" mono={false} testId="stored-result">
                  {r.stored.result ? "reserves ≥ supply ✓" : "false"}
                </DataRow>
                <DataRow k="bound supply" mono={false}>{fmtAmount(r.stored.supply, DECIMALS)} zUSD</DataRow>
                <DataRow k="issuer">{short(r.stored.issuer_id, 8)}</DataRow>
                <DataRow k="ledger">{r.stored.ledger}</DataRow>
                <div className="mt-4 flex flex-wrap gap-2.5">
                  <Link to={r.issuerId ? `/verify/${r.issuerId}` : "/verify"} className={cn(buttonVariants())} data-testid="share-verify">
                    Share · verify it yourself ↗
                  </Link>
                  <Link to="/explorer" className={cn(buttonVariants({ variant: "outline" }))}>
                    Open explorer
                  </Link>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No verified result persisted yet.</p>
            )}
          </Panel>
        </div>
      </div>

      <ConfirmModal
        open={r.pending !== null}
        title={r.pending === "mint" ? `Mint ${r.demoWhole} zUSD on-chain?` : `Burn ${r.demoWhole} zUSD on-chain?`}
        tone="outward"
        confirmLabel={r.pending === "mint" ? "Yes, mint" : "Yes, burn"}
        onCancel={() => r.setPending(null)}
        onConfirm={() => {
          const a = r.pending;
          r.setPending(null);
          if (a === "mint") r.onMint();
          else if (a === "burn") r.onBurn();
        }}
      >
        <p>
          This changes the demo token's on-chain <code className="font-mono">total_supply</code>, the live
          liability the proof is bound to. {r.pending === "mint" ? "Minting raises" : "Burning lowers"} it by{" "}
          {r.demoWhole} zUSD, so a previously-verified proof will stop matching until you change it back.
        </p>
      </ConfirmModal>
    </>
  );
}
