import { ExternalLink, Wallet } from "lucide-react";
import { usePayroll } from "@/lib/hooks/usePayroll";
import { short, explorer } from "@/lib/format";
import { humanError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProofStatusBadge, ProveWait } from "@/components/StatusBadge";
import { PageHeader, Panel, DataRow, Verdict } from "@/components/app/blocks";

function ExLink({ kind, id, net }: { kind: "contract" | "tx"; id: string; net: string }) {
  return (
    <a
      href={explorer(kind, id, net)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-brand hover:underline"
    >
      {short(id, 8)} <ExternalLink className="size-3" />
    </a>
  );
}

function friendlyError(e?: string): string {
  return humanError(e, "payroll");
}

export default function Payroll() {
  const p = usePayroll();
  const net = p.info?.network ?? "testnet";
  const j = p.journal;

  return (
    <>
      <PageHeader
        icon={Wallet}
        title="Confidential payroll"
        lead={
          <>
            An employee proves <b>"paid ≥ a threshold"</b> <b>without revealing their salary</b>. The exact
            figure stays private. The proof checks a signed payroll record, confirms <code>salary ≥ threshold</code>,
            and <b>encrypts the salary to an approved auditor's key</b>. The public sees only <b>✓ paid ≥ X</b>
            plus an unreadable encrypted blob. An <b>auditor's read key</b> reveals the exact figures
            (<i>provably the signed salary</i>). The salary never leaves the prover in the clear.
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
        {/* left rail: engine */}
        <div className="space-y-4">
          <Panel title="Engine">
            <DataRow k="Network">{p.info?.network ?? "…"}</DataRow>
            {p.info?.payrollId && (
              <DataRow k="Payroll gate">
                <ExLink kind="contract" id={p.info.payrollId} net={net} />
              </DataRow>
            )}
            {p.info?.verifierId && (
              <DataRow k="Groth16 verifier">
                <ExLink kind="contract" id={p.info.verifierId} net={net} />
              </DataRow>
            )}
            {p.info?.payrollAttesterId && (
              <DataRow k="Payroll attester (allow-listed)">{short(p.info.payrollAttesterId, 8)}</DataRow>
            )}
            {p.info?.auditorPub && (
              <DataRow k="Auditor (allow-listed)" testId="auditor-pub">
                x25519 {short(p.info.auditorPub, 8)}
              </DataRow>
            )}
          </Panel>
        </div>

        {/* right: prover + verdict + auditor + history */}
        <div className="space-y-4">
          {/* prover */}
          <Panel title="Prove income" aside={<ProofStatusBadge state={p.state} />}>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Enter a salary and the public threshold to prove against. Set the salary <b>below</b> the
              threshold to see the ✗ case, where the guest produces no receipt.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-2.5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="payroll-salary">salary (private)</Label>
                <Input
                  id="payroll-salary"
                  className="w-[120px]"
                  value={p.salary}
                  onChange={(e) => p.setSalary(e.target.value)}
                  aria-label="salary"
                  data-testid="salary"
                  inputMode="numeric"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="payroll-threshold">threshold (public)</Label>
                <Input
                  id="payroll-threshold"
                  className="w-[120px]"
                  value={p.threshold}
                  onChange={(e) => p.setThreshold(e.target.value)}
                  aria-label="threshold"
                  data-testid="threshold"
                  inputMode="numeric"
                />
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-1.5">
              <Label htmlFor="payroll-accessor">accessor (Stellar account to credential)</Label>
              <Input
                id="payroll-accessor"
                className="min-w-[380px] max-w-full font-mono text-xs"
                value={p.accessor}
                onChange={(e) => p.setAccessor(e.target.value)}
                aria-label="accessor"
                data-testid="accessor"
              />
            </div>
            <div className="mt-4">
              <Button onClick={p.onProve} disabled={p.busy} data-testid="prove">
                {p.state === "proving" ? "Proving…" : "Generate proof & grant"}
              </Button>
            </div>
            <ProveWait state={p.state} proveBy={p.proveBy} privacy="Your salary never leaves the prover in clear." />

            {j && (
              <div className="mt-4">
                <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Public journal (what goes on-chain). Note the salary is absent.
                </div>
                <DataRow k="claim" mono={false}>
                  {j.claimType === 5 ? "Payroll (proof-of-income)" : `type ${j.claimType}`}
                </DataRow>
                <DataRow k="result" mono={false}>{j.result ? "paid ≥ threshold ✓" : "false"}</DataRow>
                <DataRow k="threshold (public)">{j.threshold}</DataRow>
                <DataRow k="payroll attester">{short(j.issuerId, 8)}</DataRow>
                <DataRow k="accessor (credentialed)">{short(j.accessor, 8)}</DataRow>
                <DataRow k="auditor disclosure" testId="ct">
                  <span title={j.ct}>encrypted ct {short(j.ct, 8)}</span>
                </DataRow>
                <DataRow k="salary" variant="private" testId="salary-private">
                  private (only the auditor's view key opens it)
                </DataRow>
              </div>
            )}
          </Panel>

          {/* verdict */}
          {p.resp && (
            <div data-testid="grant-verdict-card">
              {p.resp.ok ? (
                <Panel>
                  <Verdict ok>
                    Income verified: "paid ≥ {p.resp.result?.threshold}" on Stellar (salary hidden)
                  </Verdict>
                  <div className="mt-3">
                    {p.resp.txHash && (
                      <DataRow k="tx">
                        <ExLink kind="tx" id={p.resp.txHash} net={net} />
                      </DataRow>
                    )}
                    {p.resp.cost?.minResourceFee && (
                      <DataRow k="resource fee">{p.resp.cost.minResourceFee} stroops</DataRow>
                    )}
                    {p.resp.result && <DataRow k="accessor">{short(p.resp.result.accessor, 8)}</DataRow>}
                  </div>
                </Panel>
              ) : (
                <Panel>
                  <Verdict ok={false}>{p.state === "failed" ? "No proof produced" : "Rejected"}</Verdict>
                  <p className="mt-3 text-sm text-destructive" data-testid="grant-reject-reason">
                    {friendlyError(p.resp.error)}
                  </p>
                </Panel>
              )}
            </div>
          )}

          {/* auditor view-key */}
          <Panel
            title="Auditor"
            aside={
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
reveal authorized figures with the view key
              </span>
            }
          >
            <p className="text-sm leading-relaxed text-muted-foreground">
              An allow-listed auditor holds a <b>view key</b> that decrypts each employee's exact salary, and
              the proof guarantees it equals the attester-signed figure (<b>faithful</b>). The public, with no
              key, sees only the ciphertext. Leave the field blank to use the demo auditor's key, or paste a
              different key to see <b>faithful = ✗</b>.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-2.5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="payroll-view-key">view key (hex, blank = demo auditor)</Label>
                <Input
                  id="payroll-view-key"
                  className="min-w-[360px] max-w-full font-mono text-xs"
                  value={p.viewKey}
                  onChange={(e) => p.setViewKey(e.target.value)}
                  aria-label="view key"
                  data-testid="view-key"
                  placeholder="32-byte hex (optional)"
                />
              </div>
              <Button variant="outline" onClick={p.onUnlock} data-testid="unlock">
                Reveal figures
              </Button>
            </div>
            {p.audit && (
              <div className="mt-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[13px]" data-testid="audit-table">
                    <thead>
                      <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">#</th>
                        <th className="py-2 pr-3 font-medium">accessor</th>
                        <th className="py-2 pr-3 font-medium">threshold</th>
                        <th className="py-2 pr-3 font-medium">salary</th>
                        <th className="py-2 font-medium">faithful</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.audit.entries.map((e, i) => (
                        <tr key={e.index} className="border-b border-border/60 last:border-0">
                          <td className="py-2 pr-3 tabular-nums">{e.index}</td>
                          <td className="py-2 pr-3 font-mono text-xs" title={e.accessor}>
                            {short(e.accessor, 8)}
                          </td>
                          <td className="py-2 pr-3 tabular-nums">{e.threshold}</td>
                          <td className="py-2 pr-3 tabular-nums" data-testid={`salary-${i}`}>
                            {e.salary ?? "n/a"}
                          </td>
                          <td className="py-2">
                            <span
                              className={e.faithful ? "text-success" : "text-destructive"}
                              aria-label={e.faithful ? "faithful" : "not faithful"}
                            >
                              {e.faithful ? "✓" : "✗"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <DataRow k="payroll total (auditor-summed)" mono={false} testId="payroll-total">
                  <b>{p.audit.total}</b> over {p.audit.count} employee(s)
                  {p.audit.grants > p.audit.count ? ` · ${p.audit.grants} grants` : ""}
                </DataRow>
              </div>
            )}
            {p.auditErr && !p.audit && (
              <p className="mt-3 text-sm text-destructive" data-testid="audit-error">
                {p.auditErr}
              </p>
            )}
          </Panel>

          {/* public history */}
          <Panel
            title="Income-verified grants"
            aside={
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                anyone can read on-chain · salaries hidden
              </span>
            }
          >
            {p.history.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]" data-testid="payroll-history">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">#</th>
                      <th className="py-2 pr-3 font-medium">accessor</th>
                      <th className="py-2 pr-3 font-medium">threshold</th>
                      <th className="py-2 pr-3 font-medium">salary</th>
                      <th className="py-2 font-medium">ledger</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.history.map((h) => (
                      <tr key={h.index} className="border-b border-border/60 last:border-0">
                        <td className="py-2 pr-3 tabular-nums">{h.index}</td>
                        <td className="py-2 pr-3 font-mono text-xs" title={h.accessor}>
                          {short(h.accessor, 8)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{h.threshold}</td>
                        <td className="py-2 pr-3 font-sans italic text-brand">hidden</td>
                        <td className="py-2 tabular-nums">{h.ledger}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No income-verified grants yet.</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
