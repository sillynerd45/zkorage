// zkorage Model B (M1) — per-room PENDING join requests (off-chain). A would-be member REQUESTS to join a
// room by submitting only their public id_commitment; the room owner later APPROVES, which moves the
// commitment into the eligible set (eligible-store.ts) and re-pins the on-chain root. This file holds only
// the pending queue (identified-join: the owner sees who they approve). File-backed JSON (demo); atomic
// write + fail-loud, mirroring eligible-store.ts. A pending request has NO on-chain effect until approval.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_FILE = process.env.DR2_ENROLL_FILE ||
  resolve(dirname(fileURLToPath(import.meta.url)), "../data/dr2-enroll.json");

export interface JoinRequest {
  /** The member's public id_commitment (hex, 32 bytes). The secrets stay client-side. */
  commitment: string;
  /** An optional human label the requester offers so the owner knows who to approve (identified-join). */
  label?: string;
  /** The requester's Stellar address, if they submitted one (identified-join; never required). */
  requester?: string;
  /** Unix ms when the request was filed. */
  ts: number;
}

type Store = Record<string, JoinRequest[]>; // roomIdHex -> pending requests

function load(): Store {
  if (!existsSync(DATA_FILE)) return {};
  let raw: string;
  try {
    raw = readFileSync(DATA_FILE, "utf8");
  } catch (e) {
    throw new Error(`enroll-store: cannot read ${DATA_FILE}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Store;
  } catch {
    throw new Error(`enroll-store: ${DATA_FILE} is corrupt (invalid JSON) — refusing to proceed. Restore or remove it.`);
  }
}

function save(s: Store): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, DATA_FILE); // atomic on the same volume
}

/** The pending requests for a room (empty if none). */
export function listRequests(roomIdHex: string): JoinRequest[] {
  return load()[roomIdHex.toLowerCase()] ?? [];
}

/** True if a commitment already has a pending request in this room. */
export function hasRequest(roomIdHex: string, commitmentHex: string): boolean {
  const c = commitmentHex.toLowerCase();
  return listRequests(roomIdHex).some((r) => r.commitment === c);
}

/**
 * File a pending join request. Idempotent on the commitment (a repeat request refreshes the label/requester
 * but does not duplicate the queue entry). Returns whether a NEW entry was added.
 */
export function addRequest(
  roomIdHex: string,
  req: { commitment: string; label?: string; requester?: string; ts: number },
): { added: boolean } {
  const room = roomIdHex.toLowerCase();
  const c = req.commitment.toLowerCase();
  const s = load();
  const list = s[room] ?? [];
  const existing = list.find((r) => r.commitment === c);
  if (existing) {
    existing.label = req.label ?? existing.label;
    existing.requester = req.requester ?? existing.requester;
    s[room] = list;
    save(s);
    return { added: false };
  }
  list.push({ commitment: c, label: req.label, requester: req.requester, ts: req.ts });
  s[room] = list;
  save(s);
  return { added: true };
}

/** Remove a pending request (on approve or reject). Returns whether one was removed. */
export function removeRequest(roomIdHex: string, commitmentHex: string): boolean {
  const room = roomIdHex.toLowerCase();
  const c = commitmentHex.toLowerCase();
  const s = load();
  const list = s[room] ?? [];
  const next = list.filter((r) => r.commitment !== c);
  if (next.length === list.length) return false;
  s[room] = next;
  save(s);
  return true;
}
