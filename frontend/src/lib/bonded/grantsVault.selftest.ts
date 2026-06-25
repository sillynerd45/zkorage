// Offline selftest for the encrypted Bonded Access "Your access" list vault (no browser, no wallet). Run with:
//   ../sdk/node_modules/.bin/tsx src/lib/bonded/grantsVault.selftest.ts
// Uses globalThis.crypto.subtle (Node 22), the same Web Crypto API the browser uses.
import { encryptBondGrants, decryptBondGrants, deriveBondGrantsVaultId } from "./grantsVault";
import { deriveBondHandleVaultId } from "./handleVault";
import type { BondGrantRecord } from "./grants";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
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

const grants: BondGrantRecord[] = [
  { reqId: "ab".repeat(32), tokenSymbol: "TUSD", minAmount: "25000000000", decimals: 7, deadline: 1893456000 },
  { reqId: "cd".repeat(32), tokenSymbol: "XLM", minAmount: "1000000000", decimals: 7, deadline: 1900000000 },
];

// 1) round-trip with the same signature
const blob = await encryptBondGrants(sigA, grants);
ok(blob.magic === "zkorage-bond-grants" && blob.version === 1 && blob.alg === "AES-256-GCM", "envelope shape");
ok(!JSON.stringify(blob).includes("TUSD") && !JSON.stringify(blob).includes("ab".repeat(32)), "ciphertext does not leak the records in plaintext");
const back = await decryptBondGrants(sigA, blob);
ok(back.length === 2 && back[0].reqId === "ab".repeat(32) && back[1].tokenSymbol === "XLM", "round-trips the records");

// 2) a different wallet cannot decrypt
await throws(() => decryptBondGrants(sigB, blob), "wrong wallet rejected");

// 3) tamper -> reject
const tampered = { ...blob, ct: blob.ct.slice(0, -4) + (blob.ct.slice(-4) === "AAAA" ? "BBBB" : "AAAA") };
await throws(() => decryptBondGrants(sigA, tampered), "tampered ciphertext rejected");

// 4) a foreign blob (handle vault magic) is rejected
await throws(() => decryptBondGrants(sigA, { ...blob, magic: "zkorage-bond-handle" }), "foreign magic rejected");

// 5) junk rows are dropped on decrypt
const withJunk = await encryptBondGrants(sigA, [grants[0], { reqId: "zz", tokenSymbol: "", minAmount: "x", decimals: 99, deadline: -1 } as unknown as BondGrantRecord]);
const cleaned = await decryptBondGrants(sigA, withJunk);
ok(cleaned.length === 1 && cleaned[0].reqId === "ab".repeat(32), "junk record dropped");

// 6) the grants vault id is DISTINCT from the handle vault id for the SAME signature (no namespace collision)
const gid = await deriveBondGrantsVaultId(sigA);
const hid = await deriveBondHandleVaultId(sigA);
ok(/^[0-9a-f]{64}$/.test(gid), "vault id is 32-byte hex");
ok(gid !== hid, "grants vault id differs from the handle vault id");

// 7) deterministic id for the same signature
ok((await deriveBondGrantsVaultId(sigA)) === gid, "vault id is deterministic");
ok((await deriveBondGrantsVaultId(sigB)) !== gid, "a different signature gives a different id");

console.log(`grantsVault selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
