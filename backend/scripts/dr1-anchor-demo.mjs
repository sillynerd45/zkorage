// Anchor (once) a STABLE demo document for the SDK/MCP self-tests + the frontend demo: a known room +
// doc, sealed to the demo recipient x25519 key, with a fixed plaintext. Idempotent — if the doc is
// already anchored it just prints the ids. Run with the backend up on $BASE (R2-backed).
//   node scripts/dr1-anchor-demo.mjs
import { sha256 } from "@noble/hashes/sha256";

const BASE = process.env.BASE || "http://localhost:8787";
const ROOM_LABEL = "zkorage-dataroom-demo";
const DOC_LABEL = "dr1-welcome-doc";
export const DEMO_CONTENT =
  "zkorage Confidential Data Room — DR1 demo document. If you can read this, the ECIES seal opened faithfully and the ciphertext matched its on-chain content hash. 🔒";

const toHex = (b) => Buffer.from(b).toString("hex");
const roomId = toHex(sha256(new TextEncoder().encode(ROOM_LABEL)));
const docId = toHex(sha256(new TextEncoder().encode(DOC_LABEL)));

async function jpost(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return [r.status, await r.json()];
}
async function jget(path) { const r = await fetch(BASE + path); return [r.status, await r.json()]; }

console.log(`[anchor-demo] room="${ROOM_LABEL}" (${roomId})  doc="${DOC_LABEL}" (${docId})`);

// Already anchored? → idempotent no-op.
const [, existing] = await jget(`/dataroom/document/${roomId}/${docId}`);
if (existing?.document) {
  console.log("already anchored — content_hash =", existing.document.content_hash);
  console.log(`ROOM_ID=${roomId}`);
  console.log(`DOC_ID=${docId}`);
  process.exit(0);
}

// 1. ensure the room (ignore RoomExists)
const [, room] = await jpost("/dataroom/create-room", { roomId: ROOM_LABEL });
console.log("create-room:", room.ok ? `ok tx=${room.txHash}` : `(exists/err: ${String(room.error).slice(0, 40)}…)`);

// 2. prove-seal to the DEMO recipient (default)
const [s2, seal] = await jpost("/dataroom/prove-seal", { roomId: ROOM_LABEL, docId: DOC_LABEL, content: DEMO_CONTENT });
if (!seal.jobId) throw new Error("prove-seal failed: " + JSON.stringify(seal));
console.log("prove-seal: jobId=", seal.jobId, "contentHash=", seal.contentHash, "recipientPub=", seal.recipientPub);

// 3. poll
let bundle = null, by = null;
const deadline = Date.now() + 9 * 60 * 1000;
process.stdout.write("proving ");
while (Date.now() < deadline) {
  const [, st] = await jget("/prove-status/" + seal.jobId);
  if (st.status === "done" && st.bundle) { bundle = st.bundle; by = st.by; break; }
  if (st.status === "error") throw new Error("prove error: " + st.error);
  process.stdout.write(".");
  await new Promise((r) => setTimeout(r, 5000));
}
console.log();
if (!bundle) throw new Error("proof timed out");

// 4. submit
const [, sub] = await jpost("/dataroom/submit-document", { ...bundle, blobPointer: seal.blobPointer });
if (!sub.ok) throw new Error("submit failed: " + sub.error);
console.log("anchored: proved_by=", by, "tx=", sub.txHash, "docIndex=", sub.result?.index);
console.log(`ROOM_ID=${roomId}`);
console.log(`DOC_ID=${docId}`);
console.log(`CONTENT_HASH=${seal.contentHash}`);
