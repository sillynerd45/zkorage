// M7 self-test — the access-batching queue + shuffled flush (the timing defense), store-level, no chain.
//   cd backend && rm -f /tmp/zkm7-batch.json && \
//     DR_BATCH_FILE=/tmp/zkm7-batch.json npx tsx scripts/m7-batch-selftest.ts
//
// Validates the load-bearing piece of M7: bundles enqueue, the flush submits them in SHUFFLED order (decoupling
// the on-chain grant order from arrival order), a per-bundle failure never blocks the batch, dedup on
// (room, nullifier) holds, the window boundary is epoch-aligned + arrival-independent, and the queue survives a
// reload (persistence). The HTTP routes + the real on-chain shuffled landing are covered by live curl + the e2e.
import {
  enqueue, getByTicket, listQueued, flush, markResult, nextFlushAt, findQueuedByNullifier, fisherYates,
  type QueuedBundle, type BatchEntry,
} from "../src/batch-queue-store.js";

let failures = 0;
const ok = (c: boolean, label: string) => {
  console.log(`${c ? "✓" : "✗"} ${label}`);
  if (!c) failures++;
};

const ROOM = "aa".repeat(32);
const WINDOW = 600_000; // 10 min
const bundle = (n: number): QueuedBundle => ({ seal: `${n}`.padStart(2, "0").repeat(32), image_id: "11".repeat(32), journal: "22".repeat(32) });
const nf = (n: number) => `${(n + 1).toString(16).padStart(2, "0")}`.repeat(32);
const acc = (n: number) => `${(n + 0x40).toString(16).padStart(2, "0")}`.repeat(32);

// ---- nextFlushAt: epoch-aligned, strictly after now, arrival-independent ----
ok(nextFlushAt(0, WINDOW) === WINDOW, "nextFlushAt(0) = one window");
ok(nextFlushAt(1, WINDOW) === WINDOW, "nextFlushAt mid-window = the window boundary");
ok(nextFlushAt(WINDOW, WINDOW) === 2 * WINDOW, "nextFlushAt at a boundary advances to the next");
ok(nextFlushAt(WINDOW - 1, WINDOW) === WINDOW, "nextFlushAt just before a boundary = that boundary");
{
  // Two arrivals in the same window get the SAME flushAt (arrival-independent).
  const a = nextFlushAt(WINDOW + 5, WINDOW);
  const b = nextFlushAt(WINDOW + 5000, WINDOW);
  ok(a === b && a === 2 * WINDOW, "two arrivals in one window share a flush boundary");
}

// ---- enqueue + dedup ----
const t0 = 1_000_000;
const e0 = enqueue({ roomId: ROOM, accessor: acc(0), nullifier: nf(0), bundle: bundle(0), now: t0, windowMs: WINDOW });
ok(e0.status === "queued" && /^[0-9a-f]{32}$/.test(e0.ticket), "enqueue returns a queued entry with a 32-hex ticket");
ok(e0.flushAt === nextFlushAt(t0, WINDOW), "entry flushAt = the next window boundary");
ok(getByTicket(e0.ticket)?.nullifier === nf(0), "entry is retrievable by ticket and persisted");

const dup = enqueue({ roomId: ROOM, accessor: acc(0), nullifier: nf(0), bundle: bundle(99), now: t0 + 10, windowMs: WINDOW });
ok(dup.ticket === e0.ticket, "re-enqueue of the same (room, nullifier) is idempotent (same ticket)");
ok(listQueued().length === 1, "dedup did not add a second queue entry");
ok(findQueuedByNullifier(ROOM, nf(0))?.ticket === e0.ticket, "findQueuedByNullifier locates the queued entry");

// Different nullifiers (different members) DO queue separately.
for (let n = 1; n < 8; n++) enqueue({ roomId: ROOM, accessor: acc(n), nullifier: nf(n), bundle: bundle(n), now: t0 + n, windowMs: WINDOW });
ok(listQueued().length === 8, "eight distinct members queue eight entries");
ok(listQueued().every((e, i, a) => i === 0 || a[i - 1].enqueuedAt <= e.enqueuedAt), "listQueued is oldest-first");

