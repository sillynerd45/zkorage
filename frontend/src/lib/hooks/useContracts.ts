import { useEffect, useState } from "react";
import { getDataroomInfo, getEscrowInfo, getBondInfo } from "@/lib/api";

// The deployed contract ids the app actually uses, read from the public info endpoints. Each resolves
// independently; a slow or absent endpoint leaves its row null without blocking the others. `loading` stays
// true until all reads have settled, so the page can tell a pending row ("Loading…") apart from one that
// genuinely came back empty ("unavailable"). The Contracts reference page reads this. Scope = Data Room +
// Bonded Access only: the escrow + the bond-gate that Bonded Access uses. The legacy zkUSD solvency/tier
// gates + the zkUSD bond/supply tokens are intentionally not surfaced (no longer used).
export interface ContractsInfo {
  loading: boolean;
  dataroomId: string | null;
  verifierId: string | null;
  escrowId: string | null;
  bondGateId: string | null;
}

const EMPTY: ContractsInfo = {
  loading: true,
  dataroomId: null,
  verifierId: null,
  escrowId: null,
  bondGateId: null,
};

export function useContracts(): ContractsInfo {
  const [c, setC] = useState<ContractsInfo>(EMPTY);
  useEffect(() => {
    let live = true;
    const patch = (p: Partial<ContractsInfo>) => {
      if (live) setC((prev) => ({ ...prev, ...p }));
    };
    const reads = [
      getDataroomInfo().then((i) => patch({ dataroomId: i.dataroomId ?? null, verifierId: i.config?.verifier ?? null })),
      getEscrowInfo().then((i) => patch({ escrowId: i.escrowId ?? null })),
      getBondInfo().then((i) => patch({ bondGateId: i.bondGateId ?? null })),
    ];
    Promise.allSettled(reads).then(() => patch({ loading: false }));
    return () => {
      live = false;
    };
  }, []);
  return c;
}
