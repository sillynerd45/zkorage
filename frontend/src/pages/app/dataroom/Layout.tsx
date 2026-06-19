import { NavLink, Outlet } from "react-router-dom";
import { ExternalLink, FolderLock } from "lucide-react";
import { DATAROOM_TABS } from "@/lib/content";
import { useDataroomInfo } from "@/lib/hooks/useDataroomInfo";
import { short, explorer } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader, Panel, DataRow } from "@/components/app/blocks";

function Ex({ id }: { id: string }) {
  return (
    <a
      href={explorer("contract", id)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-brand hover:underline"
    >
      {short(id, 8)} <ExternalLink className="size-3" />
    </a>
  );
}

export default function DataRoomLayout() {
  const info = useDataroomInfo();
  return (
    <>
      <PageHeader
        icon={FolderLock}
        title="Data Room"
        lead={
          <>
            A sealed room for sensitive documents. You prove you're <b>allowed in without revealing who you
            are</b>, files stay encrypted, and only a tamper-evident fingerprint goes on the public record.
            Every claim is <b>checkable by anyone</b>. Pick a capability — each is its own step.
          </>
        }
      />

      {/* B segmented tab bar (filled active, matches sidebar active style) */}
      <div className="mb-5 flex gap-1 overflow-x-auto rounded-2xl border bg-card p-1.5">
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

      <Panel title="Engine" className="mb-5">
        <DataRow k="Network">testnet</DataRow>
        {info?.dataroomId && <DataRow k="DataRoom contract"><Ex id={info.dataroomId} /></DataRow>}
        {info?.config?.verifier && <DataRow k="Groth16 verifier"><Ex id={info.config.verifier} /></DataRow>}
        {info && (
          <DataRow k="Blob storage" mono={false} testId="storage">
            {info.storage === "r2" ? "Cloudflare R2" : "local stand-in"} · content-addressed
          </DataRow>
        )}
        {info && <DataRow k="Rooms" testId="room-count">{info.roomCount}</DataRow>}
      </Panel>

      <Outlet />
    </>
  );
}
