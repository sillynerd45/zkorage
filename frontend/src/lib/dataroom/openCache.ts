// In-memory cache of opened (decrypted) documents per (account, room), so opened docs survive a SUBMENU switch.
//
// The Documents panels (Open, My files) are conditionally rendered, so switching submenu unmounts them and
// their React state, including the decrypted content. Re-opening then re-fetches the key and re-decrypts (and on
// the member path, re-runs the gate). This cache lives at module scope, so the decrypted result + which rows are
// expanded are restored on remount. Decrypted plaintext is sensitive, so this is MEMORY-ONLY (never
// localStorage); a full page reload clears it.
//
// Keyed by OWNER (the connected wallet address) as well as room, so switching wallet accounts in the same
// browser never surfaces one account's decrypted documents (or last-viewed room) to another. Generic over the
// opened-result shape, so the member open (OpenedCommitteeDocument) and the owner open (OpenedDocument) reuse
// the same logic via separate instances.

export interface RoomOpenState<T> {
  /** docId (lowercased) -> the opened result. */
  opened: Record<string, T>;
  /** docIds (original case) whose rows are expanded in the UI. */
  expanded: string[];
}

export interface OpenCache<T> {
  get(owner: string, room: string): RoomOpenState<T>;
  setOpened(owner: string, room: string, opened: Record<string, T>): void;
  setExpanded(owner: string, room: string, expanded: string[]): void;
  /** The room this account last selected this session, so a remount can resume it. */
  getLastRoom(owner: string): string | null;
  setLastRoom(owner: string, room: string): void;
}

export function makeOpenCache<T>(): OpenCache<T> {
  const store = new Map<string, RoomOpenState<T>>(); // key = owner|room
  const lastRoom = new Map<string, string>(); // owner -> room
  const ownerKey = (owner: string) => (owner || "").trim();
  const key = (owner: string, room: string) => `${ownerKey(owner)}|${room.trim().toLowerCase()}`;
  const get = (owner: string, room: string): RoomOpenState<T> =>
    store.get(key(owner, room)) ?? { opened: {}, expanded: [] };
  return {
    get,
    setOpened(owner, room, opened) {
      const k = key(owner, room);
      store.set(k, { ...(store.get(k) ?? { opened: {}, expanded: [] }), opened });
    },
    setExpanded(owner, room, expanded) {
      const k = key(owner, room);
      store.set(k, { ...(store.get(k) ?? { opened: {}, expanded: [] }), expanded });
    },
    getLastRoom: (owner) => lastRoom.get(ownerKey(owner)) ?? null,
    setLastRoom(owner, room) {
      const r = room.trim();
      if (r) lastRoom.set(ownerKey(owner), r);
      else lastRoom.delete(ownerKey(owner));
    },
  };
}
