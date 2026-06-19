import { useEffect, useState } from "react";
import { getHistory, getInfo, type VerifiedResult, type Info } from "@/lib/api";

// Read-only on-chain history of verified Proof-of-Reserves results (the policy contract's append-only log).
// Ported verbatim from the legacy ExplorerPage; newest-first.
export function useExplorer() {
  const [info, setInfo] = useState<Info | null>(null);
  const [rows, setRows] = useState<VerifiedResult[]>([]);
  const [count, setCount] = useState(0);
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getInfo().then(setInfo).catch(() => {});
    // The backend clamps each page to 50; page through `start` until we've collected the full `count`.
    (async () => {
      try {
        const PAGE = 50;
        const all: VerifiedResult[] = [];
        const first = await getHistory(0, PAGE);
        const total = first.count;
        all.push(...first.results);
        let start = PAGE;
        while (all.length < total && start < total + PAGE) {
          const next = await getHistory(start, PAGE);
          if (next.results.length === 0) break;
          all.push(...next.results);
          start += PAGE;
        }
        setRows(all.sort((a, b) => (b.index ?? 0) - (a.index ?? 0)));
        setCount(total);
        setState("done");
      } catch (e) {
        setErr(String((e as Error).message ?? e));
        setState("error");
      }
    })();
  }, []);

  return { info, rows, count, state, err };
}
