import { useEffect, useState } from "react";
import { getCount, getDataroomInfo } from "@/lib/api";

// Lightweight live stats for the app Home, from existing public endpoints. Each resolves independently.
// Nulls render as a dash placeholder, so a slow or absent endpoint never blocks the page.
export interface HomeStats {
  verifiedRecords: number | null;
  rooms: number | null;
}

export function useHomeStats(): HomeStats {
  const [verifiedRecords, setVerifiedRecords] = useState<number | null>(null);
  const [rooms, setRooms] = useState<number | null>(null);
  useEffect(() => {
    getCount()
      .then((c) => setVerifiedRecords(c.count ?? 0))
      .catch(() => {});
    getDataroomInfo()
      .then((i) => setRooms(i.roomCount ?? 0))
      .catch(() => {});
  }, []);
  return { verifiedRecords, rooms };
}
