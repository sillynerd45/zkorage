// BP5 tier — JS<->guest byte-exactness cross-check. Asserts the backend tree/commitment/nullifier/accessor
// derivations match the values the RISC0 tier guest emitted in its exec smoke for the demo inputs
//   id_secret = 0x11*32, id_trapdoor = 0x22*32, context = 0x07*32, holder_seed = 0x03*32
// (host_tier EXEC_ONLY journal). Run: npx tsx scripts/bp5-tier-selftest.ts
import { sha256 } from "@noble/hashes/sha256";
import { idCommitment, buildEligibleTree, nullifier } from "../src/membership.js";
import { qualCommitment, buildSparseTree, tierHolderSign } from "../src/tier.js";
import { toHex } from "../src/envelope.js";

const fill = (b: number) => new Uint8Array(32).fill(b);
const ZERO32 = new Uint8Array(32);

const idSecret = fill(0x11);
const idTrapdoor = fill(0x22);
const context = fill(0x07);
const holderSeed = fill(0x03);

// Expected values from the host_tier EXEC_ONLY journal (the canonical guest):
const EXPECT = {
  memberRoot: "8be678722c84e8bf478cd0c2a8e257bcc599f80d56ad2839e0188a1cace651da",
  qualRoot: "75c7de57b1536d37bdbc48033e4d01f5a8bd116005be8eb637c1325f45d11c2a",
  nullifier: "7d318db9b1204d6fd623a331c2fccf0d01d716825a5cd1ecd25350b13ba7ecf4",
  accessor: "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1",
};

const memberLeaf = idCommitment(idSecret, idTrapdoor);
const memberRoot = toHex(buildEligibleTree([memberLeaf]).root);
const qualRoot = toHex(buildSparseTree([qualCommitment(idSecret)], ZERO32).root);
const nf = toHex(nullifier(idSecret, context));
const { accessor } = tierHolderSign(holderSeed, context);
const accessorHex = toHex(accessor);

let ok = true;
function check(name: string, got: string, want: string) {
  const pass = got === want;
  ok = ok && pass;
  console.log(`${pass ? "OK " : "FAIL"}  ${name}: ${got}${pass ? "" : `\n      expected: ${want}`}`);
}

console.log("BP5 tier guest<->backend byte-exactness cross-check");
check("member_root", memberRoot, EXPECT.memberRoot);
check("qual_root  ", qualRoot, EXPECT.qualRoot);
check("nullifier  ", nf, EXPECT.nullifier);
check("accessor   ", accessorHex, EXPECT.accessor);

// Multi-leaf witness round-trip: build a 3-leaf qual tree and confirm each witness folds back to the root
// using the SAME node hash + low-bit direction the guest uses (catches any off-by-one in the sibling path).
function nodeHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + a.length + b.length);
  buf[0] = 0x01;
  buf.set(a, 1);
  buf.set(b, 1 + a.length);
  return sha256(buf);
}
const leaves = [fill(0xa1), fill(0xb2), fill(0xc3)].map((s) => qualCommitment(s));
const tree = buildSparseTree(leaves, ZERO32);
for (let idx = 0; idx < leaves.length; idx++) {
  const { siblings, leafIndex } = tree.witness(idx);
  let node = leaves[idx];
  for (let i = 0; i < 20; i++) {
    const sib = siblings.slice(i * 32, i * 32 + 32);
    node = ((leafIndex >> i) & 1) === 0 ? nodeHash(node, sib) : nodeHash(sib, node);
  }
  check(`witness[${idx}]→root`, toHex(node), toHex(tree.root));
}

if (!ok) {
  console.error("\nMISMATCH — the backend derivations diverge from the canonical guest.");
  process.exit(1);
}
console.log("\nAll four match the canonical tier guest + the 3-leaf witness round-trips. Backend is byte-exact.");
