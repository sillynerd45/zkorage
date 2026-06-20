import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { DATAROOM_TABS } from "@/lib/content";
import { cn } from "@/lib/utils";
import { getCommitteeInfo, type CommitteeInfoResp } from "@/lib/api";
import { CommitteePill, DataRoomHeader } from "@/components/app/dataroom/kit";

export default function DataRoomLayout() {
  // The committee pill now lives in the header (so it shows on every Data Room sub-page, not just Overview).
  // Read-only liveness; failures are swallowed so the header still renders if the keepers can't be reached.
  const [committee, setCommittee] = useState<CommitteeInfoResp | null>(null);
  useEffect(() => {
    getCommitteeInfo().then(setCommittee).catch(() => {});
  }, []);

  return (
    <>
      <DataRoomHeader aside={committee ? <CommitteePill c={committee} /> : undefined} />

      {/* B segmented tab bar (filled active, matches sidebar active style). w-fit so the pill hugs the tabs
          instead of stretching the full width; max-w-full + overflow-x-auto keep it scrollable when narrow.
          Tab/submenu styling is intentionally unchanged in this pass. */}
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
