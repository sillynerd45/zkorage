// zkorage Model B (M7) — the access-batching queue (the load-bearing timing defense).
//
// The owner-roster timing side channel: a room owner holds the enrollment roster (wallet -> id_commitment ->
// approval order) and reads the public chain. Submitting request_access the instant a member proves makes the
// on-chain Grant's `timestamp` + append `index` track the member's action, so the owner can re-link the
// pseudonymous accessor to a wallet by TIMING + ORDER (the mixer-deanon). A naive fixed delay only SHIFTS that
// timestamp by a constant, so it decorrelates nothing (the trap M4 refused).
//
// The real fix (mixnet-shaped): members hand their already-proven, self-authenticating bundle to this relay
// instead of submitting it themselves. The relay holds bundles and FLUSHES them at fixed wall-clock window
// boundaries (epoch-aligned, arrival-INDEPENDENT), in SHUFFLED order. Because the backend relays every
// request_access through ONE source account serially, the submission order is the on-chain grant-index order,
// so shuffling the flush genuinely decouples both the timestamp (bins to the window) and the order from the
// member's action. The relay learns nothing it could use to deanonymize: the bundle's journal carries only the
// per-room accessor/nullifier/eligible_root pseudonyms (never the wallet), so only the owner's roster could try
// to re-link, and that is exactly the timing/order link this breaks.
//
// HONEST residuals (stated in the UI copy, not hidden): cover scales with CONCURRENT traffic (a window holding
// one access has a cover set of one); statistical disclosure over many windows erodes anonymity (inherent to
// mixnets); and this defeats the OWNER (chain-reader + roster-holder), not our own backend operator (a
// separate-operator relay is the documented hardening). File-backed JSON (demo); atomic write + fail-loud,
// mirroring eligible-store / enroll-store. Entries persist across a restart, so a crash mid-window does not
// drop a member's queued access (the next boundary flushes it).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const DATA_FILE = process.env.DR_BATCH_FILE ||
  resolve(dirname(fileURLToPath(import.meta.url)), "../data/dr-batch-queue.json");

/** The self-authenticating membership proof a member hands to the relay (raw bytes, hex). */
export interface QueuedBundle {
  seal: string;
  image_id: string;
  journal: string;
}

export type BatchStatus = "queued" | "submitted" | "error";

export interface BatchEntry {
  /** Opaque handle the member polls (random, unlinkable to the wallet). */
  ticket: string;
  roomId: string;
  /** The per-room pseudonyms (for status display + dedup only; both are already public on-chain once landed). */
  accessor: string;
  nullifier: string;
  bundle: QueuedBundle;
  enqueuedAt: number;
  status: BatchStatus;
  /** The window boundary this entry was (or will be) flushed at. */
  flushAt: number;
  txHash?: string;
  error?: string;
  submittedAt?: number;
}

type Store = Record<string, BatchEntry>; // ticket -> entry

