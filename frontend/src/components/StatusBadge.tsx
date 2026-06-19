import { cn } from "@/lib/utils";

// ProofStatusBadge renders the zkorage claim-state machine. Color-independence (WCAG 1.4.1): terminal
// states get a distinct SHAPE (check/cross) in addition to color, plus the always-present text label.
export type ClaimState =
  | "draft"
  | "attested"
  | "proving"
  | "proved"
  | "verifying"
  | "verified"
  | "failed"
  | "rejected";

type StateMeta = { label: string; cls: string; pulse?: boolean; mark?: "check" | "cross" };

const STATE: Record<ClaimState, StateMeta> = {
  draft: { label: "Draft", cls: "text-muted-foreground border-muted-foreground/40" },
  attested: { label: "Attested", cls: "text-sky-600 border-sky-600/40" },
  proving: { label: "Proving…", cls: "text-warning border-warning/40", pulse: true },
  proved: { label: "Proof ready", cls: "text-brand border-brand/40" },
  verifying: { label: "Checking on-chain…", cls: "text-amber-600 border-amber-600/40", pulse: true },
  verified: { label: "Verified", cls: "text-success border-success/50", mark: "check" },
  failed: { label: "Proving failed", cls: "text-destructive border-destructive/50", mark: "cross" },
  rejected: { label: "Rejected", cls: "text-destructive border-destructive/50", mark: "cross" },
};

function Mark({ kind }: { kind: "check" | "cross" }) {
  return kind === "check" ? (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5">
      <path d="M3 8.5l3.4 3.4L13 4.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// The check/cross mark for big verdict pills. Same crisp SVG, on-palette across OSes. Decorative.
export function VerdictMark({ ok }: { ok: boolean }) {
  return ok ? (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-5">
      <path d="M3 8.5l3.4 3.4L13 4.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-5">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ProofStatusBadge({ state }: { state: ClaimState }) {
  const m = STATE[state];
  return (
    <span
      data-testid="proof-status"
      data-state={state}
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium",
        m.cls,
      )}
    >
      {m.mark ? (
        <Mark kind={m.mark} />
      ) : (
        <span className={cn("size-2 rounded-full bg-current", m.pulse && "animate-pulse-dot")} />
      )}
      {m.label}
    </span>
  );
}

// Humanize the gateway's machine prover label for users.
function proverLabel(by?: string | null): { human: string; slow: boolean } | null {
  if (!by) return null;
  const slow = /cpu|vm|fallback/i.test(by);
  return { human: slow ? "backup prover (CPU)" : "fast prover (GPU)", slow };
}

// The async proof-job wait (UX research §4): honest, indeterminate, and "safe to leave". Never a fake
// progress bar. Renders only while a job is in flight.
export function ProveWait({
  state,
  proveBy,
  privacy,
}: {
  state: ClaimState;
  proveBy?: string | null;
  privacy?: string;
}) {
  if (state !== "proving" && state !== "verifying") return null;
  const p = proverLabel(proveBy);
  const note =
    privacy ?? "Your private inputs stay on the self-hosted prover. Only the public proof goes on-chain.";
  return (
    <p
      className="mt-2 text-xs leading-relaxed text-muted-foreground"
      role="status"
      aria-live="polite"
      data-testid="prove-wait"
    >
      {state === "verifying"
        ? "Checking your proof on the public ledger. Almost done."
        : p?.slow
          ? "Building your proof on the backup prover. This can take a few minutes, which is normal. You can leave this page; we'll keep working."
          : "Building your proof. This usually takes a few seconds. You can leave this page; we'll keep working."}
      {p ? ` · ${p.human}` : ""} {note}
    </p>
  );
}
