// TRUE bond-only (no-approval) e2e — the decisive validation of Room Management's Bonded Access. A reader who
// was NEVER approved and is NOT enrolled opens a bond-only room end-to-end:
//   1. create a fresh relay-owned room, set it BOND-ONLY (mode "open") with the demo requirement (zkUSD,
//      >=100, locked until the shared demo deadline) — the SAME req_id whose qual_root the demo seed published
//      (>=3 bonders, incl. the demo holder), so the bond-open proof has a real anonymity crowd;
//   2. prove a SINGLE bond-open proof for the demo holder (real GPU; carries its OWN proof-bound recipient_pub
//      = the demo recipient, so the keepers can seal the key WITHOUT a membership grant) and submit it;
//   3. confirm is_open_granted + is_doc_admitted (no membership, no eligible_root, no approval);
//   4. store a committee document and OPEN it through the live keeper committee, verifying the plaintext —
//      this exercises admission_recipient_pub (the keepers read the recipient_pub from the BOND-OPEN grant).
// Run AFTER ba1-bond-anchor-demo.mjs (which publishes the qual_root + funds the bonds).
// Usage: BASE=https://apizk.wazowsky.id node scripts/bondonly-e2e.mjs
import { sha256 } from "@noble/hashes/sha256";
import { x25519 } from "@noble/curves/ed25519";

const BASE = process.env.BASE || "http://localhost:8787";
const enc = (s) => new TextEncoder().encode(s);
const toHex = (u) => Buffer.from(u).toString("hex");
const ROOM = toHex(sha256(enc("zkorage-bondonly-e2e-room-v1")));
const DOC = toHex(sha256(enc("zkorage-bondonly-e2e-doc-v1")));
const ID_SECRET = "11".repeat(32), ID_TRAPDOOR = "22".repeat(32), HOLDER_SEED = "03".repeat(32);
const ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";
const RECIPIENT_PUB = toHex(x25519.getPublicKey(sha256(enc("zkorage-demo-dataroom-recipient-key"))));
const TOKEN = process.env.BOND_TOKEN || "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5"; // zkUSD
const MIN = process.env.BOND_MIN || "1000000000";
const DEADLINE = Number(process.env.BOND_DEADLINE || 1900000000);
const CONTENT =
  "zkorage TRUE bond-only — this committee document opened with NO approval and NO membership. The reader " +
  "proved a single bond-open proof carrying its own recipient key; the keepers sealed the document key to it " +
  "and never identified the reader. The bond is the only gate.";
const PROOF_TIMEOUT_MS = 12 * 60 * 1000;

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

console.log(`[bondonly] BASE=${BASE} room=${ROOM.slice(0, 12)}... accessor=${ACCESSOR.slice(0, 12)}... recipient=${RECIPIENT_PUB.slice(0, 12)}...`);

// pre: the requirement must have a qualifying crowd (>= the floor) incl. the demo holder.
let [, qs] = await jget(`/bonded/bond/qual-set?token=${TOKEN}&min_amount=${MIN}&deadline=${DEADLINE}`);
console.log(`[bondonly] qual set: anonSet=${qs.anonSetSize} belowMin=${qs.belowMin} reqId=${String(qs.reqId).slice(0, 12)}...`);
if (!qs.anonSetSize || qs.belowMin) throw new Error("qual set below the floor — run ba1-bond-anchor-demo.mjs first to seed the bonds");

// 1) fresh relay-owned room, set BOND-ONLY (mode "open").
let [, cr] = await jpost("/dataroom/create-room", { roomId: ROOM });
console.log(`[bondonly] room ${cr.ok ? "created" : "exists"} owner=${String(cr.owner || "relay").slice(0, 6)}...`);
let [bs, br] = await jpost("/dataroom/bond-requirement", { roomId: ROOM, token: TOKEN, min_amount: MIN, deadline: DEADLINE, mode: "open" });
if (bs !== 200 || !br.ok) throw new Error("set bond-only requirement failed: " + JSON.stringify(br));
console.log(`[bondonly] bond-only requirement set: mode=${br.mode} reqId=${String(br.reqId).slice(0, 12)}...`);
let [, breq] = await jget(`/dataroom/bond-requirement/${ROOM}`);
if (!breq.bondOpen) throw new Error("room is not bond-only after set (is_bond_open=false)");
console.log(`[bondonly] is_bond_open=${breq.bondOpen} ✓`);

// 2) prove a SINGLE bond-open proof (real GPU) for the demo holder, carrying the demo recipient_pub, + submit.
let [, st0] = await jget(`/bonded/bond-open/status?accessor=${ACCESSOR}&req_id=${breq.reqId}`);
if (st0.is_granted) {
  console.log("[bondonly] bond-open grant already present — skipping the proof");
} else {
  console.log("[bondonly] proving bond-open (worker-first; a few minutes)...");
  let [, pa] = await jpost("/bonded/bond-open/prove", { idSecret: ID_SECRET, idTrapdoor: ID_TRAPDOOR, holderSeed: HOLDER_SEED, recipientPub: RECIPIENT_PUB, token: TOKEN, min_amount: MIN, deadline: DEADLINE });
  if (!pa.jobId) throw new Error("bond-open prove failed: " + JSON.stringify(pa));
  const bundle = await pollProof(pa.jobId);
  let [, sub] = await jpost("/bonded/bond-open/submit", bundle);
  if (!sub.ok) throw new Error("bond-open submit failed: " + JSON.stringify(sub));
  console.log(`[bondonly] bond-open GRANT tx=${String(sub.txHash).slice(0, 10)}...`);
}

// 3) the no-approval admission checks.
let [, st] = await jget(`/bonded/bond-open/status?accessor=${ACCESSOR}&req_id=${breq.reqId}`);
console.log(`[bondonly] is_open_granted=${st.is_granted} recipientPub=${String(st.recipientPub).slice(0, 12)}...`);
let [, adm] = await jget(`/dataroom/doc-admitted/${ROOM}/${DOC}/${ACCESSOR}`);
console.log(`[bondonly] is_doc_admitted=${adm.isDocAdmitted} (no membership, no eligible_root, no approval)`);

// 4) store the committee document + OPEN it via the keepers (validates admission_recipient_pub).
let [, cd] = await jget(`/dataroom/committee/document/${ROOM}/${DOC}`);
if (!cd.document) {
  let [ss, seal] = await jpost("/dataroom/committee/seal-doc", { roomId: ROOM, docId: DOC, content: CONTENT });
  if (ss !== 200 || !seal.ok) throw new Error("seal-doc failed: " + JSON.stringify(seal));
  console.log(`[bondonly] committee doc anchored: dealt=${seal.dealt} contentHash=${String(seal.contentHash).slice(0, 12)}...`);
}
let [, open] = await jpost(`/dataroom/committee/open/${ROOM}/${DOC}`, { accessor: ACCESSOR });
const ok = st.is_granted && adm.isDocAdmitted && open.ok && open.faithful && open.content === CONTENT;

console.log("\n===== TRUE bond-only OPEN E2E =====");
console.log(JSON.stringify({ room: ROOM, doc: DOC, accessor: ACCESSOR, bondOnly: breq.bondOpen, is_open_granted: st.is_granted, is_doc_admitted: adm.isDocAdmitted, recipientPub: st.recipientPub, faithful: open.faithful, contentMatch: open.content === CONTENT, error: open.error }, null, 2));
console.log(ok ? "\nTRUE bond-only OPEN e2e GREEN — a NEVER-APPROVED reader opened a bond-only room (bond is the only gate)" : "\nTRUE bond-only OPEN e2e FAILED");
process.exit(ok ? 0 : 1);
