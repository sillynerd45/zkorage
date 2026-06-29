import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";
import { Disclosure } from "@/components/Disclosure";
import { NodeLegend } from "./kit";

// A flowchart figure for the docs. The whole plate is a button that opens a larger, described copy in a
// dialog (click-to-zoom). The inline copy is decorative; the figcaption plus an sr-only ordered list are
// the text equivalent for screen readers. Reuses the ConfirmModal portal + focus-trap pattern.

export type DiagramRender = (opts: { decorative: boolean; idPrefix: string }) => ReactNode;

export function DiagramFigure({
  title,
  caption,
  steps,
  render,
  legend,
}: {
  title: string;
  caption: string;
  steps: string[];
  render: DiagramRender;
  // Defaults to the two-state node legend; the sequence diagram passes a richer legend (return + sign cues).
  legend?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const baseId = useId();
  return (
    <figure className="my-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Enlarge diagram: ${title}`}
        data-testid="diagram-trigger"
        className="group relative block w-full rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-brand/40 sm:p-6"
      >
        {render({ decorative: true, idPrefix: `${baseId}-inline` })}
        <span className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1 rounded-md border bg-card/80 px-2 py-1 text-[11px] text-muted-foreground opacity-70 backdrop-blur transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 sm:opacity-50">
          <Maximize2 className="size-3" aria-hidden="true" /> Zoom
        </span>
      </button>

      <figcaption className="mt-2 max-w-[68ch] text-[13px] leading-relaxed text-muted-foreground">
        {caption}
      </figcaption>
      {legend ?? <NodeLegend />}

      <ol className="sr-only">
        {steps.map((s, i) => (
          <li key={i}>{`Step ${i + 1}: ${s}`}</li>
        ))}
      </ol>

      <Lightbox open={open} title={title} caption={caption} onClose={close} legend={legend}>
        {render({ decorative: false, idPrefix: `${baseId}-zoom` })}
      </Lightbox>
    </figure>
  );
}

// The zoom dialog. Same portal/backdrop/Escape/focus-trap as ConfirmModal, wider, no footer, focus on Close.
// Exported so the raster ArchitectureFlow can reuse the same accessible zoom.
export function Lightbox({
  open,
  title,
  caption,
  onClose,
  children,
  legend,
}: {
  open: boolean;
  title: string;
  caption?: string;
  onClose: () => void;
  children: ReactNode;
  legend?: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const f = modalRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!f || f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm sm:p-6"
      onClick={onClose}
      data-testid="diagram-backdrop"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        data-testid="diagram-dialog"
        className="w-full max-w-[min(94vw,1120px)] animate-fade-in rounded-xl border bg-card p-4 text-card-foreground shadow-xl sm:p-6"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close diagram"
            data-testid="diagram-close"
            className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {/* Cap + scroll on the SAME element: a tall sequence SVG scrolls within the dialog instead of
            painting over the caption (a no-op for the short flows, which never exceed 78vh). */}
        <div className="mx-auto w-full overflow-auto" style={{ maxHeight: "78vh" }}>
          {children}
        </div>
        {caption && <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{caption}</p>}
        {legend ?? <NodeLegend />}
      </div>
    </div>,
    document.body,
  );
}

// "Under the hood": the layered-depth expander. Plain story stays above; the proof names and on-chain
// checks live in here so a curious reader can open them without cluttering the main read. A left brand rule
// marks the revealed block as the deeper, secondary layer. Reuses the existing Disclosure.
export function UnderTheHood({
  label = "Under the hood",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <Disclosure summary={<></>} detailsLabel={label} toggleTestId="under-the-hood">
      <div className="border-l-2 border-brand/30 pl-3.5 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </Disclosure>
  );
}
