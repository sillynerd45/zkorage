import { NavLink, Outlet } from "react-router-dom";
import { FolderLock } from "lucide-react";
import { DATAROOM_TABS } from "@/lib/content";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/app/blocks";

export default function DataRoomLayout() {
  return (
    <>
      <PageHeader
        icon={FolderLock}
        title="Data Room"
        lead={
          <>
            Keep sensitive files private and decide who can open them. New here? Start with Overview.
          </>
        }
      />

      {/* B segmented tab bar (filled active, matches sidebar active style). w-fit so the pill hugs the tabs
          instead of stretching the full width; max-w-full + overflow-x-auto keep it scrollable when narrow. */}
      <div className="mb-3 flex w-fit max-w-full gap-1 overflow-x-auto rounded-2xl border bg-card p-1.5">
        {DATAROOM_TABS.map((t) => (
          <NavLink
            key={t.slug}
            to={t.slug ? `/app/dataroom/${t.slug}` : "/app/dataroom"}
            end={t.slug === ""}
            className={({ isActive }) =>
              cn(
                "whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors",
                isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )
            }
          >
            {t.label}
            {t.star && <span aria-hidden="true"> ⭐</span>}
          </NavLink>
        ))}
      </div>

      <Outlet />
    </>
  );
}
