import { NavLink, Outlet } from "react-router-dom";
import { Lock } from "lucide-react";
import { BONDED_TABS } from "@/lib/content";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/app/blocks";

export default function BondedLayout() {
  return (
    <>
      <PageHeader
        icon={Lock}
        title="Bonded Proofs"
        lead="Lock tokens until a time you choose. This is the escrow behind upcoming time-bound proofs: a proof that stays valid only while the funds stay locked, and stops the moment you pull them."
      />

      {/* Segmented tab bar, matching the Data Room. w-fit hugs the tabs; overflow-x-auto keeps it usable when narrow. */}
      <div className="mb-3 flex w-fit max-w-full gap-1 overflow-x-auto rounded-2xl border bg-card p-1.5">
        {BONDED_TABS.map((t) => (
          <NavLink
            key={t.slug}
            to={t.slug ? `/app/bonded/${t.slug}` : "/app/bonded"}
            end={t.slug === ""}
            className={({ isActive }) =>
              cn(
                "whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>

      <Outlet />
    </>
  );
}
