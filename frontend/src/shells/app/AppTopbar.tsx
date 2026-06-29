import { Link, useLocation } from "react-router-dom";
import { BrandMark } from "@/components/BrandMark";
import { CAPABILITIES, dataroomTab } from "@/lib/content";
import { ThemeToggle } from "@/components/ThemeToggle";
import { FreighterButton } from "./FreighterButton";

// Derive the current page title from the route so the app top bar always names where you are.
function pageTitle(path: string): string {
  if (path === "/app" || path === "/app/") return "Home";
  const segs = path.replace(/^\/app\/?/, "").split("/").filter(Boolean);
  if (segs[0] === "dataroom") {
    if (!segs[1]) return "Data Room";
    const t = dataroomTab(segs[1]);
    return t ? `Data Room · ${t.label}` : "Data Room";
  }
  if (segs[0] === "contracts") return "Contracts";
  const cap = CAPABILITIES.find((c) => c.to === `/app/${segs[0]}`);
  return cap?.title ?? "zkorage";
}

// App-shell top bar. Desktop: the page title (sidebar carries the logo) + the Freighter wallet control.
// Mobile: the logo + Freighter + theme toggle (the sidebar is hidden < lg).
export function AppTopbar() {
  const { pathname } = useLocation();
  const title = pageTitle(pathname);
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b bg-background/85 px-4 backdrop-blur lg:h-16 lg:px-8">
      <Link
        to="/app"
        className="flex items-center gap-2 font-semibold tracking-tight lg:hidden"
        aria-label="zkorage home"
      >
        <BrandMark />
        <span className="text-[16px]">zkorage</span>
      </Link>
      <h1 className="hidden truncate text-base font-semibold tracking-tight lg:block" data-testid="app-page-title">
        {title}
      </h1>
      <div className="flex items-center gap-2">
        <FreighterButton />
        <span className="lg:hidden">
          <ThemeToggle />
        </span>
      </div>
    </header>
  );
}
