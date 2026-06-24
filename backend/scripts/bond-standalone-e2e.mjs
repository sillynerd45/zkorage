// Standalone Bonded Access e2e: prove the multi-token bond gate works with its OWN member context (no Data
// Room). Mint a fresh handle (enrolled into the standalone set) -> the deployer locks a qualifying zkUSD bond
// tagged with the handle -> prove (roomId = the standalone set) -> submit -> the gate records a grant keyed to
// the anonymous accessor + req_id. Confirms is_granted = true. Usage: BASE=http://localhost:8787 node scripts/bond-standalone-e2e.mjs
const BASE = process.env.BASE || "http://localhost:8787";
const TOKEN = process.env.BOND_TOKEN || "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5"; // zkUSD SAC
const MIN = process.env.BOND_MIN || "1000000000"; // 100 zkUSD
const DEADLINE = Number(process.env.BOND_DEADLINE || 1800000000); // a requirement that already has qualifying bonds
const DEPOSITOR = process.env.DEPLOYER || "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const BOND_IMAGE = "dc4da02d887b3f388ffee26860a8416b393d4cfea982831183d15d5bfcf1f6c4";
const PROOF_TIMEOUT_MS = 18 * 60 * 1000;

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

// 1. the standalone set id + a fresh enrolled handle.
let [, info] = await jget("/bonded/bond/info");
const SET = info.standaloneSetId;
if (!SET) throw new Error("no standaloneSetId in /bonded/bond/info");
console.log(`[e2e] standalone set ${SET.slice(0, 12)}... enrolled=${info.standaloneEnrolledCount}`);

let [, en] = await jpost("/bonded/bond/enroll", { mint: true });
if (!en.ok || !en.minted) throw new Error("enroll failed: " + JSON.stringify(en));
const ID = en.minted;
console.log(`[e2e] minted handle accessor=${ID.accessor.slice(0, 10)}... qualCommitment=${ID.qualCommitment.slice(0, 10)}...`);

// 2. req_id + ensure the depositor has zkUSD.
let [, qs0] = await jget(`/bonded/bond/qual-set?token=${TOKEN}&min_amount=${MIN}&deadline=${DEADLINE}`);
const REQ = qs0.reqId;
console.log(`[e2e] req_id=${REQ.slice(0, 12)}... existing anonSet=${qs0.anonSetSize}`);
let [, bal] = await jget(`/escrow/balance?owner=${DEPOSITOR}`);
if (BigInt(bal.balance || "0") < BigInt(MIN)) {
  await jpost("/escrow/faucet", { to: DEPOSITOR });
}

// 3. the deployer locks a qualifying bond tagged with the handle (non-revocable, >= MIN, until DEADLINE).
let [, d] = await jpost("/escrow/deposit", { from: DEPOSITOR, token: TOKEN, amount: MIN, unlock_time: DEADLINE, claimant: DEPOSITOR, commitment: ID.qualCommitment, revocable: false });
if (!d.ok) throw new Error("deposit failed: " + JSON.stringify(d));
console.log(`[e2e] qualifying bond locked: lockId=${d.lockId} (tx ${String(d.txHash).slice(0, 10)}...)`);

// 4. prove via the STANDALONE member set, then submit.
console.log("[e2e] proving (worker-first; can take a few minutes)...");
let [, pa] = await jpost("/bonded/bond/prove", { roomId: SET, idSecret: ID.idSecret, idTrapdoor: ID.idTrapdoor, holderSeed: ID.holderSeed, token: TOKEN, min_amount: MIN, deadline: DEADLINE });
if (!pa.jobId) throw new Error("prove failed: " + JSON.stringify(pa));
if (pa.accessor !== ID.accessor) throw new Error(`accessor mismatch: ${pa.accessor} != ${ID.accessor}`);
console.log(`[e2e] prove job=${pa.jobId.slice(0, 10)}... anonSet=${pa.anonSetSize} memberRoot=${pa.memberRoot.slice(0, 10)}...`);
const bundle = await pollProof(pa.jobId);
if (bundle?.image_id !== BOND_IMAGE) throw new Error("non-canonical bond image: " + bundle?.image_id);
let [, sub] = await jpost("/bonded/bond/submit", bundle);
if (!sub.ok) throw new Error("submit failed: " + JSON.stringify(sub));
console.log(`[e2e] bond GRANT recorded: tx=${String(sub.txHash).slice(0, 10)}...`);

// 5. confirm the live decision.
let [, st] = await jget(`/bonded/bond/status?accessor=${ID.accessor}&req_id=${REQ}`);
console.log("\n===== STANDALONE BONDED-ACCESS E2E =====");
console.log(JSON.stringify({ accessor: ID.accessor, reqId: REQ, token: TOKEN, minAmount: MIN, deadline: DEADLINE, is_granted: st.is_granted, bondGateId: st.bondGateId }, null, 2));
const ok = st.is_granted === true;
console.log(ok ? "\nstandalone bonded-access e2e OK (any-token bond proved + granted in its own context)" : "\nstandalone bonded-access e2e FAIL");
process.exit(ok ? 0 : 1);
