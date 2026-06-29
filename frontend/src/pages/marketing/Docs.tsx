import { type ComponentType, useEffect, useState } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { ChevronDown, List } from "lucide-react";
import { DOCS_SECTIONS, DOCS_SUBNAV, docsSection } from "@/lib/content";
import { PageHeader } from "@/components/marketing/blocks";
import { cn } from "@/lib/utils";
import {
  DocsOverview,
  DocsDataRoom,
  DocsBondedProofs,
  DocsVerify,
  DocsGlossary,
} from "./docs/DocsSections";

const CONTENT: Record<string, ComponentType> = {
  "": DocsOverview,
  "data-room": DocsDataRoom,
  "bonded-proofs": DocsBondedProofs,
  verify: DocsVerify,
  glossary: DocsGlossary,
};

// Scroll-spy: the id of the last sub-section heading whose top has scrolled above a line just below the sticky
// header. Drives the highlight in the desktop nested nav + the mobile "On this page" bar. A plain scroll/rAF
// read (not IntersectionObserver) so the LAST section still highlights when you reach the bottom of the page.
function useActiveHeading(ids: string[]): string | null {
  const key = ids.join("|");
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    if (!ids.length) {
      setActive(null);
      return;
    }
    let raf = 0;
    const compute = () => {
      const line = 150; // px from the top of the viewport (clears the sticky header)
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top - line <= 0) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(compute);
    };
    compute();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [key]);
  return active;
}

export default function Docs() {
  const { section } = useParams();
  // Folded/retired sections: keep old links working.
  if (section === "capabilities") return <Navigate to="/docs/data-room" replace />;
  if (section === "developers") return <Navigate to="/docs" replace />;
  const active = docsSection(section) ?? DOCS_SECTIONS[0];
  const Body = CONTENT[active.slug] ?? DocsOverview;
  const subnav = DOCS_SUBNAV[active.slug] ?? [];
  const activeId = useActiveHeading(subnav.map((s) => s.id));
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeLabel = subnav.find((s) => s.id === activeId)?.label ?? subnav[0]?.label ?? "";

  return (
    <>
      <PageHeader
        eyebrow="Documentation"
        title={active.slug ? active.label : "Documentation"}
        lead={active.blurb}
      />

      {/* Mobile "On this page": a sticky, collapsible bar pinned below the header (desktop uses the nested
          side-rail instead). top offset tracks the two TopBar heights (64px at sm+, +the mobile nav strip below). */}
      {subnav.length > 0 && (
        <div className="sticky top-[116px] z-30 mb-5 sm:top-16 lg:hidden">
          <div className="overflow-hidden rounded-lg border bg-background/95 shadow-sm backdrop-blur">
            <button
              type="button"
              onClick={() => setMobileOpen((o) => !o)}
              aria-expanded={mobileOpen}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm"
            >
              <List className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="text-muted-foreground">On this page</span>
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">{activeLabel}</span>
              <ChevronDown
                className={cn("size-4 shrink-0 text-muted-foreground transition-transform", mobileOpen && "rotate-180")}
                aria-hidden="true"
              />
            </button>
            {mobileOpen && (
              <ul className="border-t p-1.5">
                {subnav.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        "block rounded-md px-2.5 py-1.5 text-[13px] leading-snug",
                        s.id === activeId
                          ? "bg-accent font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      {s.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[220px_1fr]">
        {/* content side-rail (distinct from the app sidebar; it navigates docs content) */}
        <nav aria-label="Documentation sections" className="lg:sticky lg:top-24 lg:self-start">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0.5">
            {DOCS_SECTIONS.map((s) => {
              const isCurrent = s.slug === active.slug;
              return (
                <li key={s.slug}>
                  <NavLink
                    to={s.slug ? `/docs/${s.slug}` : "/docs"}
                    end={s.slug === ""}
                    className={({ isActive }) =>
                      cn(
                        "block whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )
                    }
                  >
                    {s.label}
                  </NavLink>
                  {/* Desktop: nested, sticky sub-section nav under the active pillar, scroll-spy highlighted. */}
                  {isCurrent && subnav.length > 0 && (
                    <ul className="ml-3 mt-1 hidden border-l border-border/70 lg:block">
                      {subnav.map((sub) => (
                        <li key={sub.id}>
                          <a
                            href={`#${sub.id}`}
                            aria-current={sub.id === activeId ? "true" : undefined}
                            className={cn(
                              "-ml-px block border-l-2 py-1 pl-3 pr-2 text-[13px] leading-snug transition-colors",
                              sub.id === activeId
                                ? "border-brand font-medium text-foreground"
                                : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground",
                            )}
                          >
                            {sub.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0">
          <Body />
        </div>
      </div>
    </>
  );
}
