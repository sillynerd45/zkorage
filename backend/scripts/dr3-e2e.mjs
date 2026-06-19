// DR3 — threshold-ECIES committee end-to-end self-test (drives the backend + the 3 live keypers).
//   create room → register a member → set eligible root → prove DR2 membership (worker-first) → GRANT
//   (recipient = the demo x25519 key we hold) → committee seal-doc (dealer splits K to the keypers + anchors
//   the committee doc) → collect sealed shares → reconstruct K (2-of-3) → AES-GCM-decrypt → content MATCH.
//   Negatives: a NON-granted accessor cannot collect/open; the on-chain k_commitment gates reconstruction.
// Prereq: backend on $BASE with KEYPER_ENDPOINTS live; the 3 keypers running. Usage: node scripts/dr3-e2e.mjs
const BASE = process.env.BASE || "http://localhost:8787";
const rnd = () => Math.random().toString(16).slice(2, 10);
const room = `dr3-e2e-room-${rnd()}`;
const PROOF_TIMEOUT_MS = 12 * 60 * 1000;
const MEMBERSHIP_IMAGE = "9550a12e84a9b26bc3926e79e271dc0f1a740f45d86f88c19d3e3e438939011c";
const SECRET = `dr3 confidential payload :: ${rnd()} :: top secret 🔐`;

const jpost = async (p, b) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) });
  return [r.status, await r.json().catch(() => ({}))];
};
const jget = async (p) => { const r = await fetch(BASE + p); return [r.status, await r.json().catch(() => ({}))]; };
let failed = 0;
const check = (label, cond, extra = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`); if (!cond) failed++; };

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

console.log(`[dr3-e2e] BASE=${BASE} room="${room}"`);

// 0. committee online?
let [, ci] = await jget("/dataroom/committee/info");
check("committee online (>= threshold keypers)", ci.online >= ci.threshold, `online=${ci.online}/${ci.n} threshold=${ci.threshold}`);

// 1. create room (owner = server admin) + 2-member anonymity set + pin root
let [, cr] = await jpost("/dataroom/create-room", { roomId: room });
check("create-room", cr.ok, `tx=${cr.txHash}`);
const roomId = cr.roomId;
let [, m1] = await jpost("/dataroom/membership/register", { roomId, mint: true });
let [, m2] = await jpost("/dataroom/membership/register", { roomId, mint: true });
check("register 2-member anonymity set", m1.ok && m2.ok && m2.memberCount === 2, `count=${m2.memberCount}`);
let [, sr] = await jpost("/dataroom/membership/set-root", { roomId });
check("set eligible root on-chain", sr.ok, `tx=${sr.txHash}`);

// 2. prove DR2 membership for M1 (worker-first) — recipientPub defaults to the demo key we hold
console.log("2. prove DR2 membership (worker-first; ~2-3 min)…");
let [, pa] = await jpost("/dataroom/membership/prove-access", {
  roomId, idSecret: m1.minted.idSecret, idTrapdoor: m1.minted.idTrapdoor, holderSeed: m1.minted.holderSeed,
});
check("prove-access enqueued", !!pa.jobId, `accessor=${pa.accessor?.slice(0, 12)}… recipient=${pa.recipientPub?.slice(0, 12)}…`);
const accessor = pa.accessor;
const bundle = await pollProof(pa.jobId);
console.log("");
check("worker/VM proved (canonical membership image)", bundle?.image_id === MEMBERSHIP_IMAGE);

// 3. request_access → GRANT (recipient_pub = the demo key)
let [, ra] = await jpost("/dataroom/membership/request-access", bundle);
check("request-access GRANT", ra.ok && ra.grant?.accessor === accessor, `tx=${ra.txHash}`);
let [, ig] = await jget(`/dataroom/membership/is-granted/${roomId}/${accessor}`);
check("is_granted = true", ig.isGranted === true);

// 4. DEALER: committee seal-doc — split K to the keypers + anchor the committee document
let [ss, seal] = await jpost("/dataroom/committee/seal-doc", { roomId, docId: `dr3-doc-${rnd()}`, content: SECRET });
check("committee seal-doc (K split + dealt + anchored)", ss === 200 && seal.ok && seal.dealt === ci.n, `dealt=${seal.dealt} tx=${seal.txHash} doc=${seal.docId?.slice(0, 12)}…`);
const docId = seal.docId;

// 5. on-chain committee document records content_hash + k_commitment
let [, cd] = await jget(`/dataroom/committee/document/${roomId}/${docId}`);
check("committee document anchored on-chain", !!cd.document && cd.document.content_hash === seal.contentHash && cd.document.k_commitment === seal.kCommitment, `content_hash=${cd.document?.content_hash?.slice(0, 12)}…`);

// 6. collect sealed shares (granted accessor) — no secret involved
let [cs, col] = await jpost(`/dataroom/committee/collect/${roomId}/${docId}`, { accessor });
check("collect >= threshold sealed shares", cs === 200 && col.shares?.length >= ci.threshold, `collected=${col.shares?.length} recipient=${col.recipientPub?.slice(0, 12)}…`);

// 7. THE acceptance: reconstruct K (2-of-3) + AES-GCM-decrypt → content MATCH (demo recipient secret)
let [os, open] = await jpost(`/dataroom/committee/open/${roomId}/${docId}`, { accessor });
check("committee OPEN → reconstruct (2-of-3) + decrypt", os === 200 && open.ok && open.faithful, `pair=${JSON.stringify(open.reconstructedFromPair)}`);
check("decrypted plaintext MATCHES the sealed document", open.content === SECRET, `got="${(open.content || "").slice(0, 40)}…"`);

// 8. NEGATIVE: a non-granted accessor cannot collect or open (the keypers' live is_granted gate)
const stranger = "ab".repeat(32);
let [ns] = await jpost(`/dataroom/committee/collect/${roomId}/${docId}`, { accessor: stranger });
check("non-granted accessor → 403 collect (committee refuses)", ns === 403);
let [no] = await jpost(`/dataroom/committee/open/${roomId}/${docId}`, { accessor: stranger });
check("non-granted accessor → 403 open", no === 403);

// 9. NEGATIVE: a wrong recipient key cannot open (shares don't open faithfully)
let [, wk] = await jpost(`/dataroom/committee/open/${roomId}/${docId}`, { accessor, recipientKey: "11".repeat(32) });
check("wrong recipient key → not faithful (cannot decrypt)", wk.ok === false && wk.faithful === false);

console.log(`\n[dr3-e2e] room=${roomId.slice(0, 12)}… doc=${docId?.slice(0, 12)}… accessor=${accessor?.slice(0, 12)}…`);
console.log(failed === 0 ? "\nDR3 E2E ALL GREEN ✓" : `\n${failed} CHECK(S) FAILED ✗`);
process.exit(failed === 0 ? 0 : 1);
