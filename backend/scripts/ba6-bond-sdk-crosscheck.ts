// BA6 — verify the zkorage-sdk Bonded Access helpers (bondReqId, bondAccessCommitment) are byte-exact with
// the backend indexer (reqIdHex, qualCommitment), so the SDK's trustless recompute path agrees with what the
// gate + guest enforce. Offline (no network). Run: npx tsx scripts/ba6-bond-sdk-crosscheck.ts
import { bondReqId, bondAccessCommitment, ZkorageClient } from "zkorage-sdk";
import { reqIdHex as backendReqId, qualCommitment as backendQual } from "../src/bond.js";
import { toHex } from "../src/envelope.js";

// referenced so an accidental removal of the recompute method is caught at type-check time (it is a method).
void (ZkorageClient.prototype.recomputeBondQualRoot as unknown);

let pass = 0;
let fail = 0;
function eq(name: string, a: string, b: string): void {
  if (a.toLowerCase() === b.toLowerCase()) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}\n   sdk: ${a}\n   be:  ${b}`);
  }
}

// A real testnet C-address (zkUSD/bond token) so StrKey.decodeContract works on both sides.
const TOKEN = "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5";
const cases: { min: bigint; deadline: number }[] = [
  { min: 1n, deadline: 1 },
  { min: 1_000_000_000n, deadline: 9_999_999_999 },
  { min: 250_000_0000n, deadline: 1_900_000_000 },
  { min: (1n << 100n), deadline: 4_102_444_800 }, // a large i128 to exercise the 16-BE encoding
];
for (const c of cases) {
  eq(`reqId(min=${c.min}, deadline=${c.deadline})`, bondReqId(TOKEN, c.min, c.deadline), backendReqId(TOKEN, c.min, c.deadline));
}

const secrets = [
  new Uint8Array(32).fill(0x11),
  new Uint8Array(32).fill(0x03),
  Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)),
];
for (const s of secrets) {
  eq(`commitment(${toHex(s).slice(0, 8)}…)`, bondAccessCommitment(toHex(s)), toHex(backendQual(s)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
