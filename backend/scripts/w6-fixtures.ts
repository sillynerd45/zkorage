// Week-6 demo fixtures generator (run with: npx tsx scripts/w6-fixtures.ts).
// Builds the demo sanctions deny-list tree and, for a SUBJECT, prints the deny-list root + a ready-to-run
// 5-line `host_compliance` job file (envelope / signature / issuer_pubkey / accessor / witness), plus the
// raw KYC fields + witness so adversarial jobs can be assembled for self-tests:
//   * SUBJECT not sanctioned (e.g. "alice") -> emits a compliance job (the ✓ case) + witnessHex.
//   * SUBJECT sanctioned     (e.g. "mallory") -> no witness (a member can't prove non-membership); pair
//     its raw KYC fields with another subject's witness to demonstrate the guest panic (the ✗ case).
//   * KYC_STATUS=0 -> a signed-but-failed KYC credential (the guest panics after verifying the sig).
// Env: SUBJECT (default "alice"), KYC_STATUS (default 1), DENY_DEPTH (default 20).
import { Keypair } from "@stellar/stellar-sdk";
import { sha256 } from "@noble/hashes/sha256";
import { attestKyc, kycIssuerPubkey, demoSubjectId } from "../src/signer.js";
import { toHex } from "../src/envelope.js";
import { demoDenyTree, DENY_DEPTH } from "../src/denylist.js";

const SUBJECT = process.env.SUBJECT || "alice";
const KYC_STATUS = BigInt(process.env.KYC_STATUS ?? "1");

// The fixed demo "user wallet" — the public accessor the compliance proof grants access to. NOTE: this
// is INTENTIONALLY subject-independent (one demo wallet, regardless of SUBJECT) — the seed string is the
// canonical demo-user seed shared with W5, and its derived key MUST stay equal to DEMO_USER in the SDK /
// DEMO_USER_G in the frontend. Do NOT interpolate SUBJECT here or the on-chain grant/check stops matching.
const userSeed = sha256(new TextEncoder().encode("zkorage-demo-user-alice"));
const userKp = Keypair.fromRawEd25519Seed(Buffer.from(userSeed));
const accessorHex = toHex(new Uint8Array(userKp.rawPublicKey()));

const tree = demoDenyTree();
const subjectId = demoSubjectId(SUBJECT);
const member = tree.isMember(subjectId);

// A signed KYC credential for this subject (kyc_status honored — 0 demonstrates the failed-KYC panic).
const kyc = attestKyc({ subjectId, kycStatus: KYC_STATUS, nonce: 1n, expiry: 9_999_999_999n });

const out: Record<string, unknown> = {
  denyDepth: DENY_DEPTH,
  denyRoot: tree.rootHex(),
  denySize: tree.size(),
  kycIssuerId: toHex(kycIssuerPubkey()),
  demoUserG: userKp.publicKey(),
  accessorHex,
  subject: SUBJECT,
  subjectIdHex: toHex(subjectId),
  kycStatus: KYC_STATUS.toString(),
  isSanctioned: member,
  // Raw KYC fields (for assembling adversarial jobs in self-tests).
  kycEnvelope: kyc.envelope,
  kycSignature: kyc.signature,
  kycPubkey: kyc.issuer_pubkey,
};

if (member) {
  out.note = `${SUBJECT} IS on the deny-list — no non-membership witness exists. Pair kycEnvelope/Signature/Pubkey with another subject's witness to show the guest panic (the ✗ case).`;
} else {
  const witness = tree.nonMembershipWitness(subjectId);
  out.witnessHex = witness;
  // 5-line host_compliance job (envelope / signature / issuer_pubkey / accessor / witness).
  out.complianceJob = `${kyc.envelope}\n${kyc.signature}\n${kyc.issuer_pubkey}\n${accessorHex}\n${witness}`;
}
console.log(JSON.stringify(out, null, 2));
