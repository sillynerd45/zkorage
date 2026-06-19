// DR1 — Confidential Data Room end-to-end self-test (drives the running backend's HTTP routes).
//   create room → encrypt+upload+prove(worker-first) → anchor on testnet → recipient-open round-trip
//   + negatives (wrong recipient key) + raw blob fetch.
// Usage: node scripts/dr1-e2e.mjs [roomLabel] [docLabel]   (backend must be running on $BASE).
const BASE = process.env.BASE || "http://localhost:8787";
const rnd = () => Math.random().toString(16).slice(2, 10);
const roomLabel = process.argv[2] || `dr1-e2e-room-${rnd()}`;
const docLabel = process.argv[3] || `dr1-e2e-doc-${rnd()}`;
const content = `zkorage DR1 confidential document — ${new Date().toISOString()} 🔒 secret payload ${rnd()}`;
const PROOF_TIMEOUT_MS = 9 * 60 * 1000;

async function jpost(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return [r.status, await r.json()];
}
async function jget(path) {
  const r = await fetch(BASE + path);
  return [r.status, await r.json()];
}

console.log(`[dr1-e2e] BASE=${BASE} room="${roomLabel}" doc="${docLabel}"`);

// 1. create room
let [s1, room] = await jpost("/dataroom/create-room", { roomId: roomLabel });
console.log("1. create-room   ", s1, "ok=", room.ok, "roomId=", room.roomId, "tx=", room.txHash);
if (!room.ok) throw new Error("create-room failed: " + room.error);
const roomId = room.roomId;

// 2. prove-seal (encrypt + upload + enqueue)
let [s2, seal] = await jpost("/dataroom/prove-seal", { roomId, docId: docLabel, content });
console.log("2. prove-seal    ", s2, "jobId=", seal.jobId, "storage=", seal.storage, "deduped=", seal.deduped);
console.log("                  contentHash=", seal.contentHash);
console.log("                  blobPointer=", seal.blobPointer, "recipientPub=", seal.recipientPub);
if (!seal.jobId) throw new Error("prove-seal failed: " + JSON.stringify(seal));
const { jobId, docId, contentHash, blobPointer } = seal;

// 3. poll for the proof (worker-first; falls back to the VM CPU if the worker is offline)
let bundle = null, by = null;
const deadline = Date.now() + PROOF_TIMEOUT_MS;
process.stdout.write("3. proving       ");
while (Date.now() < deadline) {
  const [, st] = await jget("/prove-status/" + jobId);
  if (st.status === "done" && st.bundle) { bundle = st.bundle; by = st.by; break; }
  if (st.status === "error") throw new Error("prove error: " + st.error);
  process.stdout.write(".");
  await new Promise((r) => setTimeout(r, 5000));
}
console.log();
if (!bundle) throw new Error("proof timed out");
console.log("   proved_by=", by, "image_id=", bundle.image_id, "journal_bytes=", bundle.journal.length / 2);

// 4. submit-document (anchor on testnet)
let [s4, sub] = await jpost("/dataroom/submit-document", { ...bundle, blobPointer });
console.log("4. submit-document", s4, "ok=", sub.ok, "tx=", sub.txHash, "docIndex=", sub.result?.index);
if (!sub.ok) throw new Error("submit failed: " + sub.error);

// 5. read back the public document metadata (ciphertext disclosure only — never the plaintext)
let [, docread] = await jget(`/dataroom/document/${roomId}/${docId}`);
console.log("5. document       ", "anchored index=", docread.document?.index, "blob_pointer=", docread.document?.blob_pointer);

// 6. recipient opener (default demo recipient secret) — recover K, verify faithful tag, AEAD-decrypt
let [s6, opened] = await jpost(`/dataroom/open/${roomId}/${docId}`, {});
const match = opened.plaintextUtf8 === content;
console.log("6. open           ", s6, "faithful=", opened.faithful, "contentHashVerified=", opened.contentHashVerified, "size=", opened.size, "plaintext=", match ? "MATCH ✓" : "MISMATCH ✗");
if (!opened.faithful || !opened.contentHashVerified || !match) throw new Error("open round-trip FAILED");

// 7. negative: a wrong recipient key must NOT be faithful (and must not decrypt)
let [, wrong] = await jpost(`/dataroom/open/${roomId}/${docId}`, { recipientKey: "11".repeat(32) });
console.log("7. open wrong-key ", "faithful=", wrong.faithful, wrong.faithful ? "✗ SHOULD BE FALSE" : "✓ rejected");
if (wrong.faithful) throw new Error("wrong-key must not be faithful");

// 8. raw ciphertext blob fetch by content hash (availability path; server re-verifies the bytes)
const blobRes = await fetch(`${BASE}/dataroom/blob/${contentHash}`);
const blobBytes = new Uint8Array(await blobRes.arrayBuffer());
console.log("8. blob fetch     ", blobRes.status, "bytes=", blobBytes.length, "x-content-hash=", blobRes.headers.get("x-content-hash") === contentHash ? "✓" : "✗");
if (blobRes.status !== 200 || blobBytes.length === 0) throw new Error("blob fetch FAILED");

console.log(`\n[ok] DR1 e2e PASSED — create → encrypt → upload(${seal.storage}) → prove(${by}) → anchor → open + negatives`);
