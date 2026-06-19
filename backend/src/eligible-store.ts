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
