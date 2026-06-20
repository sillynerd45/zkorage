// BP5 — anonymous bonded tier end-to-end self-test (drives the running backend's HTTP routes).
//   enroll 3 members (mint) → 3 NON-revocable qualifying escrow locks (commitment = each member's
//   qualCommitment) → set-member-root on-chain → publish qual-root → 3 anonymous proofs (worker-first)
//   → 3 UNLINKABLE grants (distinct accessors + nullifiers) → nullifier reuse rejected (#NullifierUsed)
//   → SDK recomputeQualRoot accepted=true (the trustless audit).
// Usage: node scripts/bp5-tier-e2e.mjs   (backend on $BASE; DEPLOYER/threshold/X overridable via env).
import { ZkorageClient } from "zkorage-sdk";
import { randomBytes } from "node:crypto";

const BASE = process.env.BASE || "http://localhost:8787";
const THRESHOLD = process.env.TIER_THRESHOLD || "1000000000"; // 100 zkUSD (1e9 base units)
const X = Number(process.env.TIER_X || 1800000000); // ~2027-01-15 (fixed: members share ONE anon set)
const DEPOSITOR = process.env.DEPLOYER || "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const BOND_TOKEN = "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5";
const TIER_IMAGE = "2671938b59598c129913fee8e0ef29159e6475dd61c37c503429bdaf0fba4e69";
const PROOF_TIMEOUT_MS = 15 * 60 * 1000;

