// M1 self-test — request-then-approve enrollment math + store, end to end, no server/chain.
//   cd backend && rm -f /tmp/zkm1-*.json && \
//     DR2_ELIGIBLE_FILE=/tmp/zkm1-elig.json DR2_ENROLL_FILE=/tmp/zkm1-enroll.json npx tsx scripts/m1-enroll-selftest.ts
//
// Simulates: members REQUEST -> owner APPROVES (append to the eligible set + recompute the root) -> an
// approved member can build a Merkle witness that folds to the pinned root (provable); a non-member cannot;
// reject drops a pending request. This validates the enrollment math + both stores; the HTTP wiring + the
// on-chain set_eligible_root / request_access proof are covered by the frontend (M1) and M3.
import { addRequest, listRequests, removeRequest, hasRequest } from "../src/enroll-store.js";
import { getEligible, addEligible, indexOfCommitment } from "../src/eligible-store.js";
import { buildEligibleTree, buildMembershipJob, freshIdentity, toHex, fromHex } from "../src/membership.js";

let failures = 0;
const ok = (c: boolean, label: string) => {
  console.log(`${c ? "✓" : "✗"} ${label}`);
  if (!c) failures++;
};

const ROOM = "a".repeat(64);
const recipientPub = new Uint8Array(32).fill(0xad);
type Member = ReturnType<typeof freshIdentity>;
const m1 = freshIdentity();
const m2 = freshIdentity();
const m3 = freshIdentity(); // never approved
const C = (m: Member) => toHex(m.commitment);
const rootOf = () => toHex(buildEligibleTree(getEligible(ROOM).map(fromHex)).root);
const jobFor = (m: Member, idx: number) =>
  buildMembershipJob({
    idSecret: m.idSecret,
    idTrapdoor: m.idTrapdoor,
    roomId: fromHex(ROOM),
    holderSeed: m.holderSeed,
    recipientPub,
    commitments: getEligible(ROOM).map(fromHex),
    memberIndex: idx,
  });

// ---- request ----
addRequest(ROOM, { commitment: C(m1), label: "Alice", ts: 1 });
addRequest(ROOM, { commitment: C(m2), label: "Bob", ts: 2 });
ok(listRequests(ROOM).length === 2, "two pending requests filed");
ok(hasRequest(ROOM, C(m1)), "m1 is pending");
ok(indexOfCommitment(ROOM, C(m1)) === -1, "pending is not eligible yet (no on-chain effect)");

// ---- approve m1 (server does: addEligible + removeRequest, then set_eligible_root) ----
addEligible(ROOM, C(m1));
removeRequest(ROOM, C(m1));
ok(indexOfCommitment(ROOM, C(m1)) === 0 && !hasRequest(ROOM, C(m1)), "approve moves m1 pending -> eligible[0]");
ok(listRequests(ROOM).length === 1, "m2 remains pending");
const root1 = rootOf();
ok(jobFor(m1, 0).eligibleRoot === root1, "m1 witness folds to the pinned root (provable)");

// ---- approve m2: the root rotates; both members re-prove against the new root ----
addEligible(ROOM, C(m2));
removeRequest(ROOM, C(m2));
const root2 = rootOf();
ok(root2 !== root1, "adding a member rotates the eligible root");
ok(jobFor(m2, 1).eligibleRoot === root2, "m2 (index 1) witness folds to the new root");
ok(jobFor(m1, 0).eligibleRoot === root2, "m1 re-proves against the new root after the append");

// ---- non-member cannot build a valid witness ----
ok(indexOfCommitment(ROOM, C(m3)) === -1, "m3 (never approved) is not eligible");
let threw = false;
try {
  jobFor(m3, 0);
} catch {
  threw = true;
}
ok(threw, "a non-member cannot build a membership witness (commitment mismatch)");

// ---- reject drops a pending request ----
addRequest(ROOM, { commitment: C(m3), ts: 3 });
ok(hasRequest(ROOM, C(m3)), "m3 filed a request");
ok(removeRequest(ROOM, C(m3)) === true && !hasRequest(ROOM, C(m3)), "reject removes the pending request");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
