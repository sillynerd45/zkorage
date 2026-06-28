import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { getRoomMeta, getDataroomInfo, fmtAmount, type RoomMeta } from "@/lib/api";
import { short, explorer, isHex32 } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/Disclosure";
import { PageHeader, SectionCard, DataRow, Verdict } from "@/components/marketing/blocks";

const fmtDate = (unix: number) =>
  new Date(unix * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

// Public on-chain read of a Data Room by id: confirm it exists on the Data Room contract and show how readers
// get in (an approved membership, or a bond anyone can lock). No wallet, no secret. The documents in the room
// stay encrypted; nothing here reveals contents or who has accessed it.
export default function VerifyRoom() {
  const { id = "" } = useParams();
  const valid = isHex32(id);
  const roomId = id.toLowerCase();

  const [meta, setMeta] = useState<RoomMeta | null>(null);
  const [dataroomId, setDataroomId] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!valid) {
      setState("error");
      setErr("A room id is 32-byte hex (64 hex characters).");
      return;
    }
    setState("loading");
    setErr(null);
    try {
      const [m, info] = await Promise.all([
        getRoomMeta(roomId),
        getDataroomInfo().catch(() => null),
      ]);
      setMeta(m);
      setDataroomId(info?.dataroomId ?? null);
      setState("done");
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setState("error");
    }
  }, [valid, roomId]);

  useEffect(() => {
    void run();
  }, [run]);

  const exists = !!meta && (meta.discoverable || meta.exists === true);
  const bond = meta?.bond ?? null;
  const cli = dataroomId
    ? `stellar contract invoke --network testnet --id ${dataroomId} --send=no -- get_room --room_id ${roomId}`
    : "";

  return (
    <>
      <PageHeader
        eyebrow="Verify & explore"
        title="Verify a Data Room"
        lead={
          <>
            <b>No wallet, and no need to trust our server.</b> This page reads the public Data Room contract to
            confirm a room exists and to show how readers get in. The documents stay encrypted, and nothing
            here reveals who has opened them.
          </>
        }
      />

      <SectionCard>
        {state === "loading" && <p className="text-sm text-muted-foreground">Reading the Data Room contract…</p>}
        {state === "error" && <Verdict ok={false}>{err}</Verdict>}
        {state === "done" && (
          <div data-testid="verify-room-verdict" data-state={exists ? "exists" : "not-found"}>
            <Verdict ok={exists}>
              {exists ? "This room exists on the public Data Room contract" : "No public room found for this id"}
            </Verdict>
            {!exists && (
              <p className="mt-3 border-t pt-3 text-sm leading-relaxed text-muted-foreground">
                A private room reveals nothing here by design. If you expected a result, double-check the id. If
                this is a Proof-of-Reserves issuer, {""}
                <Link to={`/verify/${roomId}`} className="rounded-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  verify it as reserves
                </Link>
                .
              </p>
            )}
          </div>
        )}
      </SectionCard>

      {state === "done" && exists && meta && (
        <SectionCard label="The room">
          {meta.name && (
            <DataRow k="name" mono={false}>
              {meta.name}
            </DataRow>
          )}
          {meta.description && (
            <DataRow k="description" mono={false}>
              {meta.description}
            </DataRow>
          )}
          <DataRow k="access" mono={false} testId="verify-room-access">
            {bond ? "Bonded Access. Lock a qualifying bond to enter, no approval." : "Membership. The owner approves readers; getting in stays anonymous."}
          </DataRow>
          {bond ? (
            <>
              <DataRow k="bond token" mono={false}>
                {bond.symbol || "token"}
              </DataRow>
              {bond.minAmount && (
                <DataRow k="minimum bond" mono={false}>
                  {fmtAmount(bond.minAmount, bond.decimals)} {bond.symbol || "token"}
                </DataRow>
              )}
              {bond.deadline ? <DataRow k="lock until" mono={false}>{fmtDate(bond.deadline)}</DataRow> : null}
            </>
          ) : (
            meta.memberBucket && (
              <DataRow k="members" mono={false}>
                {meta.memberBucket}
              </DataRow>
            )
          )}
          <DataRow k="room id">{short(roomId, 8)}</DataRow>
          <DataRow k="reader identity" variant="private">
            anonymous, never revealed
          </DataRow>
        </SectionCard>
      )}

      {dataroomId && (
        <SectionCard
          label="On-chain contract"
          aside={<span className="text-[11px] uppercase tracking-wide text-muted-foreground">read it yourself</span>}
        >
          <DataRow k="data room">
            <a
              href={explorer("contract", dataroomId, "testnet")}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-brand hover:underline"
            >
              {short(dataroomId, 8)} <ExternalLink className="size-3" />
            </a>
          </DataRow>
        </SectionCard>
      )}

      {cli && (
        <SectionCard label="Verify it yourself">
          <p className="mb-2 text-sm text-muted-foreground">
            Run the same read against the public RPC, no zkorage server involved.
          </p>
          <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            Read the room on-chain <CopyButton text={cli} label="copy" />
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground">
            {cli}
          </pre>
        </SectionCard>
      )}

      <SectionCard label="What this shows">
        <p className="text-sm leading-relaxed text-muted-foreground">
          It confirms the room is recorded on the public Data Room contract and how readers are admitted. It
          does not reveal the documents, who owns the room, or who has opened it.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => void run()} data-testid="verify-room-recheck">
            Re-check on-chain
          </Button>
          <Link
            to="/explorer"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Browse public rooms
          </Link>
        </div>
      </SectionCard>
    </>
  );
}
