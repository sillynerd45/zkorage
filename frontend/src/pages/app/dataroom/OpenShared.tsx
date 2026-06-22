import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSharedOpen } from "@/lib/hooks/useSharedOpen";
import { Disclosure, Hex } from "@/components/Disclosure";
import { GlossaryTip } from "@/components/GlossaryTip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";
import { DecryptedFile } from "@/components/app/DecryptedFile";
import { AnonymityMeter, ANON_FLOOR } from "@/components/app/dataroom/AnonymityMeter";
import { Callout, SectionLabel } from "@/components/app/dataroom/kit";
import { FileText, ShieldQuestion } from "lucide-react";
import { short } from "@/lib/format";
import { cn } from "@/lib/utils";

// M3: "Open a shared document" with sign-to-derive identity (Model B). The reader proves anonymous membership
// once with their wallet-derived identity, the 2-of-3 keepers release the key to that member's wallet-derived
// recipient key, and the file decrypts in the browser. The room learns that an approved member opened it,
// never which one. ZK is load-bearing: a login would have to know you to let you in; a proof does not.
export default function OpenShared() {
  const s = useSharedOpen();
  const leg = (v: boolean | null | undefined) => (v === null || v === undefined ? "(not required)" : v ? "✓" : "✗");

  // Prefill the room (and optionally the doc) when arriving from a deep link, e.g. "Open documents" in
  // Membership > Your requests or the Discover directory: /app/dataroom/access?room=<id>[&doc=<id>].
  const [params] = useSearchParams();
  const paramRoom = params.get("room");
  const paramDoc = params.get("doc");
  useEffect(() => {
    if (paramRoom) {
      s.setRoom(paramRoom);
      // A room-only deep link must not leave the demo doc id bound to a DIFFERENT room: clear it so the
      // "Documents in this room" picker drives the selection. (Empty doc no-ops every guard until a pick.)
      s.setDoc(paramDoc ?? "");
    } else if (paramDoc) {
      s.setDoc(paramDoc);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramRoom, paramDoc]);

  if (!s.connected) {
    return (
      <Card className="rounded-2xl border-brand/40 p-6" data-testid="access-connect-prompt">
        <h2 className="text-base font-semibold tracking-tight">Open a shared document</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Connect your wallet to open a shared document. Your identity for a room is derived from your wallet in
          this browser, so the room never learns who you are, and you can open from any device. The wallet only
          signs a fixed message to derive your keys; it never moves funds here.
        </p>
        <div className="mt-4">
          <Button onClick={s.connect} data-testid="access-connect-btn">Connect wallet</Button>
        </div>
      </Card>
    );
  }

  const admitted = Boolean(s.access?.admitted);
  const proving = s.proveStage !== "idle";

  return (
    <div data-testid="access-card" className="space-y-5">
      <Card className="rounded-2xl border-brand/40 p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">Open a shared document</h2>
          <span className="text-[11px] uppercase tracking-wide text-brand">
            prove you qualify, then the key is released to you
          </span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          A room owner can protect a document so only people who <b className="text-foreground">prove they
          qualify</b> can open it. Your <b className="text-foreground">stand-in ID</b>
          <GlossaryTip term="stand-in ID" /> is derived from your wallet in this browser, so the room never
          learns <b className="text-foreground">who you are</b> or <b className="text-foreground">which member</b>{" "}
          you are. You prove the document's conditions, each a separate <b className="text-foreground">private
          proof</b>
          <GlossaryTip term="private proof" />. If every condition holds, the document's{" "}
          <b className="text-foreground">3 keepers</b> release their parts of the key <b className="text-foreground">to
          you</b>, and you rebuild the key and decrypt here. A login can't do this: it would have to know you to
          let you in.
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

      {/* Step 1: derive your identity, see what this document requires + your live status */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">1. Prove you qualify</h3>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            read-only · runs in your browser
          </span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The document's policy is public, so you can see exactly what to prove before you try. Checking derives
          your room identity from your wallet (one signature) and reads your live status on-chain. It reveals
          only your pseudonymous stand-in ID, never your identity or your data.
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
        </div>

        {/* The room's documents, so a member can SEE and pick one instead of pasting a doc id. Public on-chain
            fingerprints only (content hash), never the contents; committee docs only (the kind openable here). */}
        {(s.roomDocs.length > 0 || s.docsLoading) && (
          <div className="mt-4 space-y-2" data-testid="access-doc-list">
            <SectionLabel withRule>
              <span className="inline-flex items-center gap-1.5">
                <FileText className="size-4" aria-hidden="true" />
                Documents in this room
              </span>
            </SectionLabel>
            {s.docsLoading && s.roomDocs.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="access-docs-loading">Loading documents…</p>
            ) : (
              <div className="divide-y divide-border/70 rounded-xl border">
                {s.roomDocs.map((d) => {
                  const selected = d.doc_id.toLowerCase() === s.doc.trim().toLowerCase();
                  return (
                    <button
                      key={d.doc_id}
                      type="button"
                      onClick={() => s.setDoc(d.doc_id)}
                      aria-pressed={selected}
                      data-testid="access-doc-row"
                      className={cn(
                        "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/40",
                        selected && "bg-accent/50",
                      )}
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-xs">{short(d.doc_id, 8)}</div>
                        <div className="truncate text-[11px] text-muted-foreground">fingerprint {short(d.content_hash, 6)}</div>
                      </div>
                      {selected && <span className="shrink-0 text-[11px] uppercase tracking-wide text-brand">selected</span>}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              The room's documents on the public record, shown as fingerprints only, never the contents. Pick
              one, then Check access.
            </p>
          </div>
        )}

        {/* anonymity meter (the room's eligible-set size) + the honest side-channel caveat */}
        <div className="mt-4 space-y-3">
          <AnonymityMeter count={s.anonCount} />
          <Callout icon={ShieldQuestion}>
            What the room can see: that an approved member opened a document in a time window, never which member.
            Accesses in a window are recorded on-chain together, in shuffled order, at fixed boundaries, so the
            timestamp and order of the record do not show when you acted. The record does note which membership
            snapshot you proved against, so a room with one stable member list gives every member the same cover,
            while a room that keeps adding members in batches narrows you to the people present at your snapshot.
            How well you blend in also depends on how many others access in the same window, which is why access
            needs at least {ANON_FLOOR} members. Over many windows the pattern can still narrow, and this hides you
            from the room owner, not from us.
          </Callout>
        </div>

        <div className="mt-3">
          <Button onClick={s.onCheck} disabled={s.checking || s.deriving} data-testid="access-check-btn">
            {s.checking || s.deriving ? "Checking…" : "Check access"}
          </Button>
        </div>

        {s.identity && (
          <div className="mt-4" data-testid="access-identity">
            <DataRow k="Your stand-in ID" testId="access-stand-in">
              {short(s.identity.accessor, 8)}
            </DataRow>
            <DataRow k="Your identity / which member" mono={false} variant="private">
              <span aria-hidden="true">🔒</span> derived in this browser, never revealed
            </DataRow>
          </div>
        )}

        {s.drift && (
          <p className="mt-3 text-sm text-amber-600 dark:text-amber-500" data-testid="access-drift">
            Your wallet produced a different identity than before. If you enrolled earlier with a different
            wallet or signing format, access tied to the old identity may not match.
          </p>
        )}

        {s.access && (
          <div className="mt-4" data-testid="access-result" data-admitted={String(s.access.admitted)}>
            {s.access.admitted ? (
              <div data-testid="access-verdict-ok">
                <Verdict ok>You qualify: every condition is met, proven anonymously. The key can be released to you below.</Verdict>
              </div>
            ) : (
              <div data-testid="access-verdict-deny">
                <Verdict ok={false}>
                  {s.access.revoked
                    ? "Access was removed for this stand-in ID."
                    : "You don't qualify yet: a required condition isn't proven."}
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
            </div>

            {/* Branch: granted -> open below; on the list, not granted -> prove once; not on the list -> join. */}
            {!s.access.admitted && !s.access.revoked && (
              <div className="mt-4 border-t border-border/70 pt-4">
                {s.enrollState === "eligible" ? (
                  <div data-testid="access-prove">
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      You are on this room's list. Prove your membership once to unlock it. The proof runs on our
                      <b className="text-foreground"> self-hosted prover</b>, which must see your secret keys to
                      build it. That is why we run the prover ourselves and never send your data to a third
                      party. Your keys are not stored and go to no one else. Your access is then recorded on-chain
                      in a <b className="text-foreground">batch</b>, shuffled with the other accesses in a short
                      time window, so the room cannot tell when you acted. After it lands, opening any document in
                      the room is instant.
                    </p>
                    <div className="mt-3">
                      <Button onClick={s.onProve} disabled={proving || s.belowFloor} data-testid="access-prove-btn">
                        {s.proveStage === "proving"
                          ? "Proving…"
                          : s.proveStage === "queuing"
                            ? "Queuing…"
                            : s.proveStage === "queued"
                              ? "Waiting for the window…"
                              : "Prove membership and unlock"}
                      </Button>
                    </div>
                    {s.belowFloor && (
                      <p className="mt-2 text-sm text-destructive" data-testid="access-floor-note">
                        This room has fewer than {ANON_FLOOR} members, so access is disabled until it grows.
                      </p>
                    )}
                    {s.proveStep && (
                      <p className="mt-3 text-sm text-muted-foreground" data-testid="access-prove-step">
                        {s.proveStep}
                        {s.proveBy ? ` (proving on: ${s.proveBy})` : ""}
                      </p>
                    )}
                    {s.proveStage === "queued" && s.flushAt && (
                      <p className="mt-1 text-sm text-muted-foreground" data-testid="access-queued-eta">
                        Next batch window around {new Date(s.flushAt).toLocaleTimeString()}. You can leave this
                        open; it unlocks once your access lands.
                      </p>
                    )}
                    {s.proveErr && (
                      <p className="mt-3 text-sm text-destructive" data-testid="access-prove-error">
                        {s.proveErr}
                      </p>
                    )}
                  </div>
                ) : s.enrollState === "pending" ? (
                  <p className="text-sm leading-relaxed text-muted-foreground" data-testid="access-pending">
                    Your request to join this room is waiting for the owner to approve it. Once approved, come
                    back here to prove your membership and open the document.
                  </p>
                ) : (
                  <p className="text-sm leading-relaxed text-muted-foreground" data-testid="access-join-pointer">
                    You are not on this room's list yet.{" "}
                    <Link to="/app/dataroom/membership" className="text-brand hover:underline">
                      Request to join in Membership
                    </Link>
                    , and once the owner approves you, come back to prove your membership and open the document.
                  </p>
                )}
              </div>
            )}
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
        <p className="text-sm leading-relaxed text-muted-foreground">
          If you qualify, each keeper releases its part of the key <b className="text-foreground">to you</b>,
          locked to your wallet-derived key. You collect 2 parts, rebuild the key, and decrypt, all in your
          browser. No single keeper can open the file; a non-qualifying reader gets no parts.
        </p>
        <div className="mt-4">
          <Button onClick={s.onOpen} disabled={s.opening || !admitted || s.belowFloor} data-testid="access-open-btn">
            {s.opening ? "Rebuilding…" : "Get the key and open"}
          </Button>
        </div>
        {admitted && s.belowFloor && (
          <p className="mt-2 text-sm text-destructive" data-testid="access-open-floor-note">
            This room has fewer than {ANON_FLOOR} members, so the key cannot be released until it grows.
          </p>
        )}
        <p className="mt-2 text-sm text-muted-foreground" data-testid="access-open-note">
          <span aria-hidden="true">🔑</span> The key that opens the parts is derived from your wallet and stays
          in this browser. The keepers only ever pass <i>sealed</i> parts, and we{" "}
          <b className="text-foreground">never receive your key</b>.
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
                  Parts released, but only {s.opened.faithfulShares} opened correctly. The wallet-derived key is
                  wrong, so the key can't be rebuilt.
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
