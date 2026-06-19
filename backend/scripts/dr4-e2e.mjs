// DR4 — document-authenticity (zkPDF in-engine) end-to-end self-test (drives the backend + the prover).
//   info → allowlist the mock-bank issuer → create a room → the bank RSA-signs a private statement →
//   prove "balance >= threshold" IN-ZKVM (worker-first, ~22 segments / multi-minute) → attest the fact
//   on-chain → read it back (predicate + threshold + issuer, but NOT the statement or exact value).
//   Negatives: a value < threshold proof is refused at the boundary; re-attesting the same doc → DocFactExists.
// Prereq: backend on $BASE with PROVER_URL + DATAROOM_CONTRACT_ID + SIGNER_SECRET set. The signer must own
// the created room (backend create-room makes the signer the owner). Usage: node scripts/dr4-e2e.mjs
const BASE = process.env.BASE || "http://localhost:8787";
const rnd = () => Math.random().toString(16).slice(2, 10);
const room = `dr4-e2e-room-${rnd()}`;
const PROOF_TIMEOUT_MS = 25 * 60 * 1000; // 22-segment RSA verify is ~7× payroll; allow generous wall-clock
const VALUE = 5_000_000; // the mock bank attests this private balance (minor units)
const THRESHOLD = 1_000_000; // the public floor X we prove value >= X against

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
    await new Promise((r) => setTimeout(r, 20000));
  }
}

console.log(`[dr4-e2e] BASE=${BASE} room="${room}"`);

const [, info] = await jget("/dataroom/docauth/info");
check("docauth/info image pinned", /^[0-9a-f]{64}$/.test(info.docauthImageOnchain || "") && info.claimType === 10,
  `image=${(info.docauthImageId || "").slice(0, 12)}… onchain=${(info.docauthImageOnchain || "").slice(0, 12)}…`);

const [, al] = await jpost("/dataroom/docauth/allowlist-issuer", {});
check("allowlist mock-bank issuer", al.ok === true || al.error?.includes("exists"), `issuer=${(al.issuerKeyHash || info.issuerKeyHash || "").slice(0, 12)}…`);

const [, cr] = await jpost("/dataroom/create-room", { roomId: room });
check("create-room (owner = signer)", cr.room?.room_id || cr.roomId || cr.error?.includes("Exists"), JSON.stringify(cr).slice(0, 80));
const roomIdHex = cr.room?.room_id || cr.roomId;
if (!roomIdHex) { console.log("cannot continue without roomId"); process.exit(1); }

console.log("[dr4-e2e] proving balance >= threshold (worker-first; this is the multi-minute RSA-verify proof)…");
const [, pf] = await jpost("/dataroom/docauth/prove-fact", { roomId: roomIdHex, value: VALUE, threshold: THRESHOLD });
check("prove-fact enqueued", !!pf.jobId, `job=${pf.jobId} msgDigest=${(pf.msgDigest || "").slice(0, 12)}…`);
const msgDigest = pf.msgDigest;
const bundle = await pollProof(pf.jobId);
process.stdout.write("\n");
check("proof produced (worker-first)", !!bundle?.seal && bundle?.image_id === info.docauthImageOnchain, `by image=${(bundle?.image_id || "").slice(0, 12)}…`);

const [, at] = await jpost("/dataroom/docauth/attest", { seal: bundle.seal, image_id: bundle.image_id, journal: bundle.journal });
check("attest_document_fact on-chain", at.ok === true && at.fact, `tx=${(at.txHash || "").slice(0, 10)}… cpu=${at.cost?.cpuInsns ?? "?"}`);

const [, fr] = await jget(`/dataroom/docauth/fact/${roomIdHex}/${msgDigest}`);
check("read fact back (predicate only; no statement/value)",
  fr.fact && String(fr.fact.threshold) === String(THRESHOLD) && fr.fact.field_tag === 1 && !("value" in fr.fact) && !("statement" in fr.fact),
  `threshold=${fr.fact?.threshold} issuer=${(fr.fact?.issuer_key_hash || "").slice(0, 10)}…`);

const [, fs] = await jget(`/dataroom/docauth/facts/${roomIdHex}`);
check("facts list count >= 1", (fs.count || 0) >= 1, `count=${fs.count}`);

// Negative: a value BELOW the threshold can't even be enqueued (the proof would not be producible).
const [st] = await jpost("/dataroom/docauth/prove-fact", { roomId: roomIdHex, value: 1, threshold: THRESHOLD });
check("prove-fact(value < threshold) refused at boundary (400)", st === 400);

// Negative: re-attesting the SAME (room, document) is rejected → one canonical fact per doc.
const [, at2] = await jpost("/dataroom/docauth/attest", { seal: bundle.seal, image_id: bundle.image_id, journal: bundle.journal });
check("re-attest same doc → DocFactExists (#18)", at2.ok === false && /DocFact|#18|exists/i.test(at2.error || ""), (at2.error || "").slice(0, 60));

console.log(failed === 0 ? "\nDR4 E2E OK" : `\nDR4 E2E FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
