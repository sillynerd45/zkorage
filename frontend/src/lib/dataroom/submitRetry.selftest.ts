// Run: cd frontend && npx tsx src/lib/dataroom/submitRetry.selftest.ts
// Pure-logic checks for the "Record access on-chain" retry. No network, no React.
import {
  SUBMIT_ATTEMPTS,
  isTransientSubmitError,
  looksAlreadyRecorded,
  humanizeSubmitError,
  submitWithRetry,
} from "./submitRetry";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL ${label}`);
  }
}
async function check(label: string, fn: () => Promise<boolean>) {
  try {
    ok(label, await fn());
  } catch (e) {
    fail++;
    console.error(`FAIL ${label} (threw ${String((e as Error)?.message ?? e)})`);
  }
}

// ── isTransientSubmitError ──
ok("502 status string is transient", isTransientSubmitError("Request failed with status code 502"));
ok("503 is transient", isTransientSubmitError("Request failed with status code 503"));
ok("504 is transient", isTransientSubmitError("Request failed with status code 504"));
ok("bad gateway is transient", isTransientSubmitError("502 Bad Gateway"));
ok("timeout is transient", isTransientSubmitError("socket hang up / ETIMEDOUT"));
ok("failed to fetch is transient", isTransientSubmitError("TypeError: Failed to fetch"));
ok("html parse error is transient", isTransientSubmitError("Unexpected token '<' in JSON at position 0"));
ok("no message is transient (retry the unknown)", isTransientSubmitError(undefined));
ok("a rejected proof is NOT transient", !isTransientSubmitError("proof verification failed"));
ok("a contract reject is NOT transient", !isTransientSubmitError("Error(Contract, #7)"));
ok("the amount 5020 does not look like a 502", !isTransientSubmitError("amount 5020 too small"));

// ── looksAlreadyRecorded ──
ok("nullifier reuse looks already-recorded", looksAlreadyRecorded("nullifier already spent"));
ok("error #12 looks already-recorded", looksAlreadyRecorded("Error(Contract, #12)"));
ok("'already granted' looks already-recorded", looksAlreadyRecorded("access already granted"));
ok("a 502 does NOT look already-recorded", !looksAlreadyRecorded("Request failed with status code 502"));
ok("no message does NOT look already-recorded", !looksAlreadyRecorded(undefined));

// ── humanizeSubmitError ──
ok("502 humanized loses the code", !humanizeSubmitError("Request failed with status code 502").includes("502"));
ok("502 humanized is reassuring", humanizeSubmitError("Request failed with status code 502").includes("try again"));
ok("a real reason is kept", humanizeSubmitError("proof verification failed") === "proof verification failed");
ok("empty string is treated as a transient hiccup", humanizeSubmitError("").includes("brief hiccup"));
ok(
  "a non-transient blank reason falls back to a sentence",
  humanizeSubmitError("   ") === "We couldn't record your access on-chain. Please try again.",
);

// ── submitWithRetry ──
const NOWAIT = { backoffMs: () => 0 };

await check("succeeds on the first try, runs once", async () => {
  let calls = 0;
  const r = await submitWithRetry(async () => { calls++; return { ok: true, txHash: "h" }; }, NOWAIT);
  return r.ok && calls === 1;
});

await check("transient then success: retries, total attempts = 2", async () => {
  let calls = 0;
  let lastAttempt = 0;
  const r = await submitWithRetry(
    async () => {
      calls++;
      return calls < 2 ? { ok: false, error: "Request failed with status code 502" } : { ok: true };
    },
    { ...NOWAIT, onAttempt: (a) => { lastAttempt = a; } },
  );
  return r.ok && calls === 2 && lastAttempt === 2;
});

await check("transient every time: gives up after SUBMIT_ATTEMPTS, returns last error", async () => {
  let calls = 0;
  const r = await submitWithRetry(async () => { calls++; return { ok: false, error: "502 Bad Gateway" }; }, NOWAIT);
  return !r.ok && calls === SUBMIT_ATTEMPTS && r.error === "502 Bad Gateway";
});

await check("non-transient failure stops immediately (no wasted retries)", async () => {
  let calls = 0;
  const r = await submitWithRetry(async () => { calls++; return { ok: false, error: "proof verification failed" }; }, NOWAIT);
  return !r.ok && calls === 1;
});

await check("already-recorded short-circuits as a result to proceed on", async () => {
  let calls = 0;
  const r = await submitWithRetry(async () => { calls++; return { ok: false, error: "nullifier already spent" }; }, NOWAIT);
  return !r.ok && looksAlreadyRecorded(r.error) && calls === 1;
});

await check("a thrown transient error is caught and retried", async () => {
  let calls = 0;
  const r = await submitWithRetry(
    async () => { calls++; if (calls < 2) throw new Error("Failed to fetch"); return { ok: true }; },
    NOWAIT,
  );
  return r.ok && calls === 2;
});

await check("a thrown non-transient error stops immediately", async () => {
  let calls = 0;
  const r = await submitWithRetry(
    async () => { calls++; throw new Error("Error(Contract, #7)"); },
    NOWAIT,
  );
  return !r.ok && calls === 1 && (r.error ?? "").includes("#7");
});

await check("cancellation before a run does nothing", async () => {
  let calls = 0;
  const r = await submitWithRetry(
    async () => { calls++; return { ok: true }; },
    { ...NOWAIT, isCancelled: () => true },
  );
  return !r.ok && calls === 0;
});

await check("cancellation between attempts stops the retry loop", async () => {
  let calls = 0;
  let cancel = false;
  const r = await submitWithRetry(
    async () => { calls++; cancel = true; return { ok: false, error: "502" }; },
    { ...NOWAIT, isCancelled: () => cancel },
  );
  return !r.ok && calls === 1; // first run flips cancel; the loop top sees it and bails
});

console.log(`submitRetry selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
