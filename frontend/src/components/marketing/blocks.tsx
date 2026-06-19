import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { VerdictMark } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";

// Variant A design molecules — light, spacious, card-led; section labels are small uppercase tracking.

export function PageHeader({
  eyebrow,
  title,
  lead,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-7">
      {eyebrow && (
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">{eyebrow}</p>
      )}
      <h1 className="mt-1.5 text-3xl font-bold tracking-tight sm:text-[34px]">{title}</h1>
      {lead && <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">{lead}</p>}
      {actions && <div className="mt-5 flex flex-wrap items-center gap-3">{actions}</div>}
    </header>
  );
}

export function SectionCard({
  label,
  aside,
  children,
  className,
}: {
  label?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("mb-5 p-6", className)}>
      {(label || aside) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {label && (
            <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</h2>
          )}
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
    <div className="flex items-center justify-between gap-4 border-b border-border/70 py-2 last:border-0">
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
      className={cn("flex items-center gap-3 py-2 text-lg font-semibold", ok ? "text-success" : "text-destructive")}
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

export function FeatureCard({
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
  return (
    <Link to={to} className="group block focus-visible:outline-none">
      <Card className="h-full p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md group-focus-visible:border-brand group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <div className="flex items-start gap-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="font-semibold tracking-tight">{title}</h3>
              {star && <span aria-hidden="true" className="text-sm">⭐</span>}
              <ArrowRight className="size-4 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:text-brand group-hover:opacity-100" />
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{blurb}</p>
            {proves && (
              <p className="mt-2.5 inline-flex rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                {proves}
              </p>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}
