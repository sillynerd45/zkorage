import { useAuthenticity } from "@/lib/hooks/useAuthenticity";
import { short } from "@/lib/format";
import { Disclosure, Hex } from "@/components/Disclosure";
import { GlossaryTip } from "@/components/GlossaryTip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";

// DR4: document authenticity (signed-PDF / zkPDF: third-party truth on self-uploaded data). A third party
// (a bank) RSA-signs a statement; the docauth guest re-verifies that real RSA-2048 signature in-zkVM and
// proves a fact about it (e.g. "balance ≥ X") without revealing the statement or the exact value.
export default function Authenticity() {
  const a = useAuthenticity();
  const { docauth, docFact, dr4Verify } = a;
  const allPass =
    !!dr4Verify && dr4Verify.factOnChain && dr4Verify.imagePinned && dr4Verify.issuerAllowlisted && dr4Verify.valueHidden;

  return (
    <div data-testid="dr4-card" className="space-y-5">
      {/* marquee card: brand-accented */}
      <Card className="rounded-2xl border-brand/40 p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">
            Prove a signed fact <span aria-hidden="true">🏦</span>
          </h2>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            a fact a bank signed, without showing the document
          </span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Prove a fact from a document someone else signed, such as a bank statement,{" "}
          <b className="text-foreground">without showing the whole file</b>. zkorage re-checks the real{" "}
          <b className="text-foreground">digital signature</b> inside a{" "}
          <b className="text-foreground">private proof</b>
          <GlossaryTip term="private proof" /> and proves a fact about it (for example,{" "}
          <b className="text-foreground">"balance ≥ X"</b>){" "}
          <b className="text-foreground">without revealing the statement or the exact value</b>. Without
          this, self-uploaded data is just your word for it. Only a{" "}
          <b className="text-foreground">recognized bank's signature</b> is accepted, so you can't fake one.
        </p>

        {/* engine machinery: demoted behind a "Verify details" expander (UX research §12) */}
        <Disclosure
          toggleTestId="dr4-engine-details"
          summary={
            <>
              The cryptographic engine: the <b>pinned signature-checking program</b> and the{" "}
              <b>recognized bank's signing key</b> (a made-up key is rejected). Expand to check them.
            </>
          }
        >
          <div data-testid="dr4-image">
            <Hex label="Signature-checking program (pinned)" value={docauth?.docauthImageOnchain ?? ""} chars={8} />
            {docauth && docauth.docauthImageOnchain === docauth.docauthImageId ? " ✓" : ""}
          </div>
          <div data-testid="dr4-issuer">
            <Hex label="Bank signing key" value={docauth?.issuerKeyHash ?? ""} chars={8} />
            {docauth?.issuerAllowlisted ? " · allowlisted ✓" : ""}
          </div>
          <div className="text-xs text-muted-foreground">
            Kind of fact: {docauth?.claimType ?? "n/a"} (document authenticity)
          </div>
        </Disclosure>
      </Card>

      {/* the proven fact + in-browser provenance re-verification */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">Proven fact</h3>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">read-only · runs in your browser</span>
        </div>
        <p className="text-sm text-muted-foreground">
          The public record shows only the fact. It never shows the statement or the exact balance.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            Room
            <Input
              className="font-mono text-xs"
              value={a.dr4Room}
              onChange={(e) => a.setDr4Room(e.target.value)}
              aria-label="dr4 room"
              data-testid="dr4-room"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            Document fingerprint
            <Input
              className="font-mono text-xs"
              value={a.dr4Digest}
              onChange={(e) => a.setDr4Digest(e.target.value)}
              aria-label="dr4 digest"
              data-testid="dr4-digest"
            />
          </label>
        </div>
        <div className="mt-3">
          <Button onClick={a.onDocauthVerify} disabled={a.dr4Busy} data-testid="dr4-verify-btn">
            {a.dr4Busy ? "Checking…" : "Check on the public record"}
          </Button>
        </div>

        {docFact ? (
          <div data-testid="dr4-fact" className="mt-4">
            <Verdict ok>
              <span data-testid="dr4-fact-claim">
                A bank vouched: <b>balance ≥ {Number(docFact.threshold).toLocaleString()}</b>. Proven, and the
                exact value stays hidden.
              </span>
            </Verdict>
            <div className="mt-3">
              <DataRow k="Field" mono={false} testId="dr4-fact-field">
                {docFact.field_tag === 1 ? "account balance" : `field ${docFact.field_tag}`}
              </DataRow>
              <DataRow k="Threshold (public)" testId="dr4-fact-threshold">{docFact.threshold}</DataRow>
              <DataRow k="Bank signing key" testId="dr4-fact-issuer">
                <span title={docFact.issuer_key_hash}>{short(docFact.issuer_key_hash, 8)}</span>
              </DataRow>
              <DataRow k="Document fingerprint">
                <span title={docFact.msg_digest}>{short(docFact.msg_digest, 8)}</span>
              </DataRow>
              <DataRow k="Exact balance / statement" variant="private" testId="dr4-value-hidden">
                <span aria-hidden="true">🔒</span> never on the public record (private)
              </DataRow>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground" data-testid="dr4-no-fact">
            No fact anchored for this (room, document) yet.
          </p>
        )}

        {dr4Verify && (
          <div data-testid="dr4-verify-result" data-verdict={String(allPass)} className="mt-4">
            <div className="mb-3">
              <DataRow k="On the public record (checked before storing)" mono={false}>
                {dr4Verify.factOnChain ? "✓" : "✗"}
              </DataRow>
              <DataRow k="Program matches the official one" mono={false}>
                {dr4Verify.imagePinned ? "✓" : "✗"}
              </DataRow>
              <DataRow k="Signed by a recognized bank" mono={false}>
                {dr4Verify.issuerAllowlisted ? "✓" : "✗"}
              </DataRow>
              <DataRow k="Statement + exact value hidden" mono={false}>
                {dr4Verify.valueHidden ? "✓" : "✗"}
              </DataRow>
            </div>
            {allPass ? (
              <div data-testid="dr4-verdict-ok">
                <Verdict ok>
                  A bank's signature, re-checked inside a private proof. The document was never revealed.
                </Verdict>
              </div>
            ) : (
              <Verdict ok={false}>This check didn't fully pass.</Verdict>
            )}
          </div>
        )}
        {a.dr4Err && (
          <p className="mt-3 text-sm text-destructive" data-testid="dr4-error">
            {a.dr4Err}
          </p>
        )}
      </Card>
    </div>
  );
}
