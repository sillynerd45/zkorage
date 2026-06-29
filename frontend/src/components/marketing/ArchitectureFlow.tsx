import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { Lightbox } from "@/pages/marketing/docs/diagrams/DiagramFigure";

// The "How zkorage works" architecture diagram (a generated raster). Light + dark versions swap with the
// theme. The whole plate is a button that opens a larger, zoomable copy (the diagram is detailed, so it is
// small on phones). The inline images are decorative; an sr-only paragraph carries the flow for screen
// readers, and the enlarged copy keeps the same description as its alt text.

const ALT =
  "How zkorage works. Your browser encrypts the file with AES-256-GCM and splits its key two-of-three locally. " +
  "The backend stores the encrypted file in Cloudflare R2 and hands three sealed key shares to a two-of-three " +
  "keeper committee. Your browser anchors a tamper-evident record on Soroban, with no key and no contents " +
  "on-chain. A self-hosted RISC Zero prover builds a zero-knowledge proof that you qualify; Soroban verifies " +
  "the Groth16 proof on-chain and records a grant without learning who you are; then two of three keepers " +
  "release sealed key shares so your browser rebuilds the key and decrypts the file.";

const LIGHT = "/diagrams/zkorage-architecture-light.png";
const DARK = "/diagrams/zkorage-architecture-dark.png";

export function ArchitectureFlow({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <figure className={className}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Enlarge diagram: How zkorage works"
        data-testid="architecture-trigger"
        className="group relative block w-full overflow-hidden rounded-xl border transition-colors hover:border-brand/40"
      >
        <img src={LIGHT} alt="" aria-hidden="true" loading="lazy" decoding="async" className="block w-full dark:hidden" />
        <img src={DARK} alt="" aria-hidden="true" loading="lazy" decoding="async" className="hidden w-full dark:block" />
        <span className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1 rounded-md border bg-card/80 px-2 py-1 text-[11px] text-muted-foreground opacity-70 backdrop-blur transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 sm:opacity-50">
          <Maximize2 className="size-3" aria-hidden="true" /> Zoom
        </span>
      </button>
      <p className="sr-only">{ALT}</p>

      <Lightbox open={open} title="How zkorage works" onClose={() => setOpen(false)} legend={<></>}>
        <img src={LIGHT} alt={ALT} className="block h-auto w-full min-w-[760px] dark:hidden" />
        <img src={DARK} alt={ALT} className="hidden h-auto w-full min-w-[760px] dark:block" />
      </Lightbox>
    </figure>
  );
}
