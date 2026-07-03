import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, Cloud, ShieldCheck, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/wallet/WalletContext";
import { getSyncPref, hasSyncPref, isDontAsk, isNoPrompt, setDontAsk } from "@/lib/sync/prefs";
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
  // Latest checkbox value, read by the stable dismiss/enable handlers so toggling it never re-runs the focus
  // trap effect (which would steal focus back to the dismiss button on every keystroke).
  const dontAskRef = useRef(false);
  dontAskRef.current = dontAsk;
  // Read busy through a ref so the focus-trap effect runs once per open (keying it on sync.busy would tear down
  // and rebuild the trap when signing starts, dropping focus to the background while the buttons are disabled).
  const busyRef = useRef(false);
  busyRef.current = sync.busy;

  const dismissRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  // Decide what to do when a wallet connects or the account changes. Consent is PER WALLET: a wallet with a
  // saved choice is applied silently, a wallet with NONE is asked. Skip the dialog only when this device hard
  // opted out (noPrompt, not set by the UI), OR the user ticked "don't ask again" AND this wallet already has a
  // saved choice. So switching to a fresh wallet (no saved choice) still prompts, even on a "don't ask again"
  // device, instead of silently leaving sync off, which is the reported bug.
  useEffect(() => {
    if (!connected || !address) return;
    if (handled.current.has(address)) return;
    if (isNoPrompt() || (isDontAsk() && hasSyncPref(address))) {
      // Apply this wallet's saved choice silently. If sync is on for it, take the one signature now (the
      // "sign on connect" expectation); otherwise stay local.
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
      if (busyRef.current) return; // do not let Escape close mid-signature
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
  }, [open]);

  const close = useCallback(() => {
    if (address) handled.current.add(address);
    setOpen(false);
  }, [address]);

  const dismiss = useCallback(() => {
    // "Don't ask again on this device" means the standing answer is always "Turn on sync", so a dismiss is not
    // available while it is ticked (the button is disabled, and a backdrop click / Escape are no-ops). The user
    // unticks to get "Not now" back. An unticked dismiss is a one-time skip, so we keep asking on the next connect.
    if (dontAskRef.current) return;
    setDontAsk(false);
    close();
  }, [close]);

  const enable = useCallback(async () => {
    setError(null);
    setDontAsk(dontAskRef.current);
    try {
      await sync.enable();
      close();
    } catch {
      setError("Sync was not turned on. You can turn it on anytime from the wallet menu.");
    }
  }, [sync, close]);

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
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
            <RefreshCw className="size-5" aria-hidden="true" />
          </span>
          <h2 id={titleId} className="text-base font-semibold tracking-tight" data-testid="sync-consent-title">
            Sync across your devices?
          </h2>
        </div>

        <p id={bodyId} className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Keep your rooms and Bonded Access on every device you use.
        </p>

        <ul className="mt-4 space-y-1 rounded-lg border bg-muted/30 p-2" data-testid="sync-consent-points">
          <li
            className="flex items-center gap-3 rounded-md px-2 py-2"
            data-testid="sync-consent-point-devices"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Cloud className="size-4" aria-hidden="true" />
            </span>
            <span className="text-sm leading-snug text-card-foreground">
              Your rooms and Bonded Access, on every device
            </span>
          </li>
          <li
            className="flex items-center gap-3 rounded-md px-2 py-2"
            data-testid="sync-consent-point-encrypted"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <ShieldCheck className="size-4" aria-hidden="true" />
            </span>
            <span className="text-sm leading-snug text-card-foreground">
              Encrypted with your wallet, we cannot read it
            </span>
          </li>
          <li
            className="flex items-center gap-3 rounded-md px-2 py-2"
            data-testid="sync-consent-point-signature"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <KeyRound className="size-4" aria-hidden="true" />
            </span>
            <span className="text-sm leading-snug text-card-foreground">
              One signature, no funds move
            </span>
          </li>
        </ul>

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
        {dontAsk && (
          <p className="mt-1.5 text-xs text-muted-foreground" data-testid="sync-consent-dontask-note">
            With this ticked, sync stays on, so "Not now" is unavailable.
          </p>
        )}

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
            disabled={sync.busy || dontAsk}
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
