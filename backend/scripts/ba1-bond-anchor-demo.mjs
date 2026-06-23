// BA6 — seed a STABLE, >= 3-member Bonded Access demo on testnet (idempotent). A demo Data Room requires an
// anonymous bond (zkUSD, at least 100, locked until X). THREE fixed members each lock a real NON-revocable
// qualifying bond (the anonymity crowd, N = 3), and ONE member (the shared demo accessor ed4928c6) proves the
// bond through the LIVE GPU prover, so is_doc_admitted(room, doc, accessor) = true. The bond proof ALSO proves
// room membership (Option A). On a re-run it skips the slow proof if the demo accessor already holds a grant,
// and every setup step is idempotent, so the room stays ready for a live user to be the 4th bonder.
//
// Usage: BASE=http://localhost:8787 node scripts/ba1-bond-anchor-demo.mjs   (the backend must reach the prover)
import { sha256 } from "@noble/hashes/sha256";
import { ZkorageClient } from "zkorage-sdk";

const BASE = process.env.BASE || "http://localhost:8787";
const TOKEN = process.env.BOND_TOKEN || "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5"; // zkUSD SAC
const MIN = process.env.BOND_MIN || "1000000000"; // 100 zkUSD (1e9 base units, 7 decimals)
const DEADLINE = Number(process.env.BOND_DEADLINE || 1900000000); // ~2030-03 (the shared demo deadline)
const DEPOSITOR = process.env.DEPLOYER || "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const BOND_IMAGE = "dc4da02d887b3f388ffee26860a8416b393d4cfea982831183d15d5bfcf1f6c4";
const PROOF_TIMEOUT_MS = 18 * 60 * 1000;

const enc = (s) => new TextEncoder().encode(s);
const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const toHex = (u) => Buffer.from(u).toString("hex");
const cat = (...p) => { const n = p.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
// member leaf = sha256(0x00 | id_secret | id_trapdoor); qual commitment = sha256(0x03 | id_secret | "escrow")
const idCommitment = (s, t) => toHex(sha256(cat(new Uint8Array([0]), fromHex(s), fromHex(t))));
const qualCommitment = (s) => toHex(sha256(cat(new Uint8Array([3]), fromHex(s), enc("escrow"))));

// A stable, label-derived demo room id (same on every run, both for the backend and the SDK read).
const ROOM = toHex(sha256(enc("zkorage-bonded-access-demo-v1")));
const DOC = toHex(sha256(enc("zkorage-bonded-access-demo-doc-v1")));

// Three fixed demo members. Member 1 is the shared demo accessor (holder 0x03 -> ed4928c6), the one we prove.
const MEMBERS = [
  { name: "m1", idSecret: "11".repeat(32), idTrapdoor: "22".repeat(32), holderSeed: "03".repeat(32),
    accessor: "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1" },
  { name: "m2", idSecret: "44".repeat(32), idTrapdoor: "55".repeat(32), holderSeed: "06".repeat(32) },
  { name: "m3", idSecret: "77".repeat(32), idTrapdoor: "88".repeat(32), holderSeed: "09".repeat(32) },
];
const PROVER = MEMBERS[0];

const jpost = async (p, b) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }); return [r.status, await r.json().catch(() => ({}))]; };
const jget = async (p) => { const r = await fetch(BASE + p); return [r.status, await r.json().catch(() => ({}))]; };
async function pollProof(jobId) {
  const t0 = Date.now();
  for (;;) {
    const [, s] = await jget(`/prove-status/${jobId}`);
    if (s.status === "done") { process.stdout.write("\n"); return s.bundle; }
    if (s.status === "error") throw new Error("prover error: " + s.error);
    if (Date.now() - t0 > PROOF_TIMEOUT_MS) throw new Error("proof timeout");
    process.stdout.write(`  ...${s.status}/${s.by || "-"}`);
    await new Promise((r) => setTimeout(r, 12000));
  }
}

console.log(`[ba6-demo] BASE=${BASE} room=${ROOM.slice(0, 12)}... token=${TOKEN.slice(0, 8)}... min=${MIN} deadline=${DEADLINE}`);

// req_id for the requirement (read it from the qual-set helper so it matches the indexer exactly).
let [, qs0] = await jget(`/bonded/bond/qual-set?token=${TOKEN}&min_amount=${MIN}&deadline=${DEADLINE}`);
const REQ = qs0.reqId;
if (!REQ) throw new Error("could not read req_id from qual-set: " + JSON.stringify(qs0));
console.log(`[ba6-demo] req_id=${REQ.slice(0, 12)}...`);

// 1. create the demo room (relay-owned; idempotent — already-exists is fine).
let [, cr] = await jpost("/dataroom/create-room", { roomId: ROOM });
console.log(`[ba6-demo] room ${cr.ok ? "created" : "exists"} owner=${String(cr.owner || "relay").slice(0, 6)}... tx=${String(cr.txHash || "-").slice(0, 10)}...`);

// 2. enroll the three demo members (register their public commitments; idempotent), then pin the eligible root.
for (const m of MEMBERS) {
  const c = idCommitment(m.idSecret, m.idTrapdoor);
  await jpost("/dataroom/membership/register", { roomId: ROOM, idCommitment: c });
  console.log(`[ba6-demo] enrolled ${m.name}: commitment ${c.slice(0, 10)}...`);
}
let [, sr] = await jpost("/dataroom/membership/set-root", { roomId: ROOM });
if (!sr.ok) throw new Error("set-root failed: " + JSON.stringify(sr));
const MEMBER_ROOT = sr.eligibleRoot;
console.log(`[ba6-demo] eligible_root pinned: ${MEMBER_ROOT.slice(0, 12)}... members=${sr.memberCount} (tx ${String(sr.txHash).slice(0, 10)}...)`);

