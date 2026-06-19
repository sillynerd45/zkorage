import { useAnchor } from "@/lib/hooks/useAnchor";
import { short, explorer } from "@/lib/format";
import { humanError } from "@/lib/errors";
import { Disclosure, Hex } from "@/components/Disclosure";
import { GlossaryTip } from "@/components/GlossaryTip";
import { ProofStatusBadge, ProveWait } from "@/components/StatusBadge";
import { ConfirmModal } from "@/components/ConfirmModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";

export default function Anchor() {
  const a = useAnchor();
  return (
    <div className="space-y-5">
      {/* upload / encrypt / anchor */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">Store a document</h2>
          <ProofStatusBadge state={a.state} />
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Encrypt a document, keep the file private, and post only a tamper-evident{" "}
          <b className="text-foreground">fingerprint</b>
          <GlossaryTip term="fingerprint" /> to the public record. The file never leaves the prover in the
          clear; creating the proof takes a few minutes on the prover you run.
        </p>

        {/* DR1 engine rows (the sealing program + demo recipient key) — demoted behind a "Verify details"
            expander (UX research §12); you don't need them to store a document. */}
        <Disclosure
          toggleTestId="anchor-engine-details"
          summary={
            <>
              The cryptographic engine — the <b>pinned sealing program</b> and the <b>demo recipient key</b>.
              Expand to check them.
            </>
          }
        >
          {a.info?.dataroomImageId && (
            <div data-testid="seal-image">
              <Hex label="Sealing program (pinned)" value={a.info.dataroomImageId} chars={8} />
            </div>
          )}
          {a.info?.recipientPub && (
            <div data-testid="recipient-pub">
              <Hex label="Demo recipient (x25519)" value={a.info.recipientPub} chars={8} />
            </div>
          )}
        </Disclosure>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            room
            <Input
              value={a.roomLabel}
              onChange={(e) => a.setRoomLabel(e.target.value)}
              aria-label="room"
              data-testid="room-label"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            recipient's public key
            <Input
              className="font-mono text-xs"
              value={a.recipientPub}
              onChange={(e) => a.setRecipientPub(e.target.value)}
              aria-label="recipient pub"
              data-testid="recipient-input"
            />
          </label>
        </div>
        <div className="mt-3">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            document (private)
            <textarea
              className="min-h-[70px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              value={a.content}
              onChange={(e) => a.setContent(e.target.value)}
              aria-label="document content"
              data-testid="doc-content"
            />
          </label>
        </div>
        <div className="mt-4">
          <Button onClick={() => a.setConfirmAnchor(true)} disabled={a.busy} data-testid="upload">
            {a.busy ? "Working…" : "Encrypt, prove & post"}
          </Button>
        </div>

        <ConfirmModal
          open={a.confirmAnchor}
          title="Encrypt, prove & post this document?"
          tone="cost"
          confirmLabel="Yes, post it"
          onCancel={() => a.setConfirmAnchor(false)}
          onConfirm={() => { a.setConfirmAnchor(false); a.onUpload(); }}
        >
          <p>
            The document is encrypted and the key sealed to the recipient on the prover you run (the file
            never leaves it in the clear). Only an encrypted file + a tamper-evident fingerprint are posted —
            never the contents.
          </p>
        </ConfirmModal>

        {a.busy && a.step && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="upload-step">
            {a.step}
          </p>
        )}
        <ProveWait
          state={a.state}
          proveBy={a.proveBy}
          privacy="The document plaintext stays on the self-hosted prover — only an encrypted blob + a tamper-evident commitment go on-chain."
        />

        {a.journal && (
          <div className="mt-4">
            <Disclosure
              toggleTestId="anchor-journal-details"
              detailsLabel="Inspect the public journal"
              summary={
                <>
                  Posted — and note <b>the document key is absent</b>: only a fingerprint of the file + the
                  sealed key go on the public record, never the contents or the key in the clear.
                </>
              }
            >
              <DataRow k="kind" mono={false}>
                {a.journal.claimType === 8 ? "Data-room seal" : `type ${a.journal.claimType}`}
              </DataRow>
              <DataRow k="room">{short(a.journal.roomId, 8)}</DataRow>
              <DataRow k="doc">{short(a.journal.docId, 8)}</DataRow>
              <DataRow k="file fingerprint" testId="journal-content-hash">
                <Hex value={a.journal.contentHash} chars={8} />
              </DataRow>
              <DataRow k="recipient">x25519 {short(a.journal.recipientPub, 8)}</DataRow>
              <DataRow k="sealed key (encrypted)">
                <Hex value={a.journal.ct} label="ct" chars={8} />
              </DataRow>
              <DataRow k="document key" variant="private" testId="k-private">
                private — sealed to the recipient; never on the public record in the clear
              </DataRow>
            </Disclosure>
          </div>
        )}
      </Card>

      {/* anchor verdict */}
      {a.resp && (
        <Card className="rounded-2xl p-6" data-testid="anchor-verdict-card">
          {a.resp.ok ? (
            <>
              <Verdict ok>Document posted to the public record — encrypted, sealed to the recipient</Verdict>
              <div className="mt-3">
                {a.resp.txHash && (
                  <DataRow k="record entry">
                    <a
                      href={explorer("tx", a.resp.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand hover:underline"
                    >
                      {short(a.resp.txHash, 8)} ↗
                    </a>
                  </DataRow>
                )}
                {a.resp.result && (
                  <DataRow k="file fingerprint">{short(a.resp.result.content_hash, 8)}</DataRow>
                )}
                {a.resp.blobPointer && (
                  <DataRow k="stored file">
                    <span title={a.resp.blobPointer}>{short(a.resp.blobPointer, 14)}</span>
                  </DataRow>
                )}
              </div>
            </>
          ) : (
            <>
              <Verdict ok={false}>{a.state === "failed" ? "No proof produced" : "Rejected"}</Verdict>
              <p className="mt-3 text-sm text-destructive" data-testid="anchor-reject-reason">
                {humanError(a.resp.error, "dataroom")}
              </p>
            </>
          )}
        </Card>
      )}

      {/* recipient open (key-free, client-side) */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">Open a document</h2>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            the recipient unlocks it with their key — in your browser
          </span>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The recipient unlocks the document <b className="text-foreground">with their private key</b>. The
          proof guarantees the key really is for <i>this</i> document, the encrypted file is fetched and
          re-checked against its fingerprint, and it's decrypted —{" "}
          <b className="text-foreground">all in your browser</b> (your key never leaves it). The field is
          prefilled with the demo recipient's key; paste a different key to see it{" "}
          <b className="text-foreground">refuse to open</b>.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            room
            <Input
              className="font-mono text-xs"
              value={a.openRoom}
              onChange={(e) => a.setOpenRoom(e.target.value)}
              aria-label="open room"
              data-testid="open-room"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            doc
            <Input
              className="font-mono text-xs"
              value={a.openDoc}
              onChange={(e) => a.setOpenDoc(e.target.value)}
              aria-label="open doc"
              data-testid="open-doc"
            />
          </label>
        </div>
        <div className="mt-3">
          <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            recipient's private key (hex)
            <Input
              className="font-mono text-xs"
              value={a.openSecret}
              onChange={(e) => a.setOpenSecret(e.target.value)}
              aria-label="recipient secret"
              data-testid="open-secret"
            />
          </label>
        </div>
        <div className="mt-3">
          <Button onClick={a.onOpen} disabled={a.openBusy} data-testid="open-btn">
            {a.openBusy ? "Opening…" : "Open document"}
          </Button>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-testid="open-secret-note">
          <span aria-hidden="true">🔑</span> Your private key stays in this browser — we never see it and{" "}
          <b className="text-foreground">can't recover it for you</b>. The field is prefilled with the demo
          key; paste your own to open as yourself.
        </p>
        {a.sealedToYou && (
          <p className="mt-1 text-xs text-muted-foreground">
            your public key: <code className="font-mono">{short(a.sealedToYou, 8)}</code>
          </p>
        )}
        {a.opened && (
          <div
            data-testid="open-result"
            data-faithful={String(a.opened.faithful)}
            data-found={String(a.opened.found)}
            className="mt-4"
          >
            {!a.opened.found ? (
              <Verdict ok={false}>Document not found on the public record</Verdict>
            ) : a.opened.faithful ? (
              <>
                <Verdict ok>Unlocked — this is provably the right file (it matched its fingerprint)</Verdict>
                <div className="mt-3 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Decrypted document
                </div>
                <pre
                  className="mt-1.5 overflow-x-auto rounded-lg border bg-muted/40 px-3.5 py-3 font-mono text-xs"
                  data-testid="open-plaintext"
                  style={{ whiteSpace: "pre-wrap" }}
                >
                  {a.opened.plaintextUtf8 ?? `(binary, ${a.opened.plaintext?.length ?? 0} bytes)`}
                </pre>
              </>
            ) : (
              <Verdict ok={false}>
                <span data-testid="open-unfaithful">
                  Won't open — wrong key (this document isn't sealed to you).
                </span>
              </Verdict>
            )}
          </div>
        )}
        {a.openErr && (
          <p className="mt-3 text-sm text-destructive" data-testid="open-error">
            {a.openErr}
          </p>
        )}
      </Card>

      {/* public document browser */}
      <Card className="rounded-2xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">Documents</h2>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            anyone can read the record · contents hidden
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-1 flex-col gap-1.5 text-[13px] text-muted-foreground">
            room
            <Input
              className="font-mono text-xs"
              value={a.browseRoom}
              onChange={(e) => a.setBrowseRoom(e.target.value)}
              aria-label="browse room"
              data-testid="browse-room"
            />
          </label>
          <Button variant="outline" onClick={() => a.refreshDocs(a.browseRoom)} data-testid="browse-btn">
            List documents
          </Button>
        </div>
        {a.docs.length ? (
          <div className="mt-4 overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-[13px]" data-testid="dataroom-docs">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">doc</th>
                  <th className="px-3 py-2 font-medium">file fingerprint</th>
                  <th className="px-3 py-2 font-medium">key</th>
                  <th className="px-3 py-2 font-medium">contents</th>
                  <th className="px-3 py-2 font-medium">recorded</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {a.docs.map((d) => (
                  <tr key={d.index} className="border-b last:border-0">
                    <td className="px-3 py-2">{d.index}</td>
                    <td className="px-3 py-2" title={d.doc_id}>{short(d.doc_id, 6)}</td>
                    <td className="px-3 py-2" title={d.content_hash}>{short(d.content_hash, 6)}</td>
                    <td className="px-3 py-2" title={d.recipient_pub}>x25519 {short(d.recipient_pub, 6)}</td>
                    <td className="px-3 py-2 font-sans italic text-brand">encrypted</td>
                    <td className="px-3 py-2">{d.ledger}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No documents in this room yet.</p>
        )}
      </Card>
    </div>
  );
}
