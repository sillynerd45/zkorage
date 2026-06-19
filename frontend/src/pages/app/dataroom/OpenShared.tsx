import { useSharedOpen } from "@/lib/hooks/useSharedOpen";
import { Disclosure, Hex } from "@/components/Disclosure";
import { GlossaryTip } from "@/components/GlossaryTip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";
import { DecryptedFile } from "@/components/app/DecryptedFile";

// Pattern 2 — prove a document's policy, get the key, open it (the self-serve reader flow). The room owner
// attaches a policy to a document; whoever proves they meet it (anonymously) has the key released to them by
// the 2-of-3 keepers, and decrypts in their browser. This folds the old "Meet all conditions" (admission)
// and "Release the key" (committee) flows into one experience. ZK is load-bearing: the room releases the key
// to someone it can't identify, because the proof, not a login, decides who qualifies.
export default function OpenShared() {
  const s = useSharedOpen();
  const leg = (v: boolean | null | undefined) => (v === null || v === undefined ? "(not required)" : v ? "✓" : "✗");
  return (
    <div data-testid="access-card" className="space-y-5">
      <Card className="rounded-2xl border-brand/40 p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">Open a shared document</h2>
          <span className="text-[11px] uppercase tracking-wide text-brand">
            prove you qualify, then the key is released to you
          </span>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          A room owner can protect a document so only people who <b className="text-foreground">prove they
          qualify</b> can open it. You prove the document's conditions (for example: a{" "}
          <b className="text-foreground">member</b>, <b className="text-foreground">ID-checked</b>, and{" "}
          <b className="text-foreground">accredited</b>), each a separate <b className="text-foreground">private
          proof</b>
          <GlossaryTip term="private proof" /> tied to one <b className="text-foreground">stand-in ID</b>
          <GlossaryTip term="stand-in ID" />. If every condition holds, the key's{" "}
          <b className="text-foreground">3 keepers</b> release their parts <b className="text-foreground">to
          you</b>, and you rebuild the key and decrypt in your browser. The room never learns{" "}
          <b className="text-foreground">who you are</b> or <b className="text-foreground">which member</b> you
          are. A login can't do this: it would have to know you to let you in.
        </p>

        {/* the keepers + this document's fingerprints, demoted behind a "Verify details" expander */}
        <Disclosure
          toggleTestId="access-engine-details"
          summary={
            <>
              The <b>3 keepers</b> and this document's fingerprints. Expand to see which keepers are online and
              check the key/file fingerprints.
            </>
          }
        >
          <DataRow k="Keepers" mono={false} testId="access-committee">
            {s.committee
              ? `${s.committee.online}/${s.committee.n} keepers online · threshold ${s.committee.threshold}`
              : "not loaded"}
          </DataRow>
          <DataRow k="Document file fingerprint" testId="access-content-hash">
            {s.committeeDoc?.content_hash ? <Hex value={s.committeeDoc.content_hash} chars={8} /> : "not loaded"}
          </DataRow>
          <DataRow k="Document key fingerprint" testId="access-k-commitment">
            {s.committeeDoc?.k_commitment ? (
              <>
                sha256(K) <Hex value={s.committeeDoc.k_commitment} chars={8} />
              </>
            ) : (
              "not loaded"
            )}
          </DataRow>
        </Disclosure>
      </Card>

      {/* Step 1: what this document requires + your live status */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">1. What this document requires</h3>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            read-only · runs in your browser
          </span>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The document's policy is public, so you can see exactly what to prove before you try. Proving it
          reveals only pass or fail per condition, never your identity or your underlying data.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            room
            <Input className="font-mono text-xs" value={s.room} onChange={(e) => s.setRoom(e.target.value)} aria-label="access room" data-testid="access-room" />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            doc
            <Input className="font-mono text-xs" value={s.doc} onChange={(e) => s.setDoc(e.target.value)} aria-label="access doc" data-testid="access-doc" />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground sm:col-span-2">
            your stand-in ID
            <Input className="font-mono text-xs" value={s.accessor} onChange={(e) => s.setAccessor(e.target.value)} aria-label="access accessor" data-testid="access-accessor" />
          </label>
        </div>
        <div className="mt-3">
          <Button onClick={s.onCheck} disabled={s.checking} data-testid="access-check-btn">
            {s.checking ? "Checking…" : "Check what I need to prove"}
          </Button>
        </div>

        {s.access && (
          <div className="mt-4" data-testid="access-result" data-admitted={String(s.access.admitted)}>
            {s.access.admitted ? (
              <div data-testid="access-verdict-ok">
                <Verdict ok>You qualify: every condition is met, proven anonymously. The key can be released to you.</Verdict>
              </div>
            ) : (
              <div data-testid="access-verdict-deny">
                <Verdict ok={false}>
                  {s.access.revoked ? "Access was removed for this stand-in ID." : "You don't qualify yet: a required condition isn't proven."}
                </Verdict>
              </div>
            )}
            <div className="mt-3">
              <DataRow k="Member (got in anonymously)" mono={false} testId="access-leg-membership">
                {s.access.membership ? "✓" : "✗"}
              </DataRow>
              <DataRow k="ID-checked and not sanctioned" mono={false} testId="access-leg-compliance">
                {leg(s.access.compliance)}
              </DataRow>
              <DataRow k="Accredited investor" mono={false} testId="access-leg-accredited">
                {leg(s.access.accredited)}
              </DataRow>
              <DataRow k="Your identity / which member" mono={false} variant="private">
                <span aria-hidden="true">🔒</span> never revealed
              </DataRow>
            </div>
          </div>
        )}
        {s.accessErr && (
          <p className="mt-3 text-sm text-destructive" data-testid="access-error">
            {s.accessErr}
          </p>
        )}
      </Card>

      {/* Step 2: get the key + open */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">2. Get the key and open it</h3>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            any 2 of 3 keepers · in your browser
          </span>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          If you qualify, each keeper releases its part of the key <b className="text-foreground">to you</b>,
          locked to your key. You collect 2 parts, rebuild the key, and decrypt, all in your browser. No single
          keeper can open the file; a non-qualifying reader gets no parts.
        </p>
        <div className="mt-4">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            your private key (hex)
            <Input className="font-mono text-xs" value={s.secret} onChange={(e) => s.setSecret(e.target.value)} aria-label="access secret" data-testid="access-secret" />
          </label>
        </div>
        <div className="mt-4">
          <Button onClick={s.onOpen} disabled={s.opening} data-testid="access-open-btn">
            {s.opening ? "Rebuilding…" : "Get the key and open"}
          </Button>
        </div>
        <p className="mt-2 text-sm text-muted-foreground" data-testid="access-secret-note">
          <span aria-hidden="true">🔑</span> Your private key stays in this browser. The keepers only ever pass{" "}
          <i>sealed</i> parts, and we <b className="text-foreground">can't recover it for you</b>. Prefilled with
          the demo key.
        </p>

        {s.opened && (
          <div className="mt-4" data-testid="access-open-result" data-reconstructed={String(s.opened.reconstructed)} data-released={String(s.opened.released)}>
            {!s.opened.found ? (
              <Verdict ok={false}>Document not found on the public record</Verdict>
            ) : !s.opened.released ? (
              <Verdict ok={false}>
                <span data-testid="access-not-released">
                  Not qualified. The keepers released no parts (fewer than 2), so a reader without access can't
                  rebuild the key.
                </span>
              </Verdict>
            ) : s.opened.reconstructed ? (
              <>
                <Verdict ok>
                  Rebuilt the key from {s.opened.faithfulShares} parts (any 2 of 3) and the file matched its
                  fingerprint
                </Verdict>
                <div data-testid="access-plaintext">
                  <DecryptedFile plaintext={s.opened.plaintext} plaintextUtf8={s.opened.plaintextUtf8} />
                </div>
              </>
            ) : (
              <Verdict ok={false}>
                <span data-testid="access-unfaithful">
                  Parts released, but only {s.opened.faithfulShares} opened correctly. The private key is wrong,
                  so the key can't be rebuilt.
                </span>
              </Verdict>
            )}
          </div>
        )}
        {s.openErr && (
          <p className="mt-3 text-sm text-destructive" data-testid="access-open-error">
            {s.openErr}
          </p>
        )}
      </Card>
    </div>
  );
}
