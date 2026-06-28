// Ambient page backdrop: a soft blue/emerald glow plus a faint grid, FIXED to the viewport so it stays in
// place as you scroll, behind all content. Decorative only (aria-hidden, pointer-events-none, -z-10). It is
// rendered once per shell (marketing + app) so every page shares the same backdrop. The shell root carries
// `relative isolate` so the -z-10 layer sits in front of the page background and behind the content.
export function AuroraBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-40 -top-48 h-[600px] w-[600px] rounded-full blur-3xl motion-safe:animate-aurora-one bg-[radial-gradient(closest-side,hsl(var(--brand)/0.20),transparent)]" />
      <div className="absolute -right-36 -top-40 h-[560px] w-[560px] rounded-full blur-3xl motion-safe:animate-aurora-two bg-[radial-gradient(closest-side,hsl(var(--success)/0.16),transparent)]" />
      <div className="absolute left-1/2 top-24 h-[520px] w-[820px] -translate-x-1/2 rounded-full blur-3xl motion-safe:animate-aurora-one bg-[radial-gradient(closest-side,hsl(var(--brand)/0.10),transparent)]" />
      <div className="aurora-grid absolute inset-x-0 top-0 h-[620px] opacity-50 dark:opacity-30" />
    </div>
  );
}
