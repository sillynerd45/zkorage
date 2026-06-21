// M0 self-test for the sign-to-derive Data Room identity module.
//   cd sdk && npx tsx test/identity-selftest.ts
//
// Two layers:
//  (1) BYTE-EXACTNESS vs an INDEPENDENT implementation: the backend witness builder
//      (backend/scripts/dr2-build-membership-job.mjs) computes leaf / node / nullifier / accessor / holder
//      signature with pure node:crypto. This test feeds the SAME secrets to the SDK's noble-based helpers and
//      asserts byte-equality, which transitively pins the SDK to the membership guest's scheme.
//  (2) SIGN-TO-DERIVE: determinism, cross-room unlinkability, internal consistency, and a frozen vector.
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import {
  deriveDataRoomIdentity,
  idCommitment,
  nullifierFor,
  accessorFromSeed,
  recipientFromSecret,
  holderSignature,
  recipientPublicKeyFromSecret,
  fromHex,
  toHex,
} from "../src/index.js";
// Independent (node:crypto) reference implementation of the membership witness.
import { buildMembershipJob } from "../../backend/scripts/dr2-build-membership-job.mjs";

let failures = 0;
const ok = (c: boolean, label: string, extra = "") => {
  console.log(`${c ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!c) failures++;
};
const fill = (b: number, n = 32) => new Uint8Array(n).fill(b);
// node-style tagged internal node, to rebuild the demo zero-subtree root from the SDK leaf.
const nodeOf = (a: Uint8Array, b: Uint8Array) => sha256(new Uint8Array([0x01, ...a, ...b]));
const demoRoot = (leaf: Uint8Array) => {
  let z = idCommitment(fill(0x00), fill(0x00)); // empty leaf
  let cur = leaf;
  for (let i = 0; i < 20; i++) {
    cur = nodeOf(cur, z); // member at index 0 = always the left child
    z = nodeOf(z, z);
  }
  return cur;
};

// ---- (1) byte-exactness vs the independent node:crypto builder, demo vectors ----
const idSecret = fill(0x11), idTrapdoor = fill(0x22), holderSeed = fill(0x03), recipientPub = fill(0xad);
const roomId = fill(0x01);
const ref = buildMembershipJob({
  idSecret: Buffer.from(idSecret),
  idTrapdoor: Buffer.from(idTrapdoor),
  roomId: Buffer.from(roomId),
  holderSeed: Buffer.from(holderSeed),
  recipientPub: Buffer.from(recipientPub),
});
const accessor = accessorFromSeed(holderSeed);

ok(toHex(accessor) === ref.accessor, "accessor matches node:crypto builder", ref.accessor.slice(0, 8));
ok(toHex(accessor).startsWith("ed4928c6"), "accessor == the live demo accessor ed4928c6 (ground truth)");
ok(toHex(nullifierFor(idSecret, roomId)) === ref.nullifier, "nullifier matches builder", ref.nullifier.slice(0, 8));
ok(toHex(demoRoot(idCommitment(idSecret, idTrapdoor))) === ref.eligible_root, "leaf+node -> eligible_root matches builder", ref.eligible_root.slice(0, 8));
const sig = holderSignature(holderSeed, roomId, accessor, recipientPub);
ok(toHex(sig) === ref.job.sig_hex, "holder signature is byte-identical (RFC 8032 determinism, noble == node)");
ok(ed25519.verify(sig, new Uint8Array([...new TextEncoder().encode("zkorage-dataroom-access-v1"), ...roomId, ...accessor, ...recipientPub]), accessor), "holder signature verifies under the accessor");

// ---- (2) sign-to-derive: determinism, cross-room unlinkability, internal consistency ----
const SIG = fill(0x07, 64); // a fixed fake SEP-53 signature as HKDF IKM
const roomA = toHex(fill(0xa1)), roomB = toHex(fill(0xb2));
const a1 = deriveDataRoomIdentity(SIG, roomA);
const a2 = deriveDataRoomIdentity(SIG, roomA);
const b1 = deriveDataRoomIdentity(SIG, roomB);

ok(JSON.stringify(a1) === JSON.stringify(a2), "deterministic: same signature + room -> identical identity");
ok(
  a1.idSecret !== b1.idSecret &&
    a1.idCommitment !== b1.idCommitment &&
    a1.accessor !== b1.accessor &&
    a1.recipientPub !== b1.recipientPub &&
    a1.nullifier !== b1.nullifier,
  "cross-room unlinkable: every field differs across rooms",
);
// internal consistency: the public artifacts recompute from the private secrets.
ok(toHex(idCommitment(fromHex(a1.idSecret), fromHex(a1.idTrapdoor))) === a1.idCommitment, "idCommitment recomputes from secrets");
ok(toHex(nullifierFor(fromHex(a1.idSecret), fromHex(a1.roomId))) === a1.nullifier, "nullifier recomputes from secrets");
ok(toHex(accessorFromSeed(fromHex(a1.accessorSeed))) === a1.accessor, "accessor recomputes from seed");
ok(toHex(recipientFromSecret(fromHex(a1.recipientSecret))) === a1.recipientPub, "recipientPub recomputes from secret");
ok(recipientPublicKeyFromSecret(a1.recipientSecret) === a1.recipientPub, "recipientPub agrees with the existing SDK x25519 helper");
const dsig = holderSignature(fromHex(a1.accessorSeed), fromHex(a1.roomId), fromHex(a1.accessor), fromHex(a1.recipientPub));
ok(
  ed25519.verify(dsig, new Uint8Array([...new TextEncoder().encode("zkorage-dataroom-access-v1"), ...fromHex(a1.roomId), ...fromHex(a1.accessor), ...fromHex(a1.recipientPub)]), fromHex(a1.accessor)),
  "derived identity produces a valid NEW-5 holder signature",
);
ok(signatureRejectsShortIkm(), "rejects too-short signature IKM (< 32 bytes)");

// ---- frozen vector (regression guard against an accidental salt/message/cap-tag change) ----
const FROZEN = {
  accessor: "92ea81a63fd2c6c2eb76409ecdc7cbfa8e24a8cad6e6403519ff705d0b6671a6",
  recipientPub: "0c04f1690025fd710092cfda96b6499fd16e9deb129bb985f61917c0ec29d471",
  idCommitment: "c919220441c1f4b45f4565988f1596d2ea6f2d17d34dde4b60fb83d64c23c9d5",
  nullifier: "76c7366c0f9b166837929651f4a21ee4709e5ad2e017471540b1d7b76cd8e9d9",
};
console.log("\n[frozen-vector candidate] room 0xa1*32, signature 0x07*64:");
console.log(`  accessor     = ${a1.accessor}`);
console.log(`  recipientPub = ${a1.recipientPub}`);
console.log(`  idCommitment = ${a1.idCommitment}`);
console.log(`  nullifier    = ${a1.nullifier}`);
if (FROZEN.accessor !== "__FILL__") {
  ok(
    a1.accessor === FROZEN.accessor &&
      a1.recipientPub === FROZEN.recipientPub &&
      a1.idCommitment === FROZEN.idCommitment &&
      a1.nullifier === FROZEN.nullifier,
    "frozen vector unchanged",
  );
}

function signatureRejectsShortIkm(): boolean {
  try {
    deriveDataRoomIdentity(fill(0x01, 16), roomA);
    return false;
  } catch {
    return true;
  }
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
