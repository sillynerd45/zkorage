// Worker-first GPU e2e: craft a reserves claim signed by the PoR custodian (seed [7;32]), submit to the
// gateway, confirm the v5 GPU worker claims+proves it on GPU, and the bundle is a valid v5 proof.
import crypto from "node:crypto";
import fs from "node:fs";

const GW = "https://prover.wazowsky.id";
const SUPPLY = 10000000000000n; // token total_supply (reserves >= supply -> value == threshold == supply)

// ed25519 from a raw 32-byte seed (PKCS8 DER wrapper).
const seed = Buffer.alloc(32, 7);
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const priv = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const pubRaw = crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32); // last 32 = raw pubkey

// 60-byte envelope: claim_type(4) | value(8) | issuer_id(32) | nonce(8) | expiry(8), all big-endian.
const env = Buffer.alloc(60);
env.writeUInt32BE(2, 0);                 // claim_type 2 (PoR)
env.writeBigUInt64BE(SUPPLY, 4);         // value (reserves)
pubRaw.copy(env, 12);                     // issuer_id = custodian pubkey
env.writeBigUInt64BE(1n, 44);            // nonce
env.writeBigUInt64BE(9999999999n, 52);   // expiry
const sig = crypto.sign(null, env, priv); // ed25519

const body = {
  kind: "reserves",
  envelope_hex: env.toString("hex"),
  signature_hex: sig.toString("hex"),
  issuer_pubkey_hex: pubRaw.toString("hex"),
  threshold: SUPPLY.toString(),
};
console.log("issuer (seed7) pubkey:", pubRaw.toString("hex"));
console.log("POST", GW + "/prove ...");
const r = await fetch(GW + "/prove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const { job_id: id } = await r.json();
console.log("job id:", id);

const t0 = Date.now();
for (let i = 0; i < 120; i++) {
  await new Promise((res) => setTimeout(res, 3000));
  const s = await (await fetch(`${GW}/prove/${id}`)).json();
  if (s.status === "done") {
    const sel = s.bundle.seal.slice(0, 8);
    console.log(`DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s by=${s.by}`);
    console.log("  image_id:", s.bundle.image_id, s.bundle.image_id === "973c983125ad3a9f115b2f4d8d12ec39e3f1b107f15c57643f72baf36f923502" ? "(== v5 canonical claim ✓)" : "(UNEXPECTED)");
    console.log("  selector:", sel, sel === "ef6cb709" ? "(== v5 verifier ✓)" : "(UNEXPECTED)");
    fs.writeFileSync(new URL("./we2e_bundle.json", import.meta.url), JSON.stringify(s.bundle));
    console.log("  bundle written to prover/we2e_bundle.json");
    break;
  }
  if (s.status === "error") { console.log("ERROR by=" + s.by + ":", s.error); break; }
  if (i % 4 === 0) console.log(`  ...${s.status} (by=${s.by ?? "-"}) ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
