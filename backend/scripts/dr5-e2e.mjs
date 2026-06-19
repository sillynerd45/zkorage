// DR5 — faithful disclosure / data-side teaser end-to-end self-test (drives the running backend's HTTP
// routes). Flow:
//   A. create room → anchor the FULL sealed original (put_document)
//   B. TEASER (positive): appraiser proves figure>=X → attest_teaser → read back + valid; figure stays PRIVATE
//   C. TEASER (negative): a SELF-MINTED appraiser key → attest_teaser must be rejected (#8 IssuerNotAllowed)
//   D. AUDITOR redacted view: redact per policy → seal to auditor → anchor → auditor opens (faithful + log) +
//      wrong-key reject
// Usage: node scripts/dr5-e2e.mjs   (backend must be running on $BASE; worker-first proving via the gateway).
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const BASE = process.env.BASE || "http://localhost:8787";
const rnd = () => Math.random().toString(16).slice(2, 10);
const roomLabel = process.argv[2] || `dr5-e2e-room-${rnd()}`;
const PROOF_TIMEOUT_MS = 9 * 60 * 1000;
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function jpost(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return [r.status, await r.json()];
}
async function jget(path) {
  const r = await fetch(BASE + path);
  return [r.status, await r.json()];
}
async function pollJob(jobId, label) {
  const deadline = Date.now() + PROOF_TIMEOUT_MS;
  process.stdout.write(`   proving ${label} `);
  while (Date.now() < deadline) {
    const [, st] = await jget("/prove-status/" + jobId);
    if (st.status === "done" && st.bundle) { console.log(` done (by=${st.by})`); return st.bundle; }
    if (st.status === "error") throw new Error("prove error: " + st.error);
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("proof timed out: " + label);
}

console.log(`[dr5-e2e] BASE=${BASE} room="${roomLabel}"`);

// ── info / config ──
const [, info] = await jget("/dataroom/teaser/info");
if (!info.appraiserAllowed) throw new Error("appraiser not allowlisted on-chain — run the DR5 upgrade first");
const PROVER_URL = (await jget("/info"))[1].proverUrl;
console.log("0. teaser/info    appraiser=", info.appraiserAttester.slice(0, 12), "allowed=", info.appraiserAllowed, "| proverUrl=", PROVER_URL);

// ── A. create room + anchor the FULL sealed original ──
let [sa, room] = await jpost("/dataroom/create-room", { roomId: roomLabel });
if (!room.ok) throw new Error("create-room failed: " + room.error);
const roomId = room.roomId;
console.log("A1. create-room   ", sa, "roomId=", roomId.slice(0, 12), "tx=", room.txHash);

const fullContent = JSON.stringify({ confidential: "FULL financial statement", revenue: 4250000, ts: new Date().toISOString() });
let [, fseal] = await jpost("/dataroom/prove-seal", { roomId, docId: `dr5-full-${rnd()}`, content: fullContent });
if (!fseal.jobId) throw new Error("prove-seal(full) failed: " + JSON.stringify(fseal));
const fullBundle = await pollJob(fseal.jobId, "full-doc seal");
let [, fsub] = await jpost("/dataroom/submit-document", { ...fullBundle, blobPointer: fseal.blobPointer });
if (!fsub.ok) throw new Error("submit full doc failed: " + fsub.error);
const fullDocId = fseal.docId;
console.log("A2. full original  anchored docId=", fullDocId.slice(0, 12), "contentHash=", fseal.contentHash.slice(0, 12), "tx=", fsub.txHash);

// ── B. TEASER (positive): prove figure>=threshold (figure PRIVATE) → attest_teaser → read back ──
let [, tprove] = await jpost("/dataroom/teaser/prove", { roomId, docId: fullDocId, threshold: 1000000 });
if (!tprove.jobId) throw new Error("teaser/prove failed: " + JSON.stringify(tprove));
const teaserBundle = await pollJob(tprove.jobId, "teaser (figure>=1M)");
let [, tatt] = await jpost("/dataroom/teaser/attest", { ...teaserBundle, roomId, docId: fullDocId });
if (!tatt.ok) throw new Error("teaser attest failed: " + tatt.error);
const teaserCost = tatt.cost;
console.log("B1. teaser attest  tx=", tatt.txHash, "| field_tag=", tatt.teaser?.field_tag, "threshold=", tatt.teaser?.threshold, "(figure ABSENT)");
let [, tread] = await jget(`/dataroom/teaser/${roomId}/${fullDocId}`);
console.log("B2. teaser read    valid=", tread.valid, "| content_hash bound=", String(tread.teaser?.content_hash).slice(0, 12), "| attester=", String(tread.teaser?.attester).slice(0, 12));
if (!tread.teaser || !tread.valid) throw new Error("teaser read-back / validity FAILED");
if (String(tread.teaser.content_hash) !== fseal.contentHash) throw new Error("teaser must bind the full doc's content_hash");

// ── C. TEASER (negative): a SELF-MINTED appraiser key → attest_teaser must reject (#8 IssuerNotAllowed) ──
// Build + ed25519-sign a teaser envelope under a fresh (non-allowlisted) key, prove it directly via the
// gateway, then attest → the contract must reject it because the key is not in the appraiser allowlist.
const selfSeed = new Uint8Array(32).fill(0x42); // a self-minted (non-allowlisted) appraiser key
const selfPub = ed.getPublicKey(selfSeed);
const env = new Uint8Array(60); const dv = new DataView(env.buffer);
dv.setUint32(0, 11, false);          // claim_type = 11 (teaser)
dv.setBigUint64(4, 4250000n, false); // value (figure)
env.set(selfPub, 12);                // issuer_id = the self-minted pubkey
dv.setBigUint64(44, 1n, false);      // nonce = field_tag (revenue)
dv.setBigUint64(52, 9999999999n, false); // expiry
const sig = ed.sign(env, selfSeed);
const gr = await fetch(`${PROVER_URL}/prove`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "reserves", envelope_hex: toHex(env), signature_hex: toHex(sig), issuer_pubkey_hex: toHex(selfPub), threshold: "1000000" }) });
const gj = await gr.json();
if (!gj.job_id) throw new Error("self-minted teaser enqueue failed: " + JSON.stringify(gj));
const selfBundle = await pollJob(gj.job_id, "self-minted teaser");
// reuse the SAME full doc but a fresh teaser binding won't matter — the attester check fires first for a new
// (room,doc). Use the full doc; since a teaser already exists there, anchor a 2nd doc to avoid TeaserExists
// masking the #8. Anchor a throwaway doc and bind the self-minted teaser to it.
let [, dseal2] = await jpost("/dataroom/prove-seal", { roomId, docId: `dr5-neg-${rnd()}`, content: "neg-doc" });
const negBundle = await pollJob(dseal2.jobId, "neg-doc seal");
await jpost("/dataroom/submit-document", { ...negBundle, blobPointer: dseal2.blobPointer });
let [, natt] = await jpost("/dataroom/teaser/attest", { ...selfBundle, roomId, docId: dseal2.docId });
const rejected = !natt.ok && /#8|IssuerNotAllowed|Error\(Contract, ?#8\)/.test(natt.error || "");
console.log("C1. self-minted    attest ok=", natt.ok, rejected ? "→ REJECTED #8 ✓ (self-minted appraiser refused)" : `→ ✗ expected #8, got: ${natt.error}`);
if (!rejected) throw new Error("self-minted appraiser MUST be rejected #8; got: " + JSON.stringify(natt));

