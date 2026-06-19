import { useId, useState, type ReactNode } from "react";

// Progressive disclosure (UX research §12): lead with plain human meaning, then tuck the cryptographic
// artifacts behind ONE expander. Machinery is DEMOTED, never deleted (auditors still get every byte).
export function Disclosure({
  summary,
  children,
  detailsLabel = "Verify details",
  defaultOpen = false,
  toggleTestId,
}: {
  summary: ReactNode;
  children: ReactNode;
  detailsLabel?: string;
  defaultOpen?: boolean;
  toggleTestId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div className="my-2.5" data-open={open}>
      <div className="text-sm leading-relaxed text-foreground">{summary}</div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid={toggleTestId}
        onClick={() => setOpen((o) => !o)}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      >
        <span aria-hidden="true" className="text-[10px] text-brand">{open ? "▾" : "▸"}</span>
        {open ? "Hide details" : detailsLabel}
      </button>
      {open && (
        <div id={panelId} className="mt-2.5 grid gap-2 rounded-lg border bg-muted/40 px-3.5 py-3">
          {children}
        </div>
      )}
    </div>
  );
}

// Copy-to-clipboard affordance with a brief confirmation. No dependency.
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked (insecure context / permissions): no-op */
        }
      }}
      aria-label={copied ? "Copied to clipboard" : `Copy ${label}`}
      className="rounded-md border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

// A raw cryptographic value rendered legibly: tabular monospace, truncated with the FULL value on
// hover/focus (title + aria-label), plus a copy button. Never the primary surface (lives inside <Disclosure>).
export function Hex({ value, label, chars = 6 }: { value: string; label?: string; chars?: number }) {
  const trimmed =
    value && value.length > chars * 2 + 1 ? `${value.slice(0, chars)}…${value.slice(-chars)}` : value;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {label && <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>}
      <code
        className="font-mono text-xs tabular-nums text-muted-foreground"
        title={value}
        aria-label={label ? `${label}: ${value}` : value}
      >
        {trimmed || "-"}
      </code>
      {value && <CopyButton text={value} label={label ?? "value"} />}
    </span>
  );
}
