// DR3 — seed a STABLE, deterministic committee-document demo on testnet (idempotent).
//   Deterministic room "zkorage-dr3-committee-demo" + the fixed demo member (id 0x11/0x22, holder 0x03 →
//   accessor ed4928c6) + a fixed doc "dr3-committee-welcome-doc", sealed to the demo recipient 97a6b925
//   (whose SECRET = sha256("zkorage-demo-dataroom-recipient-key") is known → the round-trip is reproducible).
//   On re-run it checks on-chain state and skips the (slow) proof if the grant + committee doc already exist.
// Usage: node scripts/dr3-anchor-demo.mjs   (backend on $BASE; the 3 keypers live)
import { sha256 } from "@noble/hashes/sha256";

const BASE = process.env.BASE || "http://localhost:8787";
const enc = (s) => new TextEncoder().encode(s);
const toHex = (u) => Buffer.from(u).toString("hex");
const ROOM_LABEL = "zkorage-dr3-committee-demo";
const DOC_LABEL = "dr3-committee-welcome-doc";
const roomId = toHex(sha256(enc(ROOM_LABEL)));
const docId = toHex(sha256(enc(DOC_LABEL)));
const ID_SECRET = "11".repeat(32);
const ID_TRAPDOOR = "22".repeat(32);
const HOLDER_SEED = "03".repeat(32);
const CONTENT =
  "zkorage Confidential Data Room — DR3 committee-released document. If you can read this, the 2-of-3 keyper " +
  "committee released its shares to your proof-bound key, you reconstructed K from a 2-of-3 quorum, and the " +
  "ciphertext matched its on-chain sha256(K) commitment. No single keyper ever held the key. 🔐🗝️";
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

console.log(`[dr3-demo] room=${roomId.slice(0, 12)}… doc=${docId.slice(0, 12)}…`);

// accessor for holder 0x03 (ed4928c6…)
const accessor = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";

// 1) ensure the DR2 grant (skip the slow proof if already granted)
let [, ig] = await jget(`/dataroom/membership/is-granted/${roomId}/${accessor}`);
if (ig.isGranted) {
  console.log("[dr3-demo] grant already present — skipping the membership proof");
} else {
  let [, el] = await jget(`/dataroom/membership/eligible/${roomId}`);
  if (!el.memberCount || el.memberCount < 2) {
    await jpost("/dataroom/create-room", { roomId: ROOM_LABEL }); // ignore RoomExists
    // register the FIXED demo member + one minted member (anonymity set of 2)
    const idCommitmentHex = toHex(sha256(Buffer.concat([Buffer.from([0]), Buffer.from(ID_SECRET, "hex"), Buffer.from(ID_TRAPDOOR, "hex")])));
    await jpost("/dataroom/membership/register", { roomId, idCommitment: idCommitmentHex });
    await jpost("/dataroom/membership/register", { roomId, mint: true });
    [, el] = await jget(`/dataroom/membership/eligible/${roomId}`);
    console.log(`[dr3-demo] eligible set built: members=${el.memberCount}`);
  }
  await jpost("/dataroom/membership/set-root", { roomId });
  console.log("[dr3-demo] proving membership (worker-first; ~2-3 min)…");
  let [, pa] = await jpost("/dataroom/membership/prove-access", { roomId, idSecret: ID_SECRET, idTrapdoor: ID_TRAPDOOR, holderSeed: HOLDER_SEED });
  if (!pa.jobId) throw new Error("prove-access failed: " + JSON.stringify(pa));
  const bundle = await pollProof(pa.jobId);
  console.log("");
  let [, ra] = await jpost("/dataroom/membership/request-access", bundle);
  if (!ra.ok) throw new Error("request-access failed: " + JSON.stringify(ra));
  console.log(`[dr3-demo] GRANT tx=${ra.txHash} accessor=${ra.grant?.accessor?.slice(0, 12)}…`);
}

// 2) ensure the committee document (skip if already anchored)
let [, cd] = await jget(`/dataroom/committee/document/${roomId}/${docId}`);
if (cd.document) {
  console.log("[dr3-demo] committee document already anchored — skipping seal-doc");
} else {
  let [ss, seal] = await jpost("/dataroom/committee/seal-doc", { roomId, docId, content: CONTENT });
  if (ss !== 200 || !seal.ok) throw new Error("seal-doc failed: " + JSON.stringify(seal));
  console.log(`[dr3-demo] committee doc anchored: dealt=${seal.dealt} tx=${seal.txHash} content_hash=${seal.contentHash?.slice(0, 12)}…`);
}

// 3) verify the full round-trip via the backend opener (demo recipient secret)
let [, open] = await jpost(`/dataroom/committee/open/${roomId}/${docId}`, { accessor });
const ok = open.ok && open.faithful && open.content === CONTENT;
console.log(`[dr3-demo] round-trip open: faithful=${open.faithful} pair=${JSON.stringify(open.reconstructedFromPair)} match=${open.content === CONTENT}`);

console.log("\n===== DR3 STABLE DEMO =====");
console.log(JSON.stringify({ roomLabel: ROOM_LABEL, docLabel: DOC_LABEL, roomId, docId, accessor }, null, 2));
console.log(ok ? "\nDR3 demo seeded + verified ✓" : "\nDR3 demo verification FAILED ✗");
process.exit(ok ? 0 : 1);
