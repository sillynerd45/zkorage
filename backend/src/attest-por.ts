// Helper: emit a Proof-of-Reserves attestation (claim_type=2) for the mock custodian.
// Usage: RESERVES=12000000000000 tsx src/attest-por.ts
//   stdout = JSON {envelope, signature, issuer_pubkey}; stderr = issuer_pubkey (the issuer_id).
import { attest, issuerPubkey } from "./signer.js";
import { toHex } from "./envelope.js";

const reserves = BigInt(process.env.RESERVES || "12000000000000"); // 1,200,000 zUSD @ 7dp (private)
const expiry = BigInt(process.env.EXPIRY || "9999999999");
const nonce = BigInt(process.env.NONCE || "1");

const a = attest({ claimType: 2, value: reserves, nonce, expiry });
process.stdout.write(JSON.stringify(a) + "\n");
process.stderr.write("issuer_pubkey(=issuer_id): " + toHex(issuerPubkey()) + "\n");
