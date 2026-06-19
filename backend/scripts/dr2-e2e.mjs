// DR2 — anonymous eligibility end-to-end self-test (drives the running backend's HTTP routes).
//   create room → register 2 members (anonymity set) → set eligible root on-chain → prove membership
//   (worker-first) → request_access GRANT → is_granted true → re-submit same proof → #NullifierUsed
//   + negative (unregistered identity can't prove). Usage: node scripts/dr2-e2e.mjs   (backend on $BASE).
const BASE = process.env.BASE || "http://localhost:8787";
const rnd = () => Math.random().toString(16).slice(2, 10);
const room = `dr2-e2e-room-${rnd()}`;
const PROOF_TIMEOUT_MS = 12 * 60 * 1000;

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
    if (s.status === "done") return s.bundle;
    if (s.status === "error") throw new Error("prover error: " + s.error);
    if (Date.now() - t0 > PROOF_TIMEOUT_MS) throw new Error("proof timeout");
    process.stdout.write(`  …${s.status}/${s.by || "-"}`);
    await new Promise((r) => setTimeout(r, 15000));
  }
}

console.log(`[dr2-e2e] BASE=${BASE} room="${room}"`);

// 1. create the room (owner = server admin)
let [s, r] = await jpost("/dataroom/create-room", { roomId: room });
check("create-room", s === 200 && r.ok, `tx=${r.txHash} roomId=${r.roomId?.slice(0, 12)}…`);
const roomId = r.roomId;

// 2. register member M1 (minted) + member M2 (anonymity set of 2)
let [, m1] = await jpost("/dataroom/membership/register", { roomId, mint: true });
check("register M1", m1.ok && m1.minted, `index=${m1.memberIndex} count=${m1.memberCount}`);
let [, m2] = await jpost("/dataroom/membership/register", { roomId, mint: true });
check("register M2 (anonymity set grows)", m2.ok && m2.memberCount === 2, `count=${m2.memberCount} root=${m2.eligibleRoot?.slice(0, 12)}…`);

// 3. pin the eligible root on-chain
let [, sr] = await jpost("/dataroom/membership/set-root", { roomId });
check("set-root on-chain", sr.ok, `tx=${sr.txHash} root=${sr.eligibleRoot?.slice(0, 12)}…`);
let [, el] = await jget(`/dataroom/membership/eligible/${roomId}`);
check("eligible in-sync (computed == pinned)", el.inSync && el.memberCount === 2, `members=${el.memberCount}`);

// 4. prove membership for M1 (worker-first) — anonymous among the 2 members
console.log("4. prove-access M1 (worker-first; ~2 min)…");
let [, pa] = await jpost("/dataroom/membership/prove-access", {
  roomId, idSecret: m1.minted.idSecret, idTrapdoor: m1.minted.idTrapdoor, holderSeed: m1.minted.holderSeed,
});
check("prove-access enqueued", !!pa.jobId, `accessor=${pa.accessor?.slice(0, 12)}… nullifier=${pa.nullifier?.slice(0, 12)}…`);
const accessor = pa.accessor, nullifier = pa.nullifier;
const bundle = await pollProof(pa.jobId);
console.log("");
check("worker/VM proved (image canonical)", bundle?.image_id === "9550a12e84a9b26bc3926e79e271dc0f1a740f45d86f88c19d3e3e438939011c");

// 5. request_access → GRANT
let [, ra] = await jpost("/dataroom/membership/request-access", bundle);
check("request-access GRANT", ra.ok && ra.grant?.accessor === accessor, `tx=${ra.txHash}`);

// 6. is_granted true + nullifier used
let [, ig] = await jget(`/dataroom/membership/is-granted/${roomId}/${accessor}`);
check("is_granted(accessor) = true", ig.isGranted === true);
let [, nu] = await jget(`/dataroom/membership/nullifier/${roomId}/${nullifier}`);
check("nullifier used = true", nu.used === true);

// 7. THE marquee reuse: re-submit the SAME proof → #NullifierUsed (#15)
let [, ra2] = await jpost("/dataroom/membership/request-access", bundle);
check("reuse rejected #NullifierUsed (#15)", ra2.ok === false && /#15|NullifierUsed|Contract, #15/.test(ra2.error || ""), `err=${(ra2.error || "").slice(0, 60)}`);

// 8. negative: an UNREGISTERED identity cannot prove (not in the eligible set)
let [s8, neg] = await jpost("/dataroom/membership/prove-access", {
  roomId, idSecret: "11".repeat(32), idTrapdoor: "22".repeat(32), holderSeed: "03".repeat(32),
});
check("unregistered identity → 400 not-in-set", s8 === 400 && /eligible set/.test(neg.error || ""));

console.log(failed === 0 ? "\nDR2 E2E ALL GREEN ✓" : `\n${failed} CHECK(S) FAILED ✗`);
process.exit(failed === 0 ? 0 : 1);
