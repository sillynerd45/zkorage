import { explorer, short } from "@/lib/format";
import { fmtAmount } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DataRow } from "@/components/app/blocks";
import { CopyIconButton } from "@/components/app/dataroom/kit";

// The specifics of a Bonded Access requirement, shown wherever one is surfaced: Room Management's "Current
// requirement", the Discover directory/find-by-id card, and the reader's open flow. One component so the
// three stay consistent: the token's contract and its classic issuer link to Stellar Expert, and the deadline
// shows the date AND time (a lock cannot be released before that exact moment).
//
// It renders the requirement rows only (no card/background); the caller styles the container (usually the
// success tint). The token symbol/decimals/issuer come from `meta`, which may be null while the token read is
// in flight (`metaLoading`) or after it failed (e.g. the token's SAC is not deployed): the rows then read
// "…" or "unavailable"/base units instead of guessing. `idPrefix` keeps each surface's existing test ids.
//
// Two layouts: detailed (default, a labeled row list) and compact (a two-line summary for the directory card).

function fmtBondDeadline(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export interface BondMeta {
  symbol: string;
  decimals: number;
  issuer: string | null;
}

export function BondRequirementDetail({
  token,
  minAmount,
  deadline,
  meta,
  metaLoading = false,
  compact = false,
  idPrefix = "bond-req",
  className,
}: {
  token: string;
  minAmount: string;
  deadline: number;
  meta: BondMeta | null;
  metaLoading?: boolean;
  compact?: boolean;
  idPrefix?: string;
  className?: string;
}) {
  const until = fmtBondDeadline(deadline);
  const amountText = meta
    ? `${fmtAmount(minAmount, meta.decimals)}${meta.symbol ? ` ${meta.symbol}` : ""}`
    : metaLoading
      ? "…"
      : `${minAmount} base units`;

  const contractLink = (
    <a
      href={explorer("contract", token)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-brand hover:underline"
      title={token}
    >
      {short(token, 6)} ↗
    </a>
  );
  const issuerLink = meta?.issuer ? (
    <a
      href={explorer("account", meta.issuer)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-brand hover:underline"
      title={meta.issuer}
    >
      {short(meta.issuer, 6)} ↗
    </a>
  ) : null;

  if (compact) {
    return (
      <div className={cn("text-[12px] leading-relaxed", className)} data-testid={`${idPrefix}-detail`}>
        <div className="font-medium text-foreground">
          Bond {amountText}
          <span className="font-normal text-muted-foreground"> · locked until {until}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
          <span>Contract {contractLink}</span>
          {issuerLink && <span data-testid={`${idPrefix}-issuer`}>Issuer {issuerLink}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-1", className)} data-testid={`${idPrefix}-detail`}>
      <DataRow k="token" testId={`${idPrefix}-token`}>
        <span className="font-mono">{meta?.symbol || short(token, 6)}</span>
      </DataRow>
      <DataRow k="contract" mono={false}>
        <span className="inline-flex items-center gap-1.5">
          {contractLink}
          <CopyIconButton value={token} label="token contract" />
        </span>
      </DataRow>
      <DataRow k="issuer" mono={false} testId={`${idPrefix}-issuer`}>
        {metaLoading ? (
          <span className="text-muted-foreground">…</span>
        ) : issuerLink ? (
          issuerLink
        ) : meta ? (
          <span className="text-muted-foreground">no classic issuer</span>
        ) : (
          <span className="text-muted-foreground">unavailable</span>
        )}
      </DataRow>
      <DataRow k="minimum">{amountText}</DataRow>
      <DataRow k="locked until" mono={false}>
        {until} <span className="text-muted-foreground">(or later)</span>
      </DataRow>
    </div>
  );
}
