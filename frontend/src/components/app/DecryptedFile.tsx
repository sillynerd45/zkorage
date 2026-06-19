import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

// Renders a decrypted document by type: text in a <pre>, an image inline, a PDF in an <object>, anything
// else as a download. The bytes are already in the browser (the recipient opened them client-side), so the
// preview and the download both come from an in-memory object URL that is revoked on unmount. The on-chain
// record carries no MIME type, so we sniff it from the leading magic bytes (and fall back to text/binary).
type Sniff = { mime: string; ext: string; kind: "image" | "pdf" | "text" | "binary" };

function sniff(b: Uint8Array, utf8: string | null): Sniff {
  const at = (i: number, v: number) => b[i] === v;
  if (b.length >= 4 && at(0, 0x25) && at(1, 0x50) && at(2, 0x44) && at(3, 0x46))
    return { mime: "application/pdf", ext: "pdf", kind: "pdf" }; // %PDF
  if (b.length >= 8 && at(0, 0x89) && at(1, 0x50) && at(2, 0x4e) && at(3, 0x47))
    return { mime: "image/png", ext: "png", kind: "image" };
  if (b.length >= 3 && at(0, 0xff) && at(1, 0xd8) && at(2, 0xff))
    return { mime: "image/jpeg", ext: "jpg", kind: "image" };
  if (b.length >= 6 && at(0, 0x47) && at(1, 0x49) && at(2, 0x46) && at(3, 0x38))
    return { mime: "image/gif", ext: "gif", kind: "image" }; // GIF8
  if (b.length >= 12 && at(0, 0x52) && at(1, 0x49) && at(2, 0x46) && at(3, 0x46) && at(8, 0x57) && at(9, 0x45) && at(10, 0x42) && at(11, 0x50))
    return { mime: "image/webp", ext: "webp", kind: "image" }; // RIFF....WEBP
  if (utf8 !== null) return { mime: "text/plain", ext: "txt", kind: "text" };
  return { mime: "application/octet-stream", ext: "bin", kind: "binary" };
}

export function DecryptedFile({
  plaintext,
  plaintextUtf8,
  filenameBase = "document",
}: {
  plaintext: Uint8Array | null;
  plaintextUtf8: string | null;
  filenameBase?: string;
}) {
  const meta = useMemo(() => (plaintext ? sniff(plaintext, plaintextUtf8) : null), [plaintext, plaintextUtf8]);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!plaintext || !meta) {
      setUrl(null);
      return;
    }
    // Copy into a fresh ArrayBuffer-backed view so the Blob part is a concrete BlobPart (TS 5.7's Uint8Array
    // generic otherwise widens to ArrayBufferLike, which includes SharedArrayBuffer and is not a BlobPart).
    const u = URL.createObjectURL(new Blob([new Uint8Array(plaintext)], { type: meta.mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [plaintext, meta]);

  if (!plaintext || !meta) return null;
  const filename = `${filenameBase}.${meta.ext}`;
  const sizeKb = (plaintext.length / 1024).toFixed(1);

  const onDownload = () => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div data-testid="decrypted-file" data-kind={meta.kind} className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Decrypted document · {meta.mime} · {sizeKb} KB
        </span>
        <Button variant="outline" size="sm" onClick={onDownload} data-testid="download-decrypted">
          Download
        </Button>
      </div>
      {meta.kind === "text" ? (
        <pre
          data-testid="decrypted-text"
          className="overflow-x-auto whitespace-pre-wrap rounded-lg border bg-muted/40 px-3.5 py-3 font-mono text-xs"
        >
          {plaintextUtf8}
        </pre>
      ) : meta.kind === "image" && url ? (
        <img
          data-testid="decrypted-image"
          src={url}
          alt="decrypted document"
          className="max-h-[28rem] rounded-lg border bg-muted/20"
        />
      ) : meta.kind === "pdf" && url ? (
        <object data-testid="decrypted-pdf" data={url} type="application/pdf" className="h-[32rem] w-full rounded-lg border">
          <p className="p-3 text-sm text-muted-foreground">
            Your browser can't preview this PDF inline. Use Download to open it.
          </p>
        </object>
      ) : (
        <p data-testid="decrypted-binary" className="rounded-lg border bg-muted/40 px-3.5 py-3 text-sm text-muted-foreground">
          Binary file, {plaintext.length} bytes. Use Download to save it.
        </p>
      )}
    </div>
  );
}
