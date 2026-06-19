// Client-side signing (Freighter) — backend XDR path, end-to-end on testnet.
//   A fresh Stellar keypair stands in for the Freighter extension (a headless test can't drive the real
//   browser popup). It exercises the full user-signed flow against a LOCAL backend (npm start):
//     fund wallet (friendbot) → GET /bundle/latest → POST /submit {source} → unsigned XDR
//     → sign locally (what Freighter does) → POST /tx/submit → on-chain SUCCESS.
//   Also checks: relay path (no source) still works; an unfunded source fails gracefully.
//   Run: (backend running on :8787)  node scripts/wallet-tx-e2e.mjs
import { Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";

const BASE = process.env.BASE || "http://localhost:8787";
const log = (...a) => console.log(...a);
const jpost = async (path, body) =>
  (await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const jget = async (path) => (await fetch(BASE + path)).json();

const kp = Keypair.random();
log("test wallet:", kp.publicKey());
log("friendbot:", (await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`)).status);
await new Promise((r) => setTimeout(r, 3000));

const bundle = await jget("/bundle/latest");
if (!bundle?.seal) { log("NO BUNDLE — aborting", bundle); process.exit(1); }

const built = await jpost("/submit", { ...bundle, source: kp.publicKey() });
log("\n[/submit source=wallet] mode:", built.mode, "ok:", built.ok, built.error ?? "");
if (!built.xdr) { log("NO XDR — aborting", built); process.exit(1); }

const tx = TransactionBuilder.fromXDR(built.xdr, Networks.TESTNET);
tx.sign(kp);
const sub = await jpost("/tx/submit", { signedXdr: tx.toXDR() });
log("[/tx/submit] ok:", sub.ok, " txHash:", sub.txHash, sub.error ?? "");

const relay = await jpost("/submit", bundle);
log("[/submit relay] ok:", relay.ok, " txHash:", relay.txHash?.slice(0, 12));

const bad = await jpost("/submit", { ...bundle, source: Keypair.random().publicKey() });
log("[/submit unfunded] ok:", bad.ok, " error:", (bad.error || "").slice(0, 60));

log("\nRESULT:", sub.ok && sub.txHash && relay.ok && !bad.ok ? "PASS" : "FAIL");
process.exit(sub.ok && sub.txHash && relay.ok && !bad.ok ? 0 : 1);
