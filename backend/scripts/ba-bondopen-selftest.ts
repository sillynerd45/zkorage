// TRUE bond-only — JS<->guest<->gate byte-exactness cross-check (offline; no RISC0, no network). Reproduces
// the EXACT 221-byte journal the bond-OPEN guest (host_bond_open ZKORAGE_EXEC_ONLY) emits for its DEMO defaults
//   id_secret = 0x11*32, id_trapdoor = 0x22*32, holder_seed = 0x03*32, recipient_pub = 0x44*32,
//   token = 0x7A*32, min_amount = 1_000_000_000, deadline = 9_999_999_999, context = req_id
// and asserts: (a) the gate's on-chain req_id = sha256(journal[37..93]) equals the backend reqId; (b) the
// bond-open journal field offsets/layout; (c) the NEW-5 holder sig verifies over the bond-OPEN domain AND binds
// recipient_pub; (d) the qual tree, nullifier, and accessor reproduce the shared derivations.
// Run:  npx tsx scripts/ba-bondopen-selftest.ts
// LATER (VM): `ZKORAGE_EXEC_ONLY=1 host_bond_open` prints `EXEC journal=<hex>` — it MUST equal the journal this
// script prints (the definitive guest<->backend byte-exactness gate before pinning the bond-open image).
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import { nullifier } from "../src/membership.js";
import { qualCommitment, buildSparseTree } from "../src/tier.js";
import { bondOpenHolderSign, i128be } from "../src/bond.js";
import { toHex } from "../src/envelope.js";

(ed.etc as { sha512Sync?: (...m: Uint8Array[]) => Uint8Array }).sha512Sync = (...m) =>
  sha512(ed.etc.concatBytes(...m));

const fill = (b: number) => new Uint8Array(32).fill(b);
const ZERO32 = new Uint8Array(32);

const idSecret = fill(0x11);
const holderSeed = fill(0x03);
const recipientPub = fill(0x44);
const token32 = fill(0x7a); // host_bond_open demo: a raw 32-byte token id
const minAmount = 1_000_000_000n;
const deadline = 9_999_999_999n;

// Shared anchors (same idSecret/holder pubkey as the bond + tier guests).
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

console.log("TRUE bond-only guest<->backend<->gate byte-exactness cross-check\n");

// 1) req_id = sha256(token32 ‖ i128be(min) ‖ u64be(deadline)) — IDENTICAL to the bond path (so the same ring).
const minBe = i128be(minAmount);
checkTrue("i128be(min) is 16 bytes", minBe.length === 16, toHex(minBe));
const reqId = sha256(concat(token32, minBe, u64be(deadline)));
const reqIdHex = toHex(reqId);
console.log(`     req_id = ${reqIdHex}`);

// 2) shared derivations (qual root + accessor + nullifier match the bond/tier guests).
const qualTree = buildSparseTree([qualCommitment(idSecret)], ZERO32);
const qualRoot = qualTree.root;
const { accessor, sig } = bondOpenHolderSign(holderSeed, reqId, recipientPub); // context == req_id
const nf = nullifier(idSecret, reqId);
check("qual_root (shared w/ tier/bond)", toHex(qualRoot), EXPECT_QUAL_ROOT);
check("accessor  (shared w/ tier/bond)", toHex(accessor), EXPECT_ACCESSOR);

// 3) NEW-5 holder sig verifies over "zkorage-bond-open-v1" ‖ context ‖ accessor ‖ recipient_pub (binds the key).
const sigMsg = concat(new TextEncoder().encode("zkorage-bond-open-v1"), reqId, accessor, recipientPub);
checkTrue("NEW-5 bond-open holder sig verifies + binds recipient_pub", ed.verify(sig, sigMsg, accessor));

// 4) Assemble the EXACT 221-byte bond-open journal the guest commits, then validate the gate's parsing.
const j = new Uint8Array(221);
j[0] = 1;
j.set(new Uint8Array([0, 0, 0, 15]), 1); // claim_type 15 (u32 BE)
j.set(qualRoot, 5);
j.set(token32, 37);
j.set(minBe, 69);
j.set(u64be(deadline), 85);
j.set(reqId, 93); // context == req_id
j.set(nf, 125);
j.set(accessor, 157);
j.set(recipientPub, 189);

checkTrue("journal length == 221", j.length === 221);
check("journal claim_type field", toHex(j.slice(1, 5)), "0000000f"); // 15
// The gate computes req_id = sha256(journal[37..93]) on-chain — validates the contiguous span + offsets.
check("gate req_id = sha256(journal[37..93])", toHex(sha256(j.slice(37, 93))), reqIdHex);
check("journal qual_root [5..37]", toHex(j.slice(5, 37)), toHex(qualRoot));
check("journal token [37..69]", toHex(j.slice(37, 69)), toHex(token32));
check("journal min_amount [69..85]", toHex(j.slice(69, 85)), toHex(minBe));
check("journal deadline [85..93]", toHex(j.slice(85, 93)), toHex(u64be(deadline)));
check("journal context [93..125] == req_id", toHex(j.slice(93, 125)), reqIdHex);
check("journal nullifier [125..157]", toHex(j.slice(125, 157)), toHex(nf));
check("journal accessor [157..189]", toHex(j.slice(157, 189)), toHex(accessor));
check("journal recipient_pub [189..221]", toHex(j.slice(189, 221)), toHex(recipientPub));

console.log(`\n     EXPECTED guest journal (cross-check vs host_bond_open EXEC_ONLY on the VM):\n     ${toHex(j)}`);

console.log(`\n${ok ? "ALL OK" : "FAILURES ABOVE"}`);
process.exit(ok ? 0 : 1);
