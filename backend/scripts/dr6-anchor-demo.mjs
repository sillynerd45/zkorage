// DR6 — seed a STABLE, deterministic private-policy-composition demo on testnet (idempotent).
//   Deterministic room "zkorage-dr6-policy-demo" + the fixed demo member (id 0x11/0x22, holder 0x03 →
//   accessor ed4928c6) admitted under the composite policy (member ∧ compliance ∧ accredited), plus a
//   committee doc "dr6-policy-welcome-doc" (sealed to the demo recipient 97a6b925) for the rotation demo.
//   On re-run it checks is_admitted on-chain and skips the (slow) 3-proof setup if already seeded.
// Usage: node scripts/dr6-anchor-demo.mjs   (backend on $BASE; the 3 keypers live; prover online)
import { sha256 } from "@noble/hashes/sha256";

const BASE = process.env.BASE || "http://localhost:8787";
const enc = (s) => new TextEncoder().encode(s);
const toHex = (u) => Buffer.from(u).toString("hex");
const ROOM_LABEL = "zkorage-dr6-policy-demo";
const DOC_LABEL = "dr6-policy-welcome-doc";
const roomId = toHex(sha256(enc(ROOM_LABEL)));
const docId = toHex(sha256(enc(DOC_LABEL)));
const ID_SECRET = "11".repeat(32);
const ID_TRAPDOOR = "22".repeat(32);
const HOLDER_SEED = "03".repeat(32);
const accessor = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";
const CONTENT =
  "zkorage Confidential Data Room — DR6 finale. You entered this room by proving a COMPOSITE policy " +
  "anonymously: you are an eligible member AND KYC-passed AND accredited AND not sanctioned — without " +
  "revealing which member you are or any attribute. A revoked member loses access surgically and the " +
  "committee key rotates so their cached shares are useless. 🔐🧩";
const PROOF_TIMEOUT_MS = 12 * 60 * 1000;

const jpost = async (p, b) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }); return [r.status, await r.json().catch(() => ({}))]; };
const jget = async (p) => { const r = await fetch(BASE + p); return [r.status, await r.json().catch(() => ({}))]; };
async function pollProof(jobId) {
  const t0 = Date.now();
  for (;;) {
    const [, s] = await jget(`/prove-status/${jobId}`);
    if (s.status === "done") return s.bundle;
    if (s.status === "error") throw new Error("prover error: " + s.error);
    if (Date.now() - t0 > PROOF_TIMEOUT_MS) throw new Error("proof timeout");
    process.stdout.write(`  …${s.status}/${s.by || "-"}`);
    await new Promise((r) => setTimeout(r, 15000));
  }
}

console.log(`[dr6-demo] room=${roomId.slice(0, 12)}… accessor=${accessor.slice(0, 12)}…`);