function load(): Store {
  if (!existsSync(DATA_FILE)) return {};
  let raw: string;
  try {
    raw = readFileSync(DATA_FILE, "utf8");
  } catch (e) {
    throw new Error(`batch-queue-store: cannot read ${DATA_FILE}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Store;
  } catch {
    throw new Error(`batch-queue-store: ${DATA_FILE} is corrupt (invalid JSON) — refusing to proceed. Restore or remove it.`);
  }
}

function save(s: Store): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, DATA_FILE); // atomic on the same volume — no torn file if killed mid-write
}

/** The next epoch-aligned flush boundary STRICTLY after `now`. Arrival-independent: every caller in the same
 *  window sees the same boundary, so the on-chain time of a flushed batch reveals the window, not the arrival. */
export function nextFlushAt(now: number, windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("windowMs must be a positive number");
  return (Math.floor(now / windowMs) + 1) * windowMs;
}

/** Find a still-queued entry for this (room, nullifier), so a member who re-submits the same access is not
 *  double-queued (the second submit would only burn into #NullifierUsed on-chain anyway). */
export function findQueuedByNullifier(roomIdHex: string, nullifierHex: string): BatchEntry | null {
  const room = roomIdHex.toLowerCase();
  const nf = nullifierHex.toLowerCase();
  for (const e of Object.values(load())) {
    if (e.status === "queued" && e.roomId === room && e.nullifier === nf) return e;
  }
  return null;
}

/** Enqueue a proven bundle for the next flush. Idempotent on (room, nullifier) while still queued: returns the
 *  existing ticket rather than a duplicate. */
export function enqueue(args: {
  roomId: string;
  accessor: string;
  nullifier: string;
  bundle: QueuedBundle;
  now: number;
  windowMs: number;
}): BatchEntry {
  const room = args.roomId.toLowerCase();
  const nf = args.nullifier.toLowerCase();
  const dup = findQueuedByNullifier(room, nf);
  if (dup) return dup;
  const entry: BatchEntry = {
    ticket: randomBytes(16).toString("hex"),
    roomId: room,
    accessor: args.accessor.toLowerCase(),
    nullifier: nf,
    bundle: args.bundle,
    enqueuedAt: args.now,
    status: "queued",
    flushAt: nextFlushAt(args.now, args.windowMs),
  };
  const s = load();
  s[entry.ticket] = entry;
  save(s);
  return entry;
}

export function getByTicket(ticket: string): BatchEntry | null {
  return load()[ticket] ?? null;
}

/** Every currently-queued entry (across all rooms), oldest-enqueued first. */
export function listQueued(): BatchEntry[] {
  return Object.values(load())
    .filter((e) => e.status === "queued")
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

/** The number of still-queued entries (across all rooms) — used to cap the queue against griefing. */
export function queuedCount(): number {
  let n = 0;
  for (const e of Object.values(load())) if (e.status === "queued") n++;
  return n;
}

/** Drop terminal (submitted/error) entries older than `olderThanMs`, so the store file stays bounded. A member
 *  polls their ticket only until it is submitted, so terminal entries are safe to age out. Returns how many. */
export function purgeTerminal(olderThanMs: number, now: number): number {
  const s = load();
  let removed = 0;
  for (const [t, e] of Object.entries(s)) {
    if (e.status !== "queued" && typeof e.submittedAt === "number" && now - e.submittedAt > olderThanMs) {
      delete s[t];
      removed++;
    }
  }
  if (removed) save(s);
  return removed;
}

/** Record a submission outcome for one ticket. Re-loads so a concurrent enqueue is never clobbered. */
export function markResult(ticket: string, r: { status: BatchStatus; txHash?: string; error?: string; at: number }): void {
  const s = load();
  const e = s[ticket];
  if (!e) return;
  e.status = r.status;
  e.txHash = r.txHash;
  e.error = r.error;
  e.submittedAt = r.at;
  save(s);
}

/** A uniform Fisher-Yates shuffle (in place) — the default flush ordering. The shuffle is the whole point: it
 *  is what makes the on-chain grant ORDER independent of the member arrival order. */
export function fisherYates<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Flush the queue: take every currently-queued entry, SHUFFLE it, and submit each bundle in shuffled order via
 * the injected `submit` (in production = invokeContract(request_access); in tests = a stub that records order).
 * Submission is SEQUENTIAL because the relay uses one source account (serial sequence numbers), so the on-chain
 * grant-index order equals the shuffled order. A single bundle failing (e.g. #NullifierUsed, or a rotated root)
 * is recorded per-ticket and never blocks the rest of the batch. Returns a summary for logging/self-test.
 */
export async function flush(opts: {
  submit: (bundle: QueuedBundle, entry: BatchEntry) => Promise<{ txHash: string }>;
  now: number;
  shuffle?: <T>(arr: T[]) => T[];
}): Promise<{ flushed: number; submitted: number; failed: number; order: string[] }> {
  const shuffle = opts.shuffle ?? ((a) => fisherYates(a));
  const batch = shuffle(listQueued());
  const order: string[] = [];
  let submitted = 0;
  let failed = 0;
  for (const entry of batch) {
    order.push(entry.ticket);
    try {
      const { txHash } = await opts.submit(entry.bundle, entry);
      markResult(entry.ticket, { status: "submitted", txHash, at: opts.now });
      submitted++;
    } catch (e) {
      markResult(entry.ticket, { status: "error", error: (e as Error).message, at: opts.now });
      failed++;
    }
  }
  return { flushed: batch.length, submitted, failed, order };
}
