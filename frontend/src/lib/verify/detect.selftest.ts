// Run: cd frontend && npx tsx src/lib/verify/detect.selftest.ts
// Pure-logic checks for the smart-input router. No network.
import { detectVerifyTarget, type VerifyTarget } from "./detect";

const HEX = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const ROOM = "46745e986e85e583e76eb57217419021e3e3e23835c9b27bb562a596b7b34209";
const PUB = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";

let pass = 0;
let fail = 0;
function eq(label: string, got: VerifyTarget, want: VerifyTarget) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${label}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

// bare ids
eq("bare stellar pub -> reserves", detectVerifyTarget(PUB), { kind: "reserves", issuer: PUB });
eq("bare hex64 -> ambiguous id", detectVerifyTarget(ROOM), { kind: "id", id: ROOM });
eq("uppercase hex64 -> lowercased id", detectVerifyTarget(ROOM.toUpperCase()), { kind: "id", id: ROOM });
eq("whitespace trimmed", detectVerifyTarget(`  ${HEX}  `), { kind: "id", id: HEX });

// links (unambiguous)
eq(
  "full bond link -> bond",
  detectVerifyTarget(`https://zkorage.wazowsky.id/verify/bond?accessor=${HEX}&req=${ROOM}&amount=100`),
  { kind: "bond", search: `?accessor=${HEX}&req=${ROOM}&amount=100` },
);
eq("relative bond path -> bond", detectVerifyTarget(`/verify/bond?accessor=${HEX}&req=${ROOM}`), {
  kind: "bond",
  search: `?accessor=${HEX}&req=${ROOM}`,
});
eq("host-only bond paste -> bond", detectVerifyTarget(`zkorage.wazowsky.id/verify/bond?accessor=${HEX}&req=${ROOM}`), {
  kind: "bond",
  search: `?accessor=${HEX}&req=${ROOM}`,
});
eq("room link -> room", detectVerifyTarget(`https://zkorage.wazowsky.id/verify/room/${ROOM}`), {
  kind: "room",
  roomId: ROOM,
});
eq("reserves link (hex) -> reserves", detectVerifyTarget(`https://zkorage.wazowsky.id/verify/${HEX}`), {
  kind: "reserves",
  issuer: HEX,
});

// bare bond query
eq("bare bond query -> bond", detectVerifyTarget(`accessor=${HEX}&req=${ROOM}&deadline=9999999999`), {
  kind: "bond",
  search: `?accessor=${HEX}&req=${ROOM}&deadline=9999999999`,
});

// unknown
eq("empty -> unknown", detectVerifyTarget(""), { kind: "unknown" });
eq("garbage -> unknown", detectVerifyTarget("hello world"), { kind: "unknown" });
eq("short hex -> unknown", detectVerifyTarget("deadbeef"), { kind: "unknown" });

console.log(`\ndetect.selftest: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
