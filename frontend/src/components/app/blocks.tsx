import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Star, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { VerdictMark } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";

// Variant B design molecules, dashboard/app feel: rounded-2xl panels, list-style cards, stat tiles.

export function PageHeader({
  title,
  lead,
  icon: Icon,
  actions,
}: {
  title: ReactNode;
  lead?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6">
      <div className="flex items-start gap-3">
        {Icon && (
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
            <Icon className="size-5" />
          </span>
        )}
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
          {lead && <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{lead}</p>}
        </div>
      </div>
      {actions && <div className="mt-5 flex flex-wrap gap-3">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("rounded-2xl p-6", className)}>
      {(title || aside) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </Card>
  );
}

export function DataRow({
  k,
  children,
  mono = true,
  variant,
  testId,
}: {
  k: ReactNode;
  children: ReactNode;
  mono?: boolean;
  variant?: "private";
  testId?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/70 py-2.5 last:border-0">
      <span className="shrink-0 text-[13px] text-muted-foreground">{k}</span>
      <span
        data-testid={testId}
        className={cn(
          "break-all text-right text-[13px]",
          mono && variant !== "private" && "font-mono tabular-nums",
          variant === "private" && "font-sans italic text-brand",
        )}
      >
        {children}
      </span>
    </div>
  );
}

export function Verdict({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-2xl border p-4 text-lg font-semibold",
        ok ? "border-success/40 bg-success/5 text-success" : "border-destructive/40 bg-destructive/5 text-destructive",
      )}
    >
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-full border",
          ok ? "border-success/50 bg-success/10" : "border-destructive/50 bg-destructive/10",
        )}
      >
        <VerdictMark ok={ok} />
      </span>
      <span>{children}</span>
    </div>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-2xl border bg-card p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-2xl font-bold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function NavCard({
  to,
  icon: Icon,
  title,
  blurb,
  proves,
  star,
}: {
  to: string;
  icon: LucideIcon;
  title: string;
  blurb: string;
  proves?: string;
  star?: boolean;
}) {
  // Visual match to the Data Room task cards (components/app/dataroom/kit.tsx): faint shadow at rest; on
  // hover the card lifts, the shadow deepens, the border strengthens, the icon tile inverts, and a corner
  // arrow fades in. The "proves" pill sits in a bottom row to the LEFT of the arrow so the two never collide.
  return (
    <Link to={to} className="group block focus-visible:outline-none">
      <div
        className={cn(
          "relative flex h-full items-start gap-3.5 overflow-hidden rounded-xl border bg-card p-4",
          "shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[transform,box-shadow,border-color] [transition-duration:180ms] ease-out",
          "hover:-translate-y-[3px] hover:border-foreground/20 hover:shadow-[0_12px_28px_rgba(0,0,0,0.12)]",
          "dark:hover:shadow-[0_12px_28px_rgba(0,0,0,0.45)]",
          "group-focus-visible:ring-2 group-focus-visible:ring-ring",
        )}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand transition-colors [transition-duration:180ms] group-hover:bg-foreground group-hover:text-background">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="font-semibold tracking-tight">{title}</h3>
            {star && <Star className="size-4 shrink-0 fill-warning text-warning" aria-hidden="true" />}
          </div>
          <p className="mt-0.5 pr-5 text-sm leading-relaxed text-muted-foreground">{blurb}</p>
          {proves && (
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="inline-flex min-w-0 truncate rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                {proves}
              </span>
              <ArrowUpRight
                className="size-4 shrink-0 text-muted-foreground opacity-0 transition-all [transition-duration:180ms] group-hover:translate-x-[2px] group-hover:-translate-y-[2px] group-hover:opacity-100"
                aria-hidden="true"
              />
            </div>
          )}
        </div>
        {!proves && (
          <ArrowUpRight
            className="absolute bottom-3 right-3 size-4 text-muted-foreground opacity-0 transition-all [transition-duration:180ms] group-hover:translate-x-[2px] group-hover:-translate-y-[2px] group-hover:opacity-100"
            aria-hidden="true"
          />
        )}
      </div>
    </Link>
  );
}
