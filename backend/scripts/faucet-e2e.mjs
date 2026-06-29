// On-chain e2e for the faucet: fresh wallet -> friendbot -> build trustlines -> sign -> claim -> verify
// balances -> second claim is rate-limited. Run against a backend started with FAUCET_ISSUER_SECRETS.
//   BACKEND=http://localhost:8790 node scripts/faucet-e2e.mjs
import { Keypair, Networks, TransactionBuilder, Horizon } from "@stellar/stellar-sdk";

const BACKEND = process.env.BACKEND || "http://localhost:8790";
const HORIZON = "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const horizon = new Horizon.Server(HORIZON);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jpost = async (path, body) => {
  const r = await fetch(`${BACKEND}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

const kp = Keypair.random();
const G = kp.publicKey();
console.log("wallet:", G);

console.log("info:", (await (await fetch(`${BACKEND}/faucet/info`)).json()));

console.log("friendbot...");
await fetch(`${FRIENDBOT()}?addr=${G}`);
function FRIENDBOT() { return "https://friendbot.stellar.org"; }
for (let i = 0; i < 20; i++) {
  try { await horizon.loadAccount(G); break; } catch { await sleep(1000); }
}

const built = await jpost("/faucet/build-trustlines", { address: G });
console.log("build-trustlines:", built.status, JSON.stringify(built.body));
if (!built.body.ok) throw new Error("build failed");
let signed;
if (built.body.xdr) {
  const tx = TransactionBuilder.fromXDR(built.body.xdr, PASSPHRASE);
  tx.sign(kp);
  signed = tx.toXDR();
}

const claim = await jpost("/faucet/claim", { address: G, signedTrustlineXdr: signed });
console.log("claim:", claim.status, JSON.stringify(claim.body, null, 2));
if (!claim.body.ok) throw new Error("claim failed");

await sleep(2000);
const acct = await horizon.loadAccount(G);
const held = acct.balances.filter((b) => b.asset_type !== "native").map((b) => `${b.asset_code}=${b.balance}`);
console.log("balances:", held.join(", "));

const claim2 = await jpost("/faucet/claim", { address: G, signedTrustlineXdr: undefined });
console.log("second claim status:", claim2.status, "(expect 429)", JSON.stringify(claim2.body));

const ok = claim.body.sent.length === 4 && held.length === 4 && claim2.status === 429;
console.log(ok ? "\nE2E GREEN" : "\nE2E FAILED");
process.exit(ok ? 0 : 1);
