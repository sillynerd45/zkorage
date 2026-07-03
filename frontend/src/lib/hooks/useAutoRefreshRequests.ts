import { useEffect, useRef } from "react";
import { refreshJoinRequestStatuses } from "@/lib/dataroom/requests";

// Silently keep this wallet's local join-request history in step with the chain, so a request the owner just
// approved flips from "Requested"/"Pending" to open on its own, with no manual Refresh. It re-checks:
//   - on mount (arriving on the page),
//   - on a wallet switch (the address changes, incl. an in-tab Freighter account switch the WalletContext poll
//     surfaces): the store + commitments are per wallet, so the new wallet re-checks its own requests,
//   - when the tab regains focus / becomes visible (e.g. you approved in another tab, then came back).
// The check is commitment-based (@/lib/dataroom/requests), so it needs NO wallet signature and never prompts;
// entries with no stored commitment are skipped (the manual Refresh re-derives those). `onChanged` fires only
// when a status actually changed, so the caller can cheaply re-read the store and repaint.
export function useAutoRefreshRequests(
  address: string | null | undefined,
  enabled: boolean,
  onChanged: () => void,
): void {
  // Keep the latest callback in a ref so the effect deps stay just [address, enabled] (an inline onChanged
  // changes every render); the ref always calls the freshest closure.
  const cb = useRef(onChanged);
  cb.current = onChanged;

  useEffect(() => {
    if (!enabled || !address) return;
    let live = true;
    const run = () => {
      refreshJoinRequestStatuses(address)
        .then((res) => { if (live && res.changed) cb.current(); })
        .catch(() => { /* silent: a background hint, never blocks the UI */ });
    };
    run();
    const onFocus = () => run();
    const onVisible = () => { if (document.visibilityState === "visible") run(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [address, enabled]);
}
