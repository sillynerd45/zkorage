// Week-5 demo fixtures generator (run with: npx tsx scripts/w5-fixtures.ts).
// Prints the shared demo identities + ready-to-run prover job files for both canonical proofs:
//   * PoR re-pin proof  (claim_type 2, supply-bound)  -> host job format
//   * Identity proof     (claim_type 3, accessor-bound) -> host_identity job format
// Env: SUPPLY (base units, default 1e13 = 1,000,000 zUSD), SUBJECT (default "alice").
import { Keypair } from "@stellar/stellar-sdk";
import { sha256 } from "@noble/hashes/sha256";
import { attest, attestKyc, kycIssuerPubkey, demoSubjectId } from "../src/signer.js";
import { toHex } from "../src/envelope.js";

const SUPPLY = BigInt(process.env.SUPPLY || "10000000000000");
const SUBJECT = process.env.SUBJECT || "alice";

// Deterministic demo "user wallet" (Q3: accessor = a Stellar account's raw ed25519 key).
const userSeed = sha256(new TextEncoder().encode("zkorage-demo-user-alice"));
const userKp = Keypair.fromRawEd25519Seed(Buffer.from(userSeed));
const accessorG = userKp.publicKey();
const accessorHex = toHex(new Uint8Array(userKp.rawPublicKey()));

// PoR custodian (claim_type 2) — reserves == supply at the binding boundary (value >= threshold).
const por = attest({ claimType: 2, value: SUPPLY, nonce: 1n, expiry: 9_999_999_999n });

// KYC credential (claim_type 3) — subject_id stays private; accessor is the public binding.
const subjectId = demoSubjectId(SUBJECT);
const kyc = attestKyc({ subjectId, kycStatus: 1n, nonce: 1n, expiry: 9_999_999_999n });

const out = {
  demoUser: { g: accessorG, accessorHex },
  kycIssuerId: toHex(kycIssuerPubkey()),
  porIssuerId: por.issuer_pubkey,
  supply: SUPPLY.toString(),
  // 4-line job files (envelope / signature / pubkey / 4th-field).
  porJob: `${por.envelope}\n${por.signature}\n${por.issuer_pubkey}\n${SUPPLY}`,
  identityJob: `${kyc.envelope}\n${kyc.signature}\n${kyc.issuer_pubkey}\n${accessorHex}`,
};
console.log(JSON.stringify(out, null, 2));
