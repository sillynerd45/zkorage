// BA1 bond — JS<->guest<->gate byte-exactness cross-check (offline; no RISC0, no network). Reproduces the
// EXACT 221-byte journal the bond guest (host_bond ZKORAGE_EXEC_ONLY) emits for its DEMO defaults
//   id_secret = 0x11*32, id_trapdoor = 0x22*32, holder_seed = 0x03*32,
//   token = 0x7A*32, min_amount = 1_000_000_000, deadline = 9_999_999_999, context = req_id
// and asserts: (a) the gate's on-chain req_id = sha256(journal[69..125]) equals the backend reqId; (b) the
// journal field offsets/layout; (c) the NEW-5 holder sig verifies over the bond domain; (d) the member tree,
// qual tree, nullifier, and accessor reproduce the shared tier/membership derivations. Run:
//   npx tsx scripts/ba1-bond-selftest.ts
// LATER (VM): `ZKORAGE_EXEC_ONLY=1 host_bond` prints `EXEC journal=<hex>` — it MUST equal the journal this
// script prints (the definitive guest<->backend byte-exactness gate before deploying the image).
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import { idCommitment, buildEligibleTree, nullifier } from "../src/membership.js";
import { qualCommitment, buildSparseTree } from "../src/tier.js";
import { bondHolderSign, i128be } from "../src/bond.js";
import { toHex } from "../src/envelope.js";

(ed.etc as { sha512Sync?: (...m: Uint8Array[]) => Uint8Array }).sha512Sync = (...m) =>
  sha512(ed.etc.concatBytes(...m));

const fill = (b: number) => new Uint8Array(32).fill(b);
const ZERO32 = new Uint8Array(32);

const idSecret = fill(0x11);
const idTrapdoor = fill(0x22);
const holderSeed = fill(0x03);
const token32 = fill(0x7a); // host_bond demo: a raw 32-byte token id (not a C-address-derived id here)
const minAmount = 1_000_000_000n;
const deadline = 9_999_999_999n;

// Shared anchors from the canonical tier guest (same idCommitment + qualCommitment + holder pubkey):
const EXPECT_MEMBER_ROOT = "8be678722c84e8bf478cd0c2a8e257bcc599f80d56ad2839e0188a1cace651da";
const EXPECT_QUAL_ROOT = "75c7de57b1536d37bdbc48033e4d01f5a8bd116005be8eb637c1325f45d11c2a";
const EXPECT_ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function u64be(v: bigint): Uint8Array {
  let x = v & ((1n << 64n) - 1n);
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

let ok = true;
function check(name: string, got: string, want: string) {
  const pass = got === want;
  ok = ok && pass;
  console.log(`${pass ? "OK " : "FAIL"}  ${name}: ${got}${pass ? "" : `\n      expected: ${want}`}`);
}
function checkTrue(name: string, cond: boolean, detail = "") {
  ok = ok && cond;
  console.log(`${cond ? "OK " : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
}

console.log("BA1 bond guest<->backend<->gate byte-exactness cross-check\n");

// 1) req_id = sha256(token32 ‖ i128be(min) ‖ u64be(deadline)). Independent encoders here; cross-check i128be.
const minBe = i128be(minAmount);
checkTrue("i128be(min) is 16 bytes", minBe.length === 16, toHex(minBe));
const reqId = sha256(concat(token32, minBe, u64be(deadline)));
const reqIdHex = toHex(reqId);
console.log(`     req_id = ${reqIdHex}`);

// 2) shared derivations (must equal the canonical tier guest — same idCommitment/qualCommitment/holder pubkey)
const memberLeaf = idCommitment(idSecret, idTrapdoor);
const memberTree = buildEligibleTree([memberLeaf]);
const memberRoot = memberTree.root;
const qualTree = buildSparseTree([qualCommitment(idSecret)], ZERO32);
const qualRoot = qualTree.root;
const { accessor, sig } = bondHolderSign(holderSeed, reqId); // context == req_id
const nf = nullifier(idSecret, reqId); // context == req_id
check("member_root (shared w/ tier)", toHex(memberRoot), EXPECT_MEMBER_ROOT);
check("qual_root   (shared w/ tier)", toHex(qualRoot), EXPECT_QUAL_ROOT);
check("accessor    (shared w/ tier)", toHex(accessor), EXPECT_ACCESSOR);

// 3) NEW-5 holder sig verifies over "zkorage-bond-access-v1" ‖ context ‖ accessor
const sigMsg = concat(new TextEncoder().encode("zkorage-bond-access-v1"), reqId, accessor);
checkTrue("NEW-5 holder sig verifies", ed.verify(sig, sigMsg, accessor));

// 4) Assemble the EXACT 221-byte journal the guest commits, then validate the gate's parsing.
const j = new Uint8Array(221);
j[0] = 1;
j.set(new Uint8Array([0, 0, 0, 14]), 1); // claim_type 14 (u32 BE)
j.set(memberRoot, 5);
j.set(qualRoot, 37);
j.set(token32, 69);
j.set(minBe, 101);
j.set(u64be(deadline), 117);
j.set(reqId, 125); // context == req_id
j.set(nf, 157);
j.set(accessor, 189);

checkTrue("journal length == 221", j.length === 221);
check("journal claim_type field", toHex(j.slice(1, 5)), "0000000e"); // 14
// The gate computes req_id = sha256(journal[69..125]) on-chain — this validates the contiguous span + offsets.
check("gate req_id = sha256(journal[69..125])", toHex(sha256(j.slice(69, 125))), reqIdHex);
check("journal context [125..157] == req_id", toHex(j.slice(125, 157)), reqIdHex);
check("journal member_root [5..37]", toHex(j.slice(5, 37)), toHex(memberRoot));
check("journal qual_root [37..69]", toHex(j.slice(37, 69)), toHex(qualRoot));
check("journal token [69..101]", toHex(j.slice(69, 101)), toHex(token32));
check("journal min_amount [101..117]", toHex(j.slice(101, 117)), toHex(minBe));
check("journal deadline [117..125]", toHex(j.slice(117, 125)), toHex(u64be(deadline)));
check("journal nullifier [157..189]", toHex(j.slice(157, 189)), toHex(nf));
check("journal accessor [189..221]", toHex(j.slice(189, 221)), toHex(accessor));

console.log(`\n     EXPECTED guest journal (cross-check vs host_bond EXEC_ONLY on the VM):\n     ${toHex(j)}`);

// 5) 3-leaf qual witness round-trip (catches any off-by-one in the sibling path / direction bits).
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
  check(`qual witness[${idx}]→root`, toHex(node), toHex(tree.root));
}

if (!ok) {
  console.error("\nMISMATCH — the backend/journal derivations diverge from the canonical guest/gate.");
  process.exit(1);
}
console.log("\nAll checks pass. Backend reqId + journal layout are byte-exact with the bond guest + gate.");
