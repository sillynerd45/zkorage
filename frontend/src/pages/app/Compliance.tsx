import { ExternalLink, ShieldCheck } from "lucide-react";
import { useCompliance } from "@/lib/hooks/useCompliance";
import { short, explorer } from "@/lib/format";
import { humanError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProofStatusBadge, ProveWait, VerdictMark } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import { PageHeader, Panel, DataRow, Verdict } from "@/components/app/blocks";

const SELECT_CLS = "h-9 rounded-md border border-input bg-background px-3 text-sm";

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

export default function Compliance() {
  const c = useCompliance();
  const net = c.info?.network ?? "testnet";
  const j = c.journal;
  const resp = c.resp;

  return (
    <>
      <PageHeader
        icon={ShieldCheck}
        title="Compliance (KYC ∧ not-sanctioned)"
        lead={
          <>
            A user proves they are <b>ID-checked by an approved provider</b> <b>AND not on a sanctions
            list</b>, <b>without revealing their identity</b>, in a single proof, and the proof grants
            access to a chosen account. The proof checks the ID credential, then proves the person is
            <b> not on the sanctions list</b>, sharing only a fingerprint of that list. Their identity never
            leaves the prover.
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
        {/* left rail: engine + relying party + history */}
        <div className="space-y-4">
          <Panel title="Engine">
            <DataRow k="Network">{c.info?.network ?? "…"}</DataRow>
            {c.info?.complianceId && (
              <DataRow k="Compliance gate">
                <ExLink id={c.info.complianceId} net={net} />
              </DataRow>
            )}
            {c.info?.verifierId && (
              <DataRow k="Groth16 verifier">
                <ExLink id={c.info.verifierId} net={net} />
              </DataRow>
            )}
            {c.info?.kycIssuerId && (
              <DataRow k="KYC provider (allow-listed)">{short(c.info.kycIssuerId, 8)}</DataRow>
            )}
            {c.info?.denyRoot && (
              <DataRow k="Sanctions deny-list" mono={false} testId="deny-root">
                <span title={c.info.denyRoot}>
                  root {short(c.info.denyRoot, 8)} · {c.info.denySize} entries · depth {c.info.denyDepth}
                </span>
              </DataRow>
            )}
          </Panel>

          {/* relying party */}
          <Panel
            title="Relying party"
            aside={
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                gate a wallet behind compliance
              </span>
            }
          >
            <p className="text-xs text-muted-foreground">
              A relying party checks whether an account is KYC'd &amp; not-sanctioned, without ever learning
              who the account belongs to.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <Input
                className="min-w-[280px] flex-1 font-mono text-xs"
                value={c.checkAccessor}
                onChange={(e) => c.setCheckAccessor(e.target.value)}
                aria-label="check accessor"
                data-testid="check-accessor"
              />
              <Button variant="outline" onClick={() => c.onCheck()} data-testid="check-access">
                Check access
              </Button>
            </div>
            {c.granted !== null && (
              <div
                className="mt-3 flex items-center gap-3 rounded-2xl border p-4 text-sm font-semibold"
                data-testid="access-verdict"
                data-granted={c.granted}
              >
                <span
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-full border",
                    c.granted
                      ? "border-success/50 bg-success/10 text-success"
                      : "border-destructive/50 bg-destructive/10 text-destructive",
                  )}
                >
                  <VerdictMark ok={c.granted} />
                </span>
                <span className={c.granted ? "text-success" : "text-destructive"}>
                  {c.granted
                    ? "ACCESS GRANTED (KYC'd & not-sanctioned)"
                    : "ACCESS DENIED (no valid compliance proof)"}
                </span>
              </div>
            )}
            {c.granted && c.grantedRec && (
              <div className="mt-3">
                <DataRow k="KYC provider">{short(c.grantedRec.issuer_id, 8)}</DataRow>
                <DataRow k="deny-root checked" mono={false}>
                  <span title={c.grantedRec.deny_root}>{short(c.grantedRec.deny_root, 8)}</span>
                </DataRow>
                <DataRow k="granted at ledger" mono={false}>{c.grantedRec.ledger}</DataRow>
              </div>
            )}
          </Panel>

          {/* access history */}
          <Panel
            title="Compliance grants"
            aside={
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                anyone can read on-chain
              </span>
            }
          >
            {c.history.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs" data-testid="access-history">
                  <thead className="text-muted-foreground">
                    <tr className="border-b border-border/70">
                      <th className="py-2 pr-3 font-medium">#</th>
                      <th className="py-2 pr-3 font-medium">accessor</th>
                      <th className="py-2 pr-3 font-medium">KYC provider</th>
                      <th className="py-2 pr-3 font-medium">deny-root</th>
                      <th className="py-2 font-medium">ledger</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums">
                    {c.history.map((h) => (
                      <tr key={h.index} className="border-b border-border/40 last:border-0">
                        <td className="py-2 pr-3">{h.index}</td>
                        <td className="py-2 pr-3" title={h.accessor}>{short(h.accessor, 8)}</td>
                        <td className="py-2 pr-3" title={h.issuer_id}>{short(h.issuer_id, 8)}</td>
                        <td className="py-2 pr-3" title={h.deny_root}>{short(h.deny_root, 6)}</td>
                        <td className="py-2">{h.ledger}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No compliance grants yet.</p>
            )}
          </Panel>
        </div>

        {/* right: the proof + verdict */}
        <div className="space-y-4">
          <Panel title="Prove compliance" aside={<ProofStatusBadge state={c.state} />}>
            <p className="text-sm text-muted-foreground">
              Pick <b>Mallory</b> (on the deny-list) to see the ✗ case. A sanctioned subject cannot generate
              a non-membership proof.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <label className="text-[13px] text-muted-foreground" htmlFor="subject">subject (private)</label>
              <select
                id="subject"
                className={SELECT_CLS}
                value={c.subject}
                onChange={(e) => c.setSubject(e.target.value)}
                aria-label="subject"
                data-testid="subject"
              >
                <option value="alice">Alice (clean)</option>
                <option value="bob">Bob (clean)</option>
                <option value="mallory">Mallory (sanctioned)</option>
              </select>
              <label className="text-[13px] text-muted-foreground" htmlFor="kyc-status">KYC status</label>
              <select
                id="kyc-status"
                className={SELECT_CLS}
                value={c.kycPassed ? "passed" : "failed"}
                onChange={(e) => c.setKycPassed(e.target.value === "passed")}
                aria-label="kyc status"
                data-testid="kyc-status"
              >
                <option value="passed">passed</option>
                <option value="failed">failed</option>
              </select>
            </div>

            <div className="mt-2.5 flex flex-col gap-1.5">
              <label className="text-[13px] text-muted-foreground" htmlFor="accessor">
                accessor (Stellar account to gate)
              </label>
              <Input
                id="accessor"
                className="max-w-[420px] font-mono text-xs"
                value={c.accessor}
                onChange={(e) => c.setAccessor(e.target.value)}
                aria-label="accessor"
                data-testid="accessor"
              />
            </div>

            <div className="mt-4">
              <Button onClick={c.onProve} disabled={c.busy} data-testid="prove">
                {c.state === "proving" ? "Proving…" : "Generate proof and grant access"}
              </Button>
            </div>
            <ProveWait state={c.state} proveBy={c.proveBy} privacy="Your identity never leaves the prover." />

            {j && (
              <div className="mt-4">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Public journal (what goes on-chain). Note the identity is absent.
                </p>
                <DataRow k="claim" mono={false}>
                  {j.claimType === 4 ? "Compliance (KYC ∧ not-sanctioned)" : `type ${j.claimType}`}
                </DataRow>
                <DataRow k="result" mono={false}>
                  {j.result ? "KYC passed & not sanctioned ✓" : "false"}
                </DataRow>
                <DataRow k="KYC provider (issuer)">{short(j.issuerId, 8)}</DataRow>
                <DataRow k="sanctions deny-root">
                  <span title={j.denyRoot}>{short(j.denyRoot, 8)}</span>
                </DataRow>
                <DataRow k="accessor (granted)">{short(j.accessor, 8)}</DataRow>
                <DataRow k="subject / identity" variant="private" testId="subject-private">
                  private (never revealed)
                </DataRow>
              </div>
            )}
          </Panel>

          {resp && (
            <div data-testid="grant-verdict-card">
              {resp.ok ? (
                <Panel>
                  <Verdict ok>KYC'd &amp; not sanctioned. Access granted on Stellar.</Verdict>
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
                  <Verdict ok={false}>{c.state === "failed" ? "No proof produced" : "Rejected"}</Verdict>
                  <p className="mt-3 text-sm text-destructive" data-testid="grant-reject-reason">
                    {humanError(resp.error, "compliance")}
                  </p>
                </Panel>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
