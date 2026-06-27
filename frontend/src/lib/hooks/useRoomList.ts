import { useEffect, useMemo, useState } from "react";

// Client-side search + "show more" pagination over an already-loaded room array. Shared by the surfaces that
// list rooms (Discover directory, Room Management picker, Membership > Approve picker) so they behave alike:
// instant case-insensitive substring search over each room's text (name + id + description + label, supplied
// by `getText`), then a "Show more" window that appends `pageSize` at a time. The search box only matters once
// a list is long enough (`searchThreshold`), and typing resets the window to the first page.
//
// `getText` should be stable (a module-level function or a useCallback), so the filter memo does not recompute
// every render. It returns the haystack for one room; the hook lowercases it once.
export function useRoomList<T>(
  rooms: T[],
  getText: (r: T) => string,
  opts?: { pageSize?: number; searchThreshold?: number },
) {
  const pageSize = opts?.pageSize ?? 8;
  const searchThreshold = opts?.searchThreshold ?? 6;
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const q = query.trim().toLowerCase();
  const matched = useMemo(
    () => (q ? rooms.filter((r) => getText(r).toLowerCase().includes(q)) : rooms),
    [rooms, q, getText],
  );

  // Searching resets to the first page.
  useEffect(() => setPage(1), [q]);

  const visibleCount = Math.min(page * pageSize, matched.length);
  return {
    query,
    setQuery,
    searching: q.length > 0,
    showSearch: rooms.length > searchThreshold,
    matched, // the full filtered set (for the count + the empty-result state)
    visible: matched.slice(0, visibleCount), // the rooms to render this page
    total: rooms.length,
    shown: visibleCount,
    canShowMore: visibleCount < matched.length,
    remaining: matched.length - visibleCount,
    showMore: () => setPage((p) => p + 1),
  };
}
