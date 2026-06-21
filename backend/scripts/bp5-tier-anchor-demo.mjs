// BP5 — seed a STABLE, deterministic anonymous-tier demo on testnet (idempotent).
//   The fixed demo identity (id 0x11/0x22, holder 0x03 -> accessor ed4928c6, the same demo member as
//   DR2/DR3/DR6) holds a live tier grant for the demo tier (floor 100 zkUSD, X = 1_800_000_000 ~2027-01-15):
//   an enrolled member AND a non-revocable qualifying bond, proven ANONYMOUSLY. The on-chain grant reveals
//   neither which member nor which lock. On re-run it checks is_granted on-chain and skips the (slow) proof
//   if the demo accessor is already granted.
// Usage: BASE=https://apizk.wazowsky.id node scripts/bp5-tier-anchor-demo.mjs   (seeds the VM backend; prover online)
import { sha256 } from "@noble/hashes/sha256";

const BASE = process.env.BASE || "http://localhost:8787";
const THRESHOLD = process.env.TIER_THRESHOLD || "1000000000"; // 100 zkUSD
const X = Number(process.env.TIER_X || 1800000000); // ~2027-01-15 (the shared demo deadline)
const BOND_TOKEN = "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5";
const DEPOSITOR = process.env.DEPLOYER || "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const TIER_IMAGE = "2671938b59598c129913fee8e0ef29159e6475dd61c37c503429bdaf0fba4e69";
const ID_SECRET = "11".repeat(32);
const ID_TRAPDOOR = "22".repeat(32);
const HOLDER_SEED = "03".repeat(32);
const ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";
const PROOF_TIMEOUT_MS = 15 * 60 * 1000;

const enc = (s) => new TextEncoder().encode(s);
const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const toHex = (u) => Buffer.from(u).toString("hex");
const cat = (...p) => { const n = p.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
// member leaf = sha256(0x00 ‖ id_secret ‖ id_trapdoor); qual commitment = sha256(0x03 ‖ id_secret ‖ "escrow")
const idCommitment = toHex(sha256(cat(new Uint8Array([0]), fromHex(ID_SECRET), fromHex(ID_TRAPDOOR))));
const qualCommitment = toHex(sha256(cat(new Uint8Array([3]), fromHex(ID_SECRET), enc("escrow"))));

const jpost = async (p, b) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }); return [r.status, await r.json().catch(() => ({}))]; };
const jget = async (p) => { const r = await fetch(BASE + p); return [r.status, await r.json().catch(() => ({}))]; };
async function pollProof(jobId) {
  const t0 = Date.now();
  for (;;) {
    const [, s] = await jget(`/prove-status/${jobId}`);
    if (s.status === "done") { process.stdout.write("\n"); return s.bundle; }
    if (s.status === "error") throw new Error("prover error: " + s.error);
    if (Date.now() - t0 > PROOF_TIMEOUT_MS) throw new Error("proof timeout");
    process.stdout.write(`  …${s.status}/${s.by || "-"}`);
    await new Promise((r) => setTimeout(r, 12000));
  }
}

console.log(`[bp5-demo] BASE=${BASE} accessor=${ACCESSOR.slice(0, 12)}… qc=${qualCommitment.slice(0, 12)}…`);

// 0. idempotency: if the demo accessor already holds a live grant, we are done.
let [, st0] = await jget(`/bonded/tier/status?accessor=${ACCESSOR}`);
if (st0.is_granted) {
  console.log("[bp5-demo] demo accessor already holds a live tier grant — nothing to do");
  process.exit(0);
}

// 1. enroll the fixed demo member (by its id_commitment, NOT a mint — deterministic + idempotent).
let [, en] = await jpost("/bonded/tier/enroll", { idCommitment });
if (!en.ok) throw new Error("enroll failed: " + JSON.stringify(en));
console.log(`[bp5-demo] enrolled demo member: index=${en.memberIndex} added=${en.added} count=${en.memberCount}`);

// 2. ensure the demo's qualifying bond exists (skip the deposit if its commitment already qualifies).
let [, qs] = await jget(`/bonded/tier/qual-set?threshold=${THRESHOLD}&unlock_after=${X}`);
const haveLock = (qs.locks || []).some((l) => String(l.commitment).toLowerCase() === qualCommitment);
if (haveLock) {
  console.log("[bp5-demo] demo qualifying bond already present — skipping deposit");
} else {
  let [, d] = await jpost("/escrow/deposit", { from: DEPOSITOR, token: BOND_TOKEN, amount: THRESHOLD, unlock_time: X, claimant: DEPOSITOR, commitment: qualCommitment, revocable: false });
  if (!d.ok) throw new Error("deposit failed: " + JSON.stringify(d));
  console.log(`[bp5-demo] demo qualifying bond deposited: lockId=${d.lockId} tx=${String(d.txHash).slice(0, 10)}…`);
}

// 3. pin the member root + publish the qual root on-chain (idempotent).
let [, sr] = await jpost("/bonded/tier/set-member-root", {});
console.log(`[bp5-demo] member root pinned: ${String(sr.memberRoot).slice(0, 12)}… (tx ${String(sr.txHash).slice(0, 10)}…)`);
let [, qr] = await jpost("/bonded/tier/qual-root", { threshold: THRESHOLD, unlock_after: X });
if (!qr.ok) throw new Error("qual-root failed: " + JSON.stringify(qr));
console.log(`[bp5-demo] qual root published: ${String(qr.qualRoot).slice(0, 12)}… anonSet=${qr.anonSetSize} (tx ${String(qr.txHash).slice(0, 10)}…)`);

// 4. prove anonymously (worker-first) + submit -> the demo grant.
console.log("[bp5-demo] proving the demo tier (worker-first)…");
let [, pa] = await jpost("/bonded/tier/prove", { idSecret: ID_SECRET, idTrapdoor: ID_TRAPDOOR, holderSeed: HOLDER_SEED, threshold: THRESHOLD, unlock_after: X });
if (!pa.jobId) throw new Error("prove failed: " + JSON.stringify(pa));
if (pa.accessor !== ACCESSOR) throw new Error(`accessor mismatch: got ${pa.accessor}, expected ${ACCESSOR}`);
const bundle = await pollProof(pa.jobId);
if (bundle?.image_id !== TIER_IMAGE) throw new Error("non-canonical tier image: " + bundle?.image_id);
let [, sub] = await jpost("/bonded/tier/submit", bundle);
if (!sub.ok) throw new Error("submit failed: " + JSON.stringify(sub));
console.log(`[bp5-demo] tier GRANT: tx=${String(sub.txHash).slice(0, 10)}…`);

// 5. confirm + print the stable demo record.
let [, st] = await jget(`/bonded/tier/status?accessor=${ACCESSOR}`);
console.log("\n===== BP5 STABLE TIER DEMO =====");
console.log(JSON.stringify({ accessor: ACCESSOR, threshold: THRESHOLD, unlockAfter: X, is_granted: st.is_granted, tierGateId: st.tierGateId }, null, 2));
console.log(st.is_granted ? "\nBP5 tier demo seeded + granted ✓" : "\nBP5 tier demo NOT granted ✗");
process.exit(st.is_granted ? 0 : 1);