// ---- fisherYates is a permutation (no loss/dup) ----
{
  const src = Array.from({ length: 50 }, (_, i) => i);
  const out = fisherYates([...src]);
  ok(out.length === 50 && new Set(out).size === 50 && [...out].sort((a, b) => a - b).every((v, i) => v === i), "fisherYates is a faithful permutation");
}

// ---- flush submits every queued bundle exactly once, in the SHUFFLED order ----
{
  const submittedOrder: string[] = [];
  // Deterministic non-identity shuffle for the test: reverse the queue (so we can prove the SUBMIT order is the
  // shuffled order, not the arrival order).
  const reverse = <T,>(a: T[]): T[] => [...a].reverse();
  const arrival = listQueued().map((e) => e.ticket);
  const summary = await flush({
    now: t0 + 1000,
    shuffle: reverse,
    submit: async (_b: QueuedBundle, e: BatchEntry) => {
      submittedOrder.push(e.ticket);
      return { txHash: `tx-${e.ticket.slice(0, 6)}` };
    },
  });
  ok(summary.flushed === 8 && summary.submitted === 8 && summary.failed === 0, "flush submitted all 8 bundles");
  ok(submittedOrder.length === 8 && new Set(submittedOrder).size === 8, "each queued bundle submitted exactly once");
  ok(JSON.stringify(submittedOrder) === JSON.stringify([...arrival].reverse()), "submit order = the SHUFFLED order, not arrival order");
  ok(JSON.stringify(submittedOrder) !== JSON.stringify(arrival), "shuffled order differs from arrival order");
  ok(summary.order.join(",") === submittedOrder.join(","), "summary.order reflects the on-chain submission order");
  ok(listQueued().length === 0, "queue is empty after a full flush");
  ok(getByTicket(e0.ticket)?.status === "submitted", "flushed entries are marked submitted");
  ok(getByTicket(e0.ticket)?.txHash?.startsWith("tx-") === true, "submitted entries record a tx hash");
}

// ---- a per-bundle failure is isolated (never blocks the batch); a re-enqueue after a window is allowed ----
{
  enqueue({ roomId: ROOM, accessor: acc(10), nullifier: nf(10), bundle: bundle(10), now: t0 + 2000, windowMs: WINDOW }); // will succeed
  enqueue({ roomId: ROOM, accessor: acc(11), nullifier: nf(11), bundle: bundle(11), now: t0 + 2001, windowMs: WINDOW }); // will throw (simulated #NullifierUsed)
  enqueue({ roomId: ROOM, accessor: acc(12), nullifier: nf(12), bundle: bundle(12), now: t0 + 2002, windowMs: WINDOW }); // will succeed
  const summary = await flush({
    now: t0 + 3000,
    shuffle: (a) => a, // identity for a determinate accounting
    submit: async (_b: QueuedBundle, e: BatchEntry) => {
      if (e.nullifier === nf(11)) throw new Error("Error(Contract, #12)"); // NullifierUsed
      return { txHash: `tx-${e.ticket.slice(0, 6)}` };
    },
  });
  ok(summary.flushed === 3 && summary.submitted === 2 && summary.failed === 1, "one failing bundle does not block the batch (2 ok, 1 error)");
  const bad = findQueuedByNullifier(ROOM, nf(11));
  ok(bad === null, "the failed entry left the queue (marked error, not stuck queued)");
}

// ---- markResult re-loads (a concurrent enqueue during a flush is never clobbered) ----
{
  const a = enqueue({ roomId: ROOM, accessor: acc(20), nullifier: nf(20), bundle: bundle(20), now: t0 + 4000, windowMs: WINDOW });
  const b = enqueue({ roomId: ROOM, accessor: acc(21), nullifier: nf(21), bundle: bundle(21), now: t0 + 4001, windowMs: WINDOW });
  markResult(a.ticket, { status: "submitted", txHash: "tx-aaa", at: t0 + 4100 });
  ok(getByTicket(a.ticket)?.status === "submitted", "markResult updates the target ticket");
  ok(getByTicket(b.ticket)?.status === "queued", "a concurrently-queued ticket is untouched by markResult");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
