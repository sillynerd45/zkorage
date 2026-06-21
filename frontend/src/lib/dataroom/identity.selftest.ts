// M0 self-test for the frontend sign-to-derive orchestration (no React/Vite needed).
//   cd frontend && npx tsx src/lib/dataroom/identity.selftest.ts
import { toSignatureBytes, deriveRoomIdentity, driftKey } from "./identity.ts";

let failures = 0;
const ok = (c: boolean, label: string) => {
  console.log(`${c ? "✓" : "✗"} ${label}`);
  if (!c) failures++;
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fill = (b: number, n = 64) => new Uint8Array(n).fill(b);

// ---- toSignatureBytes: every encoding maps to the same raw bytes ----
const raw = fill(0x07, 64);
const b64 = Buffer.from(raw).toString("base64");
ok(hex(toSignatureBytes(raw)) === hex(raw), "passes through Uint8Array");
ok(hex(toSignatureBytes(b64)) === hex(raw), "decodes base64 (SEP-53 V4)");
ok(hex(toSignatureBytes(hex(raw))) === hex(raw), "decodes hex");
ok(hex(toSignatureBytes(Array.from(raw))) === hex(raw), "accepts number[]");
ok(hex(toSignatureBytes({ type: "Buffer", data: Array.from(raw) })) === hex(raw), "accepts Buffer-json");

// ---- deriveRoomIdentity: ties the frontend path to the SDK frozen vector ----
const ADDR = "GTEST";
const roomA = "a1".repeat(32);
const FROZEN_ACCESSOR = "92ea81a63fd2c6c2eb76409ecdc7cbfa8e24a8cad6e6403519ff705d0b6671a6";

const fakeStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), _m: m };
};
let signCalls = 0;
const fakeSign = async (_msg: string) => {
  signCalls++;
  return raw; // a fixed signature == the SDK frozen-vector IKM (0x07*64)
};

const cache = new Map<string, Uint8Array>();
const store = fakeStore();
const r1 = await deriveRoomIdentity({ address: ADDR, roomId: roomA, signMessage: fakeSign, cache, storage: store });
ok(r1.identity.accessor === FROZEN_ACCESSOR, "frontend derive matches the SDK frozen-vector accessor");
ok(r1.drift === false, "first derive: no drift, fingerprint stored");
ok(store.getItem(driftKey(ADDR, roomA)) === `${r1.identity.accessor}:${r1.identity.recipientPub}`, "stored the derived public fingerprint (not the secret)");

const r2 = await deriveRoomIdentity({ address: ADDR, roomId: roomA, signMessage: fakeSign, cache, storage: store });
ok(signCalls === 1, "wallet prompted once per session (signature cached across derives)");
ok(r2.drift === false, "repeat derive: still no drift");

// tamper the stored fingerprint -> drift surfaces
store._m.set(driftKey(ADDR, roomA), "deadbeef:deadbeef");
const r3 = await deriveRoomIdentity({ address: ADDR, roomId: roomA, signMessage: fakeSign, cache, storage: store });
ok(r3.drift === true, "drift detected when the stored fingerprint differs");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
