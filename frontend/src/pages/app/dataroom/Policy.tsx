import { usePolicy } from "@/lib/hooks/usePolicy";
import { Disclosure, Hex } from "@/components/Disclosure";
import { GlossaryTip } from "@/components/GlossaryTip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";

// DR6: private-policy composition + revocation/rotation (the finale). A requester is admitted only by
// satisfying a composite policy (member ∧ KYC ∧ accredited ∧ not-sanctioned), each an independent ZK
// proof bound to one pseudonymous accessor, AND'd on-chain. No new guest; the AND is the cross-call.
export default function Policy() {
  const p = usePolicy();
  return (
    <div data-testid="dr6-card" className="space-y-5">
      {/* marquee card (brand-accented) */}
      <Card className="rounded-2xl border-brand/40 p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">
            Meet all conditions <span aria-hidden="true">🧩</span>
          </h2>
          <span className="text-[11px] uppercase tracking-wide text-brand">
            get in only if you meet every condition, anonymously
          </span>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          You're let in <b className="text-foreground">only if you meet every condition at once</b>. You're a{" "}
          <b className="text-foreground">member</b>, <b className="text-foreground">ID-checked</b>,
          <b className="text-foreground"> accredited</b>, and{" "}
          <b className="text-foreground">not on a sanctions list</b>. Each is a separate{" "}
          <b className="text-foreground">private proof</b>
          <GlossaryTip term="private proof" /> tied to one <b className="text-foreground">stand-in ID</b>
          <GlossaryTip term="stand-in ID" />, and the room checks them all together. Nothing reveals{" "}
          <b className="text-foreground">which member</b> you are or any of your details. A member can be{" "}
          <b className="text-foreground">removed</b> at any time, and the document key{" "}
          <b className="text-foreground">rotated</b> so their old parts no longer work.
        </p>

        {/* the policy machinery (the on-chain AND + the gate addresses): demoted behind a "Verify details"
            expander (UX research §12); the plain admission verdict below is what most people need */}
        <Disclosure
          toggleTestId="dr6-engine-details"
          summary={
            <>
              The rule checks <b>all conditions at once</b>: member <b>and</b> ID-checked <b>and</b> accredited{" "}
              <b>and</b> not-sanctioned. Expand to see the exact contract each condition is checked against.
            </>
          }
        >
          <DataRow k="All conditions (checked together)" mono={false}>
            member · ID-check · accredited · not-sanctioned
          </DataRow>
          {p.dr6Access?.policy && (
            <>
              <DataRow k="ID-check contract" testId="dr6-compliance-gate">
                {p.dr6Access.policy.compliance_gate ? (
                  <Hex value={p.dr6Access.policy.compliance_gate} chars={8} />
                ) : (
                  "(not required)"
                )}
              </DataRow>
              <DataRow k="Accredited contract" testId="dr6-accredited-gate">
                {p.dr6Access.policy.accredited_gate ? (
                  <Hex value={p.dr6Access.policy.accredited_gate} chars={8} />
                ) : (
                  "(not required)"
                )}
              </DataRow>
            </>
          )}
        </Disclosure>
      </Card>

      {/* who gets in (read-only, in-browser) */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">Who gets in</h3>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            read-only · runs in your browser
          </span>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The public record shows only the stand-in ID, never your name, which member you are, or any of your
          details.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            Room
            <Input
              className="font-mono text-xs"
              value={p.dr6Room}
              onChange={(e) => p.setDr6Room(e.target.value)}
              aria-label="dr6 room"
              data-testid="dr6-room"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            Stand-in ID
            <Input
              className="font-mono text-xs"
              value={p.dr6Accessor}
              onChange={(e) => p.setDr6Accessor(e.target.value)}
              aria-label="dr6 accessor"
              data-testid="dr6-accessor"
            />
          </label>
        </div>
        <div className="mt-3">
          <Button onClick={p.onCheckAccess} disabled={p.dr6Busy} data-testid="dr6-check-btn">
            {p.dr6Busy ? "Checking…" : "Check who gets in"}
          </Button>
        </div>

        {p.dr6Access && (
          <div
            data-testid="dr6-access"
            data-admitted={String(p.dr6Access.admitted)}
            className="mt-4"
          >
            {p.dr6Access.admitted ? (
              <div data-testid="dr6-verdict-ok">
                <Verdict ok>ADMITTED: every condition is met, proven anonymously</Verdict>
              </div>
            ) : (
              <div data-testid="dr6-verdict-deny">
                <Verdict ok={false}>
                  {p.dr6Access.revoked
                    ? "DENIED: access was removed"
                    : "DENIED: one of the required checks didn't pass"}
                </Verdict>
              </div>
            )}
            <div className="mt-3">
              <DataRow k="Member (got in anonymously)" mono={false} testId="dr6-leg-membership">
                {p.dr6Access.membership ? "✓" : "✗"}
              </DataRow>
              <DataRow k="ID-checked and not sanctioned" mono={false} testId="dr6-leg-compliance">
                {p.dr6Access.compliance === null ? "(not required)" : p.dr6Access.compliance ? "✓" : "✗"}
              </DataRow>
              <DataRow k="Accredited investor" mono={false} testId="dr6-leg-accredited">
                {p.dr6Access.accredited === null ? "(not required)" : p.dr6Access.accredited ? "✓" : "✗"}
              </DataRow>
              <DataRow k="Access removed" mono={false} testId="dr6-revoked">
                {p.dr6Access.revoked ? "yes" : "no"}
              </DataRow>
              <DataRow k="Your identity / which member" mono={false} variant="private">
                <span aria-hidden="true">🔒</span> never revealed
              </DataRow>
            </div>
          </div>
        )}
        {p.dr6Err && (
          <p className="mt-3 text-sm text-destructive" data-testid="dr6-error">
            {p.dr6Err}
          </p>
        )}
      </Card>

      {/* how fast, how private (live numbers) */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">How fast, how private</h3>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            live on the public record + measured
          </span>
        </div>
        <DataRow k="Demo room passes / admissions (live)" mono={false} testId="dr6-counts">
          {p.dr6Counts ? `${p.dr6Counts.grants} pass(es) · ${p.dr6Counts.admissions} admission(s)` : "…"}
        </DataRow>
        <DataRow k="Demo document key version (live)" mono={false} testId="dr6-epoch">
          {p.dr6Epoch === null ? "…" : p.dr6Epoch}
        </DataRow>
        <DataRow k="Proof work per condition" mono={false}>
          member 2 · ID-check 2 · accredited 1 (~6–12s each on GPU)
        </DataRow>
        <DataRow k="Checking all conditions" mono={false}>
          ~3 quick reads; no new proof needed to combine them
        </DataRow>
        <DataRow k="Privacy" mono={false}>
          your name · which member · ID-check subject · accreditation all hidden; the record shows only a
          stand-in ID + pass/fail flags
        </DataRow>
      </Card>
    </div>
  );
}
