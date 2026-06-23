import { Fragment, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  FolderLock,
  Star,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CommitteeInfoResp } from "@/lib/api";

// Data-Room UI kit. These molecules drive the Data Room pages, plus TaskCard + GroupLabel are reused by the
// Bonded Proofs Overview (both are route-agnostic launchers). The rest of the app (Home + the five proof
// pages + the shared blocks.tsx) keeps its exact look. Nothing here restyles a shared component; it adds new
// pieces: the header with the committee pill, the task cards with their hover interaction, category chips,
// group labels, step strips, callouts, and a copy button. If a third surface needs TaskCard/GroupLabel,
// promote them to a shared components/app kit instead of widening this one.
//
// The card hover (lift + deeper shadow + border + icon-tile inversion + corner arrow) all rides on the
// parent `group`, and uses only Tailwind utilities + the existing tokens, so it works in light and dark and
// is disabled automatically under prefers-reduced-motion (the global rule in index.css zeroes transitions).

export type DRCategory = "Documents" | "Access" | "Share" | "Authenticity";

// Category → token color. Documents = blue/info, Access = green/success, Share = amber/warning,
// Authenticity = neutral/gray. The chip encodes the group so the grid needs no section headers.
const CHIP_TONE: Record<DRCategory, string> = {
  Documents: "bg-brand/10 text-brand",
  Access: "bg-success/10 text-success",
  Share: "bg-warning/10 text-warning",
  Authenticity: "bg-muted text-muted-foreground",
};

export function CategoryChip({ category }: { category: DRCategory }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        CHIP_TONE[category],
      )}
    >
      {category}
    </span>
  );
}

// Small sentence-case section label: ~11px, muted, light letter-spacing. Not ALL CAPS (the new convention).
// The lightweight eyebrow/caption for grids and lists (Overview "All tasks" / "Learn more", Browse room line).
export function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-[11px] font-medium tracking-[0.02em] text-muted-foreground", className)}>
      {children}
    </p>
  );
}

// In-card form-section header: a real <h3> that out-ranks the [13px] field labels (semibold, foreground),
// with an optional trailing hairline rule as the section separator. Used inside the Store/Open cards only.
// Pass withRule to draw the divider (the rule is decorative, aria-hidden). Sections sit a generous margin
// apart so the separator reads as a real break.
export function SectionLabel({
  children,
  withRule = false,
  className,
}: {
  children: ReactNode;
  withRule?: boolean;
  className?: string;
}) {
  return (
    <h3 className={cn("flex items-center gap-3 text-xs font-semibold tracking-tight text-foreground", className)}>
      {children}
      {withRule && <span className="h-px flex-1 bg-border" aria-hidden="true" />}
    </h3>
  );
}

// A compact copy-to-clipboard icon button sized to sit beside an input. No dependency.
export function CopyIconButton({ value, label = "value" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied to clipboard" : `Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked (insecure context / permissions): no-op */
        }
      }}
      className="grid size-10 shrink-0 place-items-center rounded-md border border-input text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
    </button>
  );
}

