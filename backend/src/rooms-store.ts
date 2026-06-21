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

// M5 discovery tiers (off-chain, NON-security). Anonymity + access control stay enforced by the membership
// proof + the k=5 floor + the keepers; visibility is only a discovery convenience, so it lives here (no
// contract change). Default = "private" (a room is unlisted/private unless the owner opts in).
//   private  -> reachable only by a link/id the owner hands out; reveals NOTHING to a browser by id.
//   unlisted -> resolvable by EXACT id (name/desc + a coarse count), but NOT in the public directory.
//   listed   -> shown in the public directory (opt-in), plus resolvable by id.
export type RoomVisibility = "private" | "unlisted" | "listed";

export interface RoomRecord {
  owner: string;
  label?: string;
  /** Discovery tier. Absent means "private" (the default). */
  visibility?: RoomVisibility;
  /** Opt-in PUBLIC-facing name (sanitized). Surfaced only when the room is discoverable (unlisted/listed).
   *  Hidden by default because a name alone can leak that a deal exists. */
  name?: string;
  /** Opt-in PUBLIC-facing description (sanitized). Same discoverability rule as `name`. */
  description?: string;
  /** Unix ms the room was first set to "listed" (directory sort key; newest first). */
  listedAt?: number;
}
type Store = Record<string, RoomRecord>; // roomIdHex -> { owner, label, visibility, name, description }

export const ROOM_NAME_MAX = 80;
export const ROOM_DESCRIPTION_MAX = 280;

// Coarse member-count buckets for discovery (the exact count never crosses the wire). Boundaries align to
// the k=5 anonymity floor + the M4 meter's amber(5)/green(20) thresholds. `forming` = below the floor.
export function memberBucket(n: number): string {
  if (n < 5) return "under 5";
  if (n < 20) return "5-19";
  if (n < 50) return "20-49";
  return "50+";
}
export function bucketTier(n: number): "forming" | "ok" | "strong" {
  if (n < 5) return "forming";
  if (n < 20) return "ok";
  return "strong";
}

/**
 * Sanitize an opt-in PUBLIC room name/description. This string is rendered to every directory visitor, so it
 * is the one attacker-controlled public surface and must be neutered for DISPLAY (React already blocks HTML):
 *   - C0 + DEL + C1 control chars -> space (C1 incl. U+0085 NEL, which `\s` does not match);
 *   - zero-width + bidi controls removed (U+202E RLO etc. can visually reverse adjacent text; zero-width
 *     chars defeat the eyeball-dedupe of two look-alike listings);
 *   - angle brackets removed (defense in depth);
 *   - whitespace collapsed, trimmed, length-capped.
 * Combining-mark ("Zalgo") spam is intentionally NOT stripped (removing combining marks would corrupt
 * legitimate non-Latin names); the length cap bounds its blast radius. Empty after sanitizing -> undefined.
 */
export function sanitizeRoomText(input: unknown, maxLen: number): string | undefined {
  if (typeof input !== "string") return undefined;
  const cleaned = input
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ") // C0 + DEL + C1 controls -> space
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "") // zero-width + bidi controls + ZWNBSP
    .replace(/[<>]/g, "") // no angle brackets
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
  return cleaned.length > 0 ? cleaned : undefined;
}

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
 *  AND any prior visibility/name/description/listedAt if a later call omits them (so create-room, which
 *  only knows owner+label, never clobbers a visibility the owner set later). */
export function recordRoom(roomIdHex: string, owner: string, label?: string): void {
  const room = roomIdHex.toLowerCase();
  const s = load();
  const prev = s[room];
  s[room] = {
    owner,
    label: label ?? prev?.label,
    visibility: prev?.visibility,
    name: prev?.name,
    description: prev?.description,
    listedAt: prev?.listedAt,
  };
  save(s);
}

/** The full record for one room (null if unknown). The reader still verifies ownership on-chain. */
export function getRoom(roomIdHex: string): RoomRecord | null {
  return load()[roomIdHex.toLowerCase()] ?? null;
}

/**
 * Set a room's discovery tier + opt-in public name/description. The CALLER must verify the room owner
 * on-chain first (this only writes the off-chain discovery flag; it is not a security boundary). `name`
 * and `description` are sanitized + length-capped here. `listedAt` is stamped the first time the room
 * becomes "listed" (and kept after) so the directory can sort newest-first.
 */
export function setRoomVisibility(
  roomIdHex: string,
  owner: string,
  patch: { visibility: RoomVisibility; name?: string; description?: string; nowMs: number },
): RoomRecord {
  const room = roomIdHex.toLowerCase();
  const s = load();
  const prev = s[room];
  const name = sanitizeRoomText(patch.name, ROOM_NAME_MAX);
  const description = sanitizeRoomText(patch.description, ROOM_DESCRIPTION_MAX);
  const listedAt =
    patch.visibility === "listed" ? (prev?.listedAt ?? patch.nowMs) : prev?.listedAt;
  const next: RoomRecord = {
    owner,
    label: prev?.label,
    visibility: patch.visibility,
    name,
    description,
    listedAt,
  };
  s[room] = next;
  save(s);
  return next;
}

/** Every known (roomId, owner, label). The enumeration index; ownership is verified on-chain by the caller. */
export function listRooms(): { roomId: string; owner: string; label?: string }[] {
  return Object.entries(load()).map(([roomId, r]) => ({ roomId, owner: r.owner, label: r.label }));
}

/** Known rooms whose RECORDED owner equals `owner` (still re-verify on-chain before trusting), including
 *  their off-chain discovery fields so the owner's UI can show the current visibility without an extra read. */
export function listRoomsByOwner(
  owner: string,
): { roomId: string; owner: string; label?: string; visibility?: RoomVisibility; name?: string; description?: string }[] {
  return Object.entries(load())
    .filter(([, r]) => r.owner === owner)
    .map(([roomId, r]) => ({
      roomId,
      owner: r.owner,
      label: r.label,
      visibility: r.visibility,
      name: r.name,
      description: r.description,
    }));
}

/** Rooms the owner opted into the public directory ("listed" only). Coarse counts are computed by the
 *  caller (the exact member count never crosses the wire for the directory). */
export function listListedRooms(): { roomId: string; owner: string; name?: string; description?: string; listedAt?: number }[] {
  return Object.entries(load())
    .filter(([, r]) => r.visibility === "listed")
    .map(([roomId, r]) => ({ roomId, owner: r.owner, name: r.name, description: r.description, listedAt: r.listedAt }));
}
