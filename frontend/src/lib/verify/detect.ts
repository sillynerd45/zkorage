// Smart-input router for the public "Verify it yourself" page. A user pastes ONE thing (a shared verify
// link, or a bare id) and we route it to the right on-chain check:
//   - a Bonded Access grant link        -> /verify/bond?<query>
//   - a Data Room room id                -> /verify/room/<id>
//   - a Proof-of-Reserves issuer id      -> /verify/<issuer>
//
// A bare 64-hex value is ambiguous: a room id AND a reserves issuer are both 32-byte hex. We can't tell them
// apart by shape, so we return { kind: "id" } and let the caller probe (read the public room first; if there
// is no such room, treat it as a reserves issuer). A FULL link is never ambiguous because the path names the
// type. This module is pure (no network) so it can be unit-tested.

export type VerifyTarget =
  | { kind: "bond"; search: string } // navigate to /verify/bond + this query string (leading "?")
  | { kind: "reserves"; issuer: string } // navigate to /verify/<issuer>
  | { kind: "room"; roomId: string } // navigate to /verify/room/<roomId>
  | { kind: "id"; id: string } // bare 64-hex: caller probes room-first, else reserves
  | { kind: "unknown" };

const HEX64 = /^[0-9a-f]{64}$/i;
const STELLAR_PUB = /^G[A-Z2-7]{55}$/; // ed25519 Stellar account (G...), kept for completeness

// Pull a { path, search } out of a full URL, a root-relative path, or a "host/verify/..." paste. Returns
// null when the input is not link-shaped, so the caller falls through to the bare-id checks.
function looseUrl(s: string): { path: string; search: string } | null {
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      return { path: u.pathname, search: u.search };
    }
    if (s.startsWith("/")) {
      const u = new URL(s, "http://local");
      return { path: u.pathname, search: u.search };
    }
    if (s.includes("/verify/")) {
      const u = new URL("http://" + s);
      return { path: u.pathname, search: u.search };
    }
  } catch {
    /* not parseable as a URL */
  }
  return null;
}

export function detectVerifyTarget(raw: string): VerifyTarget {
  const s = (raw ?? "").trim();
  if (!s) return { kind: "unknown" };

  // 1) A link/path that already names the verify route (unambiguous: the path carries the type). A
  //    /verify/<id> link is the reserves deep link (a room link is /verify/room/<id>, matched first). Match
  //    hex case-insensitively but the Stellar pubkey case-sensitively (real G-addresses are uppercase).
  const u = looseUrl(s);
  if (u) {
    if (u.path.includes("/verify/bond")) return { kind: "bond", search: u.search };
    const room = u.path.match(/\/verify\/room\/([0-9a-fA-F]{64})(?:\/|$)/);
    if (room) return { kind: "room", roomId: room[1].toLowerCase() };
    const hex = u.path.match(/\/verify\/([0-9a-fA-F]{64})(?:\/|$)/);
    if (hex) return { kind: "reserves", issuer: hex[1].toLowerCase() };
    const pub = u.path.match(/\/verify\/(G[A-Z2-7]{55})(?:\/|$)/);
    if (pub) return { kind: "reserves", issuer: pub[1] };
  }

  // 2) A bare bond query (someone copied just the "accessor=..&req=.." part). Require no path separator so a
  //    path-shaped paste does not get misparsed as a query.
  if (!s.includes("/") && /(^|[?&])accessor=/.test(s) && /(^|[?&])req=/.test(s)) {
    return { kind: "bond", search: s.startsWith("?") ? s : "?" + s.replace(/^&/, "") };
  }

  // 3) Bare tokens.
  if (STELLAR_PUB.test(s)) return { kind: "reserves", issuer: s };
  if (HEX64.test(s)) return { kind: "id", id: s.toLowerCase() };

  return { kind: "unknown" };
}
