import { useCallback, useEffect, useState } from "react";
import { getDirectory, getRoomMeta, type DirectoryRoom, type RoomMeta } from "@/lib/api";
import { isHex32 } from "@/lib/format";

// M5 — the public discovery surface (wallet not required). Two reads:
//   - the directory: rooms whose owner opted into "listed", with coarse member buckets (never exact).
//   - resolve-by-id: paste an exact room id; a private room reveals nothing, an unlisted/listed one resolves.
// Visibility is a discovery convenience, not the privacy mechanism (that is the membership proof + the k=5
// floor + the keepers), so nothing here is wallet-gated or trust-bearing.

// Module-level cache (mirrors the My files / Room Management pattern): the last-loaded directory survives an
// unmount within one app session, so navigating away and back repaints instantly instead of flashing a cold
// load, then a background refresh swaps in fresh data. Cleared on a full page reload. Public data, no secrets.
let directoryCache: DirectoryRoom[] | null = null;

export function useDirectory() {
  // Seed from the cache for an instant warm paint; cold (no cache yet) starts empty + loading.
  const [rooms, setRooms] = useState<DirectoryRoom[]>(directoryCache ?? []);
  const [loading, setLoading] = useState(directoryCache === null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataroomId, setDataroomId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const warm = directoryCache !== null;
    if (warm) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const r = await getDirectory();
      directoryCache = r.rooms;
      setRooms(r.rooms);
      setDataroomId(r.dataroomId ?? null);
    } catch (e) {
      // On a warm background refresh, keep the cached list painted and stay silent; only surface the error on a
      // cold load (nothing to show otherwise).
      if (!warm) setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // --- resolve a room by exact id ---
  const [lookupId, setLookupId] = useState("");
  const [lookupResult, setLookupResult] = useState<RoomMeta | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupErr, setLookupErr] = useState<string | null>(null);

  const resolve = useCallback(async () => {
    setLookupErr(null);
    setLookupResult(null);
    const id = lookupId.trim();
    if (!isHex32(id)) {
      setLookupErr("Room id must be 32-byte hex (64 hex chars).");
      return;
    }
    setLookupBusy(true);
    try {
      setLookupResult(await getRoomMeta(id));
    } catch (e) {
      setLookupErr(String((e as Error).message ?? e));
    } finally {
      setLookupBusy(false);
    }
  }, [lookupId]);

  return {
    rooms,
    loading,
    refreshing,
    error,
    dataroomId,
    reload,
    lookupId,
    setLookupId,
    lookupResult,
    lookupBusy,
    lookupErr,
    resolve,
  };
}
