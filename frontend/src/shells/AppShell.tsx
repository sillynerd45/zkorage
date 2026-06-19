import { Outlet } from "react-router-dom";
import { Sidebar } from "./app/Sidebar";
import { AppTopbar } from "./app/AppTopbar";
import { BottomNav } from "./app/BottomNav";
import VersionBadge from "@/components/VersionBadge";

// App shell (grouped left sidebar, Blank/BlockWallet pattern) wraps the ZK operations under /app/*.
// Layout route: renders <Outlet/> for the matched child page. The Freighter wallet control lives in AppTopbar.
export default function AppShell() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:border focus:bg-card focus:px-4 focus:py-2 focus:shadow-lg"
      >
        Skip to main content
      </a>
      <Sidebar />
      <div className="lg:pl-72">
        <AppTopbar />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto max-w-7xl px-5 py-6 pb-28 outline-none lg:px-8 lg:pb-12"
        >
          <Outlet />
        </main>
      </div>
      <BottomNav />
      {/* lift above the mobile bottom-nav (~3.5rem tall); back to the corner on lg+ where there's no bottom-nav */}
      <VersionBadge className="max-lg:!bottom-[4.25rem]" />
    </div>
  );
}
