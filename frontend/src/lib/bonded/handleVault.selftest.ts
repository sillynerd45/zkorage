// Offline selftest for the encrypted Bonded Access handle vault (no browser, no wallet). Run with the SDK's tsx:
//   ../sdk/node_modules/.bin/tsx src/lib/bonded/handleVault.selftest.ts
// Uses globalThis.crypto.subtle (Node 22), the same Web Crypto API the browser uses.
import { encryptBondHandle, decryptBondHandle, deriveBondHandleVaultId, type BondHandle } from "./handleVault";

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

const handle: BondHandle = {
  idSecret: "11".repeat(32),
  idTrapdoor: "22".repeat(32),
  holderSeed: "33".repeat(32),
  accessor: "44".repeat(32),
  qualCommitment: "55".repeat(32),
};

// 1) round-trip with the same signature
const blob = await encryptBondHandle(sigA, handle);
ok(blob.magic === "zkorage-bond-handle" && blob.version === 1 && blob.alg === "AES-256-GCM", "envelope shape");
ok(!JSON.stringify(blob).includes("11".repeat(32)), "ciphertext does not leak id_secret in plaintext");
const back = await decryptBondHandle(sigA, blob);
ok(
  back.idSecret === handle.idSecret && back.idTrapdoor === handle.idTrapdoor && back.holderSeed === handle.holderSeed &&
    back.accessor === handle.accessor && back.qualCommitment === handle.qualCommitment,
  "round-trip preserves the handle exactly",
);

// 2) a different wallet's signature cannot decrypt
await throws(() => decryptBondHandle(sigB, blob), "wrong wallet signature is rejected");

// 3) the vault id is deterministic per signature, distinct per wallet, and 32-byte hex
const idA1 = await deriveBondHandleVaultId(sigA);
const idA2 = await deriveBondHandleVaultId(sigA);
const idB = await deriveBondHandleVaultId(sigB);
ok(idA1 === idA2, "vault id is deterministic for the same signature");
ok(idA1 !== idB, "vault id differs per wallet");
ok(/^[0-9a-f]{64}$/.test(idA1), "vault id is 32-byte hex");

// 4) tamper detection: flipping the ciphertext fails the GCM tag
const tampered = { ...blob, ct: blob.ct.slice(0, -4) + (blob.ct.endsWith("A") ? "B" : "A") + blob.ct.slice(-3) };
await throws(() => decryptBondHandle(sigA, tampered), "tampered ciphertext is rejected");

// 5) a decryptable-but-junk payload (missing fields) is rejected
const junkBlob = await encryptBondHandle(sigA, { idSecret: "zz", idTrapdoor: "22".repeat(32), holderSeed: "33".repeat(32), accessor: "44".repeat(32), qualCommitment: "55".repeat(32) } as BondHandle);
await throws(() => decryptBondHandle(sigA, junkBlob), "invalid (non-hex32) field is rejected");

// 6) a foreign-shaped blob is rejected
await throws(() => decryptBondHandle(sigA, { magic: "something-else", version: 1, alg: "AES-256-GCM", iv: "x", ct: "y" }), "foreign magic is rejected");

console.log(`handleVault selftest: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
