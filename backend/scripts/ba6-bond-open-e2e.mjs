// BA6 e2e — validate the Option-A two-grant open (the fix for the recipient_pub gap). A bonded reader needs
// BOTH: a MEMBERSHIP grant (the keepers seal the document key to its proof-bound recipient_pub) AND a BOND
// grant (is_doc_admitted). This script: (1) ensures the demo member's membership grant on the bonded demo room
// (sealed to the known demo recipient so the backend opener can decrypt), (2) stores a committee document in
// that room, (3) opens it end-to-end through the live keeper committee, and verifies the plaintext. The BOND
// grant comes from ba1-bond-anchor-demo.mjs — run that FIRST. Run against apizk (the keepers are live there).
// Usage: BASE=https://apizk.wazowsky.id node scripts/ba6-bond-open-e2e.mjs
import { sha256 } from "@noble/hashes/sha256";

const BASE = process.env.BASE || "http://localhost:8787";
const enc = (s) => new TextEncoder().encode(s);
const toHex = (u) => Buffer.from(u).toString("hex");
const ROOM = toHex(sha256(enc("zkorage-bonded-access-demo-v1")));
const DOC = toHex(sha256(enc("zkorage-bonded-access-demo-doc-v1")));
const ID_SECRET = "11".repeat(32), ID_TRAPDOOR = "22".repeat(32), HOLDER_SEED = "03".repeat(32);
const ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";
const CONTENT =
  "zkorage Bonded Access — this committee document opened because you proved a qualifying bond (admission) " +
  "AND a membership (the keepers sealed the key to your proof-bound recipient key). The bond gates access; " +
  "membership provides the key. No single keeper ever held the key.";
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

console.log(`[ba6-open] BASE=${BASE} room=${ROOM.slice(0, 12)}... doc=${DOC.slice(0, 12)}... accessor=${ACCESSOR.slice(0, 12)}...`);

// 0) the BOND grant must already exist (run ba1-bond-anchor-demo.mjs first). is_doc_admitted is what the
//    keepers gate on; surface it up front so a missing bond grant fails clearly here, not deep in the open.
const [, info] = await jget(`/bonded/bond/info`);
if (!info.bondGateId) throw new Error("bond gate not configured on this backend");

// 1) ensure the MEMBERSHIP grant (recipient_pub for the keepers). Sealed to the demo recipient (default), so
//    the backend opener's known demo secret can decrypt. Skip the slow proof if already granted.
let [, ig] = await jget(`/dataroom/membership/is-granted/${ROOM}/${ACCESSOR}`);
if (ig.isGranted) {
  console.log("[ba6-open] membership grant already present — skipping the membership proof");
} else {
  // The demo seed registered the 3 members + pinned the root; re-pin idempotently in case this backend's store
  // was just seeded.
  await jpost("/dataroom/membership/set-root", { roomId: ROOM });
  console.log("[ba6-open] proving membership for the demo member (worker-first; a few minutes)...");
  let [, pa] = await jpost("/dataroom/membership/prove-access", { roomId: ROOM, idSecret: ID_SECRET, idTrapdoor: ID_TRAPDOOR, holderSeed: HOLDER_SEED });
  if (!pa.jobId) throw new Error("prove-access failed: " + JSON.stringify(pa));
  const bundle = await pollProof(pa.jobId);
  let [, ra] = await jpost("/dataroom/membership/request-access", bundle);
  if (!ra.ok) throw new Error("request-access failed: " + JSON.stringify(ra));
  console.log(`[ba6-open] membership GRANT tx=${String(ra.txHash).slice(0, 10)}... recipient_pub=${String(ra.grant?.recipient_pub).slice(0, 12)}...`);
}

// 2) ensure the committee DOCUMENT (split K, deal sealed shares to the live keepers, anchor on-chain).
let [, cd] = await jget(`/dataroom/committee/document/${ROOM}/${DOC}`);
if (cd.document) {
  console.log("[ba6-open] committee document already anchored — skipping seal-doc");
} else {
  let [ss, seal] = await jpost("/dataroom/committee/seal-doc", { roomId: ROOM, docId: DOC, content: CONTENT });
  if (ss !== 200 || !seal.ok) throw new Error("seal-doc failed: " + JSON.stringify(seal));
  console.log(`[ba6-open] committee doc anchored: dealt=${seal.dealt} tx=${String(seal.txHash).slice(0, 10)}... content_hash=${String(seal.contentHash).slice(0, 12)}...`);
}

// 3) OPEN end-to-end through the keepers: they check is_doc_admitted (the BOND leg) AND read recipient_pub
//    (the MEMBERSHIP grant) and seal their shares to it; the opener reconstructs K and decrypts.
let [, open] = await jpost(`/dataroom/committee/open/${ROOM}/${DOC}`, { accessor: ACCESSOR });
const ok = open.ok && open.faithful && open.content === CONTENT;

console.log("\n===== BA6 BONDED-ACCESS OPEN E2E =====");
console.log(JSON.stringify({ room: ROOM, doc: DOC, accessor: ACCESSOR, faithful: open.faithful, reconstructedFromPair: open.reconstructedFromPair, contentMatch: open.content === CONTENT, error: open.error }, null, 2));
console.log(ok ? "\nBA6 bonded-access OPEN e2e GREEN — a bonded reader opened the document (bond admission + membership key) OK" : "\nBA6 bonded-access OPEN e2e FAILED");
process.exit(ok ? 0 : 1);
