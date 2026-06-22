// Offline selftest for the encrypted rooms backup (no browser, no wallet). Run with the SDK's tsx:
//   ../sdk/node_modules/.bin/tsx src/lib/dataroom/roomsBackup.selftest.ts
// Uses globalThis.crypto.subtle (Node 22), the same Web Crypto API the browser uses.
import { exportRoomsBackup, importRoomsBackup, mergeJoinRequests, deriveVaultHandle } from "./roomsBackup";
import type { JoinRequest } from "./requests";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
async function throws(fn: () => Promise<unknown>, msg: string) {
  try {
    await fn();
    fail++;
    console.error("  FAIL (expected throw):", msg);
  } catch {
    pass++;
  }
}

const sigA = new Uint8Array(64).fill(7);
const sigB = new Uint8Array(64).fill(9);

const rooms: JoinRequest[] = [
  { roomId: "aa".repeat(32), label: "Acme term sheet", state: "eligible", ts: 100 },
  { roomId: "bb".repeat(32), state: "pending", ts: 200 },
];

// 1) round-trip with the same signature
const file = await exportRoomsBackup(sigA, rooms);
ok(file.magic === "zkorage-rooms-backup" && file.version === 1 && file.alg === "AES-256-GCM", "envelope shape");
ok(!JSON.stringify(file).includes("aa".repeat(32)), "ciphertext does not leak a room id in plaintext");
const back = await importRoomsBackup(sigA, file);
ok(back.length === 2, "round-trip preserves both rooms");
ok(back[0].roomId === rooms[0].roomId && back[0].label === "Acme term sheet" && back[0].state === "eligible", "entry 0 intact");
ok(back[1].roomId === rooms[1].roomId && back[1].state === "pending", "entry 1 intact");

// 2) a different wallet's signature cannot decrypt
await throws(() => importRoomsBackup(sigB, file), "wrong wallet signature is rejected");

// 3) a non-backup / tampered envelope is rejected
await throws(() => importRoomsBackup(sigA, { magic: "nope" }), "foreign file rejected");
await throws(() => importRoomsBackup(sigA, { ...file, version: 99 }), "unsupported version rejected");
await throws(() => importRoomsBackup(sigA, { ...file, ct: file.ct.slice(0, -4) + "AAAA" }), "tampered ciphertext rejected");

// 4) a decrypted-but-junk row is filtered out (defense in depth)
const junkFile = await exportRoomsBackup(sigA, [
  ...rooms,
  { roomId: "not-hex", state: "eligible", ts: 1 } as unknown as JoinRequest,
]);
const junkBack = await importRoomsBackup(sigA, junkFile);
ok(junkBack.length === 2, "malformed row is dropped on import");

// 4b) an unknown state, a non-finite ts, and an injected extra field are rejected/stripped; long labels truncate
const tamperedFile = await exportRoomsBackup(sigA, [
  { roomId: "11".repeat(32), state: "bogus", ts: 1 } as unknown as JoinRequest,
  { roomId: "22".repeat(32), state: "eligible", ts: NaN } as unknown as JoinRequest,
  { roomId: "33".repeat(32), state: "eligible", ts: 5, label: "x".repeat(500), evil: "leak" } as unknown as JoinRequest,
]);
const tamperedBack = await importRoomsBackup(sigA, tamperedFile);
ok(tamperedBack.length === 1, "unknown state + non-finite ts rows are dropped");
ok(tamperedBack[0].roomId === "33".repeat(32) && tamperedBack[0].label!.length === 200, "label truncated to 200");
ok(!("evil" in tamperedBack[0]), "injected extra field is stripped on rebuild");

// 5) merge: union by room id, newer ts wins, label preserved
const existing: JoinRequest[] = [
  { roomId: "aa".repeat(32), label: "old label", state: "pending", ts: 50 },
  { roomId: "cc".repeat(32), state: "eligible", ts: 10 },
];
const merged = mergeJoinRequests(existing, rooms);
ok(merged.length === 3, "merge unions to 3 rooms");
const aa = merged.find((r) => r.roomId === "aa".repeat(32))!;
ok(aa.state === "eligible" && aa.ts === 100, "newer incoming entry wins on conflict");
ok(aa.label === "Acme term sheet", "newer entry's label kept");
const cc = merged.find((r) => r.roomId === "cc".repeat(32))!;
ok(!!cc, "existing-only room survives the merge");
// label fallback: incoming newer entry without a label keeps the older label
const labelFallback = mergeJoinRequests(
  [{ roomId: "dd".repeat(32), label: "kept", state: "pending", ts: 1 }],
  [{ roomId: "dd".repeat(32), state: "eligible", ts: 2 }],
);
ok(labelFallback[0].label === "kept", "label falls back to the older entry when the newer has none");

// 6) vault handle: deterministic per signature, different across signatures, 32-byte hex, != the room id
const h1 = await deriveVaultHandle(sigA);
const h2 = await deriveVaultHandle(sigA);
const h3 = await deriveVaultHandle(sigB);
ok(/^[0-9a-f]{64}$/.test(h1), "vault handle is 32-byte hex");
ok(h1 === h2, "vault handle is deterministic for the same signature");
ok(h1 !== h3, "vault handle differs across signatures");

console.log(`roomsBackup selftest: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
