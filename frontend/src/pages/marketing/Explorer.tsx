import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { useExplorer } from "@/lib/hooks/useExplorer";
import { fmtAmount } from "@/lib/api";
import { short, explorer as explorerUrl } from "@/lib/format";
import { PageHeader, SectionCard } from "@/components/marketing/blocks";

export default function Explorer() {
  const { info, rows, count, state, err } = useExplorer();
  const net = info?.network ?? "testnet";

  return (
    <>
      <PageHeader
        eyebrow="Verify & explore"
        title="Explorer"
        lead={
          <>
            Every successful Proof-of-Reserves verification is appended to an <b>on-chain, append-only log</b>{" "}
            in the policy contract. Anyone can list it straight from the chain, and this page just mirrors it.
          </>
        }
      />

      <SectionCard
        label={`On-chain history · ${count} total`}
        aside={
          info?.policyId ? (
            <a
              href={explorerUrl("contract", info.policyId, net)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-brand hover:underline"
            >
              policy <ExternalLink className="size-3" />
            </a>
          ) : undefined
        }
      >
        {state === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}
        {state === "error" && <p className="text-sm text-destructive">Could not load history: {err}</p>}
        {state === "done" && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No verified results yet.</p>
        )}
        {state === "done" && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="history-table">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">#</th>
                  <th className="py-2 pr-3 font-medium">result</th>
                  <th className="py-2 pr-3 font-medium">bound supply</th>
                  <th className="py-2 pr-3 font-medium">issuer</th>
                  <th className="py-2 pr-3 font-medium">ledger</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.index ?? `${r.issuer_id}-${r.nonce}`}
                    data-testid="history-row"
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="py-2.5 pr-3 tabular-nums text-muted-foreground">{r.index ?? "-"}</td>
                    <td className="py-2.5 pr-3">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/5 px-2 py-0.5 text-xs font-medium text-success">
                        reserves ≥ supply ✓
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 tabular-nums">{fmtAmount(r.supply, info?.decimals ?? 7)} zUSD</td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">{short(r.issuer_id, 6)}</td>
                    <td className="py-2.5 pr-3 tabular-nums text-muted-foreground">{r.ledger}</td>
                    <td className="py-2.5">
                      <Link to={`/verify/${r.issuer_id}`} className="inline-flex items-center gap-1 text-brand hover:underline">
                        verify ↗
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
