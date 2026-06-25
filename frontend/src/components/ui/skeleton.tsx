import { cn } from "@/lib/utils";

// A loading placeholder with a horizontal shimmer sweep: a faint highlight band moves across a muted block.
// The sweep is a translucent highlight over `bg-muted`, tuned per theme (a soft darken in light, a soft
// lighten in dark), so it works in both without a per-theme block color. It is reduced-motion safe: the
// `motion-safe:` prefix keeps the band parked off-screen (invisible) when motion is disabled, so the
// placeholder reads as a clean static block instead of a frozen stripe.
//
// Size each placeholder via `className` (e.g. `h-3.5 w-28 rounded`); the box should match the real element it
// stands in for, so the swap to real content does not shift layout. Decorative by design: it is aria-hidden,
// and the caller marks the surrounding loading region with `aria-busy` plus an sr-only status for AT.
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-md bg-muted", className)} aria-hidden="true">
      <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-foreground/[0.07] to-transparent motion-safe:animate-shimmer dark:via-white/[0.06]" />
    </div>
  );
}