// A horizontal "what happens" strip: icon + label, chevron separators, in one subtle filled row.
export function StepStrip({ steps }: { steps: { icon: LucideIcon; label: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 rounded-xl border bg-muted/40 px-3 py-2.5 text-[13px]">
      {steps.map((s, i) => (
        <Fragment key={s.label}>
          {i > 0 && (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          )}
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <s.icon className="size-4 shrink-0 text-brand" aria-hidden="true" />
            {s.label}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

// A plain-language safety/info note: subtle background, thin border, leading icon, no marketing.
export function Callout({
  icon: Icon,
  children,
  testId,
}: {
  icon: LucideIcon;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-start gap-2.5 rounded-xl border border-border/70 bg-muted/40 px-3.5 py-3 text-[13px] leading-relaxed text-muted-foreground"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

// The Overview task card. One component for the grid cards and the hero (the hero shares the look with
// larger padding, a chip, and a right-arrow that slides instead of a corner arrow). Used by the Data Room
// Overview and the Bonded Proofs Overview. A featured card shows a "Start here" chip by default; pass `tag`
// to label it differently (the Bonded Overview has two co-equal featured proofs, so both carry "ZK proof"
// instead of a single "Start here"). `tag` only renders on a featured card; on a plain card it is a no-op.
export function TaskCard({
  to,
  icon: Icon,
  title,
  blurb,
  category,
  featured = false,
  tag,
  star = false,
  testid,
}: {
  to: string;
  icon: LucideIcon;
  title: string;
  blurb: string;
  category?: DRCategory;
  featured?: boolean;
  tag?: string;
  star?: boolean;
  testid?: string;
}) {
  return (
    <Link to={to} data-testid={testid} className="group block focus-visible:outline-none">
      <div
        className={cn(
          "relative flex h-full items-start gap-3.5 overflow-hidden rounded-xl border bg-card",
          "shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[transform,box-shadow,border-color] [transition-duration:180ms] ease-out",
          "hover:-translate-y-[3px] hover:border-foreground/20 hover:shadow-[0_12px_28px_rgba(0,0,0,0.12)]",
          "dark:hover:shadow-[0_12px_28px_rgba(0,0,0,0.45)]",
          "group-focus-visible:ring-2 group-focus-visible:ring-ring",
          featured ? "p-5 sm:p-6" : "p-4",
        )}
      >
        <span
          className={cn(
            "grid shrink-0 place-items-center rounded-xl bg-brand/10 text-brand transition-colors [transition-duration:180ms]",
            "group-hover:bg-foreground group-hover:text-background",
            featured ? "size-11" : "size-10",
          )}
        >
          <Icon className="size-5" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <h3 className={cn("font-semibold tracking-tight", featured && "text-lg")}>{title}</h3>
              {star && (
                <Star className="size-4 shrink-0 fill-warning text-warning" aria-hidden="true" />
              )}
              {featured && (
                <span className="ml-1 inline-flex shrink-0 items-center rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                  {tag ?? "Start here"}
                </span>
              )}
            </div>
            {category && !featured && <CategoryChip category={category} />}
          </div>
          <p className="mt-1 pr-5 text-sm leading-relaxed text-muted-foreground">{blurb}</p>
        </div>

        {featured ? (
          <ArrowRight
            className="size-5 shrink-0 self-center text-muted-foreground transition-transform [transition-duration:180ms] group-hover:translate-x-1 group-hover:text-brand"
            aria-hidden="true"
          />
        ) : (
          <ArrowUpRight
            className="absolute bottom-3 right-3 size-4 text-muted-foreground opacity-0 transition-all [transition-duration:180ms] group-hover:translate-x-[2px] group-hover:-translate-y-[2px] group-hover:opacity-100"
            aria-hidden="true"
          />
        )}
      </div>
    </Link>
  );
}

// The live key-release readiness pill: any `threshold` of `n` keepers can release a document's key. Shown
// in the Data Room header so a visitor sees the "Open a shared document" path is up before they try it.
export function CommitteePill({ c }: { c: CommitteeInfoResp }) {
  const allUp = c.online >= c.n;
  const someUp = c.online > 0;
  const dot = allUp ? "bg-emerald-500" : someUp ? "bg-amber-500" : "bg-muted-foreground/40";
  return (
    <div
      data-testid="overview-committee"
      data-online={c.online}
      title={`any ${c.threshold} of ${c.n} keepers release a document's key; ${c.online} reachable now`}
      className="flex shrink-0 items-center gap-2 self-start rounded-full border bg-card px-3 py-1.5 text-xs"
    >
      <span className={cn("size-2 rounded-full", dot)} aria-hidden="true" />
      <span className="text-muted-foreground">
        Key committee: <b className="text-foreground">{c.online} of {c.n}</b> keepers online
      </span>
    </div>
  );
}

// Data-Room-scoped page header: the folder/lock tile, the "Data Room" title, one quiet line, and the
// committee pill pinned top-right. A route-local header (not the shared PageHeader) because the pill needs
// to sit in the top-right of the header, which the shared component does not do.
export function DataRoomHeader({ aside }: { aside?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
          <FolderLock className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Data Room</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
            Keep sensitive files private. Decide who can open them.
          </p>
        </div>
      </div>
      {aside}
    </header>
  );
}
