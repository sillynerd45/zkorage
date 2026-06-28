import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/wallet/WalletContext";
import { getSyncPref, isDontAsk, setDontAsk } from "@/lib/sync/prefs";
import { useSync } from "@/lib/sync/useSync";

// The connect-time consent gate for cross-device sync. It appears once per session when a wallet connects (or
// the account changes), unless the user chose "Don't ask again on this device". Turning sync on takes ONE
// signature and restores both the Data Room rooms list and the Bonded Access handle. It never moves funds and
// never authorizes a transaction; the signature only derives an encryption key. Mounted once at the app shell.
export function SyncConsentDialog() {
  const { connected, address } = useWallet();
  const sync = useSync();
  const [open, setOpen] = useState(false);
  const [dontAsk, setDontAskState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Addresses handled this session, so we ask (or auto-apply) at most once per account per session.
  const handled = useRef<Set<string>>(new Set());

  const dismissRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  // Decide what to do when a wallet connects or the account changes.
  useEffect(() => {
    if (!connected || !address) return;
    if (handled.current.has(address)) return;
    if (isDontAsk()) {
      // A familiar user opted out of the dialog: apply their saved choice silently. If sync is on for this
      // wallet, take the one signature now (their "sign on connect" expectation); otherwise stay local.
      handled.current.add(address);
      if (getSyncPref(address)) void sync.enable().catch(() => {});
      return;
    }
    setError(null);
    setDontAskState(false);
    setOpen(true);
    // sync is intentionally omitted: enabling reads the latest address via the hook; we only want this to fire
    // on a connect / account change, not on every hook re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, address]);

  // Close + reset focus trap, mirroring ConfirmModal.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    dismissRef.current?.focus(); // focus the non-signing action so Enter never starts a signature
    const onKey = (e: KeyboardEvent) => {
      if (sync.busy) return; // do not let Escape close mid-signature
      if (e.key === "Escape") {
        dismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const f = modalRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!f || f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sync.busy]);

  const close = useCallback(() => {
    if (address) handled.current.add(address);
    setOpen(false);
  }, [address]);

  const dismiss = useCallback(() => {
    setDontAsk(dontAsk); // honor "don't ask again" even on a dismiss; leave the sync preference unchanged
    close();
  }, [dontAsk, close]);

  const enable = useCallback(async () => {
    setError(null);
    setDontAsk(dontAsk);
    try {
      await sync.enable();
      close();
    } catch {
      setError("Sync was not turned on. You can turn it on anytime from the wallet menu.");
    }
  }, [dontAsk, sync, close]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-5 backdrop-blur-sm"
      onClick={sync.busy ? undefined : dismiss}
      data-testid="sync-consent-backdrop"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        aria-busy={sync.busy}
        onClick={(e) => e.stopPropagation()}
        data-testid="sync-consent-dialog"
        className="w-full max-w-[480px] animate-fade-in rounded-xl border bg-card p-6 text-card-foreground shadow-xl"
      >
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
            <RefreshCw className="size-4.5" aria-hidden="true" />
          </span>
          <h2 id={titleId} className="text-base font-semibold tracking-tight" data-testid="sync-consent-title">
            Sync your rooms and access to other devices?
          </h2>
        </div>

        <p id={bodyId} className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Your "rooms you can open" list and your Bonded Access handle live in this browser only. Sync carries
          them to your other devices, encrypted with a key that only your wallet can derive.
        </p>
        <p role="note" className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
          Turning this on signs one fixed message to derive that key. It never moves funds and never approves a
          transaction. We store only the encrypted copy, which we cannot read and cannot link to your wallet.
        </p>

        <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={dontAsk}
            disabled={sync.busy}
            onChange={(e) => setDontAskState(e.target.checked)}
            data-testid="sync-consent-dontask"
            className="size-4 rounded border-input accent-primary"
          />
          Don't ask again on this device
        </label>

        {sync.busy && (
          <p
            className="mt-3 text-xs text-muted-foreground"
            aria-live="polite"
            data-testid="sync-consent-status"
          >
            Restoring your rooms and Bonded Access…
          </p>
        )}
        {error && (
          <p className="mt-3 text-xs leading-relaxed text-warning" role="alert" data-testid="sync-consent-error">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2.5">
          <Button
            ref={dismissRef}
            variant="outline"
            size="sm"
            onClick={dismiss}
            disabled={sync.busy}
            data-testid="sync-consent-dismiss"
          >
            Not now
          </Button>
          <Button size="sm" onClick={enable} disabled={sync.busy} data-testid="sync-consent-enable">
            {sync.busy ? "Restoring…" : "Turn on sync"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
