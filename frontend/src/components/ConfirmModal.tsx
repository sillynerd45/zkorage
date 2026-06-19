import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

// Confirmation gate for actions that are hard to take back (UX research: honest trust / irreversibility).
// `tone` selects the standing warning line so every irreversible/outward action reads the same way.
export type ConfirmTone = "cost" | "outward" | "irreversible";

const TONE_NOTE: Record<ConfirmTone, string> = {
  cost: "This runs the self-hosted prover (a few minutes) and then writes on-chain — it can't be undone once it starts.",
  outward: "This writes to a public ledger — anyone will be able to see the record, and it can't be unpublished.",
  irreversible: "This can't be undone.",
};

export function ConfirmModal({
  open,
  title,
  children,
  tone = "irreversible",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  tone?: ConfirmTone;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
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
  }, [open, onCancel]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-5 backdrop-blur-sm"
      onClick={onCancel}
      data-testid="confirm-backdrop"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        data-testid="confirm-modal"
        className="w-full max-w-[460px] animate-fade-in rounded-xl border bg-card p-6 text-card-foreground shadow-xl"
      >
        <h2 id={titleId} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {children && <div className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{children}</div>}
        <p role="note" className="mt-3 text-xs leading-relaxed text-warning">
          <span aria-hidden="true">⚠ </span>
          {TONE_NOTE[tone]}
        </p>
        <div className="mt-5 flex justify-end gap-2.5">
          <Button variant="outline" size="sm" onClick={onCancel} data-testid="confirm-cancel">
            {cancelLabel}
          </Button>
          <Button ref={confirmRef} size="sm" onClick={onConfirm} data-testid="confirm-go">
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