let [, adm0] = await jget(`/dataroom/admission/is-admitted/${roomId}/${accessor}`);
if (adm0.isAdmitted) {
  console.log("[dr6-demo] already admitted under the composite policy — skipping the 3-proof setup");
} else {
  // 1) ensure room + eligible set + root
  let [, el] = await jget(`/dataroom/membership/eligible/${roomId}`);
  if (!el.memberCount || el.memberCount < 2) {
    await jpost("/dataroom/create-room", { roomId: ROOM_LABEL }); // ignore RoomExists
    const idCommitmentHex = toHex(sha256(Buffer.concat([Buffer.from([0]), Buffer.from(ID_SECRET, "hex"), Buffer.from(ID_TRAPDOOR, "hex")])));
    await jpost("/dataroom/membership/register", { roomId, idCommitment: idCommitmentHex });
    await jpost("/dataroom/membership/register", { roomId, mint: true });
    [, el] = await jget(`/dataroom/membership/eligible/${roomId}`);
    console.log(`[dr6-demo] eligible set built: members=${el.memberCount}`);
  }
  await jpost("/dataroom/membership/set-root", { roomId });

  // 2) membership leg (skip the proof if already granted — nullifier is one-shot per room)
  let [, ig] = await jget(`/dataroom/membership/is-granted/${roomId}/${accessor}`);
  if (!ig.isGranted) {
    console.log("[dr6-demo] proving membership (worker-first)…");
    let [, pa] = await jpost("/dataroom/membership/prove-access", { roomId, idSecret: ID_SECRET, idTrapdoor: ID_TRAPDOOR, holderSeed: HOLDER_SEED });
    if (!pa.jobId) throw new Error("prove-access failed: " + JSON.stringify(pa));
    const b = await pollProof(pa.jobId); console.log("");
    let [, ra] = await jpost("/dataroom/membership/request-access", b);
    if (!ra.ok) throw new Error("request-access failed: " + JSON.stringify(ra));
    console.log(`[dr6-demo] membership GRANT tx=${ra.txHash}`);
  } else console.log("[dr6-demo] membership already granted — skipping that proof");

  // 3) compliance leg (alice, not sanctioned) bound to the SAME accessor
  console.log("[dr6-demo] proving compliance (worker-first)…");
  let [, pc] = await jpost("/prove-compliance", { subject: "alice", accessor });
  if (!pc.jobId) throw new Error("prove-compliance failed: " + JSON.stringify(pc));
  const cb = await pollProof(pc.jobId); console.log("");
  let [, gc] = await jpost("/grant-compliance", cb);
  if (!gc.ok) throw new Error("grant-compliance failed: " + JSON.stringify(gc));
  console.log(`[dr6-demo] compliance GRANT tx=${gc.txHash}`);

  // 4) accredited leg (ivy) bound to the SAME accessor
  console.log("[dr6-demo] proving accredited (worker-first)…");
  let [, pacc] = await jpost("/prove-accredited", { subject: "ivy", accessor });
  if (!pacc.jobId) throw new Error("prove-accredited failed: " + JSON.stringify(pacc));
  const ab = await pollProof(pacc.jobId); console.log("");
  let [, ga] = await jpost("/grant-accredited", ab);
  if (!ga.ok) throw new Error("grant-accredited failed: " + JSON.stringify(ga));
  console.log(`[dr6-demo] accredited GRANT tx=${ga.txHash}`);

  // 5) set the composite policy + admit
  let [, ps] = await jpost("/dataroom/policy/set", { roomId });
  if (!ps.ok) throw new Error("policy/set failed: " + JSON.stringify(ps));
  let [, adm] = await jpost("/dataroom/admission/request", { roomId, accessor });
  if (!adm.ok) throw new Error("admission failed: " + JSON.stringify(adm));
  console.log(`[dr6-demo] ADMITTED tx=${adm.txHash}`);
}

// 6) ensure a committee doc for the rotation demo (skip if already anchored)
let [, cd] = await jget(`/dataroom/committee/document/${roomId}/${docId}`);
if (cd.document) console.log("[dr6-demo] committee document already anchored — skipping seal-doc");
else {
  let [ss, seal] = await jpost("/dataroom/committee/seal-doc", { roomId, docId, content: CONTENT });
  if (ss !== 200 || !seal.ok) throw new Error("seal-doc failed: " + JSON.stringify(seal));
  console.log(`[dr6-demo] committee doc anchored: tx=${seal.txHash}`);
}

let [, ia] = await jget(`/dataroom/admission/is-admitted/${roomId}/${accessor}`);
let [, ke] = await jget(`/dataroom/committee/key-epoch/${roomId}/${docId}`);
console.log("\n===== DR6 STABLE DEMO =====");
console.log(JSON.stringify({ roomLabel: ROOM_LABEL, docLabel: DOC_LABEL, roomId, docId, accessor, isAdmitted: ia.isAdmitted, keyEpoch: ke.keyEpoch }, null, 2));
console.log(ia.isAdmitted ? "\nDR6 demo seeded + admitted ✓" : "\nDR6 demo NOT admitted ✗");
process.exit(ia.isAdmitted ? 0 : 1);
