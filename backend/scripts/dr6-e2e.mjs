// DR6 — private-policy composition + revocation + committee key rotation, end-to-end (drives the backend +
// the 3 live keypers + the real compliance/accredited gates on testnet).
//   create room → member M1 in eligible set → prove DR2 membership → GRANT (accessor A)
//   → set composite policy (member ∧ compliance ∧ accredited)
//   → request_room_admission(A) BEFORE the gate legs → #23 NotCompliant      (denial demo)
//   → prove+grant compliance(A) → request_room_admission(A) → #24 NotAccredited (denial demo)
//   → prove+grant accredited(A) → request_room_admission(A) → ADMITTED        (the composite AND)
//   → is_admitted(A) true
//   REVOCATION: revoke(A) → is_admitted false + membership is_granted false → request_room_admission #25;
//               unrevoke → admitted again.
//   KEY ROTATION: seal committee doc → open(A) MATCH → rotate (fresh K') → key_epoch 1 → open(A) MATCH (K')
//                 → revoke(A) → collect(A) 403 (keypers refuse the revoked accessor).
// Prereq: backend on $BASE, the 3 keypers live, prover online. Usage: node scripts/dr6-e2e.mjs
const BASE = process.env.BASE || "http://localhost:8787";
const rnd = () => Math.random().toString(16).slice(2, 10);
const room = `dr6-e2e-room-${rnd()}`;
const PROOF_TIMEOUT_MS = 12 * 60 * 1000;
const MEMBERSHIP_IMAGE = "9550a12e84a9b26bc3926e79e271dc0f1a740f45d86f88c19d3e3e438939011c";
const COMPLIANCE_IMAGE = "54d5921c58280b63ef80905ffe6d4e506f77031b53ff2a347fe84ace423cb129";
const ACCREDITED_IMAGE = "26d743739468287991220d6da2cb891616aa7c6b90da2eda9836395f31bcc947";
const SECRET = `dr6 board minutes :: ${rnd()} :: confidential 🔐`;
const SECRET2 = `dr6 board minutes (post-rotation) :: ${rnd()} :: confidential 🔐`;

