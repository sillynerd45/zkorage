// Resilience for the "Record access on-chain" step of opening a room.
//
// That step posts a finished proof to the backend, which records it on Soroban. A momentarily unreachable RPC
// or tunnel can return a transient gateway error (a 502, say), which used to surface raw as
// "Request failed with status code 502" and forced a full, minutes-long re-prove via the "Try again" button.
// These helpers retry the submit itself a few times before giving up, and translate a failure into plain
// language a user can act on. Pure logic, no React, so it is unit-tested in submitRetry.selftest.ts.

export const SUBMIT_ATTEMPTS = 3;

/** A failure worth another go on its own: a gateway / network blip, not a rejected proof. An unknown failure
 *  (no message) is treated as transient too, since a bare network throw often carries none. */
export function isTransientSubmitError(msg?: string): boolean {
  if (!msg) return true;
  const m = msg.toLowerCase();
  return (
    /\b50[0234]\b/.test(m) || // 500 / 502 / 503 / 504, incl. "status code 502"
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
 *  attempt's tx landed but its response was lost. */
export function looksAlreadyRecorded(msg?: string): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return m.includes("nullifier") || m.includes("already") || /\b#12\b/.test(m) || m.includes("error(contract, #12)");
}

/** Turn a raw submit failure into a sentence a user can act on, never a bare "status code 502". */
export function humanizeSubmitError(msg?: string): string {
  if (isTransientSubmitError(msg)) {
    return "We couldn't reach the network to record your access. This is usually a brief hiccup, so please try again in a moment.";
  }
  return msg && msg.trim() ? msg : "We couldn't record your access on-chain. Please try again.";
}

/** Run an on-chain submit with a few retries on transient failures (small backoff between tries). Stops early
 *  on a non-transient failure (it will not pass on a retry) or once the grant is recorded. Returns the last
 *  result either way; the caller decides success via `ok` / looksAlreadyRecorded. */
export async function submitWithRetry<T extends { ok: boolean; error?: string }>(
  fn: () => Promise<T>,
  opts: {
    isCancelled?: () => boolean;
    onAttempt?: (attempt: number, total: number) => void;
    attempts?: number;
    /** Backoff before the next attempt; overridable so the selftest runs without real waits. */
    backoffMs?: (attempt: number) => number;
  } = {},
): Promise<T> {
  const total = opts.attempts ?? SUBMIT_ATTEMPTS;
  const isCancelled = opts.isCancelled ?? (() => false);
  const backoff = opts.backoffMs ?? ((attempt: number) => 1500 * attempt); // 1.5s, then 3s
  let last = { ok: false } as T;
  for (let attempt = 1; attempt <= total; attempt++) {
    if (isCancelled()) return last;
    opts.onAttempt?.(attempt, total);
    try {
      const r = await fn();
      if (r.ok || looksAlreadyRecorded(r.error)) return r;
      last = r;
      if (!isTransientSubmitError(r.error)) return r;
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      last = { ok: false, error } as T;
      if (looksAlreadyRecorded(error) || !isTransientSubmitError(error)) return last;
    }
    if (attempt < total && !isCancelled()) {
      await new Promise((res) => setTimeout(res, backoff(attempt)));
    }
  }
  return last;
}
