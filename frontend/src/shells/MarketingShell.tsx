import { Outlet } from "react-router-dom";
import { TopBar } from "./marketing/TopBar";
import { Footer } from "./marketing/Footer";
import VersionBadge from "@/components/VersionBadge";
import { AuroraBackground } from "@/components/AuroraBackground";

// Public marketing shell (top-bar, fhenix/Obolos pattern) wraps the landing, docs, verify, and
// explorer routes. Layout route: renders <Outlet/> for the matched child page. `relative isolate` lets the
// fixed AuroraBackground sit behind the content (a shared, scroll-persistent backdrop on every page).
export default function MarketingShell() {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-x-clip bg-background text-foreground">
      <AuroraBackground />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:border focus:bg-card focus:px-4 focus:py-2 focus:shadow-lg"
      >
        Skip to main content
      </a>
      <TopBar />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-6 py-8 outline-none">
        <Outlet />
      </main>
      <Footer />
      <VersionBadge />
    </div>
  );
}
