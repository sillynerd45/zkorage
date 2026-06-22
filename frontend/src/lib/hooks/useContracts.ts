import { useEffect, useState } from "react";
import { getDataroomInfo, getEscrowInfo, getSolvencyInfo, getTierInfo } from "@/lib/api";

// The deployed contract ids the app points at, read from the existing public info endpoints. Each resolves
// independently; a slow or absent endpoint leaves its row null without blocking the others. `loading` stays
// true until all four reads have settled, so the page can tell a pending row ("Loading…") apart from one that
// genuinely came back empty ("unavailable"). The Contracts reference page reads this.
export interface ContractsInfo {
  loading: boolean;
  dataroomId: string | null;
  verifierId: string | null;
  escrowId: string | null;
  bondTokenId: string | null;
  solvencyGateId: string | null;
  tierGateId: string | null;
  supplyTokenId: string | null;
}

const EMPTY: ContractsInfo = {
  loading: true,
  dataroomId: null,
  verifierId: null,
  escrowId: null,
  bondTokenId: null,
  solvencyGateId: null,
  tierGateId: null,
  supplyTokenId: null,
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
      getEscrowInfo().then((i) => patch({ escrowId: i.escrowId ?? null, bondTokenId: i.bondTokenId ?? null })),
      getSolvencyInfo().then((i) => patch({ solvencyGateId: i.solvencyGateId ?? null, supplyTokenId: i.supplyTokenId ?? null })),
      getTierInfo().then((i) => patch({ tierGateId: i.tierGateId ?? null })),
    ];
    Promise.allSettled(reads).then(() => patch({ loading: false }));
    return () => {
      live = false;
    };
  }, []);
  return c;
}
