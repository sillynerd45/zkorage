import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAnchor } from "@/lib/hooks/useAnchor";
import { short, explorer } from "@/lib/format";
import { humanError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Disclosure, Hex } from "@/components/Disclosure";
import { GlossaryTip } from "@/components/GlossaryTip";
import { ProofStatusBadge, ProveWait } from "@/components/StatusBadge";
import { ConfirmModal } from "@/components/ConfirmModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";
import { DecryptedFile } from "@/components/app/DecryptedFile";

// The Documents page is now a small submenu (Store / Open / Browse) instead of one long scroll. The
// Overview's deep links (#store / #open / #browse) select the matching sub-tab, so the entry points still
// work. One sub-tab shows at a time.
type DocTab = "store" | "open" | "browse";
const SUBTABS: { key: DocTab; label: string }[] = [
  { key: "store", label: "Store" },
  { key: "open", label: "Open" },
  { key: "browse", label: "Browse" },
];
const tabFromHash = (h: string): DocTab => {
  const id = h.replace("#", "");
  return id === "open" || id === "browse" ? id : "store";
};

export default function Anchor() {
  const a = useAnchor();
  const { hash } = useLocation();
  const [tab, setTab] = useState<DocTab>(() => tabFromHash(hash));
  // Keep the sub-tab in sync with the URL hash so a deep link from the Overview lands on the right one.
  useEffect(() => {
    setTab(tabFromHash(hash));
  }, [hash]);

  return (
    <div className="space-y-5">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Everything for this room's files in one place: <b className="text-foreground">store</b> a new one,{" "}
        <b className="text-foreground">open</b> one you can decrypt, or <b className="text-foreground">browse</b>{" "}
        what's yours.
      </p>

      {/* Documents submenu */}
      <div className="flex gap-1 rounded-2xl border bg-card p-1.5" role="tablist" aria-label="Documents">
        {SUBTABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            data-testid={`doc-subtab-${t.key}`}
            className={cn(
              "rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors",
              tab === t.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── STORE: upload / encrypt / anchor ── */}
      {tab === "store" && (
        <>
          <Card id="store" className="rounded-2xl p-6">
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

            {/* DR1 engine rows (the sealing program + demo recipient key), demoted behind a "Verify details"
                expander (UX research §12); you don't need them to store a document. */}
            <Disclosure
              toggleTestId="anchor-engine-details"
              summary={
                <>
                  The cryptographic engine: the <b>pinned sealing program</b> and the <b>demo recipient key</b>.
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
                document text (private)
                <textarea
                  className="min-h-[70px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                  value={a.content}
                  onChange={(e) => a.setContent(e.target.value)}
                  aria-label="document content"
                  data-testid="doc-content"
                  disabled={!!a.file}
                />
              </label>
            </div>

            {/* Or store a file instead. A chosen file (PDF, image, any bytes) overrides the text box; it is
                read in your browser and encrypted exactly like text. The contents still never leave in the clear. */}
            <div className="mt-3">
              <span className="text-[13px] text-muted-foreground">
                or store a file <span className="text-muted-foreground/70">(PDF, image, any file up to 8 MB)</span>
              </span>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input
                  type="file"
                  onChange={(e) => a.pickFile(e.target.files?.[0] ?? null)}
                  aria-label="document file"
                  data-testid="doc-file"
                  className="block max-w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-accent"
                />
                {a.file && (
                  <span
                    data-testid="doc-file-chip"
                    className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs"
                  >
                    <span className="max-w-[16rem] truncate font-medium" title={a.file.name}>{a.file.name}</span>
                    <span className="text-muted-foreground">{(a.file.size / 1024).toFixed(1)} KB</span>
                    <button
                      type="button"
                      onClick={a.clearFile}
                      aria-label="remove file"
                      data-testid="doc-file-clear"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      ✕
                    </button>
                  </span>
                )}
              </div>
              {a.fileErr && (
                <p className="mt-1.5 text-xs text-destructive" data-testid="doc-file-error">{a.fileErr}</p>
              )}
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
                never leaves it in the clear). Only an encrypted file and a tamper-evident fingerprint are posted.
                The contents are never posted.
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
              privacy="The document plaintext stays on the self-hosted prover. Only an encrypted blob and a tamper-evident commitment go on-chain."
            />

            {a.journal && (
              <div className="mt-4">
                <Disclosure
                  toggleTestId="anchor-journal-details"
                  detailsLabel="Inspect the public journal"
                  summary={
                    <>
                      Posted. Note that <b>the document key is absent</b>. Only a fingerprint of the file and the
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
                    private (sealed to the recipient; never on the public record in the clear)
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
                  <Verdict ok>Document posted to the public record (encrypted and sealed to the recipient)</Verdict>
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
        </>
      )}

      {/* ── OPEN: recipient open (key-free, client-side) ── */}
      {tab === "open" && (
        <Card id="open" className="rounded-2xl p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold tracking-tight">Open a document</h2>
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              the recipient opens it with their key, in your browser
            </span>
          </div>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            The recipient opens the document <b className="text-foreground">with their private key</b>. The
            proof guarantees the key really is for <i>this</i> document, the encrypted file is fetched and
            re-checked against its fingerprint, and then it's decrypted{" "}
            <b className="text-foreground">all in your browser</b> (your key never leaves it). The field is
            prefilled with the demo recipient's key. Paste a different key to see it{" "}
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
            <span aria-hidden="true">🔑</span> Your private key stays in this browser. We never see it and{" "}
            <b className="text-foreground">can't recover it for you</b>. The field is prefilled with the demo
            key. Paste your own to open as yourself.
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
                  <Verdict ok>Opened. This is provably the right file (it matched its fingerprint)</Verdict>
                  <div data-testid="open-plaintext">
                    <DecryptedFile plaintext={a.opened.plaintext} plaintextUtf8={a.opened.plaintextUtf8} />
                  </div>
                </>
              ) : (
                <Verdict ok={false}>
                  <span data-testid="open-unfaithful">
                    Won't open: wrong key (this document isn't sealed to you).
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
      )}

      {/* ── BROWSE: your documents (rooms your wallet owns on-chain) ── */}
      {tab === "browse" && (
        <Card id="browse" className="rounded-2xl p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold tracking-tight">Your documents</h2>
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              everything here is encrypted
            </span>
          </div>
          {!a.connected ? (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground" data-testid="browse-connect-prompt">
              Connect your wallet to see the rooms you own and the documents you stored. This only reads the
              on-chain owner of each room. Your address is a public key, not your name.
            </p>
          ) : a.roomsLoading ? (
            <p className="text-sm text-muted-foreground">Reading the public record…</p>
          ) : a.myRooms.length === 0 ? (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground" data-testid="browse-empty">
              You haven't stored anything yet. Store a document and the room you own shows up here.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Rooms your wallet owns. Pick one to list its documents.</p>
              <div className="flex flex-wrap gap-2" data-testid="my-rooms">
                {a.myRooms.map((r) => (
                  <button
                    key={r.roomId}
                    onClick={() => { a.setBrowseRoom(r.roomId); a.refreshDocs(r.roomId); }}
                    data-testid="my-room"
                    aria-pressed={a.browseRoom === r.roomId}
                    className={cn(
                      "rounded-xl border px-3.5 py-2 text-left text-[13px] transition-colors hover:border-brand/30 hover:bg-accent/40",
                      a.browseRoom === r.roomId && "border-brand/40 bg-accent/40",
                    )}
                  >
                    <div className="font-medium">{r.label || short(r.roomId, 8)}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.docCount} document{r.docCount === 1 ? "" : "s"} · {short(r.roomId, 6)}
                    </div>
                  </button>
                ))}
              </div>
              {a.browseRoom &&
                (a.docs.length ? (
                  <div className="mt-2 overflow-x-auto rounded-lg border">
                    <table className="w-full text-left text-[13px]" data-testid="dataroom-docs">
                      <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">#</th>
                          <th className="px-3 py-2 font-medium">doc</th>
                          <th className="px-3 py-2 font-medium">file fingerprint</th>
                          <th className="px-3 py-2 font-medium">sealed to</th>
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
                            <td className="px-3 py-2">{d.ledger}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No documents in this room yet.</p>
                ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
