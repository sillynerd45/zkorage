import { useRelease } from "@/lib/hooks/useRelease";
import { Disclosure, Hex } from "@/components/Disclosure";
import { GlossaryTip } from "@/components/GlossaryTip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";

// DR3: threshold-ECIES committee (key release). A per-doc key K is Shamir-split 2-of-3 across an
// independent keyper committee; the recipient collects >= 2 sealed shares and reconstructs K + decrypts
// entirely in the browser. The recipient secret never leaves it.
export default function Release() {
  const r = useRelease();
  return (
    <div data-testid="dr3-card" className="space-y-5">
      <Card className="rounded-2xl border-brand/40 p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">
            Release the document key
          </h2>
          <span className="text-[11px] uppercase tracking-wide text-brand">
            split among 3 keepers <span aria-hidden="true">⚠️</span>
          </span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          A document's key is <b className="text-foreground">split into 3 parts</b>
          <GlossaryTip term="split key" /> held by separate
          <b className="text-foreground"> keepers</b>.{" "}
          <b className="text-foreground">No single keeper can open the file; any 2 together can</b>. Each keeper
          watches the public record and releases its part{" "}
          <b className="text-foreground">only to whoever won anonymous entry</b>, locked to that person's key.
          You collect 2 parts, then <b className="text-foreground">rebuild the key and decrypt entirely in your
          browser</b> (your private key never leaves it; the keepers only ever pass <i>sealed</i> parts).
          Remove this layer and you'd be back to one server holding the whole key. The private proof still decides{" "}
          <i>who</i> gets in.
        </p>

        {/* committee status + doc commitments: demoted behind a "Verify details" expander (UX research §12) */}
        <Disclosure
          toggleTestId="dr3-engine-details"
          summary={
            <>
              The <b>3 keepers</b> and this document's fingerprints. Expand to see which keepers are online and
              check the key/file fingerprints.
            </>
          }
        >
          <DataRow k="Keepers" mono={false} testId="dr3-committee">
            {r.committee
              ? `${r.committee.online}/${r.committee.n} keepers online · threshold ${r.committee.threshold}`
              : "not loaded"}
          </DataRow>
          {r.committee?.keypers?.map((kp) => (
            <DataRow
              key={kp.endpoint}
              k={`keeper ${kp.keyperIndex ?? "?"}`}
              mono={false}
              testId={`dr3-keyper-${kp.keyperIndex ?? 0}`}
            >
              {kp.ok ? `online · ${kp.shares ?? 0} part(s)` : "offline"}
            </DataRow>
          ))}
          <DataRow k="Demo doc file fingerprint" testId="dr3-content-hash">
            {r.committeeDoc?.content_hash ? <Hex value={r.committeeDoc.content_hash} chars={8} /> : "not loaded"}
          </DataRow>
          <DataRow k="Demo doc key fingerprint" testId="dr3-k-commitment">
            {r.committeeDoc?.k_commitment ? (
              <>
                sha256(K) <Hex value={r.committeeDoc.k_commitment} chars={8} />
              </>
            ) : (
              "not loaded"
            )}
          </DataRow>
        </Disclosure>

        {/* reconstruct & open (key-free, in-browser) */}
        <div className="mb-3 mt-5 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">Collect the parts, rebuild the key &amp; open</h3>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            any 2 of 3 · in your browser
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            room
            <Input
              className="font-mono text-xs"
              value={r.dr3Room}
              onChange={(e) => r.setDr3Room(e.target.value)}
              aria-label="dr3 room"
              data-testid="dr3-room"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            doc
            <Input
              className="font-mono text-xs"
              value={r.dr3Doc}
              onChange={(e) => r.setDr3Doc(e.target.value)}
              aria-label="dr3 doc"
              data-testid="dr3-doc"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground sm:col-span-2">
            your stand-in ID (admitted)
            <Input
              className="font-mono text-xs"
              value={r.dr3Accessor}
              onChange={(e) => r.setDr3Accessor(e.target.value)}
              aria-label="dr3 accessor"
              data-testid="dr3-accessor-input"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground sm:col-span-2">
            your private key (hex)
            <Input
              className="font-mono text-xs"
              value={r.dr3Secret}
              onChange={(e) => r.setDr3Secret(e.target.value)}
              aria-label="dr3 recipient secret"
              data-testid="dr3-secret"
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={r.onCommitteeOpen} disabled={r.dr3Busy} data-testid="dr3-open-btn">
            {r.dr3Busy ? "Rebuilding…" : "Collect parts, rebuild & open"}
          </Button>
        </div>
        <p className="mt-2 text-sm text-muted-foreground" data-testid="dr3-secret-note">
          <span aria-hidden="true">🔑</span> Your private key stays in this browser. The keepers only ever pass{" "}
          <i>sealed</i> parts, and we <b>can't recover it for you</b>. Prefilled with the demo key.
        </p>

        {r.dr3Opened && (
          <div
            data-testid="dr3-open-result"
            data-reconstructed={String(r.dr3Opened.reconstructed)}
            data-released={String(r.dr3Opened.released)}
            className="mt-4"
          >
            {!r.dr3Opened.found ? (
              <Verdict ok={false}>Document not found on the public record</Verdict>
            ) : !r.dr3Opened.released ? (
              <Verdict ok={false}>
                <span data-testid="dr3-not-released">
                  Not admitted. The keepers released no parts (fewer than 2), so someone without access can't
                  rebuild the key.
                </span>
              </Verdict>
            ) : r.dr3Opened.reconstructed ? (
              <>
                <Verdict ok>
                  Rebuilt the key from {r.dr3Opened.faithfulShares} parts (any 2 of 3) and the file matched its
                  fingerprint
                </Verdict>
                <div className="mt-3">
                  <DataRow k="rebuilt from keepers" mono={false} testId="dr3-pair">
                    {r.dr3Opened.reconstructedFromPair
                      ? `#${r.dr3Opened.reconstructedFromPair[0]} + #${r.dr3Opened.reconstructedFromPair[1]}`
                      : "not loaded"}
                  </DataRow>
                </div>
                <div className="mt-4 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Decrypted document
                </div>
                <pre
                  data-testid="dr3-plaintext"
                  className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border bg-muted/40 px-3.5 py-3 font-mono text-xs"
                >
                  {r.dr3Opened.plaintextUtf8 ?? `(binary, ${r.dr3Opened.plaintext?.length ?? 0} bytes)`}
                </pre>
              </>
            ) : (
              <Verdict ok={false}>
                <span data-testid="dr3-unfaithful">
                  Parts released, but only {r.dr3Opened.faithfulShares} opened correctly. The private key is
                  wrong, so the key can't be rebuilt.
                </span>
              </Verdict>
            )}
          </div>
        )}
        {r.dr3OpenErr && (
          <p className="mt-3 text-sm text-destructive" data-testid="dr3-open-error">
            {r.dr3OpenErr}
          </p>
        )}
      </Card>
    </div>
  );
}