// 3. ensure the depositor has enough zkUSD for three bonds, then lock each member's qualifying bond
//    (NON-revocable, the demo token, >= MIN, until DEADLINE, commitment = sha256(0x03|id_secret|"escrow")).
let [, bal] = await jget(`/escrow/balance?owner=${DEPOSITOR}`);
if (BigInt(bal.balance || "0") < BigInt(MIN) * 3n) {
  let [, f] = await jpost("/escrow/faucet", { to: DEPOSITOR });
  console.log(`[ba6-demo] faucet minted ${f.minted || "?"} zkUSD to the depositor (tx ${String(f.txHash || "-").slice(0, 10)}...)`);
}
let [, qs] = await jget(`/bonded/bond/qual-set?token=${TOKEN}&min_amount=${MIN}&deadline=${DEADLINE}`);
const have = new Set((qs.locks || []).map((l) => String(l.commitment).toLowerCase()));
for (const m of MEMBERS) {
  const qc = qualCommitment(m.idSecret);
  if (have.has(qc)) { console.log(`[ba6-demo] ${m.name} bond already present (${qc.slice(0, 10)}...)`); continue; }
  let [, d] = await jpost("/escrow/deposit", { from: DEPOSITOR, token: TOKEN, amount: MIN, unlock_time: DEADLINE, claimant: DEPOSITOR, commitment: qc, revocable: false });
  if (!d.ok) throw new Error(`deposit for ${m.name} failed: ` + JSON.stringify(d));
  console.log(`[ba6-demo] ${m.name} bond locked: lockId=${d.lockId} commitment ${qc.slice(0, 10)}... (tx ${String(d.txHash).slice(0, 10)}...)`);
}

// 4. publish the qualifying-set root for the requirement (refuses below the anonymity floor of 3).
let [, qr] = await jpost("/bonded/bond/qual-root", { token: TOKEN, min_amount: MIN, deadline: DEADLINE });
if (!qr.ok) throw new Error("qual-root failed: " + JSON.stringify(qr));
console.log(`[ba6-demo] qual_root published: ${String(qr.qualRoot).slice(0, 12)}... anonSet=${qr.anonSetSize} (tx ${String(qr.txHash).slice(0, 10)}...)`);

// 5. set the room's bond requirement (relay owns the demo room).
let [, br] = await jpost("/dataroom/bond-requirement", { roomId: ROOM, token: TOKEN, min_amount: MIN, deadline: DEADLINE });
if (!br.ok) throw new Error("set bond-requirement failed: " + JSON.stringify(br));
console.log(`[ba6-demo] bond requirement set on the room (members=${br.memberCount}, tx ${String(br.txHash).slice(0, 10)}...)`);

// 6. prove member 1's bond anonymously (worker-first) + submit -> the demo grant. Skip if already granted.
let [, st0] = await jget(`/bonded/bond/status?accessor=${PROVER.accessor}&req_id=${REQ}&member_root=${MEMBER_ROOT}`);
if (st0.is_granted_for) {
  console.log("[ba6-demo] demo accessor already holds a live bond grant for this room — skipping the proof");
} else {
  console.log("[ba6-demo] proving member 1's bond (worker-first; this can take a few minutes)...");
  let [, pa] = await jpost("/bonded/bond/prove", { roomId: ROOM, idSecret: PROVER.idSecret, idTrapdoor: PROVER.idTrapdoor, holderSeed: PROVER.holderSeed, token: TOKEN, min_amount: MIN, deadline: DEADLINE });
  if (!pa.jobId) throw new Error("prove failed: " + JSON.stringify(pa));
  if (pa.accessor !== PROVER.accessor) throw new Error(`accessor mismatch: got ${pa.accessor}, expected ${PROVER.accessor}`);
  const bundle = await pollProof(pa.jobId);
  if (bundle?.image_id !== BOND_IMAGE) throw new Error("non-canonical bond image: " + bundle?.image_id);
  let [, sub] = await jpost("/bonded/bond/submit", bundle);
  if (!sub.ok) throw new Error("submit failed: " + JSON.stringify(sub));
  console.log(`[ba6-demo] bond GRANT: tx=${String(sub.txHash).slice(0, 10)}...`);
}

// 7. confirm: the gate's room-binding decision + the DataRoom's is_doc_admitted (read straight from chain).
let [, st] = await jget(`/bonded/bond/status?accessor=${PROVER.accessor}&req_id=${REQ}&member_root=${MEMBER_ROOT}`);
const sdk = new ZkorageClient();
const access = await sdk.canOpenDocument(ROOM, DOC, PROVER.accessor).catch((e) => ({ admitted: false, err: String(e) }));

console.log("\n===== BA6 STABLE BONDED-ACCESS DEMO =====");
console.log(JSON.stringify({
  room: ROOM, doc: DOC, accessor: PROVER.accessor, reqId: REQ, memberRoot: MEMBER_ROOT,
  token: TOKEN, minAmount: MIN, deadline: DEADLINE, anonSet: qr.anonSetSize,
  is_granted_for: st.is_granted_for, is_doc_admitted: access.admitted, bondGateId: st.bondGateId,
}, null, 2));
const ok = st.is_granted_for === true && access.admitted === true;
console.log(ok ? "\nBA6 bonded-access demo seeded + admitted (3 real bonders) OK" : "\nBA6 bonded-access demo NOT fully admitted FAIL");
process.exit(ok ? 0 : 1);
