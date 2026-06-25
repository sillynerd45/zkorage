// Background Bonded Access e2e: verify the BACKEND finishes a bond proof (poll + submit) so a client can
// leave. Mint a handle -> lock a qualifying bond -> POST /bonded/bond/prove {background:true} -> then ONLY
// poll /bonded/bond/status (never call /submit). If is_granted flips true, the backend submitted it on its
// own. Usage: BASE=http://localhost:8787 node scripts/bond-background-e2e.mjs
const BASE = process.env.BASE || "http://localhost:8787";
const TOKEN = process.env.BOND_TOKEN || "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5"; // zkUSD SAC
const MIN = process.env.BOND_MIN || "1000000000"; // 100 zkUSD
const DEADLINE = Number(process.env.BOND_DEADLINE || 1800000000);
const DEPOSITOR = process.env.DEPLOYER || "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const STATUS_TIMEOUT_MS = 18 * 60 * 1000;

const jpost = async (p, b) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }); return [r.status, await r.json().catch(() => ({}))]; };
const jget = async (p) => { const r = await fetch(BASE + p); return [r.status, await r.json().catch(() => ({}))]; };

let [, info] = await jget("/bonded/bond/info");
const SET = info.standaloneSetId;
if (!SET) throw new Error("no standaloneSetId in /bonded/bond/info");

let [, en] = await jpost("/bonded/bond/enroll", { mint: true });
if (!en.ok || !en.minted) throw new Error("enroll failed: " + JSON.stringify(en));
const ID = en.minted;
console.log(`[bg-e2e] minted handle accessor=${ID.accessor.slice(0, 10)}...`);

let [, qs0] = await jget(`/bonded/bond/qual-set?token=${TOKEN}&min_amount=${MIN}&deadline=${DEADLINE}`);
const REQ = qs0.reqId;
let [, bal] = await jget(`/escrow/balance?owner=${DEPOSITOR}`);
if (BigInt(bal.balance || "0") < BigInt(MIN)) await jpost("/escrow/faucet", { to: DEPOSITOR });

let [, d] = await jpost("/escrow/deposit", { from: DEPOSITOR, token: TOKEN, amount: MIN, unlock_time: DEADLINE, claimant: DEPOSITOR, commitment: ID.qualCommitment, revocable: false });
if (!d.ok) throw new Error("deposit failed: " + JSON.stringify(d));
console.log(`[bg-e2e] qualifying bond locked: lockId=${d.lockId}`);

// Prove in the BACKGROUND. The client gets a jobId and then walks away (we never call /submit).
let [, pa] = await jpost("/bonded/bond/prove", { roomId: SET, idSecret: ID.idSecret, idTrapdoor: ID.idTrapdoor, holderSeed: ID.holderSeed, token: TOKEN, min_amount: MIN, deadline: DEADLINE, background: true });
if (!pa.jobId) throw new Error("prove failed: " + JSON.stringify(pa));
if (pa.background !== true) throw new Error("prove did not echo background:true: " + JSON.stringify(pa));
console.log(`[bg-e2e] background prove started job=${pa.jobId.slice(0, 10)}... (NOT calling /submit; the backend should finish it)`);

// Only poll is_granted. If the backend's poll+submit works, it flips true on its own.
const t0 = Date.now();
let granted = false;
for (;;) {
  const [, st] = await jget(`/bonded/bond/status?accessor=${ID.accessor}&req_id=${REQ}`);
  if (st.is_granted === true) { granted = true; break; }
  if (Date.now() - t0 > STATUS_TIMEOUT_MS) break;
  process.stdout.write(".");
  await new Promise((r) => setTimeout(r, 10000));
}
process.stdout.write("\n");

console.log("\n===== BACKGROUND BONDED-ACCESS E2E =====");
console.log(JSON.stringify({ accessor: ID.accessor, reqId: REQ, is_granted: granted, elapsedS: Math.round((Date.now() - t0) / 1000) }, null, 2));
console.log(granted ? "\nbackground bonded-access e2e OK (backend finished + submitted; client never did)" : "\nbackground bonded-access e2e FAIL (no grant landed)");
process.exit(granted ? 0 : 1);
