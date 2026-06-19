import { useEligibility } from "@/lib/hooks/useEligibility";
import { short } from "@/lib/format";
import { humanError } from "@/lib/errors";
import { Disclosure, Hex } from "@/components/Disclosure";
import { GlossaryTip } from "@/components/GlossaryTip";
import { ProofStatusBadge, ProveWait } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";

export default function Eligibility() {
  const e = useEligibility();
  return (
    <div data-testid="dr2-card" className="space-y-5">
      {/* marquee card — brand-accented */}
      <Card className="rounded-2xl border-brand/40 p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">
            Get in anonymously <span aria-hidden="true">⭐</span>
          </h2>
          <span className="text-[11px] uppercase tracking-wide text-brand">the core idea</span>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          You get into a room <b className="text-foreground">only by proving you're on its approved list</b> —{" "}
          <b className="text-foreground">without showing which member you are</b>, and{" "}
          <b className="text-foreground">only once per room</b> (a{" "}
          <b className="text-foreground">one-time pass</b>
          <GlossaryTip term="one-time pass" /> stops the same member entering twice). A normal access list
          can't do this: it always learns who you are and can let you back in any time. That's the one thing
          only a <b className="text-foreground">private proof</b>
          <GlossaryTip term="private proof" /> can give you. The public record shows neither your name nor
          which member you are — though the <b className="text-foreground">time you enter is still recorded</b>.
        </p>

        <Disclosure
          toggleTestId="dr2-engine-details"
          summary={
            <>
              The cryptographic engine — the <b>pinned proving program</b>, this room's{" "}
              <b>approved-list fingerprint</b>, and the proof internals. Expand to check them yourself.
            </>
          }
        >
          <div data-testid="dr2-image">
            <Hex label="Proving program (pinned)" value={e.memInfo?.membershipImageOnchain ?? ""} chars={8} />
            {e.memInfo && e.memInfo.membershipImageOnchain === e.memInfo.membershipImageId ? " ✓" : ""}
          </div>
          <div className="text-xs text-muted-foreground">
            claim type {e.memInfo?.claimType ?? "—"} · tree depth {e.memInfo?.treeDepth ?? "—"}
          </div>
          <div data-testid="dr2-root">
            <Hex label="Approved-list fingerprint" value={e.elig?.pinnedRoot ?? ""} chars={8} />
          </div>
          <div className="text-xs text-muted-foreground" data-testid="dr2-grants">
            Demo room approved list:{" "}
            {e.elig?.memberCount != null ? `${e.elig.memberCount} member(s)${e.elig.inSync ? " · in sync ✓" : ""}` : "—"}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Proof internals: a depth-20 SHA-256 Merkle membership proof + a per-room nullifier (the one-time
            pass) + an in-prover holder signature.
          </p>
        </Disclosure>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={e.onRequestAccess} disabled={e.busy} data-testid="dr2-request">
            {e.busy ? "Working…" : "Request anonymous access"}
          </Button>
          <ProofStatusBadge state={e.state} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Joins a fresh room anonymously, proves you belong (a few minutes), and gets you in — then shows the
          same proof can't be reused to enter again.
        </p>
        {e.busy && e.step && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="dr2-step">
            {e.step}
          </p>
        )}
        <ProveWait
          state={e.state}
          proveBy={e.proveBy}
          privacy="Your identity — and which member you are — never leaves your browser; only the anonymous proof goes on-chain."
        />

        {e.grant && (
          <div data-testid="dr2-verdict" className="mt-4">
            <Verdict ok>You're in — anonymously (the public record shows only a stand-in ID, not your name)</Verdict>
            <div className="mt-3">
              <DataRow k="your stand-in ID" testId="dr2-accessor">{short(e.grant.accessor, 8)}</DataRow>
              <DataRow k="one-time pass (used)">{short(e.grant.nullifier ?? "", 8)}</DataRow>
              <DataRow k="your identity" variant="private">
                hidden — the proof never shows which member you are
              </DataRow>
              {e.grant.reused !== undefined && (
                <DataRow k="re-entry with the same pass" mono={false} testId="dr2-reuse">
                  {e.grant.reused
                    ? "blocked — this pass was already used (one entry per room)"
                    : "⚠ not blocked — unexpected"}
                </DataRow>
              )}
            </div>
          </div>
        )}
        {e.err && (
          <p className="mt-3 text-sm text-destructive" data-testid="dr2-error">
            {humanError(e.err, "dataroom")}
          </p>
        )}
      </Card>

      {/* read-only status check */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">Check who's in</h3>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">read-only · in your browser</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            room
            <Input
              className="font-mono text-xs"
              value={e.statusRoom}
              onChange={(ev) => e.setStatusRoom(ev.target.value)}
              aria-label="status room"
              data-testid="dr2-status-room"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            stand-in ID
            <Input
              className="font-mono text-xs"
              value={e.statusAccessor}
              onChange={(ev) => e.setStatusAccessor(ev.target.value)}
              aria-label="status accessor"
              data-testid="dr2-status-accessor"
            />
          </label>
        </div>
        <div className="mt-3">
          <Button variant="outline" onClick={e.onCheckStatus} disabled={e.statusBusy} data-testid="dr2-status-btn">
            {e.statusBusy ? "Checking…" : "Check access"}
          </Button>
        </div>
        {e.statusRes && (
          <div data-testid="dr2-status-result" data-granted={String(e.statusRes.granted)} className="mt-4">
            <Verdict ok={e.statusRes.granted}>
              {e.statusRes.granted ? "In — this stand-in ID has a currently-valid pass" : "Not in this room"}
            </Verdict>
            {e.statusRes.grant && (
              <div className="mt-3">
                <DataRow k="one-time pass">{short(e.statusRes.grant.nullifier, 8)}</DataRow>
                <DataRow k="approved-list fingerprint">{short(e.statusRes.grant.eligible_root, 8)}</DataRow>
                <DataRow k="identity" variant="private">absent — the record shows only a stand-in ID</DataRow>
              </div>
            )}
          </div>
        )}
        {e.statusErr && (
          <p className="mt-3 text-sm text-destructive" data-testid="dr2-status-error">
            {e.statusErr}
          </p>
        )}
      </Card>
    </div>
  );
}
