// Resilience for the "Record access on-chain" step of opening a room.
//
// That step posts a finished proof to the backend, which records it on Soroban. A momentarily unreachable RPC
// or tunnel can return a transient gateway error (a 502, say), which used to surface raw as
// "Request failed with status code 502" and forced a full, minutes-long re-prove via the "Try again" button.
// These helpers retry the submit itself a few times before giving up, and translate a failure into plain
// language a user can act on. Pure logic, no React, so it is unit-tested in submitRetry.selftest.ts.

export const SUBMIT_ATTEMPTS = 3;

/** A failure worth another go on its own: a gateway / network blip, not a rejected proof. An unknown failure
 *  (no message) is treated as transient too, since a bare network throw often carries none. The HTTP codes are
 *  matched only in an HTTP context ("status code 502", "HTTP 502"), never as a bare number, so a domain error
 *  that happens to contain "502" (e.g. "need 502 stroops") is not mistaken for a gateway blip. */
export function isTransientSubmitError(msg?: string): boolean {
  if (!msg) return true;
  const m = msg.toLowerCase();
  return (
    /(status code|http)\s*50[234]\b/.test(m) || // "request failed with status code 502", "HTTP 502"
    m.includes("bad gateway") ||
    m.includes("gateway timeout") ||
    m.includes("service unavailable") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("failed to fetch") ||
    m.includes("fetch failed") ||
    m.includes("network error") ||
    m.includes("networkerror") ||
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("etimedout") ||
    m.includes("socket hang up") ||
    m.includes("unexpected token") // an HTML error page parsed as JSON
  );
}

/** The grant already exists (this accessor's per-room nullifier is spent). That is a SUCCESS for opening: the
 *  access is on-chain, so we fetch the key rather than fail. It also makes a retry idempotent if a prior
 *  attempt's tx landed but its response was lost. Matches the gate's reused-nullifier error #12 (in any
 *  wrapping) and the explicit "already (spent|recorded|granted|...)" phrasings, but NOT a bare "already" (which
 *  could appear in an unrelated message like "transaction already submitted"). */
export function looksAlreadyRecorded(msg?: string): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return m.includes("nullifier") || m.includes("#12") || /already (spent|recorded|granted|admitted|exist)/.test(m);
}

/** Turn a raw submit failure into a sentence a user can act on, never a bare "status code 502". */
export function humanizeSubmitError(msg?: string): string {
  if (isTransientSubmitError(msg)) {
    return "We couldn't reach the network to record your access. This is usually a brief hiccup, so please try again in a moment.";
  }
  return msg && msg.trim() ? msg : "We couldn't record your access on-chain. Please try again.";
}

// Sleep, but wake early if cancelled, so teardown after the user navigates away mid-backoff is snappy.
async function cancellableSleep(ms: number, isCancelled: () => boolean): Promise<void> {
  const step = 250;
  for (let waited = 0; waited < ms; waited += step) {
    if (isCancelled()) return;
    await new Promise((res) => setTimeout(res, Math.min(step, ms - waited)));
  }
}

/** Run an on-chain submit with a few retries on transient failures (small backoff between tries). Stops early
 *  on a non-transient failure (it will not pass on a retry) or once the grant is recorded. Returns the last
 *  result either way; the caller decides success via `ok` / looksAlreadyRecorded. The returned value is either
 *  the real submit result `T` or, when every attempt failed (or the run was cancelled before any attempt), a
 *  minimal `{ ok: false, error? }` the caller reads the same way. */
export async function submitWithRetry<T extends { ok: boolean; error?: string }>(
  fn: () => Promise<T>,
  opts: {
    isCancelled?: () => boolean;
    onAttempt?: (attempt: number, total: number) => void;
    attempts?: number;
    /** Backoff before the next attempt; overridable so the selftest runs without real waits. */
    backoffMs?: (attempt: number) => number;
  } = {},
): Promise<T | { ok: false; error?: string }> {
  const total = opts.attempts ?? SUBMIT_ATTEMPTS;
  const isCancelled = opts.isCancelled ?? (() => false);
  const backoff = opts.backoffMs ?? ((attempt: number) => 1500 * attempt); // 1.5s, then 3s
  let last: { ok: false; error?: string } = { ok: false };
  for (let attempt = 1; attempt <= total; attempt++) {
    if (isCancelled()) return last;
    opts.onAttempt?.(attempt, total);
    try {
      const r = await fn();
      if (r.ok || looksAlreadyRecorded(r.error)) return r;
      last = { ok: false, error: r.error };
      if (!isTransientSubmitError(r.error)) return r;
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      if (looksAlreadyRecorded(error) || !isTransientSubmitError(error)) return { ok: false, error };
      last = { ok: false, error };
    }
    if (attempt < total) await cancellableSleep(backoff(attempt), isCancelled);
  }
  return last;
}
