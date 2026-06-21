// M5 self-test — discovery tiers + coarse buckets + metadata sanitizing, store-level, no server/chain.
//   cd backend && rm -f /tmp/zkm5-rooms.json && \
//     DATAROOM_ROOMS_FILE=/tmp/zkm5-rooms.json npx tsx scripts/m5-discovery-selftest.ts
//
// Validates the off-chain discovery layer: sanitize (control chars / angle brackets / length cap / empty),
// coarse member buckets (boundaries align to the k=5 floor + the M4 meter), and the rooms-store visibility
// semantics (private-by-default, listedAt stamping/preservation, listed-only directory, owner view carries
// visibility, recordRoom never clobbers a visibility the owner set). The HTTP routes + the on-chain owner
// gate + the IP rate-limit are covered by the live curl pass; the frontend Discover flow by Playwright.
import {
  sanitizeRoomText,
  memberBucket,
  bucketTier,
  setRoomVisibility,
  recordRoom,
  getRoom,
  listListedRooms,
  listRoomsByOwner,
  ROOM_NAME_MAX,
  ROOM_DESCRIPTION_MAX,
} from "../src/rooms-store.js";

let failures = 0;
const ok = (c: boolean, label: string) => {
  console.log(`${c ? "✓" : "✗"} ${label}`);
  if (!c) failures++;
};

const OWNER_A = "GA" + "A".repeat(54);
const OWNER_B = "GB" + "B".repeat(54);
const R1 = "11".repeat(32);
const R2 = "22".repeat(32);
const R3 = "33".repeat(32);

// ---- sanitizeRoomText ----
ok(sanitizeRoomText("  Series A  data\troom  ", ROOM_NAME_MAX) === "Series A data room", "collapses whitespace + trims");
ok(sanitizeRoomText("<script>alert(1)</script>", ROOM_NAME_MAX) === "scriptalert(1)/script", "strips angle brackets");
ok(sanitizeRoomText("a\x01b\x02c", ROOM_NAME_MAX) === "a b c", "control chars become spaces");
ok(sanitizeRoomText("x".repeat(200), ROOM_NAME_MAX)?.length === ROOM_NAME_MAX, "name capped at ROOM_NAME_MAX");
ok(sanitizeRoomText("y".repeat(400), ROOM_DESCRIPTION_MAX)?.length === ROOM_DESCRIPTION_MAX, "description capped at ROOM_DESCRIPTION_MAX");
ok(sanitizeRoomText("   ", ROOM_NAME_MAX) === undefined, "all-whitespace -> undefined (not set)");
ok(sanitizeRoomText(undefined, ROOM_NAME_MAX) === undefined, "non-string -> undefined");
ok(sanitizeRoomText(42, ROOM_NAME_MAX) === undefined, "number -> undefined");

// ---- coarse buckets (boundaries: <5, 5-19, 20-49, 50+) ----
ok(memberBucket(0) === "under 5" && bucketTier(0) === "forming", "0 members -> under 5 / forming");
ok(memberBucket(4) === "under 5" && bucketTier(4) === "forming", "4 -> under 5 (still below the k=5 floor)");
ok(memberBucket(5) === "5-19" && bucketTier(5) === "ok", "5 -> 5-19 / ok (at the floor)");
ok(memberBucket(19) === "5-19", "19 -> 5-19");
ok(memberBucket(20) === "20-49" && bucketTier(20) === "strong", "20 -> 20-49 / strong (green target)");
ok(memberBucket(49) === "20-49", "49 -> 20-49");
ok(memberBucket(50) === "50+" && bucketTier(50) === "strong", "50 -> 50+ / strong");
ok(memberBucket(1000) === "50+", "1000 -> 50+ (never an exact count)");

// ---- visibility: private by default ----
recordRoom(R1, OWNER_A, "Series A");
ok(getRoom(R1)?.visibility === undefined, "a freshly recorded room has no visibility (route treats absent as private)");
ok(listListedRooms().length === 0, "nothing is listed by default");

// ---- set unlisted then listed; listedAt is stamped on first listing and preserved ----
setRoomVisibility(R1, OWNER_A, { visibility: "unlisted", name: "<b>Series A</b> round", description: "Diligence pack", nowMs: 100 });
let rec = getRoom(R1)!;
ok(rec.visibility === "unlisted" && rec.name === "bSeries A/b round" && rec.description === "Diligence pack", "unlisted stores sanitized name + description");
ok(rec.listedAt === undefined, "unlisted does not stamp listedAt");
ok(listListedRooms().length === 0, "unlisted is NOT in the directory");

setRoomVisibility(R1, OWNER_A, { visibility: "listed", name: "Series A", nowMs: 200 });
rec = getRoom(R1)!;
ok(rec.visibility === "listed" && rec.listedAt === 200, "listed stamps listedAt");
ok(rec.description === undefined, "omitting description on re-set clears it (sanitize of undefined)");
ok(listListedRooms().some((r) => r.roomId === R1), "listed room appears in the directory");

setRoomVisibility(R1, OWNER_A, { visibility: "unlisted", nowMs: 300 });
ok(getRoom(R1)!.listedAt === 200, "leaving listed PRESERVES the original listedAt");
setRoomVisibility(R1, OWNER_A, { visibility: "listed", name: "Series A", nowMs: 400 });
ok(getRoom(R1)!.listedAt === 200, "re-listing keeps the FIRST listedAt (stable directory sort)");

// ---- recordRoom (create-room refresh) never clobbers the visibility/name the owner set later ----
recordRoom(R1, OWNER_A); // simulates a later create_room idempotent refresh (owner+label only)
ok(getRoom(R1)?.visibility === "listed", "recordRoom preserves the owner's visibility");
ok(getRoom(R1)?.name === "Series A", "recordRoom preserves the owner's name");

// ---- listing is per-room; owner view carries visibility ----
recordRoom(R2, OWNER_A);
setRoomVisibility(R2, OWNER_A, { visibility: "listed", name: "Series B", nowMs: 500 });
recordRoom(R3, OWNER_B);
setRoomVisibility(R3, OWNER_B, { visibility: "private", nowMs: 600 });
ok(listListedRooms().length === 2, "directory has exactly the two listed rooms (R1, R2), not the private R3");
const aRooms = listRoomsByOwner(OWNER_A);
ok(aRooms.length === 2 && aRooms.every((r) => r.visibility === "listed"), "owner A view carries visibility for its rooms");
ok(listRoomsByOwner(OWNER_B)[0].visibility === "private", "owner B's room reads back private");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
