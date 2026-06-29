import { Link, NavLink } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { buttonVariants } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { cn } from "@/lib/utils";

// Public marketing nav. The app's ZK operations live behind "Open app →"; the top bar carries only the
// public/exploration surfaces.
const NAV = [
  { to: "/docs", label: "Documentation" },
  { to: "/verify", label: "Verify" },
  { to: "/explorer", label: "Explorer" },
];

function linkCls(isActive: boolean) {
  return cn(
    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
    isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
  );
}

// Minimal sticky top bar (fhenix/Obolos pattern): logo left, few centered nav entries, "Open app" right.
export function TopBar() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-6 px-6">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight" aria-label="zkorage home">
          <BrandMark />
          <span className="text-[17px]">zkorage</span>
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-1 sm:flex">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => linkCls(isActive)}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Link to="/app" className={cn(buttonVariants({ size: "sm" }))} data-testid="open-app">
            Open app <ArrowRight className="size-4" />
          </Link>
        </div>
      </div>
      {/* mobile nav: horizontally scrollable strip */}
      <nav aria-label="Primary mobile" className="flex gap-1 overflow-x-auto border-t px-4 py-2 sm:hidden">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => cn(linkCls(isActive), "whitespace-nowrap")}>
            {n.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
