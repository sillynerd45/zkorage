// zkorage DR2 — per-room eligible-set store (off-chain). The DataRoom contract pins only the Merkle
// ROOT; the full ordered list of id_commitments lives here so the backend can (a) recompute the root to
// push on-chain and (b) build a member's Merkle witness. File-backed JSON (demo); in production this is a
// proper DB and members register only their public commitment (never the secrets).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_FILE = process.env.DR2_ELIGIBLE_FILE ||
  resolve(dirname(fileURLToPath(import.meta.url)), "../data/dr2-eligible.json");

/** Depth-20 eligible tree capacity (must match TREE_DEPTH in membership.ts / the guest). */
const MAX_MEMBERS = 1 << 20;

type Store = Record<string, string[]>; // roomIdHex -> [commitmentHex...]

// All access is synchronous fs (readFileSync/writeFileSync) inside synchronous route handlers, so a
// load→mutate→save sequence runs to completion with no await-interleaving on Node's single thread —
// i.e. it is effectively atomic against other requests. The remaining risk is a *torn file* if the
// process is killed mid-write; `save` writes to a temp file then `renameSync`s (atomic on the same
// volume) to eliminate that, and `load` FAILS LOUD on a corrupt file rather than silently returning {}
// (which would wipe every room's eligible set and, on the next set-root, revoke all grants).
function load(): Store {
  if (!existsSync(DATA_FILE)) return {};
  let raw: string;
  try {
    raw = readFileSync(DATA_FILE, "utf8");
  } catch (e) {
    throw new Error(`eligible-store: cannot read ${DATA_FILE}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Store;
  } catch {
    throw new Error(`eligible-store: ${DATA_FILE} is corrupt (invalid JSON) — refusing to proceed (a silent reset would revoke grants). Restore or remove it.`);
  }
}

function save(s: Store): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, DATA_FILE); // atomic on the same volume — no torn file if killed mid-write
}

/** The ordered list of commitment hexes for a room (empty if none). */
export function getEligible(roomIdHex: string): string[] {
  return load()[roomIdHex.toLowerCase()] ?? [];
}

/**
 * Append a commitment to a room's eligible set if not already present; returns its index (existing or new)
 * and whether it was newly added. Idempotent on a duplicate commitment.
 */
export function addEligible(roomIdHex: string, commitmentHex: string): { index: number; added: boolean; total: number } {
  const room = roomIdHex.toLowerCase();
  const c = commitmentHex.toLowerCase();
  const s = load();
  const list = s[room] ?? [];
  const existing = list.indexOf(c);
  if (existing >= 0) return { index: existing, added: false, total: list.length };
  // Bound the set to the depth-20 tree capacity — a member at index ≥ 2^20 has no valid Merkle path, so
  // reject at registration with a clear error rather than failing later at proof-build time.
  if (list.length >= MAX_MEMBERS) {
    throw new Error(`eligible set for room is full (max ${MAX_MEMBERS} members, the depth-20 tree capacity)`);
  }
  list.push(c);
  s[room] = list;
  save(s);
  return { index: list.length - 1, added: true, total: list.length };
}

/** The index of a commitment in a room's eligible set, or -1. */
export function indexOfCommitment(roomIdHex: string, commitmentHex: string): number {
  return getEligible(roomIdHex).indexOf(commitmentHex.toLowerCase());
}

/** Uniform Fisher-Yates shuffle (in place); the default new-batch ordering for addEligibleBatch. */
function fisherYates<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * M7 (timing defense #2) — append a BATCH of new commitments in RANDOMIZED order, in a single set-root.
 *
 * Why this is not theater: enrollment is identified (the owner approves each commitment, so they know
 * commitment -> wallet AND the order they approved). If every approval appended one leaf and re-pinned a new
 * root, each `eligible_root` would act as a fine-grained "enrolled-by" marker the owner could correlate with the
 * exact wallet they just approved, and early accessors would prove against smaller-set roots. Approving a BATCH
 * coarsens that: one root jump for the whole batch, so a grant only reveals "enrolled by batch B", not "after
 * member m". Shuffling the new leaves' order on top is defense-in-depth — the leaf index never appears on-chain
 * today (the depth-20 Merkle proof hides it and the witness length is fixed), so the shuffle costs nothing and
 * removes approval-order -> leaf-position coupling if the position ever became observable.
 *
 * EXISTING leaves keep their index (their witnesses stay valid); only the NEW commitments are shuffled, among
 * themselves, before being appended. Duplicates (already-eligible, or repeated in the input) are skipped.
 * `order` is injectable for deterministic tests (defaults to Fisher-Yates).
 */
export function addEligibleBatch(
  roomIdHex: string,
  commitmentHexes: string[],
  order: <T>(a: T[]) => T[] = (a) => fisherYates(a),
): { added: { commitment: string; index: number }[]; skipped: string[]; total: number } {
  const room = roomIdHex.toLowerCase();
  const s = load();
  const list = s[room] ?? [];
  const present = new Set(list);
  const fresh: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of commitmentHexes) {
    const c = raw.toLowerCase();
    if (present.has(c) || seen.has(c)) {
      skipped.push(c);
      continue;
    }
    seen.add(c);
    fresh.push(c);
  }
  if (list.length + fresh.length > MAX_MEMBERS) {
    throw new Error(`eligible set for room would exceed capacity (max ${MAX_MEMBERS} members, the depth-20 tree)`);
  }
  const shuffled = order([...fresh]);
  const added = shuffled.map((c) => {
    list.push(c);
    return { commitment: c, index: list.length - 1 };
  });
  s[room] = list;
  save(s);
  return { added, skipped, total: list.length };
}
