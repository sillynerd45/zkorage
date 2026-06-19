// A tiny, unobtrusive build stamp pinned bottom-right so we always know exactly what's deployed.
// Values are inlined at build time by vite `define` (see vite.config.ts). The full ISO build time
// is in the title (hover/focus); the visible chip stays compact: `vX.Y.Z · <sha>`.
//
// First diagnostic for any "I'm seeing a stale app" report: compare the chip's <sha> against
// `git rev-parse --short HEAD`. user-select:all (see .vbadge CSS) makes it one-click copyable.

import { cn } from "@/lib/utils";

const VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
const SHA = typeof __GIT_SHA__ !== "undefined" ? __GIT_SHA__ : "nogit";
const BUILT = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "";

// `className` lets a shell nudge the badge, e.g. the app shell lifts it above the mobile bottom-nav.
export default function VersionBadge({ className }: { className?: string }) {
  const title = BUILT ? `zkorage v${VERSION} · ${SHA} · built ${BUILT}` : `zkorage v${VERSION} · ${SHA}`;
  return (
    <span
      className={cn("vbadge", className)}
      title={title}
      aria-label={`Build version ${VERSION}, commit ${SHA}${BUILT ? `, built ${BUILT}` : ""}`}
      data-testid="version-badge"
    >
      v{VERSION}&nbsp;·&nbsp;{SHA}
    </span>
  );
}
