// Validate membership.ts byte-exact against the known guest/host outputs (single-member zero-subtree),
// and exercise the multi-member tree + witness. Run: npx tsx scripts/dr2-membership-selftest.ts
import { buildMembershipJob, buildEligibleTree, idCommitment, nullifier, toHex, fromHex } from "../src/membership.js";

const fill = (b: number) => new Uint8Array(32).fill(b);
let fail = 0;
const eq = (label: string, got: string, want: string) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${got}${ok ? "" : `  (want ${want})`}`);
};

// 1) Single-member set (member 0x11/0x22 at index 0) must reproduce the guest/host demo outputs exactly.
const idSecret = fill(0x11), idTrapdoor = fill(0x22);
const leaf = idCommitment(idSecret, idTrapdoor);
const single = buildMembershipJob({
  idSecret, idTrapdoor,
  roomId: fill(0x01),
  holderSeed: fill(0x03),
  recipientPub: fill(0xad),
  commitments: [leaf],
  memberIndex: 0,
});
eq("eligible_root (1 member)", single.eligibleRoot, "8be678722c84e8bf478cd0c2a8e257bcc599f80d56ad2839e0188a1cace651da");
eq("nullifier (room 0x01)", single.nullifier, "5c108953be03872c864d205f9fbe0974c2b20f3d9f2137467b7d7b09faa5cb5f");
eq("accessor (holder 0x03)", single.accessor, "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1");
console.log(`  siblings len = ${(single.job.siblings_hex as string).length / 2} bytes (expect 640); leaf_index = ${single.job.leaf_index}`);

// 2) Multi-member set (3 members). The member at index 1 must produce a DIFFERENT root than the
//    single-member tree, a valid witness, and the SAME nullifier as if alone (nullifier is id+room only).
const m0 = idCommitment(fill(0x31), fill(0x32));
const m1 = idCommitment(fill(0x41), fill(0x42));
const m2 = idCommitment(fill(0x51), fill(0x52));
const multi = buildMembershipJob({
  idSecret: fill(0x41), idTrapdoor: fill(0x42),
  roomId: fill(0x07),
  holderSeed: fill(0x09),
  recipientPub: fill(0xbe),
  commitments: [m0, m1, m2],
  memberIndex: 1,
});
const { root } = buildEligibleTree([m0, m1, m2]);
eq("multi-member root matches buildEligibleTree", multi.eligibleRoot, toHex(root));
console.log(`  multi root differs from single: ${multi.eligibleRoot !== single.eligibleRoot ? "✓" : "✗"}`);
eq("multi nullifier = sha256(0x02|id41|room07)", multi.nullifier, toHex(nullifier(fill(0x41), fill(0x07))));
console.log(`  member-1 leaf_index = ${multi.job.leaf_index} (expect 1)`);

// 3) A wrong member index must throw (secret/commitment mismatch).
let threw = false;
try {
  buildMembershipJob({ idSecret: fill(0x41), idTrapdoor: fill(0x42), roomId: fill(0x07), holderSeed: fill(0x09), recipientPub: fill(0xbe), commitments: [m0, m1, m2], memberIndex: 0 });
} catch { threw = true; }
console.log(`${threw ? "✓" : "✗"} wrong-index secret/commitment mismatch rejected`);
if (!threw) fail++;

console.log(fail === 0 ? "\nALL GREEN ✓" : `\n${fail} FAILED ✗`);
process.exit(fail === 0 ? 0 : 1);