const jpost = async (p, b) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) });
  return [r.status, await r.json().catch(() => ({}))];
};
const jget = async (p) => { const r = await fetch(BASE + p); return [r.status, await r.json().catch(() => ({}))]; };
let failed = 0;
const check = (label, cond, extra = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`); if (!cond) failed++; };
const errMatches = (o, codes) => codes.some((c) => new RegExp(`#${c}\\b|Contract, #${c}`).test(o?.error || ""));

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

console.log(`[dr6-e2e] BASE=${BASE} room="${room}"`);

// 0. DR6 info + committee online
let [, info] = await jget("/dataroom/admission/info");
check("admission/info (gates configured)", !!info.complianceGate && !!info.accreditedGate, `comp=${info.complianceGate?.slice(0, 8)}… acc=${info.accreditedGate?.slice(0, 8)}…`);
let [, ci] = await jget("/dataroom/committee/info");
check("committee online (>= threshold)", ci.online >= ci.threshold, `online=${ci.online}/${ci.n} threshold=${ci.threshold}`);

// 1. create room + a 2-member anonymity set + pin root
let [, cr] = await jpost("/dataroom/create-room", { roomId: room });
check("create-room", cr.ok, `tx=${cr.txHash}`);
const roomId = cr.roomId;
let [, m1] = await jpost("/dataroom/membership/register", { roomId, mint: true });
let [, m2] = await jpost("/dataroom/membership/register", { roomId, mint: true });
check("register 2-member anonymity set", m1.ok && m2.ok && m2.memberCount === 2, `count=${m2.memberCount}`);
let [, sr] = await jpost("/dataroom/membership/set-root", { roomId });
check("set eligible root on-chain", sr.ok, `tx=${sr.txHash}`);

// 2. prove DR2 membership for M1 (worker-first) → request_access GRANT → accessor A
console.log("2. prove DR2 membership (worker-first)…");
let [, pa] = await jpost("/dataroom/membership/prove-access", {
  roomId, idSecret: m1.minted.idSecret, idTrapdoor: m1.minted.idTrapdoor, holderSeed: m1.minted.holderSeed,
});
check("prove-access enqueued", !!pa.jobId, `accessor=${pa.accessor?.slice(0, 12)}…`);
const A = pa.accessor;
const memBundle = await pollProof(pa.jobId);
console.log("");
check("membership canonical image", memBundle?.image_id === MEMBERSHIP_IMAGE);
let [, ra] = await jpost("/dataroom/membership/request-access", memBundle);
check("membership GRANT", ra.ok && ra.grant?.accessor === A, `tx=${ra.txHash}`);

// 3. set the composite policy (member ∧ compliance ∧ accredited)
let [, ps] = await jpost("/dataroom/policy/set", { roomId }); // gates default ON
check("set_room_policy (composite)", ps.ok, `comp=${!!ps.complianceGate} acc=${!!ps.accreditedGate} tx=${ps.txHash}`);
let [, pol] = await jget(`/dataroom/policy/${roomId}`);
check("policy reads back (both gates set)", !!pol.policy?.compliance_gate && !!pol.policy?.accredited_gate && pol.policy?.require_membership === true);

// 4. DENIAL: membership granted but no compliance yet → request_room_admission → #23 NotCompliant
let [, d1] = await jpost("/dataroom/admission/request", { roomId, accessor: A });
check("admission denied #23 NotCompliant (member only)", d1.ok === false && errMatches(d1, [23]), `err=${(d1.error || "").slice(0, 40)}`);

// 5. prove + grant compliance for A (subject alice, not sanctioned)
console.log("5. prove compliance (worker-first)…");
let [, pc] = await jpost("/prove-compliance", { subject: "alice", accessor: A });
check("prove-compliance enqueued", !!pc.jobId, `accessor=${pc.accessor?.slice(0, 12)}…`);
const compBundle = await pollProof(pc.jobId);
console.log("");
check("compliance canonical image", compBundle?.image_id === COMPLIANCE_IMAGE);
let [, gc] = await jpost("/grant-compliance", compBundle);
check("compliance GRANT", gc.ok, `tx=${gc.txHash}`);

// 6. DENIAL: compliance now true but accredited not → #24 NotAccredited
let [, d2] = await jpost("/dataroom/admission/request", { roomId, accessor: A });
check("admission denied #24 NotAccredited (member+compliant)", d2.ok === false && errMatches(d2, [24]), `err=${(d2.error || "").slice(0, 40)}`);

// 7. prove + grant accredited for A (subject ivy)
console.log("7. prove accredited (worker-first)…");
let [, pacc] = await jpost("/prove-accredited", { subject: "ivy", accessor: A });
check("prove-accredited enqueued", !!pacc.jobId);
const accBundle = await pollProof(pacc.jobId);
console.log("");
check("accredited canonical image", accBundle?.image_id === ACCREDITED_IMAGE);
let [, ga] = await jpost("/grant-accredited", accBundle);
check("accredited GRANT", ga.ok, `tx=${ga.txHash}`);

// 8. THE composite AND: all three legs true → ADMITTED
let [, adm] = await jpost("/dataroom/admission/request", { roomId, accessor: A });
check("request_room_admission → ADMITTED (member ∧ compliance ∧ accredited)", adm.ok === true && adm.admission?.accessor === A, `tx=${adm.txHash} cpu=${adm.cost?.cpuInsns}`);
let [, ia] = await jget(`/dataroom/admission/is-admitted/${roomId}/${A}`);
check("is_admitted = true (live AND)", ia.isAdmitted === true);

// 9. REVOCATION: revoke A → is_admitted false + membership is_granted false → request #25
let [, rv] = await jpost("/dataroom/revoke", { roomId, accessor: A, revoked: true });
check("revoke_access(A)", rv.ok, `tx=${rv.txHash}`);
let [, ia2] = await jget(`/dataroom/admission/is-admitted/${roomId}/${A}`);
check("revoked → is_admitted false", ia2.isAdmitted === false);
let [, ig2] = await jget(`/dataroom/membership/is-granted/${roomId}/${A}`);
check("revoked → membership is_granted false (keypers refuse)", ig2.isGranted === false);
let [, d3] = await jpost("/dataroom/admission/request", { roomId, accessor: A });
check("revoked → request_room_admission #25 AccessRevoked", d3.ok === false && errMatches(d3, [25]), `err=${(d3.error || "").slice(0, 40)}`);
let [, un] = await jpost("/dataroom/revoke", { roomId, accessor: A, revoked: false });
check("unrevoke restores", un.ok);
let [, ia3] = await jget(`/dataroom/admission/is-admitted/${roomId}/${A}`);
check("unrevoked → is_admitted true again", ia3.isAdmitted === true);

// 10. COMMITTEE KEY ROTATION: seal a committee doc → open(A) MATCH → rotate → open(A) MATCH new K'
let [, seal] = await jpost("/dataroom/committee/seal-doc", { roomId, docId: `dr6-doc-${rnd()}`, content: SECRET });
check("committee seal-doc (K split + anchored)", seal.ok && seal.dealt === ci.n, `doc=${seal.docId?.slice(0, 12)}… tx=${seal.txHash}`);
const docId = seal.docId;
let [, ke0] = await jget(`/dataroom/committee/key-epoch/${roomId}/${docId}`);
check("key_epoch = 0 (original)", ke0.keyEpoch === 0);
let [o1s, open1] = await jpost(`/dataroom/committee/open/${roomId}/${docId}`, { accessor: A });
check("granted A opens (2-of-3) + decrypt MATCH", o1s === 200 && open1.ok && open1.faithful && open1.content === SECRET);

console.log("10. rotate committee key (fresh K' re-split + re-encrypt)…");
let [rrs, rot] = await jpost("/dataroom/committee/rotate-doc", { roomId, docId, content: SECRET2 });
check("rotate-doc (K' re-split + rotated on-chain)", rrs === 200 && rot.ok && rot.keyEpoch === 1, `epoch=${rot.keyEpoch} tx=${rot.txHash}`);
let [, ke1] = await jget(`/dataroom/committee/key-epoch/${roomId}/${docId}`);
check("key_epoch = 1 (rotated)", ke1.keyEpoch === 1);
let [o2s, open2] = await jpost(`/dataroom/committee/open/${roomId}/${docId}`, { accessor: A });
check("after rotation A opens with K' → NEW content MATCH", o2s === 200 && open2.ok && open2.faithful && open2.content === SECRET2, `got="${(open2.content || "").slice(0, 30)}…"`);

// 11. REVOKE during a live doc → keypers refuse the revoked accessor (403 collect)
let [, rv2] = await jpost("/dataroom/revoke", { roomId, accessor: A, revoked: true });
check("revoke A again (for the keyper-refusal demo)", rv2.ok);
let [cs] = await jpost(`/dataroom/committee/collect/${roomId}/${docId}`, { accessor: A });
check("revoked A → keypers refuse share release (403)", cs === 403);

console.log(`\n[dr6-e2e] room=${roomId.slice(0, 12)}… accessor=${A?.slice(0, 12)}… doc=${docId?.slice(0, 12)}…`);
console.log(failed === 0 ? "\nDR6 E2E ALL GREEN ✓" : `\n${failed} CHECK(S) FAILED ✗`);
process.exit(failed === 0 ? 0 : 1);
