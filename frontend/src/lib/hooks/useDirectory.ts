import { useCallback, useEffect, useState } from "react";
import { getDirectory, getRoomMeta, type DirectoryRoom, type RoomMeta } from "@/lib/api";
import { isHex32 } from "@/lib/format";

// M5 — the public discovery surface (wallet not required). Two reads:
//   - the directory: rooms whose owner opted into "listed", with coarse member buckets (never exact).
//   - resolve-by-id: paste an exact room id; a private room reveals nothing, an unlisted/listed one resolves.
// Visibility is a discovery convenience, not the privacy mechanism (that is the membership proof + the k=5
// floor + the keepers), so nothing here is wallet-gated or trust-bearing.
export function useDirectory() {
  const [rooms, setRooms] = useState<DirectoryRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getDirectory();
      setRooms(r.rooms);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
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
    error,
    reload,
    lookupId,
    setLookupId,
    lookupResult,
    lookupBusy,
    lookupErr,
    resolve,
  };
}
