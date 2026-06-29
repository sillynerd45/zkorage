import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { createPortal } from "react-dom";
import { MoreHorizontal, X, ExternalLink } from "lucide-react";
import { MOBILE_PRIMARY, NAV_SECTIONS, MARKETING_LINKS } from "./nav-registry";
import { cn } from "@/lib/utils";

// App mobile nav: a bottom bar with the 3 primary destinations + a "More" bottom-sheet (Blank pattern).
export function BottomNav() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <nav
        aria-label="Primary mobile"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-card/95 backdrop-blur lg:hidden"
      >
        {MOBILE_PRIMARY.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium",
                isActive ? "text-brand" : "text-muted-foreground",
              )
            }
          >
            <item.icon className="size-5" />
            <span>{item.label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium text-muted-foreground"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <MoreHorizontal className="size-5" />
          <span>More</span>
        </button>
      </nav>

      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="More navigation">
            <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
            <div className="absolute inset-x-0 bottom-0 max-h-[80vh] animate-fade-in overflow-y-auto rounded-t-3xl border-t bg-card p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold tracking-tight">All sections</h2>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-5" />
                </button>
              </div>
              {NAV_SECTIONS.filter((s) => s.key !== "home").map((section) => (
                <div key={section.key} className="mb-4">
                  {section.label && (
                    <p className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {section.label}
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    {section.items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        onClick={() => setOpen(false)}
                        className={({ isActive }) =>
                          cn(
                            "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm",
                            isActive ? "border-brand/40 bg-brand/5 text-foreground" : "text-muted-foreground hover:bg-accent",
                          )
                        }
                      >
                        <item.icon className="size-[18px] shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </NavLink>
                    ))}
                  </div>
                </div>
              ))}
              <div className="mt-1 border-t pt-3">
                <p className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Public
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {MARKETING_LINKS.map((l) => (
                    <Link
                      key={l.to}
                      to={l.to}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setOpen(false)}
                      className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent"
                    >
                      <ExternalLink className="size-[18px] shrink-0" />
                      <span className="truncate">{l.label}</span>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
