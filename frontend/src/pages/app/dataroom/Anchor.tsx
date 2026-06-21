import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  Download,
  FileText,
  Fingerprint,
  KeyRound,
  Lock,
  LockKeyholeOpen,
  Search,
  ShieldCheck,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useAnchor } from "@/lib/hooks/useAnchor";
import { short, explorer } from "@/lib/format";
import { humanError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Disclosure, Hex } from "@/components/Disclosure";
import { ProofStatusBadge, ProveWait } from "@/components/StatusBadge";
import { ConfirmModal } from "@/components/ConfirmModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";
import { DecryptedFile } from "@/components/app/DecryptedFile";
import { Callout, CopyIconButton, GroupLabel, SectionLabel, StepStrip } from "@/components/app/dataroom/kit";

// The Documents page is a small submenu (Store / Open / Browse) instead of one long scroll. The Overview's
// deep links (#store / #open / #browse) select the matching sub-tab, so the entry points still work. One
// sub-tab shows at a time. The tab/submenu styling is unchanged in this pass; only the body of each sub-tab
// was reworked (calmer copy, step strips, grouped fields, callouts, a drop zone, and a document list).
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
  const [dragOver, setDragOver] = useState(false);
  const [docQuery, setDocQuery] = useState("");
  // Keep the sub-tab in sync with the URL hash so a deep link from the Overview lands on the right one.
  useEffect(() => {
    setTab(tabFromHash(hash));
  }, [hash]);

  // Browse → Open hand-off: prefill the room/doc and switch to the Open sub-tab, where the reader supplies
  // the private key. Browse is the owner view and does not know the recipient's key, so it cannot decrypt
  // inline; this keeps every crypto step exactly where it is today.
  const openFromBrowse = (docId: string) => {
    a.setOpenRoom(a.browseRoom);
    a.setOpenDoc(docId);
    setTab("open");
  };

  const q = docQuery.trim().toLowerCase();
  const shownDocs = q ? a.docs.filter((d) => d.doc_id.toLowerCase().includes(q)) : a.docs;

  return (
    <div className="space-y-5">
      {/* The section tabs (Overview / Documents / …) live in the layout directly above this. The Documents
          sub-tabs sit right under them, with one calm line below (the submenu pill is w-fit so it hugs its
          three items). */}
      <div className="space-y-2">
        <div
          className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-2xl border bg-card p-1.5"
          role="tablist"
          aria-label="Documents"
        >
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
        <p className="text-sm text-muted-foreground">Store, open, or browse this room's files.</p>
      </div>

      {/* ── STORE: upload / encrypt / anchor ── */}
      {tab === "store" && (
        <>
          <Card id="store" className="rounded-2xl p-6">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold tracking-tight">Store a document</h2>
              <ProofStatusBadge state={a.state} />
            </div>
            {/* Access mode: SHARED = anonymous policy-gated committee doc (browser dealer); DIRECT = a seal to
                one named recipient (not anonymous). The two have different trust stories, so they sit side by
                side and the copy below is honest about each. */}
            <div
              role="radiogroup"
              aria-label="Who can open it"
              className="mt-1 flex w-fit max-w-full gap-1 rounded-2xl border bg-card p-1.5"
            >
              {([
                ["shared", "Shared (anonymous)"],
                ["direct", "Direct (1:1)"],
              ] as const).map(([m, label]) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={a.accessMode === m}
                  onClick={() => a.setAccessMode(m)}
                  data-testid={`access-mode-${m}`}
                  className={cn(
                    "rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors",
                    a.accessMode === m
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {a.accessMode === "shared" ? (
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                The file is encrypted in your browser and its key is split across the{" "}
                <b className="text-foreground">keepers</b>. Anyone who proves they are a{" "}
                <b className="text-foreground">member of this room</b> can open it, without revealing which
                member. The file and its key never reach our server. A copy of the key is sealed to your wallet
                so you can reopen it on any device.
              </p>
            ) : (
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                The file is sealed to <b className="text-foreground">one recipient's key</b>. This is a direct
                share, <b className="text-foreground">not anonymous</b>. Encryption happens on the server you
                run, which briefly holds the key. Use this only when you are sending a file to one named person.
              </p>
            )}

            <div className="mt-4">
              <StepStrip
                steps={
                  a.accessMode === "shared"
                    ? [
                        { icon: Lock, label: "Encrypt in your browser" },
                        { icon: Users, label: "Split key to keepers" },
                        { icon: Fingerprint, label: "Anchor fingerprint" },
                      ]
                    : [
                        { icon: Lock, label: "Encrypt on your server" },
                        { icon: KeyRound, label: "Seal to recipient" },
                        { icon: Fingerprint, label: "Anchor fingerprint" },
                      ]
                }
              />
            </div>

            {/* What you're storing: the room, then ONE of a file or pasted text (a segmented switcher picks
                the mode, so only the active input shows instead of both at once). */}
            <div className="mt-7 space-y-3">
              <SectionLabel withRule>What you're storing</SectionLabel>
              <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
                Room
                <div className="flex gap-2">
                  <Input
                    className="font-mono text-xs"
                    value={a.roomLabel}
                    onChange={(e) => a.setRoomLabel(e.target.value)}
                    placeholder="Name a room, for example acme-board-docs"
                    aria-label="room"
                    data-testid="room-label"
                  />
                  <CopyIconButton value={a.roomLabel} label="room" />
                </div>
              </label>

              {/* Room picker: the connected wallet's existing rooms (read on-chain), shown only when there is
                  at least one. Pick one to file this document into a room you already own, or type a new name
                  above to create one. Selecting sets the field to the room's label (or its id if unlabelled). */}
              {a.myRooms.length > 0 && (
                <div className="space-y-1.5" data-testid="store-room-picker">
                  <p className="text-[13px] text-muted-foreground">Or pick a room you own</p>
                  <div className="flex flex-wrap gap-2">
                    {a.myRooms.map((r) => {
                      const pick = r.label || r.roomId;
                      const active = a.roomLabel === pick;
                      return (
                        <button
                          key={r.roomId}
                          type="button"
                          onClick={() => a.setRoomLabel(pick)}
                          data-testid="store-room-pick"
                          aria-pressed={active}
                          className={cn(
                            "rounded-xl border px-3 py-1.5 text-left text-xs transition-colors hover:border-brand/30 hover:bg-accent/40",
                            active && "border-brand/40 bg-accent/40",
                          )}
                        >
                          <span className="font-medium">{r.label || short(r.roomId, 8)}</span>
                          <span className="ml-2 text-muted-foreground">
                            {r.docCount} doc{r.docCount === 1 ? "" : "s"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Input-mode switcher (segmented, matching the section tabs). A radiogroup, not a tablist:
                  it picks which form field is shown, it does not navigate. Switching preserves both inputs. */}
              <div
                role="radiogroup"
                aria-label="Input method"
                className="flex w-fit max-w-full gap-1 rounded-2xl border bg-card p-1.5"
              >
                {([
                  ["file", "File"],
                  ["text", "Text"],
                ] as const).map(([m, label]) => (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={a.storeMode === m}
                    onClick={() => a.setStoreMode(m)}
                    data-testid={`store-mode-${m}`}
                    className={cn(
                      "rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors",
                      a.storeMode === m
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {a.storeMode === "file" ? (
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) a.pickFile(f);
                  }}
                  className={cn(
                    "rounded-xl border border-dashed px-4 py-6 text-center transition-colors",
                    dragOver ? "border-brand bg-brand/5" : "border-input bg-muted/30",
                  )}
                >
                  <Upload className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-2 text-sm font-medium">Drag a file here, or browse</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    PDF, image, any file up to 8 MB.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                    <input
                      type="file"
                      onChange={(e) => a.pickFile(e.target.files?.[0] ?? null)}
                      aria-label="document file"
                      data-testid="doc-file"
                      className="block max-w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-accent"
                    />
                  </div>
                  {a.file && (
                    <span
                      data-testid="doc-file-chip"
                      className="mt-3 inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs"
                    >
                      <span className="max-w-[16rem] truncate font-medium" title={a.file.name}>
                        {a.file.name}
                      </span>
                      <span className="text-muted-foreground">{(a.file.size / 1024).toFixed(1)} KB</span>
                      <button
                        type="button"
                        onClick={a.clearFile}
                        aria-label="remove file"
                        data-testid="doc-file-clear"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    </span>
                  )}
                  {a.fileErr && (
                    <p className="mt-2 text-xs text-destructive" data-testid="doc-file-error">
                      {a.fileErr}
                    </p>
                  )}
                </div>
              ) : (
                <textarea
                  className="min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  value={a.content}
                  onChange={(e) => a.setContent(e.target.value)}
                  aria-label="document content"
                  data-testid="doc-content"
                  placeholder="Paste the document text…"
                />
              )}
            </div>

            {/* Who can open it: SHARED = anyone who proves room membership (no key field); DIRECT = one named
                recipient's x25519 public key. */}
            <div className="mt-7 space-y-3">
              <SectionLabel withRule>Who can open it</SectionLabel>
              {a.accessMode === "shared" ? (
                <p className="text-[13px] leading-relaxed text-muted-foreground" data-testid="shared-access-note">
                  Anyone who proves they are a <b className="text-foreground">member of this room</b> can open
                  it, anonymously. Approve members in the <b className="text-foreground">Membership</b> tab. A
                  copy of the key is sealed to your wallet, so you can always reopen it.
                </p>
              ) : (
                <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
                  Recipient's public key (hex)
                  <Input
                    className="font-mono text-xs"
                    value={a.recipientPub}
                    onChange={(e) => a.setRecipientPub(e.target.value)}
                    aria-label="recipient pub"
                    data-testid="recipient-input"
                  />
                </label>
              )}
            </div>

            <div className="mt-4">
              {a.accessMode === "shared" ? (
                <Callout icon={ShieldCheck}>
                  The file is encrypted and its key split in this browser. Only ciphertext and sealed shares
                  leave it; the server never sees the key or the contents.
                </Callout>
              ) : (
                <Callout icon={ShieldCheck}>
                  A direct share is not anonymous: it is sealed to one recipient, and the server you run holds
                  the key while it encrypts. Only a fingerprint goes on-chain.
                </Callout>
              )}
            </div>

            {/* DR1 engine rows (the sealing program + demo recipient key) apply only to the direct seal;
                demoted behind a "Verify details" expander. */}
            {a.accessMode === "direct" && (
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
            )}

            <div className="mt-4">
              <Button onClick={() => a.setConfirmAnchor(true)} disabled={a.busy} data-testid="upload">
                <Lock aria-hidden="true" />
                {a.busy ? "Working…" : a.accessMode === "shared" ? "Store shared document" : "Store direct share"}
              </Button>
            </div>

            <ConfirmModal
              open={a.confirmAnchor}
              title={a.accessMode === "shared" ? "Encrypt, split & post this document?" : "Encrypt, seal & post this document?"}
              tone="cost"
              confirmLabel="Yes, post it"
              onCancel={() => a.setConfirmAnchor(false)}
              onConfirm={() => {
                a.setConfirmAnchor(false);
                if (a.accessMode === "shared") a.onStoreShared();
                else a.onUpload();
              }}
            >
              {a.accessMode === "shared" ? (
                <p>
                  The file is encrypted and its key split across the keepers in this browser. Only ciphertext
                  and sealed shares are sent; the server never sees the key or the contents. Your wallet then
                  signs the on-chain record. Only a tamper-evident fingerprint is posted.
                </p>
              ) : (
                <p>
                  The document is encrypted and the key sealed to the recipient on the server you run (which
                  briefly holds the key). Only an encrypted file and a tamper-evident fingerprint are posted.
                  The contents are never posted. This share is not anonymous.
                </p>
              )}
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
                  <Verdict ok>
                    {a.sharedResult
                      ? "Stored as a shared document. Anyone who proves they're a member of this room can open it, anonymously."
                      : "Document posted to the public record (encrypted and sealed to the recipient)"}
                  </Verdict>
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
                    {a.sharedResult && (
                      <>
                        <DataRow k="room" testId="shared-result-room">{short(a.sharedResult.roomId, 8)}</DataRow>
                        <DataRow k="document" testId="shared-result-doc">{short(a.sharedResult.docId, 8)}</DataRow>
                        <DataRow k="how to open" mono={false}>
                          a member opens it from <b className="text-foreground">Open a shared document</b>
                        </DataRow>
                      </>
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
          <h2 className="text-base font-semibold tracking-tight">Open a document</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            The recipient opens it with their private key. It's fetched, fingerprint-checked, and decrypted
            entirely in your browser.
          </p>

          <div className="mt-4">
            <StepStrip
              steps={[
                { icon: Download, label: "Fetch encrypted file" },
                { icon: Fingerprint, label: "Re-check fingerprint" },
                { icon: LockKeyholeOpen, label: "Decrypt in your browser" },
              ]}
            />
          </div>

          <div className="mt-7 space-y-3">
            <SectionLabel withRule>What you're opening</SectionLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
                Room
                <div className="flex gap-2">
                  <Input
                    className="font-mono text-xs"
                    value={a.openRoom}
                    onChange={(e) => a.setOpenRoom(e.target.value)}
                    aria-label="open room"
                    data-testid="open-room"
                  />
                  <CopyIconButton value={a.openRoom} label="room" />
                </div>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
                Document
                <div className="flex gap-2">
                  <Input
                    className="font-mono text-xs"
                    value={a.openDoc}
                    onChange={(e) => a.setOpenDoc(e.target.value)}
                    aria-label="open doc"
                    data-testid="open-doc"
                  />
                  <CopyIconButton value={a.openDoc} label="document" />
                </div>
              </label>
            </div>
          </div>

          <div className="mt-7 space-y-3">
            <SectionLabel withRule>Your key</SectionLabel>
            <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
              Recipient's private key (hex)
              <Input
                className="border-brand/40 font-mono text-xs"
                value={a.openSecret}
                onChange={(e) => a.setOpenSecret(e.target.value)}
                aria-label="recipient secret"
                data-testid="open-secret"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Prefilled with the demo key. Paste your own to open as yourself.
            </p>
          </div>

          <div className="mt-4">
            <Button onClick={a.onOpen} disabled={a.openBusy} data-testid="open-btn">
              <LockKeyholeOpen aria-hidden="true" />
              {a.openBusy ? "Opening…" : "Open document"}
            </Button>
          </div>

          <div className="mt-4">
            <Callout icon={KeyRound} testId="open-secret-note">
              Your private key stays in this browser. We never see it, and we can't recover it for you.
            </Callout>
          </div>

          {a.sealedToYou && (
            <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              Your public key:{" "}
              <code className="font-mono text-foreground">{short(a.sealedToYou, 8)}</code>
              <CopyIconButton value={a.sealedToYou} label="public key" />
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
          <div className="mb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold tracking-tight">Browse documents</h2>
              {a.connected && (
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    value={docQuery}
                    onChange={(e) => setDocQuery(e.target.value)}
                    placeholder="Search by doc id…"
                    aria-label="search documents"
                    data-testid="doc-search"
                    className="h-9 w-56 max-w-full pl-8 text-xs"
                  />
                </div>
              )}
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Rooms you own and documents you've stored. Contents stay encrypted.
            </p>
          </div>

          {!a.connected ? (
            <p className="text-sm leading-relaxed text-muted-foreground" data-testid="browse-connect-prompt">
              Connect your wallet to see the rooms you own and the documents you stored. This only reads the
              on-chain owner of each room. Your address is a public key, not your name.
            </p>
          ) : a.roomsLoading ? (
            <p className="text-sm text-muted-foreground">Reading the public record…</p>
          ) : a.myRooms.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted-foreground" data-testid="browse-empty">
              You haven't stored anything yet. Store a document and the room you own shows up here.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2" data-testid="my-rooms">
                {a.myRooms.map((r) => (
                  <button
                    key={r.roomId}
                    onClick={() => {
                      a.setBrowseRoom(r.roomId);
                      a.refreshDocs(r.roomId);
                      setDocQuery("");
                    }}
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

              {a.browseRoom && (
                <div className="space-y-2">
                  <GroupLabel>
                    Room {short(a.browseRoom, 8)} · {a.docs.length} document{a.docs.length === 1 ? "" : "s"}
                  </GroupLabel>
                  {a.docs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No documents in this room yet.</p>
                  ) : shownDocs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No documents match your search.</p>
                  ) : (
                    <div className="divide-y divide-border/70 rounded-xl border" data-testid="dataroom-docs">
                      {shownDocs.map((d) => (
                        <div
                          key={d.index}
                          role="button"
                          tabIndex={0}
                          onClick={() => openFromBrowse(d.doc_id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openFromBrowse(d.doc_id);
                            }
                          }}
                          data-testid="doc-row"
                          className="group/row flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
                        >
                          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
                            <FileText className="size-4" aria-hidden="true" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-[13px]" title={d.doc_id}>
                              {short(d.doc_id, 10)}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              Recorded at ledger {d.ledger} · sealed to x25519 {short(d.recipient_pub, 6)}
                            </div>
                          </div>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                            <Lock className="size-3" aria-hidden="true" /> Encrypted
                          </span>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-input px-2.5 py-1 text-xs font-medium text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100">
                            <LockKeyholeOpen className="size-3.5" aria-hidden="true" /> Open
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
