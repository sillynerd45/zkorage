import { type ComponentType } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { DOCS_SECTIONS, docsSection } from "@/lib/content";
import { PageHeader } from "@/components/marketing/blocks";
import { cn } from "@/lib/utils";
import {
  DocsOverview,
  DocsDataRoom,
  DocsBondedProofs,
  DocsVerify,
  DocsDevelopers,
  DocsGlossary,
} from "./docs/DocsSections";

const CONTENT: Record<string, ComponentType> = {
  "": DocsOverview,
  "data-room": DocsDataRoom,
  "bonded-proofs": DocsBondedProofs,
  verify: DocsVerify,
  developers: DocsDevelopers,
  glossary: DocsGlossary,
};

export default function Docs() {
  const { section } = useParams();
  // The former "Capabilities" section folded into the two pillar sections; keep old links working.
  if (section === "capabilities") return <Navigate to="/docs/data-room" replace />;
  const active = docsSection(section) ?? DOCS_SECTIONS[0];
  const Body = CONTENT[active.slug] ?? DocsOverview;

  return (
    <>
      <PageHeader
        eyebrow="Documentation"
        title={active.slug ? active.label : "Documentation"}
        lead={active.blurb}
      />

      <div className="grid gap-8 lg:grid-cols-[200px_1fr]">
        {/* content side-rail (distinct from the app sidebar; it navigates docs content) */}
        <nav aria-label="Documentation sections" className="lg:sticky lg:top-24 lg:self-start">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0.5">
            {DOCS_SECTIONS.map((s) => (
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
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0">
          <Body />
        </div>
      </div>
    </>
  );
}
