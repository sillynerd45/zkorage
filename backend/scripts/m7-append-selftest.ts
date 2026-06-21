// M7 self-test — randomized batch appends (timing defense #2), store-level, no chain.
//   cd backend && rm -f /tmp/zkm7-elig.json && \
//     DR2_ELIGIBLE_FILE=/tmp/zkm7-elig.json npx tsx scripts/m7-append-selftest.ts
//
// Validates addEligibleBatch: existing leaves keep their index (witnesses stay valid), the NEW batch is appended
// in the injected (here: reversed) order to prove approval-order != leaf-order, duplicates are skipped, the tree
// root is stable+recomputable, and a member's witness still folds to the pinned root after a randomized batch.
import { addEligible, addEligibleBatch, getEligible, indexOfCommitment } from "../src/eligible-store.js";
import { buildEligibleTree, idCommitment, toHex, fromHex } from "../src/membership.js";

let failures = 0;
const ok = (c: boolean, label: string) => {
  console.log(`${c ? "✓" : "✗"} ${label}`);
  if (!c) failures++;
};

const ROOM = "bb".repeat(32);
// Distinct commitments derived from distinct secrets (so they are valid leaves we can witness against).
const member = (n: number) => {
  const idSecret = new Uint8Array(32).fill(n + 1);
  const idTrapdoor = new Uint8Array(32).fill(0x80 + n);
  return { idSecret, idTrapdoor, commitment: toHex(idCommitment(idSecret, idTrapdoor)) };
};
const M = Array.from({ length: 6 }, (_, n) => member(n));

// Seed two existing members one-at-a-time (the legacy single-approve path), recording their indices.
ok(addEligible(ROOM, M[0].commitment).index === 0, "existing member 0 at index 0");
ok(addEligible(ROOM, M[1].commitment).index === 1, "existing member 1 at index 1");

// Batch-append the next four in REVERSED order (deterministic injected order = the opposite of approval order).
const approvalOrder = [M[2].commitment, M[3].commitment, M[4].commitment, M[5].commitment];
const { added, skipped } = addEligibleBatch(ROOM, approvalOrder, (a) => [...a].reverse());
ok(added.length === 4 && skipped.length === 0, "batch appended four new members");
ok(getEligible(ROOM).length === 6, "set now holds six members");

// Existing leaves untouched (their indices, hence witnesses, are stable).
ok(indexOfCommitment(ROOM, M[0].commitment) === 0 && indexOfCommitment(ROOM, M[1].commitment) === 1, "existing leaves keep their index");

// The NEW batch landed in the injected (reversed) order, NOT approval order -> approval order is decoupled
// from leaf position.
const newOrder = added.map((a) => a.commitment);
ok(JSON.stringify(newOrder) === JSON.stringify([...approvalOrder].reverse()), "new leaves are in the shuffled order, not approval order");
ok(indexOfCommitment(ROOM, M[5].commitment) === 2, "the last-approved member took the first free slot (shuffled)");
ok(indexOfCommitment(ROOM, M[2].commitment) === 5, "the first-approved member took the last slot (shuffled)");

// Duplicates (already-eligible + repeated in input) are skipped, no growth.
const dup = addEligibleBatch(ROOM, [M[0].commitment, M[3].commitment, M[3].commitment]);
ok(dup.added.length === 0 && dup.skipped.length === 3, "already-eligible + repeated commitments are skipped");
ok(getEligible(ROOM).length === 6, "skipped duplicates did not grow the set");

// The root is recomputable and a shuffled member's witness still folds to it (the proof is unaffected by the
// shuffle — the leaf index is just where the path starts).
const commitments = getEligible(ROOM).map((h) => fromHex(h));
const { root, witness } = buildEligibleTree(commitments);
const idx5 = indexOfCommitment(ROOM, M[5].commitment);
const w = witness(idx5);
// Re-fold M5's leaf up through the siblings and confirm it reaches the pinned root.
const { sha256 } = await import("@noble/hashes/sha256");
const node = (a: Uint8Array, b: Uint8Array) => sha256(new Uint8Array([0x01, ...a, ...b]));
let acc = idCommitment(M[5].idSecret, M[5].idTrapdoor);
let li = w.leafIndex;
for (let d = 0; d < 20; d++) {
  const sib = w.siblings.slice(d * 32, d * 32 + 32);
  acc = (li & 1) === 0 ? node(acc, sib) : node(sib, acc);
  li >>= 1;
}
ok(toHex(acc) === toHex(root), "a shuffled member's witness still folds to the pinned root");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
