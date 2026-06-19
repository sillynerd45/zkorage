// Throwaway end-to-end check: upload a real binary (a 1x1 PNG) as base64 through the live API, wait for the
// real seal proof, anchor it, then print the room/doc so an opener can decrypt + preview it. Confirms the
// contentB64 path works end to end through the actual prover. Usage: BASE=https://apizk.wazowsky.id node scripts/binary-e2e.mjs
const BASE = process.env.BASE || "http://localhost:8787";
const ROOM = process.env.ROOM || "zkorage-binary-e2e-demo";
// A valid 1x1 PNG, already base64 (so it doubles as the contentB64 we send).
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");
const jpost = async (p, b) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }); return [r.status, await r.json().catch(() => ({}))]; };
const jget = async (p) => { const r = await fetch(BASE + p); return [r.status, await r.json().catch(() => ({}))]; };

console.log(`[bin-e2e] PNG is ${PNG.length} bytes, magic=${PNG.subarray(0, 4).toString("hex")} (expect 89504e47)`);
await jpost("/dataroom/create-room", { roomId: ROOM }); // ignore RoomExists

const [ps, pr] = await jpost("/dataroom/prove-seal", { roomId: ROOM, contentB64: PNG_B64 });
if (ps !== 200 || !pr.jobId) { console.error("prove-seal failed:", pr); process.exit(1); }
console.log(`[bin-e2e] queued job=${pr.jobId} room=${pr.roomId.slice(0, 12)}… doc=${pr.docId.slice(0, 12)}… contentHash=${pr.contentHash.slice(0, 12)}…`);

const t0 = Date.now();
let bundle = null;
for (;;) {
  const [, s] = await jget(`/prove-status/${pr.jobId}`);
  if (s.status === "done") { bundle = s.bundle; console.log(`\n[bin-e2e] proved by=${s.by} in ${((Date.now() - t0) / 1000).toFixed(0)}s`); break; }
  if (s.status === "error") { console.error("prover error:", s.error); process.exit(1); }
  if (Date.now() - t0 > 8 * 60 * 1000) { console.error("proof timeout"); process.exit(1); }
  process.stdout.write(`  …${s.status}/${s.by || "-"}`);
  await new Promise((r) => setTimeout(r, 6000));
}

const [ss, sub] = await jpost("/dataroom/submit-document", { ...bundle, blobPointer: pr.blobPointer });
if (!sub.ok) { console.error("submit-document failed:", sub); process.exit(1); }
console.log(`[bin-e2e] anchored tx=${sub.txHash}`);
console.log(JSON.stringify({ roomId: pr.roomId, docId: pr.docId, contentHash: pr.contentHash, pngBytes: PNG.length }, null, 2));
