import { Link, NavLink } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { NAV_SECTIONS, MARKETING_LINKS } from "./nav-registry";
import { ThemeToggle } from "@/components/ThemeToggle";
import { cn } from "@/lib/utils";

// Fixed grouped left sidebar (Blank/BlockWallet pattern). Active = filled pill. Footer carries the
// testnet pill, theme toggle, and small links out to the public Verify / Docs surfaces.
export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 flex-col border-r bg-card lg:flex">
      <div className="flex h-16 items-center border-b px-5">
        <Link to="/app" className="flex items-center gap-2 font-semibold tracking-tight" aria-label="zkorage home">
          <BrandMark />
          <span className="text-[17px]">zkorage</span>
        </Link>
      </div>
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-4">
        {NAV_SECTIONS.map((section) => (
          <div key={section.key} className="mb-5">
            {section.label && (
              <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )
                    }
                  >
                    <item.icon className="size-[18px]" />
                    <span>{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t px-3 py-3">
        <ul className="mb-2 space-y-0.5">
          {MARKETING_LINKS.map((l) => (
            <li key={l.to}>
              <Link
                to={l.to}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between px-1">
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" /> Stellar testnet
          </span>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
