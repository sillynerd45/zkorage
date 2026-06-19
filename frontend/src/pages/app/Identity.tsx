import { ExternalLink, UserCheck } from "lucide-react";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { short, explorer } from "@/lib/format";
import { humanError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProofStatusBadge, ProveWait } from "@/components/StatusBadge";
import { PageHeader, Panel, DataRow, Verdict } from "@/components/app/blocks";

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

const SELECT_CLASS = "h-9 rounded-md border border-input bg-background px-3 text-sm";

export default function Identity() {
  const i = useIdentity();
  const net = i.info?.network ?? "testnet";
  const j = i.journal;
  const resp = i.resp;

  return (
    <>
      <PageHeader
        icon={UserCheck}
        title="Identity — KYC"
        lead={
          <>
            A user proves they are <b>ID-checked by an approved provider</b> — <b>without revealing
            their identity</b> — and the proof grants access to a chosen account. The provider signs a
            credential about the person; the proof shows "ID check passed, by an approved source" while their
            identity stays private. The proof is tied to a public account (the one that gets access).
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
        {/* left rail: engine */}
        <div className="space-y-4">
          <Panel title="Engine">
            <DataRow k="Network">{i.info?.network ?? "…"}</DataRow>
            {i.info?.gateId && (
              <DataRow k="KYC gate">
                <ExLink id={i.info.gateId} net={net} />
              </DataRow>
            )}
            {i.info?.verifierId && (
              <DataRow k="Groth16 verifier">
                <ExLink id={i.info.verifierId} net={net} />
              </DataRow>
            )}
            {i.info?.kycIssuerId && (
              <DataRow k="KYC provider (allow-listed)">{short(i.info.kycIssuerId, 8)}</DataRow>
            )}
          </Panel>
        </div>

        {/* right: prover + verdict + relying party + history */}
        <div className="space-y-4">
          {/* prover */}
          <Panel title="Prove KYC" aside={<ProofStatusBadge state={i.state} />}>
            <div className="flex flex-wrap items-end gap-2.5">
              <div className="flex flex-col gap-1.5">
                <label className="text-[13px] text-muted-foreground" htmlFor="identity-subject">
                  subject (private)
                </label>
                <select
                  id="identity-subject"
                  className={SELECT_CLASS}
                  value={i.subject}
                  onChange={(e) => i.setSubject(e.target.value)}
                  aria-label="subject"
                  data-testid="subject"
                >
                  <option value="alice">Alice</option>
                  <option value="bob">Bob</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[13px] text-muted-foreground" htmlFor="identity-kyc-status">
                  KYC status
                </label>
                <select
                  id="identity-kyc-status"
                  className={SELECT_CLASS}
                  value={i.kycPassed ? "passed" : "failed"}
                  onChange={(e) => i.setKycPassed(e.target.value === "passed")}
                  aria-label="kyc status"
                  data-testid="kyc-status"
                >
                  <option value="passed">passed</option>
                  <option value="failed">failed</option>
                </select>
              </div>
            </div>

            <div className="mt-2.5 flex flex-col gap-1.5">
              <label className="text-[13px] text-muted-foreground" htmlFor="identity-accessor">
                accessor (Stellar account to gate)
              </label>
              <Input
                id="identity-accessor"
                className="font-mono text-xs"
                value={i.accessor}
                onChange={(e) => i.setAccessor(e.target.value)}
                aria-label="accessor"
                data-testid="accessor"
              />
            </div>

            <div className="mt-4">
              <Button onClick={i.onProve} disabled={i.busy} data-testid="prove">
                {i.state === "proving" ? "Proving…" : "Generate proof & grant access"}
              </Button>
            </div>

            <ProveWait state={i.state} proveBy={i.proveBy} privacy="Your identity never leaves the prover." />

            {j && (
              <div className="mt-4">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Public journal (what goes on-chain) — note the identity is absent
                </p>
                <DataRow k="claim" mono={false}>
                  {j.claimType === 3 ? "Identity / KYC" : `type ${j.claimType}`}
                </DataRow>
                <DataRow k="result" mono={false}>{j.result ? "KYC passed ✓" : "false"}</DataRow>
                <DataRow k="KYC provider (issuer)">{short(j.issuerId, 8)}</DataRow>
                <DataRow k="accessor (granted)">{short(j.accessor, 8)}</DataRow>
                <DataRow k="subject / identity" variant="private" testId="subject-private">
                  private — never revealed
                </DataRow>
              </div>
            )}
          </Panel>

          {/* verdict */}
          {resp && (
            <div data-testid="grant-verdict-card">
              {resp.ok ? (
                <Panel>
                  <Verdict ok>KYC verified — access granted on Stellar</Verdict>
                  <div className="mt-3">
                    {resp.txHash && (
                      <DataRow k="tx">
                        <a
                          href={explorer("tx", resp.txHash, net)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-brand hover:underline"
                        >
                          {short(resp.txHash, 8)} <ExternalLink className="size-3" />
                        </a>
                      </DataRow>
                    )}
                    {resp.cost?.minResourceFee && (
                      <DataRow k="resource fee">{resp.cost.minResourceFee} stroops</DataRow>
                    )}
                    {resp.result && <DataRow k="accessor">{short(resp.result.accessor, 8)}</DataRow>}
                  </div>
                </Panel>
              ) : (
                <Panel>
                  <Verdict ok={false}>{i.state === "failed" ? "No proof produced" : "Rejected"}</Verdict>
                  <p className="mt-3 text-sm text-destructive" data-testid="grant-reject-reason">
                    {humanError(resp.error, "identity")}
                  </p>
                </Panel>
              )}
            </div>
          )}

          {/* relying party */}
          <Panel
            title="Relying party"
            aside={
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                gate a wallet behind KYC
              </span>
            }
          >
            <p className="text-sm text-muted-foreground">
              A relying party checks whether an account has a valid KYC access grant — without ever learning who
              the account belongs to.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-2.5">
              <Input
                className="min-w-[320px] flex-1 font-mono text-xs"
                value={i.checkAccessor}
                onChange={(e) => i.setCheckAccessor(e.target.value)}
                aria-label="check accessor"
                data-testid="check-accessor"
              />
              <Button variant="outline" onClick={() => i.onCheck()} data-testid="check-access">
                Check access
              </Button>
            </div>
            {i.granted !== null && (
              <div className="mt-3" data-testid="access-verdict" data-granted={i.granted}>
                <Verdict ok={i.granted}>
                  {i.granted ? "ACCESS GRANTED — KYC-verified" : "ACCESS DENIED — no valid KYC proof"}
                </Verdict>
              </div>
            )}
            {i.granted && i.grantedRec && (
              <div className="mt-3">
                <DataRow k="KYC provider">{short(i.grantedRec.issuer_id, 8)}</DataRow>
                <DataRow k="granted at ledger" mono={false}>{i.grantedRec.ledger}</DataRow>
              </div>
            )}
          </Panel>

          {/* access history */}
          <Panel
            title="Access grants"
            aside={
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                anyone can read on-chain
              </span>
            }
          >
            {i.history.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="access-history">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">#</th>
                      <th className="py-2 pr-3 font-medium">accessor</th>
                      <th className="py-2 pr-3 font-medium">KYC provider</th>
                      <th className="py-2 font-medium">ledger</th>
                    </tr>
                  </thead>
                  <tbody>
                    {i.history.map((h) => (
                      <tr key={h.index} className="border-b border-border/60 last:border-0">
                        <td className="py-2 pr-3 tabular-nums">{h.index}</td>
                        <td className="py-2 pr-3 font-mono text-xs" title={h.accessor}>
                          {short(h.accessor, 8)}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs" title={h.issuer_id}>
                          {short(h.issuer_id, 8)}
                        </td>
                        <td className="py-2 tabular-nums">{h.ledger}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No access grants yet.</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
