// DR5 — seed a STABLE, reproducible demo on testnet (idempotent): a fixed room with (a) a sealed full
// financial statement, (b) a public TEASER about it (revenue >= $1M, figure private), and (c) an auditor
// REDACTED view (PCI/HIPAA/GDPR masking) sealed to the demo auditor. Deterministic labels → stable ids, so
// the SDK smoke / MCP selftest / frontend can read + open the same fixture. Re-running skips already-seeded
// pieces. Usage: node scripts/dr5-anchor-demo.mjs   (backend must be running on $BASE; worker-first proving).
import { sha256 } from "@noble/hashes/sha256";
const BASE = process.env.BASE || "http://localhost:8787";
const PROOF_TIMEOUT_MS = 9 * 60 * 1000;
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const id32 = (label) => toHex(sha256(new TextEncoder().encode(label)));

const ROOM_LABEL = "zkorage-dataroom-dr5-demo";
const FULL_LABEL = "dr5-demo-full-statement";
const VIEW_LABEL = "dr5-demo-auditor-view";
const roomId = id32(ROOM_LABEL), fullDocId = id32(FULL_LABEL), viewDocId = id32(VIEW_LABEL);

async function jpost(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return [r.status, await r.json()];
}
async function jget(path) { const r = await fetch(BASE + path); return [r.status, await r.json()]; }
async function pollJob(jobId, label) {
  const deadline = Date.now() + PROOF_TIMEOUT_MS;
  process.stdout.write(`   proving ${label} `);
  while (Date.now() < deadline) {
    const [, st] = await jget("/prove-status/" + jobId);
    if (st.status === "done" && st.bundle) { console.log(` done (by=${st.by})`); return st.bundle; }
    if (st.status === "error") throw new Error("prove error: " + st.error);
    process.stdout.write("."); await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("proof timed out: " + label);
}

console.log(`[dr5-demo] room=${roomId.slice(0,12)} full=${fullDocId.slice(0,12)} view=${viewDocId.slice(0,12)}`);

// 1. room (idempotent)
let [, room] = await jpost("/dataroom/create-room", { roomId: ROOM_LABEL });
console.log("1. room          ", room.ok ? `created tx=${room.txHash}` : `exists (${room.error || "ok"})`);

// 2. full sealed statement (skip if anchored)
let [, fdoc] = await jget(`/dataroom/document/${roomId}/${fullDocId}`);
if (!fdoc.document) {
  const fullContent = JSON.stringify({ note: "FULL confidential financial statement (sealed)", company: "Stellar Aurora Labs, Inc.", annual_revenue_usd: 4250000 });
  let [, fseal] = await jpost("/dataroom/prove-seal", { roomId: ROOM_LABEL, docId: FULL_LABEL, content: fullContent });
  if (!fseal.jobId) throw new Error("prove-seal(full) failed: " + JSON.stringify(fseal));
  const b = await pollJob(fseal.jobId, "full statement seal");
  let [, sub] = await jpost("/dataroom/submit-document", { ...b, blobPointer: fseal.blobPointer });
  if (!sub.ok) throw new Error("submit full failed: " + sub.error);
  console.log("2. full statement anchored tx=", sub.txHash);
} else {
  console.log("2. full statement already anchored (idx", fdoc.document.index, ")");
}

// 3. teaser about the full statement (skip if present)
let [, tr] = await jget(`/dataroom/teaser/${roomId}/${fullDocId}`);
if (!tr.teaser) {
  let [, tp] = await jpost("/dataroom/teaser/prove", { roomId: ROOM_LABEL, docId: FULL_LABEL, threshold: 1000000 });
  if (!tp.jobId) throw new Error("teaser/prove failed: " + JSON.stringify(tp));
  const b = await pollJob(tp.jobId, "teaser (revenue>=1M)");
  let [, ta] = await jpost("/dataroom/teaser/attest", { ...b, roomId: ROOM_LABEL, docId: FULL_LABEL });
  if (!ta.ok) throw new Error("teaser attest failed: " + ta.error);
  console.log("3. teaser        attested tx=", ta.txHash);
} else {
  console.log("3. teaser        already attested (threshold", tr.teaser.threshold, "valid", tr.valid, ")");
}

// 4. auditor redacted view (skip if anchored)
let [, vdoc] = await jget(`/dataroom/document/${roomId}/${viewDocId}`);
if (!vdoc.document) {
  let [, dp] = await jpost("/dataroom/disclose/prove", { roomId: ROOM_LABEL, docId: VIEW_LABEL });
  if (!dp.jobId) throw new Error("disclose/prove failed: " + JSON.stringify(dp));
  const b = await pollJob(dp.jobId, "auditor redacted seal");
  let [, sub] = await jpost("/dataroom/submit-document", { ...b, blobPointer: dp.blobPointer });
  if (!sub.ok) throw new Error("submit redacted failed: " + sub.error);
  console.log("4. redacted view anchored tx=", sub.txHash);
} else {
  console.log("4. redacted view already anchored (idx", vdoc.document.index, ")");
}

console.log("\n[dr5-demo] ✅ stable fixture ready. Add to SDK defaults:");
console.log(JSON.stringify({ roomId, fullDocId, viewDocId, threshold: "1000000", fieldTag: 1 }, null, 2));