// ── D. AUDITOR redacted view: redact per policy → seal to auditor → anchor → open (faithful + log) ──
let [, dprove] = await jpost("/dataroom/disclose/prove", { roomId });
if (!dprove.jobId) throw new Error("disclose/prove failed: " + JSON.stringify(dprove));
console.log("D1. disclose       redaction log:", dprove.redactionLog.map((e) => `${e.field}:${e.mask}`).join(", "));
const discBundle = await pollJob(dprove.jobId, "auditor redacted seal");
let [, dsub] = await jpost("/dataroom/submit-document", { ...discBundle, blobPointer: dprove.blobPointer });
if (!dsub.ok) throw new Error("submit redacted view failed: " + dsub.error);
const redactedDocId = dprove.docId;
console.log("D2. redacted view  anchored docId=", redactedDocId.slice(0, 12), "sealed to auditor=", dprove.auditorPub.slice(0, 12), "tx=", dsub.txHash);

let [, dopen] = await jpost(`/dataroom/disclose/open/${roomId}/${redactedDocId}`, {});
const doc = dopen.disclosure?.document || {};
const bankMasked = typeof doc.bank_account === "string" && doc.bank_account.startsWith("****") && !String(doc.bank_account).includes("4012888888881881");
const ssnRedacted = doc.ceo_ssn === "[REDACTED]";
const routingDropped = doc.routing_number === undefined;
const revenueKept = doc.annual_revenue_usd === 4250000;
const netIncomeKept = doc.net_income_usd === 880000;
console.log("D3. auditor open   faithful=", dopen.faithful, "| bank_account=", doc.bank_account, "| ceo_ssn=", doc.ceo_ssn, "| signed_date=", doc.signed_date, "| revenue=", doc.annual_revenue_usd);
if (!dopen.faithful) throw new Error("auditor open must be faithful");
if (!(bankMasked && ssnRedacted && routingDropped && revenueKept && netIncomeKept)) {
  throw new Error("redacted view incorrect: " + JSON.stringify(doc));
}

let [, dwrong] = await jpost(`/dataroom/disclose/open/${roomId}/${redactedDocId}`, { viewKey: "11".repeat(32) });
console.log("D4. wrong view-key faithful=", dwrong.faithful, dwrong.faithful ? "✗ SHOULD BE FALSE" : "✓ rejected");
if (dwrong.faithful) throw new Error("wrong auditor key must not be faithful");

console.log("\n[dr5-e2e] ✅ ALL GREEN");
console.log(`  • teaser attested (figure>=1M, figure PRIVATE); self-minted appraiser rejected #8`);
console.log(`  • auditor opened the redacted view faithfully (PCI/HIPAA/GDPR masking); wrong key rejected`);
console.log(`  • attest_teaser verify cost: ${teaserCost?.cpuInsns ?? teaserCost?.cpu_insns ?? JSON.stringify(teaserCost)} | room=${roomId}`);
