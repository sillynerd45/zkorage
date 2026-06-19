import { ExternalLink, Rocket } from "lucide-react";
import { useFundraise, friendlyError, validRevenue } from "@/lib/hooks/useFundraise";
import { short, explorer } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProofStatusBadge, ProveWait, VerdictMark } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import { PageHeader, Panel, DataRow } from "@/components/app/blocks";

// Fundraise figures are plain USD, so the page uses this dollar formatter (not the base-unit fmtAmount).
const fmtUsd = (v?: string) => (v ? "$" + BigInt(v).toLocaleString("en-US") : "—");

const SELECT_CLS = "h-9 rounded-md border border-input bg-background px-3 text-sm";

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

export default function Fundraise() {
  const f = useFundraise();
  const net = f.info?.network ?? "testnet";
  const X = f.X;

  return (
    <>
      <PageHeader
        icon={Rocket}
        title="Fundraising"
        lead={
          <>
            A fundraise an investor can access <b>only by proving BOTH</b> — (a) they are an <b>accredited
            investor</b> (their identity stays hidden) AND (b) the fundraise has <b>revenue ≥ X</b> (the real
            revenue stays hidden). Two independent <b>private proofs</b> about two different parties, <b>checked
            together on the public record</b>.
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-start">
        {/* left rail: engine */}
        <div className="space-y-4">
          <Panel title="Engine">
            <DataRow k="Network">{f.info?.network ?? "…"}</DataRow>
            {f.info?.fundraiseId && (
              <DataRow k="Fundraise contract">
                <ExLink kind="contract" id={f.info.fundraiseId} net={net} />
              </DataRow>
            )}
            {f.info?.accreditedId && (
              <DataRow k="Accredited gate">
                <ExLink kind="contract" id={f.info.accreditedId} net={net} />
              </DataRow>
            )}
            {f.info?.verifierId && (
              <DataRow k="Groth16 verifier">
                <ExLink kind="contract" id={f.info.verifierId} net={net} />
              </DataRow>
            )}
            <DataRow k="Revenue floor (X, public)" mono={false}>
              {fmtUsd(X)}
            </DataRow>
          </Panel>
        </div>

        {/* right: composition banner + the two proofs + history */}
        <div className="space-y-4">
          {/* COMPOSITION banner — the headline */}
          <Panel
            title={<>Investor access</>}
            aside={
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                accredited ∧ revenue ≥ X
              </span>
            }
            className="space-y-4"
          >
            <div data-testid="composition" className="space-y-4">
              <div className="flex flex-wrap items-end gap-2.5">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="check-accessor-input">investor accessor</Label>
                  <Input
                    id="check-accessor-input"
                    className="min-w-[360px] font-mono text-xs"
                    value={f.checkAccessor}
                    onChange={(e) => f.setCheckAccessor(e.target.value)}
                    aria-label="check accessor"
                    data-testid="check-accessor"
                  />
                </div>
                <Button variant="outline" onClick={() => f.refreshAccess(f.checkAccessor)} data-testid="check-access">
                  Check
                </Button>
                <Button
                  onClick={f.onRequestAccess}
                  disabled={!f.revVerified || !f.accredited}
                  data-testid="request-access"
                >
                  Request fundraise access
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-6">
                <span
                  className={cn("inline-flex items-center gap-1.5 text-sm", f.accredited ? "text-success" : "text-muted-foreground")}
                  data-testid="leg-accredited"
                  data-ok={f.accredited}
                >
                  {f.accredited ? "✓" : "✗"} accredited investor
                </span>
                <span
                  className={cn("inline-flex items-center gap-1.5 text-sm", f.revVerified ? "text-success" : "text-muted-foreground")}
                  data-testid="leg-revenue"
                  data-ok={f.revVerified}
                >
                  {f.revVerified ? "✓" : "✗"} revenue ≥ {fmtUsd(X)}
                </span>
              </div>

              <div
                className={cn(
                  "flex items-center gap-3 rounded-2xl border p-4 text-base font-semibold",
                  f.canAccess
                    ? "border-success/40 bg-success/5 text-success"
                    : "border-destructive/40 bg-destructive/5 text-destructive",
                )}
                data-testid="access-verdict"
                data-granted={f.canAccess}
              >
                <span
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-full border",
                    f.canAccess ? "border-success/50 bg-success/10" : "border-destructive/50 bg-destructive/10",
                  )}
                >
                  <VerdictMark ok={!!f.canAccess} />
                </span>
                <span>
                  {f.canAccess
                    ? "ACCESS GRANTED — both proofs hold"
                    : f.accredited
                      ? "ACCESS DENIED — fundraise revenue not proven"
                      : f.revVerified
                        ? "ACCESS DENIED — investor not accredited"
                        : "ACCESS DENIED — neither proof holds"}
                </span>
              </div>

              {f.admitResp &&
                (f.admitResp.ok ? (
                  <DataRow k="admitted (tx)">
                    {f.admitResp.txHash ? (
                      <ExLink kind="tx" id={f.admitResp.txHash} net={net} />
                    ) : (
                      "ok"
                    )}
                  </DataRow>
                ) : (
                  <p className="text-sm text-destructive" data-testid="admit-error">
                    {friendlyError(f.admitResp.error)}
                  </p>
                ))}
            </div>
          </Panel>

          {/* company: prove revenue ≥ X */}
          <Panel title={<>Company — prove revenue ≥ X</>} aside={<ProofStatusBadge state={f.revState} />}>
            <p className="text-sm text-muted-foreground">
              The company's auditor signs the real (private) revenue; the zkVM proves it clears the public
              floor X. Only "≥ X" is revealed.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-2.5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="revenue-input">revenue (private, USD)</Label>
                <Input
                  id="revenue-input"
                  className="w-[160px]"
                  value={f.revenue}
                  onChange={(e) => f.setRevenue(e.target.value)}
                  aria-label="revenue"
                  data-testid="revenue"
                />
              </div>
              <Button onClick={f.onProveRevenue} disabled={f.revBusy || !validRevenue(f.revenue)} data-testid="prove-revenue">
                {f.revState === "proving" ? "Proving…" : "Prove revenue ≥ X & submit"}
              </Button>
            </div>
            {!validRevenue(f.revenue) && (
              <p className="mt-2 text-sm text-muted-foreground">
                Enter a positive whole-number revenue (private — only "≥ X" is revealed).
              </p>
            )}
            <ProveWait state={f.revState} proveBy={f.revBy} privacy="The real revenue figure never leaves the prover." />
            {f.revJournal && (
              <div className="mt-4">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Public journal — the revenue itself is absent
                </div>
                <DataRow k="claim" mono={false}>
                  {f.revJournal.claimType === 6 ? "Revenue ≥ X" : `type ${f.revJournal.claimType}`}
                </DataRow>
                <DataRow k="proven floor (X)" mono={false}>
                  {fmtUsd(f.revJournal.threshold)}
                </DataRow>
                <DataRow k="revenue" variant="private">
                  private — never revealed
                </DataRow>
              </div>
            )}
            {f.revResp && !f.revResp.ok && <p className="mt-3 text-sm text-destructive">{friendlyError(f.revResp.error)}</p>}
          </Panel>

          {/* investor: prove accredited */}
          <Panel title={<>Investor — prove accredited</>} aside={<ProofStatusBadge state={f.accState} />}>
            <p className="text-sm text-muted-foreground">
              An allow-listed accreditation provider signs the investor's credential; the zkVM proves
              "accredited = yes" while the investor's identity stays private, bound to a public accessor.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-2.5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="subject-select">investor (private)</Label>
                <select
                  id="subject-select"
                  className={SELECT_CLS}
                  value={f.subject}
                  onChange={(e) => f.setSubject(e.target.value)}
                  aria-label="subject"
                  data-testid="subject"
                >
                  <option value="ivy">Ivy</option>
                  <option value="fred">Fred</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="status-select">status</Label>
                <select
                  id="status-select"
                  className={SELECT_CLS}
                  value={f.accStatus ? "yes" : "no"}
                  onChange={(e) => f.setAccStatus(e.target.value === "yes")}
                  aria-label="accredited status"
                  data-testid="accredited-status"
                >
                  <option value="yes">accredited</option>
                  <option value="no">not accredited</option>
                </select>
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap items-end gap-2.5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="accessor-input">accessor</Label>
                <Input
                  id="accessor-input"
                  className="min-w-[360px] font-mono text-xs"
                  value={f.accessor}
                  onChange={(e) => f.setAccessor(e.target.value)}
                  aria-label="accessor"
                  data-testid="accessor"
                />
              </div>
              <Button onClick={f.onProveAccredited} disabled={f.accBusy} data-testid="prove-accredited">
                {f.accState === "proving" ? "Proving…" : "Prove accredited & grant"}
              </Button>
            </div>
            <ProveWait state={f.accState} proveBy={f.accBy} privacy="The investor's identity never leaves the prover." />
            {f.accJournal && (
              <div className="mt-4">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Public journal — the identity is absent
                </div>
                <DataRow k="claim" mono={false}>
                  {f.accJournal.claimType === 7 ? "Accredited investor" : `type ${f.accJournal.claimType}`}
                </DataRow>
                <DataRow k="accessor (granted)">{short(f.accJournal.accessor, 8)}</DataRow>
                <DataRow k="identity" variant="private" testId="identity-private">
                  private — never revealed
                </DataRow>
              </div>
            )}
            {f.accResp && !f.accResp.ok && (
              <p className="mt-3 text-sm text-destructive" data-testid="accredited-error">
                {friendlyError(f.accResp.error)}
              </p>
            )}
          </Panel>

          {/* admission history */}
          <Panel
            title={<>Investor admissions</>}
            aside={<span className="text-[11px] uppercase tracking-wide text-muted-foreground">anyone can read on-chain</span>}
          >
            {f.history.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm" data-testid="admission-history">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">#</th>
                      <th className="py-2 pr-3 font-medium">accessor</th>
                      <th className="py-2 pr-3 font-medium">revenue floor</th>
                      <th className="py-2 font-medium">ledger</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.history.map((h) => (
                      <tr key={h.index} className="border-b border-border/70 last:border-0">
                        <td className="py-2 pr-3 tabular-nums">{h.index}</td>
                        <td className="py-2 pr-3 font-mono text-xs" title={h.accessor}>
                          {short(h.accessor, 8)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{fmtUsd(h.revenue_threshold)}</td>
                        <td className="py-2 tabular-nums">{h.ledger}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No admissions yet.</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
