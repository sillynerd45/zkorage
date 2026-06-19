import { useDisclosure } from "@/lib/hooks/useDisclosure";
import { short } from "@/lib/format";
import { DEMO_TEASER_ATTESTER_ID, TEASER_IMAGE_ID } from "zkorage-sdk";
import { Disclosure, Hex } from "@/components/Disclosure";
import { GlossaryTip } from "@/components/GlossaryTip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";

// DR5: faithful disclosure / data-side teaser. A teaser proves a public fact about a SEALED document
// (e.g. "revenue ≥ $1M") vouched by an allowlisted appraiser, without revealing the figure; a designated
// auditor separately gets a provably-faithful redacted view. No new guest.
export default function DisclosureRoute() {
  const d = useDisclosure();
  return (
    <div data-testid="dr5-card" className="space-y-5">
      {/* marquee card (brand-accented) */}
      <Card className="rounded-2xl border-brand/40 p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">
            Share an unaltered copy, plus a verified preview
          </h2>
          <span className="text-[11px] uppercase tracking-wide text-brand">
            prove a fact about a sealed file; share a masked copy <span aria-hidden="true">🪪</span>
          </span>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          A <b className="text-foreground">verified preview</b>
          <GlossaryTip term="verified preview" /> proves a public fact about a{" "}
          <b className="text-foreground">sealed</b> document (for example,{" "}
          <b className="text-foreground">"revenue ≥ $1M"</b>), vouched for by an approved{" "}
          <b className="text-foreground">reviewer</b>,{" "}
          <b className="text-foreground">without revealing the document or the exact figure</b>. A named{" "}
          <b className="text-foreground">auditor</b> separately gets a{" "}
          <b className="text-foreground">masked copy</b>
          <GlossaryTip term="masked copy" /> with private fields blacked out, HIPAA/PCI/GDPR-style. You can also prove it is{" "}
          <b className="text-foreground">the real, unaltered file</b>.
        </p>

        {/* engine machinery: demoted behind a "Verify details" expander (UX research §12) */}
        <Disclosure
          toggleTestId="dr5-engine-details"
          summary={
            <>
              The cryptographic engine: the <b>pinned proving program</b> and the{" "}
              <b>approved reviewer</b> who vouches for the figure. Expand to check them.
            </>
          }
        >
          <div data-testid="dr5-image">
            <Hex label="Proving program (pinned)" value={TEASER_IMAGE_ID} chars={8} /> (generic value≥threshold)
          </div>
          <div data-testid="dr5-appraiser">
            <Hex label="Reviewer" value={DEMO_TEASER_ATTESTER_ID} chars={8} />
            {d.teaser ? " · allowlisted ✓" : ""}
          </div>
          <div className="text-xs text-muted-foreground">Kind of fact: 11 (data-room preview)</div>
        </Disclosure>

        <div className="mt-4 mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">The verified preview</h3>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            read-only · runs in your browser
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          The public record shows only the fact (figure ≥ X). It never shows the figure itself.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            Room
            <Input
              className="font-mono text-xs"
              value={d.dr5Room}
              onChange={(e) => d.setDr5Room(e.target.value)}
              aria-label="dr5 room"
              data-testid="dr5-room"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            Document (sealed)
            <Input
              className="font-mono text-xs"
              value={d.dr5Doc}
              onChange={(e) => d.setDr5Doc(e.target.value)}
              aria-label="dr5 doc"
              data-testid="dr5-doc"
            />
          </label>
        </div>
        <div className="mt-3">
          <Button onClick={d.onTeaserVerify} disabled={d.dr5Busy} data-testid="dr5-verify-btn">
            {d.dr5Busy ? "Checking…" : "Check on the public record"}
          </Button>
        </div>

        {d.teaser ? (
          <div data-testid="dr5-teaser" className="mt-4">
            <Verdict ok>
              <span data-testid="dr5-teaser-claim">
                Verified preview:{" "}
                <b>
                  {d.teaser.field_tag === 1 ? "revenue" : `field ${d.teaser.field_tag}`} ≥{" "}
                  {Number(d.teaser.threshold).toLocaleString()}
                </b>{" "}
                (proven about the sealed file, exact figure hidden)
              </span>
            </Verdict>
            <div className="mt-3">
              <DataRow k="Threshold (public)" testId="dr5-teaser-threshold">{d.teaser.threshold}</DataRow>
              <DataRow k="Tied to the file's fingerprint">
                <span data-testid="dr5-teaser-bound" title={d.teaser.content_hash}>
                  {short(d.teaser.content_hash, 8)}
                </span>
              </DataRow>
              <DataRow k="Reviewer">
                <span title={d.teaser.attester}>{short(d.teaser.attester, 8)}</span>
              </DataRow>
              <DataRow k="Still valid (not expired)" mono={false} testId="dr5-teaser-valid">
                {d.teaserValid ? "✓" : "✗"}
              </DataRow>
              <DataRow k="Exact figure" variant="private" testId="dr5-figure-hidden">
                <span aria-hidden="true">🔒</span> never on the public record (private)
              </DataRow>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground" data-testid="dr5-no-teaser">
            No verified preview for this (room, document) yet.
          </p>
        )}

        {d.dr5Verify && (
          <div
            data-testid="dr5-verify-result"
            data-verdict={String(d.dr5Verify.teaserOnChain && d.dr5Verify.imagePinned && d.dr5Verify.appraiserAllowlisted && d.dr5Verify.figureHidden)}
            className="mt-4"
          >
            <DataRow k="On the public record (checked before storing)" mono={false}>
              {d.dr5Verify.teaserOnChain ? "✓" : "✗"}
            </DataRow>
            <DataRow k="Program matches the official one" mono={false}>
              {d.dr5Verify.imagePinned ? "✓" : "✗"}
            </DataRow>
            <DataRow k="Vouched by an approved reviewer" mono={false}>
              {d.dr5Verify.appraiserAllowlisted ? "✓" : "✗"}
            </DataRow>
            <DataRow k="Exact figure hidden" mono={false}>
              {d.dr5Verify.figureHidden ? "✓" : "✗"}
            </DataRow>
            {d.dr5Verify.teaserOnChain && d.dr5Verify.imagePinned && d.dr5Verify.appraiserAllowlisted && d.dr5Verify.figureHidden ? (
              <div className="mt-3" data-testid="dr5-verdict-ok">
                <Verdict ok>A reviewer-vouched fact, proven privately. The document was never revealed.</Verdict>
              </div>
            ) : (
              <div className="mt-3">
                <Verdict ok={false}>This check didn't fully pass.</Verdict>
              </div>
            )}
          </div>
        )}
        {d.dr5Err && (
          <p className="mt-3 text-sm text-destructive" data-testid="dr5-error">
            {d.dr5Err}
          </p>
        )}
      </Card>

      {/* auditor's masked copy: key-free, in-browser open */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">Auditor's masked copy</h3>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            the read key never leaves your browser
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          The auditor opens a <b className="text-foreground">masked copy</b> of the same statement, with private
          fields blacked out, HIPAA/PCI/GDPR-style. You can prove it is the{" "}
          <b className="text-foreground">real, unaltered file</b>. It opens entirely in your browser. A wrong
          key means it won't open.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            Masked copy (doc)
            <Input
              className="font-mono text-xs"
              value={d.viewDoc}
              onChange={(e) => d.setViewDoc(e.target.value)}
              aria-label="dr5 view doc"
              data-testid="dr5-view-doc"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            Auditor's read key
            <Input
              className="font-mono text-xs"
              value={d.auditorSecret}
              onChange={(e) => d.setAuditorSecret(e.target.value)}
              aria-label="auditor secret"
              data-testid="dr5-auditor-secret"
            />
          </label>
        </div>
        <div className="mt-3">
          <Button onClick={d.onAuditorOpen} disabled={d.openBusyDr5} data-testid="dr5-open-btn">
            {d.openBusyDr5 ? "Opening…" : "Open the masked copy"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="dr5-secret-note">
          <span aria-hidden="true">🔑</span> Your auditor read key stays in this browser. We never see it and{" "}
          <b className="text-foreground">can't recover it for you</b>. Prefilled with the demo key.
        </p>
        {d.redacted && (
          <div data-testid="dr5-redacted" data-faithful={String(d.redacted.faithful)} className="mt-4">
            {d.redacted.faithful && d.redacted.document ? (
              <>
                <div data-testid="dr5-faithful">
                  <Verdict ok>Unaltered masked copy, provably the real file's contents</Verdict>
                </div>
                <pre
                  data-testid="dr5-redacted-json"
                  className="mt-3 whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 font-mono text-xs"
                >
                  {JSON.stringify(d.redacted.document, null, 2)}
                </pre>
                {d.redacted.log && d.redacted.log.length > 0 && (
                  <div className="mt-3">
                    <span className="text-[13px] text-muted-foreground">What was masked</span>
                    <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                      {d.redacted.log.map((e) => (
                        <li key={e.field}>
                          <b className="text-foreground">{e.field}</b>: {e.mask} ({e.basis})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <div data-testid="dr5-not-faithful">
                <Verdict ok={false}>Won't open: wrong read key, or the file was tampered with. Nothing released.</Verdict>
              </div>
            )}
          </div>
        )}
        {d.openErrDr5 && (
          <p className="mt-3 text-sm text-destructive" data-testid="dr5-open-error">
            {d.openErrDr5}
          </p>
        )}
      </Card>
    </div>
  );
}