const jpost = async (p, b) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) });
  return [r.status, await r.json()];
};
const jget = async (p) => { const r = await fetch(BASE + p); return [r.status, await r.json()]; };
let failed = 0;
const check = (label, cond, extra = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`); if (!cond) failed++; };

async function pollProof(jobId) {
  const t0 = Date.now();
  for (;;) {
    const [, s] = await jget(`/prove-status/${jobId}`);
    if (s.status === "done") { process.stdout.write("\n"); return s.bundle; }
    if (s.status === "error") throw new Error("prover error: " + s.error);
    if (Date.now() - t0 > PROOF_TIMEOUT_MS) throw new Error("proof timeout");
    process.stdout.write(`  …${s.status}/${s.by || "-"}`);
    await new Promise((r) => setTimeout(r, 12000));
  }
}

console.log(`[bp5-tier-e2e] BASE=${BASE} threshold=${THRESHOLD} X=${X}`);

// 1. enroll 3 fresh members (the DEMO backend mints + returns their secrets).
const members = [];
for (let i = 0; i < 3; i++) {
  const [, m] = await jpost("/bonded/tier/enroll", { mint: true });
  if (!m.ok || !m.minted) throw new Error("enroll failed: " + JSON.stringify(m));
  members.push({ ...m.minted, memberIndex: m.memberIndex });
  console.log(`  enrolled M${i} index=${m.memberIndex} accessor=${m.minted.accessor.slice(0, 12)}… qc=${m.minted.qualCommitment.slice(0, 12)}…`);
}
check("enrolled 3 fresh members", members.length === 3);

// 2. each member bonds a NON-revocable qualifying lock (commitment = its qualCommitment).
for (let i = 0; i < members.length; i++) {
  const [, d] = await jpost("/escrow/deposit", {
    from: DEPOSITOR, token: BOND_TOKEN, amount: THRESHOLD, unlock_time: X,
    claimant: DEPOSITOR, commitment: members[i].qualCommitment, revocable: false,
  });
  check(`M${i} qualifying lock deposited`, d.ok === true, `lockId=${d.lockId} tx=${String(d.txHash).slice(0, 10)}…`);
}

// 3. pin the enrolled-member root on-chain.
let [, sr] = await jpost("/bonded/tier/set-member-root", {});
check("set-member-root on-chain", sr.ok === true, `tx=${String(sr.txHash).slice(0, 10)}… root=${String(sr.memberRoot).slice(0, 12)}… members=${sr.memberCount}`);

// 4. publish the qualifying-set root (must be ≥ N=3 to publish).
let [, qr] = await jpost("/bonded/tier/qual-root", { threshold: THRESHOLD, unlock_after: X });
check("qual-root published (anon set ≥ 3)", qr.ok === true && qr.anonSetSize >= 3, `size=${qr.anonSetSize} root=${String(qr.qualRoot).slice(0, 12)}… tx=${String(qr.txHash).slice(0, 10)}…`);

// 5. each member proves anonymously (worker-first) and submits → a grant.
const grants = [];
for (let i = 0; i < members.length; i++) {
  console.log(`5.${i} prove M${i} (worker-first)…`);
  const [, pa] = await jpost("/bonded/tier/prove", {
    idSecret: members[i].idSecret, idTrapdoor: members[i].idTrapdoor, holderSeed: members[i].holderSeed,
    threshold: THRESHOLD, unlock_after: X,
  });
  if (!pa.jobId) throw new Error(`prove M${i} failed: ` + JSON.stringify(pa));
  const bundle = await pollProof(pa.jobId);
  check(`M${i} worker proved canonical image`, bundle?.image_id === TIER_IMAGE, `by=${bundle?.by || "-"}`);
  const [, sub] = await jpost("/bonded/tier/submit", bundle);
  check(`M${i} submit → GRANT`, sub.ok === true && sub.grant?.accessor === pa.accessor, `tx=${String(sub.txHash).slice(0, 10)}…`);
  grants.push({ accessor: pa.accessor, nullifier: pa.nullifier, member: i, bundle });
}

// 6. the 3 grants are UNLINKABLE: distinct accessors + distinct nullifiers, all live.
const accs = new Set(grants.map((g) => g.accessor));
const nulls = new Set(grants.map((g) => g.nullifier));
check("3 distinct accessors", accs.size === 3);
check("3 distinct nullifiers", nulls.size === 3);
for (let i = 0; i < grants.length; i++) {
  const [, st] = await jget(`/bonded/tier/status?accessor=${grants[i].accessor}`);
  check(`M${i} is_granted = true`, st.is_granted === true);
}

// 7. nullifier reuse: re-prove M0 with a FRESH holder key (different accessor, SAME id_secret/context ⇒
//    SAME nullifier) → submit → #NullifierUsed (one grant per identity per context; a second wallet can't
//    ride the same credential).
console.log("7. nullifier-reuse attempt (M0, fresh accessor, same credential)…");
const reuseSeed = randomBytes(32).toString("hex");
const [, pr] = await jpost("/bonded/tier/prove", {
  idSecret: members[0].idSecret, idTrapdoor: members[0].idTrapdoor, holderSeed: reuseSeed,
  threshold: THRESHOLD, unlock_after: X,
});
if (!pr.jobId) throw new Error("reuse prove failed: " + JSON.stringify(pr));
check("reuse proof: same nullifier, different accessor", pr.nullifier === grants[0].nullifier && pr.accessor !== grants[0].accessor);
const reuseBundle = await pollProof(pr.jobId);
const [, rs] = await jpost("/bonded/tier/submit", reuseBundle);
check("reuse submit REJECTED (#NullifierUsed / #12)", rs.ok === false && /#?12\b|NullifierUsed|nullifier/i.test(String(rs.error)), `err=${String(rs.error).slice(0, 80)}`);
const [, nu] = await jget(`/bonded/tier/nullifier/${grants[0].nullifier}`);
check("nullifier marked used", nu.used === true);

// 8. the trustless audit: the SDK recomputes the qual root from the escrow's PUBLIC state and confirms the
//    gate's published root is honest (accepted).
const client = new ZkorageClient();
const rq = await client.recomputeQualRoot(THRESHOLD, X);
check("SDK recomputeQualRoot accepted = true", rq.accepted === true, `size=${rq.size} complete=${rq.complete} root=${rq.root.slice(0, 12)}…`);

console.log(`\n[bp5-tier-e2e] ${failed === 0 ? "ALL GREEN ✓" : failed + " CHECK(S) FAILED ✗"}`);
console.log("grants:", grants.map((g) => ({ m: g.member, accessor: g.accessor.slice(0, 10) + "…", nullifier: g.nullifier.slice(0, 10) + "…" })));
process.exit(failed === 0 ? 0 : 1);
