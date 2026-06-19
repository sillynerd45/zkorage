// zkorage — off-chain ROOM registry (an enumeration index only). The DataRoom contract keys rooms by
// room_id and exposes only a RoomCount, with no "list rooms" read, so to answer "which rooms does this
// owner own?" we keep a small index of room_id -> { owner, label } here. Ownership is AUTHORITATIVE
// on-chain (get_room.owner); this file is only the set of room_ids worth checking, so a stale entry (a
// create that was never submitted) is harmless: the reader re-verifies the owner on-chain and drops it.
// File-backed JSON (demo); a real DB in production. Mirrors eligible-store's atomic-write + fail-loud.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_FILE = process.env.DATAROOM_ROOMS_FILE ||
  resolve(dirname(fileURLToPath(import.meta.url)), "../data/dataroom-rooms.json");

export interface RoomRecord {
  owner: string;
  label?: string;
}
type Store = Record<string, RoomRecord>; // roomIdHex -> { owner, label }

function load(): Store {
  if (!existsSync(DATA_FILE)) return {};
  let raw: string;
  try {
    raw = readFileSync(DATA_FILE, "utf8");
  } catch (e) {
    throw new Error(`rooms-store: cannot read ${DATA_FILE}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Store;
  } catch {
    throw new Error(`rooms-store: ${DATA_FILE} is corrupt (invalid JSON) — refusing to proceed. Restore or remove it.`);
  }
}

function save(s: Store): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, DATA_FILE); // atomic on the same volume — no torn file if killed mid-write
}

/** Record (or refresh) a room's owner + label in the enumeration index. Idempotent; keeps a prior label
 *  if a later call omits one. */
export function recordRoom(roomIdHex: string, owner: string, label?: string): void {
  const room = roomIdHex.toLowerCase();
  const s = load();
  const prev = s[room];
  s[room] = { owner, label: label ?? prev?.label };
  save(s);
}

/** Every known (roomId, owner, label). The enumeration index; ownership is verified on-chain by the caller. */
export function listRooms(): { roomId: string; owner: string; label?: string }[] {
  return Object.entries(load()).map(([roomId, r]) => ({ roomId, owner: r.owner, label: r.label }));
}

/** Known rooms whose RECORDED owner equals `owner` (still re-verify on-chain before trusting). */
export function listRoomsByOwner(owner: string): { roomId: string; owner: string; label?: string }[] {
  return listRooms().filter((r) => r.owner === owner);
}
