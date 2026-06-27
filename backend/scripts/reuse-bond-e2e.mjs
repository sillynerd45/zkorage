// Live e2e: ONE per-wallet Bonded Access handle, ONE locked bond, ONE bond-open proof -> opens TWO separate
// bond-only rooms that share the same requirement. Validates the reusable-bonds change end-to-end on testnet.
// Idempotent + submit-retry (testnet tx confirmation can lag). Usage: BASE=https://apizk.wazowsky.id node scripts/reuse-bond-e2e.mjs
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { recipientPublicKeyFromSecret } from "zkorage-sdk";

const BASE = process.env.BASE || "https://apizk.wazowsky.id";
const TOKEN = "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5";
const MIN = "1000000000";
const DEADLINE = 1900000000;
const DEPOSITOR = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const PROOF_TIMEOUT_MS = 18 * 60 * 1000;
const enc = (s) => new TextEncoder().encode(s);
const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const toHex = (u) => Buffer.from(u).toString("hex");
const cat = (...p) => { const n = p.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const qualCommitment = (s) => toHex(sha256(cat(new Uint8Array([3]), fromHex(s), enc("escrow"))));
const bondOpenRecipient = (idSecret) => { const secret = toHex(sha256(cat(enc("zkorage-bond-open-recipient-v1"), fromHex(idSecret)))); return { recipientSecret: secret, recipientPub: recipientPublicKeyFromSecret(secret) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    await sleep(12000);
  }
}
async function granted(accessor, req) { const [, st] = await jget(`/bonded/bond-open/status?accessor=${accessor}&req_id=${req}`); return st; }

// A FIXED handle (deterministic), so re-runs are idempotent: the lock + grant persist, and a re-run skips the
// slow proof once the grant exists. Mirrors the frontend handle fields (idSecret/idTrapdoor/holderSeed).
const ID_SECRET = toHex(sha256(enc("zkorage-reuse-e2e-handle-idsecret-v1")));
const ID_TRAPDOOR = toHex(sha256(enc("zkorage-reuse-e2e-handle-trapdoor-v1")));
const HOLDER_SEED = toHex(sha256(enc("zkorage-reuse-e2e-handle-holder-v1")));
const ACCESSOR = toHex(ed25519.getPublicKey(fromHex(HOLDER_SEED)));
const QC = qualCommitment(ID_SECRET);
const RCPT = bondOpenRecipient(ID_SECRET);
const ROOM1 = toHex(sha256(enc("zkorage-reuse-e2e-room1-v1")));
const ROOM2 = toHex(sha256(enc("zkorage-reuse-e2e-room2-v1")));
const DOC1 = toHex(sha256(enc("zkorage-reuse-e2e-doc1-v1")));
const DOC2 = toHex(sha256(enc("zkorage-reuse-e2e-doc2-v1")));
const CONTENT1 = "zkorage reuse e2e — room ONE, opened with the shared Bonded Access handle.";
const CONTENT2 = "zkorage reuse e2e — room TWO, opened with the SAME handle + grant, no re-lock.";

console.log(`[reuse] BASE=${BASE}`);
let [, qs0] = await jget(`/bonded/bond/qual-set?token=${TOKEN}&min_amount=${MIN}&deadline=${DEADLINE}`);
const REQ = qs0.reqId;
console.log(`[reuse] req_id=${REQ.slice(0, 12)}... anonSet=${qs0.anonSetSize} | handle accessor=${ACCESSOR.slice(0, 10)}... qualCommit=${QC.slice(0, 10)}...`);

let st = await granted(ACCESSOR, REQ);
if (!st.is_granted) {
  // ensure the handle's qualifying bond is locked (idempotent).
  const have = new Set((qs0.locks || []).map((l) => String(l.commitment).toLowerCase()));
  if (!have.has(QC.toLowerCase())) {
    let [, bal] = await jget(`/escrow/balance?owner=${DEPOSITOR}`);
    if (BigInt(bal.balance || "0") < BigInt(MIN)) await jpost("/escrow/faucet", { to: DEPOSITOR });
    let [, dep] = await jpost("/escrow/deposit", { from: DEPOSITOR, token: TOKEN, amount: MIN, unlock_time: DEADLINE, claimant: DEPOSITOR, commitment: QC, revocable: false });
    console.log(`[reuse] handle bond locked: lockId=${dep.lockId} ok=${dep.ok}`);
  } else { console.log("[reuse] handle bond already locked"); }
  // prove bond-open ONCE with the handle identity.
  console.log("[reuse] proving bond-open (worker-first; a few minutes)...");
  let [, pa] = await jpost("/bonded/bond-open/prove", { idSecret: ID_SECRET, idTrapdoor: ID_TRAPDOOR, holderSeed: HOLDER_SEED, recipientPub: RCPT.recipientPub, token: TOKEN, min_amount: MIN, deadline: DEADLINE });
  if (!pa.jobId) throw new Error("prove failed: " + JSON.stringify(pa));
  if (pa.accessor && pa.accessor.toLowerCase() !== ACCESSOR.toLowerCase()) throw new Error(`accessor mismatch: ${pa.accessor} vs ${ACCESSOR}`);
  const bundle = await pollProof(pa.jobId);
  // submit with retry: testnet tx confirmation can lag, so poll is_open_granted between attempts (a prior
  // attempt's tx may land late) before resubmitting, to avoid a NullifierUsed double-submit.
  for (let attempt = 0; attempt < 5 && !st.is_granted; attempt++) {
    let [, sub] = await jpost("/bonded/bond-open/submit", bundle);
    console.log(`[reuse] submit attempt ${attempt + 1}: ok=${sub.ok}${sub.error ? " err=" + String(sub.error).slice(0, 40) : ""}`);
    for (let i = 0; i < 6 && !st.is_granted; i++) { await sleep(5000); st = await granted(ACCESSOR, REQ); }
  }
}
console.log(`[reuse] is_open_granted=${st.is_granted} recipientPub(on-chain)=${String(st.recipientPub).slice(0, 10)}... (expect ${RCPT.recipientPub.slice(0, 10)}...)`);
if (!st.is_granted) throw new Error("grant never landed after retries");

// create TWO bond-only rooms with the SAME requirement, seal a doc in each (idempotent).
for (const [room, doc, content] of [[ROOM1, DOC1, CONTENT1], [ROOM2, DOC2, CONTENT2]]) {
  let [, cr] = await jpost("/dataroom/create-room", { roomId: room });
  let [, sbr] = await jpost("/dataroom/bond-requirement", { roomId: room, token: TOKEN, min_amount: MIN, deadline: DEADLINE, mode: "open" });
  console.log(`[reuse] room ${room.slice(0,8)}: create ok=${cr.ok ?? "(exists)"} | bond-req ok=${sbr.ok}${sbr.error ? " err=" + String(sbr.error).slice(0,50) : ""}`);
  let [, cd] = await jget(`/dataroom/committee/document/${room}/${doc}`);
  if (!cd.document) { let [, sd] = await jpost("/dataroom/committee/seal-doc", { roomId: room, docId: doc, content }); console.log(`[reuse] sealed ${room.slice(0,8)} ok=${sd.ok}`); }
}

// THE REUSE PROOF: ONE grant admits to BOTH rooms; open each doc with the handle's recipient secret.
let [, a1] = await jget(`/dataroom/doc-admitted/${ROOM1}/${DOC1}/${ACCESSOR}`);
let [, a2] = await jget(`/dataroom/doc-admitted/${ROOM2}/${DOC2}/${ACCESSOR}`);
let [, o1] = await jpost(`/dataroom/committee/open/${ROOM1}/${DOC1}`, { accessor: ACCESSOR, recipientKey: RCPT.recipientSecret });
let [, o2] = await jpost(`/dataroom/committee/open/${ROOM2}/${DOC2}`, { accessor: ACCESSOR, recipientKey: RCPT.recipientSecret });
const ok = st.is_granted && String(st.recipientPub).toLowerCase() === RCPT.recipientPub.toLowerCase()
  && a1.isDocAdmitted && a2.isDocAdmitted && o1.faithful && o1.content === CONTENT1 && o2.faithful && o2.content === CONTENT2;
console.log("\n===== REUSABLE BONDED ACCESS e2e =====");
console.log(JSON.stringify({ handleAccessor: ACCESSOR.slice(0, 16), reqId: REQ.slice(0, 16), is_open_granted: st.is_granted,
  room1: { admitted: a1.isDocAdmitted, faithful: o1.faithful, contentMatch: o1.content === CONTENT1 },
  room2: { admitted: a2.isDocAdmitted, faithful: o2.faithful, contentMatch: o2.content === CONTENT2 } }, null, 2));
console.log(ok ? "\nGREEN — ONE handle + ONE bond + ONE proof opened TWO bond-only rooms (no re-lock)" : "\nFAILED");
process.exit(ok ? 0 : 1);
