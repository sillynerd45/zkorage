import { useState } from "react";
import { Check, Copy, ExternalLink, FileText } from "lucide-react";
import { PageHeader, DataRow } from "@/components/app/blocks";
import { useContracts } from "@/lib/hooks/useContracts";
import { short, explorer } from "@/lib/format";

// A read-only reference: the Stellar testnet contracts behind the Data Room and Bonded Proofs, each with a
// link to a public explorer so anyone can re-check a result without trusting our server. The ids come from
// the public info endpoints (useContracts), so this page always shows what the serving backend points at.
const NETWORK = "testnet";

function CopyId({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied to clipboard" : `Copy ${label} contract id`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(id);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked (insecure context / permissions): no-op */
        }
      }}
      className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-card"
    >
      {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
    </button>
  );
}

function ContractValue({ id, label, loading }: { id: string | null; label: string; loading: boolean }) {
  if (!id) return <span className="text-muted-foreground">{loading ? "Loading…" : "unavailable"}</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <code className="font-mono text-xs text-muted-foreground">{short(id, 4)}</code>
      <a
        href={explorer("contract", id, NETWORK)}
        target="_blank"
        rel="noreferrer"
        aria-label={`View ${label} on the explorer`}
        data-testid="contract-explorer-link"
        className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      >
        <ExternalLink className="size-4" />
      </a>
      <CopyId id={id} label={label} />
    </span>
  );
}

function Section({ title, intro, rows, loading, testid }: { title: string; intro: string; rows: { label: string; id: string | null }[]; loading: boolean; testid: string }) {
  return (
    <section className="rounded-2xl border bg-card p-6" data-testid={testid}>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{intro}</p>
      </div>
      <div>
        {rows.map((r) => (
          <DataRow key={r.label} k={r.label} mono={false}>
            <ContractValue id={r.id} label={r.label} loading={loading} />
          </DataRow>
        ))}
      </div>
    </section>
  );
}

export default function Contracts() {
  const c = useContracts();
  return (
    <div data-testid="contracts-page" className="space-y-6">
      <PageHeader
        icon={FileText}
        title="Contracts"
        lead="The Stellar testnet contracts behind zkorage, with links to view each one on a public explorer."
      />

      <Section
        testid="contracts-dataroom"
        title="Data Room"
        loading={c.loading}
        intro="The contract that stores room policies and admits readers, plus the proof verifier it checks every proof against."
        rows={[
          { label: "DataRoom contract", id: c.dataroomId },
          { label: "Proof verifier", id: c.verifierId },
        ]}
      />

      <Section
        testid="contracts-bonded"
        title="Bonded Proofs"
        loading={c.loading}
        intro="The escrow that time-locks collateral and the gates that read it, including the bond token and the supply token they price against."
        rows={[
          { label: "Escrow", id: c.escrowId },
          { label: "Bond token (zUSD)", id: c.bondTokenId },
          { label: "Solvency gate", id: c.solvencyGateId },
          { label: "Anonymous tier gate", id: c.tierGateId },
          { label: "Supply token", id: c.supplyTokenId },
        ]}
      />

      <p className="text-sm text-muted-foreground">
        Network: <b className="text-foreground">Stellar {NETWORK}</b>. These are unaudited demo contracts, not
        for production funds.
      </p>
    </div>
  );
}
