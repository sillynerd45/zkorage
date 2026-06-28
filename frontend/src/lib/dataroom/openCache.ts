// In-memory cache of opened (decrypted) documents per room, so opened docs survive a SUBMENU switch.
//
// The Documents panels (Open, My files) are conditionally rendered, so switching submenu unmounts them and
// their React state, including the decrypted content. Re-opening then re-fetches the key and re-decrypts (and on
// the member path, re-runs the gate). This cache lives at module scope, so the decrypted result + which rows are
// expanded are restored on remount. Decrypted plaintext is sensitive, so this is MEMORY-ONLY (never
// localStorage); a full page reload clears it.
//
// Generic over the opened-result shape, so the member open (OpenedCommitteeDocument) and the owner open
// (OpenedDocument) reuse the same logic via separate instances.

export interface RoomOpenState<T> {
  /** docId (lowercased) -> the opened result. */
  opened: Record<string, T>;
  /** docIds (original case) whose rows are expanded in the UI. */
  expanded: string[];
}

export interface OpenCache<T> {
  get(room: string): RoomOpenState<T>;
  setOpened(room: string, opened: Record<string, T>): void;
  setExpanded(room: string, expanded: string[]): void;
  /** The room the user last selected this session, so a remount can resume it. */
  getLastRoom(): string | null;
  setLastRoom(room: string): void;
}

export function makeOpenCache<T>(): OpenCache<T> {
  const store = new Map<string, RoomOpenState<T>>();
  let lastRoom: string | null = null;
  const norm = (room: string) => room.trim().toLowerCase();
  const get = (room: string): RoomOpenState<T> => store.get(norm(room)) ?? { opened: {}, expanded: [] };
  return {
    get,
    setOpened(room, opened) {
      const k = norm(room);
      store.set(k, { ...(store.get(k) ?? { opened: {}, expanded: [] }), opened });
    },
    setExpanded(room, expanded) {
      const k = norm(room);
      store.set(k, { ...(store.get(k) ?? { opened: {}, expanded: [] }), expanded });
    },
    getLastRoom: () => lastRoom,
    setLastRoom(room) {
      lastRoom = room.trim() || null;
    },
  };
}
