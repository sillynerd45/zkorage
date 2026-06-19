// Mock ed25519 attester (swappable for a real custodian/KYC issuer).
// Produces a signed ClaimEnvelope the RISC0 guest verifies in-zkVM.
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import {
  buildEnvelope,
  buildIdentityEnvelope,
  toHex,
  CLAIM_TYPE_IDENTITY,
  CLAIM_TYPE_ACCREDITED,
  CLAIM_TYPE_REVENUE,
  CLAIM_TYPE_TEASER,
  ACCREDITED_DOMAIN,
  type ClaimEnvelope,
} from "./envelope.js";

// Wire sha512 so the synchronous ed25519 API works (Node has no sync subtle).
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// Demo issuer seed — matches the host's demo seed ([7u8;32]) so issuer_id is consistent
// across the self-signing host and this service. Real deployments load a private key.
export const DEMO_ISSUER_SEED = new Uint8Array(32).fill(7);

// Mock KYC provider seed ([9u8;32]) — DISTINCT from the PoR custodian, so the demo clearly separates
// "custodian" (Proof-of-Reserves) from "KYC provider" (identity). Matches host_identity's demo seed.
export const DEMO_KYC_ISSUER_SEED = new Uint8Array(32).fill(9);

// Mock payroll attester seed ([11u8;32]) — DISTINCT from the PoR custodian [7] and KYC provider [9].
// Matches host_payroll's demo seed. Signs a PayrollEnvelope (claim_type 5, salary private).
export const DEMO_PAYROLL_ATTESTER_SEED = new Uint8Array(32).fill(11);

export function payrollAttesterPubkey(seed: Uint8Array = DEMO_PAYROLL_ATTESTER_SEED): Uint8Array {
  return ed.getPublicKey(seed);
}

/**
 * Mock payroll attester: sign a payroll record. `salary` stays private (only the prover sees it; the
 * journal never carries it in cleartext — the ZK proof hides it). The PayrollEnvelope reuses the
 * ClaimEnvelope shape with claim_type = 5 (`value` = salary). `issuer_id` is the attester pubkey
 * (the guest enforces `issuer_id == signing key`).
 */
export function attestPayroll(
  claim: { salary: bigint; nonce?: bigint; expiry?: bigint },
  seed: Uint8Array = DEMO_PAYROLL_ATTESTER_SEED,
): Attestation {
  return attest(
    {
      claimType: 5,
      value: claim.salary,
      nonce: claim.nonce ?? 1n,
      expiry: claim.expiry ?? 9_999_999_999n,
    },
    seed,
  );
}

export interface Attestation {
  envelope: string; // hex (60 bytes)
  signature: string; // hex (64 bytes)
  issuer_pubkey: string; // hex (32 bytes)
}

export function issuerPubkey(seed: Uint8Array = DEMO_ISSUER_SEED): Uint8Array {
  return ed.getPublicKey(seed);
}

/** Sign a claim. `value` stays private (only the prover sees it). */
export function attest(
  claim: Omit<ClaimEnvelope, "issuerId"> & { issuerId?: Uint8Array },
  seed: Uint8Array = DEMO_ISSUER_SEED,
): Attestation {
  const pub = ed.getPublicKey(seed);
  const issuerId = claim.issuerId ?? pub; // demo convention: issuer_id = issuer pubkey
  const envelope = buildEnvelope({ ...claim, issuerId });
  const signature = ed.sign(envelope, seed);
  // sanity: self-verify
  if (!ed.verify(signature, envelope, pub)) throw new Error("self-verify failed");
  return {
    envelope: toHex(envelope),
    signature: toHex(signature),
    issuer_pubkey: toHex(pub),
  };
}

export const KYC_PASSED = 1n;

export interface KycAttestation {
  envelope: string; // hex (92 bytes)
  signature: string; // hex (64 bytes)
  issuer_pubkey: string; // hex (32 bytes — the KYC provider)
}

export function kycIssuerPubkey(seed: Uint8Array = DEMO_KYC_ISSUER_SEED): Uint8Array {
  return ed.getPublicKey(seed);
}

/**
 * Mock KYC provider: sign an identity credential for a subject. `subjectId` (the real identity) stays
 * server-side and is NEVER committed to the journal — the ZK proof hides it (selective disclosure).
 * `issuer_id` is the KYC provider pubkey (the guest enforces `issuer_id == signing key`).
 */
export function attestKyc(
  claim: {
    subjectId: Uint8Array;
    kycStatus?: bigint;
    nonce?: bigint;
    expiry?: bigint;
  },
  seed: Uint8Array = DEMO_KYC_ISSUER_SEED,
): KycAttestation {
  if (claim.subjectId.length !== 32) throw new Error("subjectId must be 32 bytes");
  const pub = ed.getPublicKey(seed);
  const envelope = buildIdentityEnvelope({
    claimType: CLAIM_TYPE_IDENTITY,
    kycStatus: claim.kycStatus ?? KYC_PASSED,
    subjectId: claim.subjectId,
    issuerId: pub, // convention: issuer_id == issuer pubkey
    nonce: claim.nonce ?? 1n,
    expiry: claim.expiry ?? 9_999_999_999n,
  });
  const signature = ed.sign(envelope, seed);
  if (!ed.verify(signature, envelope, pub)) throw new Error("kyc self-verify failed");
  return {
    envelope: toHex(envelope),
    signature: toHex(signature),
    issuer_pubkey: toHex(pub),
  };
}

/** Derive a deterministic 32-byte subject_id from a demo label (e.g. "alice"). Private witness. */
export function demoSubjectId(label: string): Uint8Array {
  const h = sha512(new TextEncoder().encode(`zkorage-kyc-subject:${label}`));
  return h.slice(0, 32);
}

// ─────────────────────────── Week 8 — Fundraising (composition) ───────────────────────────

// Mock accreditation-provider seed ([13u8;32]) — DISTINCT from PoR [7] / KYC [9] / payroll [11].
// Matches host_accredited's demo seed. Signs an AccreditedEnvelope (claim_type 7, identity-hidden).
export const DEMO_ACCREDITED_ISSUER_SEED = new Uint8Array(32).fill(13);
// Mock revenue-auditor seed ([15u8;32]) — DISTINCT from all the above. Matches the generic host's job
// path. Signs a RevenueEnvelope (claim_type 6, the 60-byte ClaimEnvelope; `value` = private revenue).
export const DEMO_REVENUE_ATTESTER_SEED = new Uint8Array(32).fill(15);

export function accreditedIssuerPubkey(seed: Uint8Array = DEMO_ACCREDITED_ISSUER_SEED): Uint8Array {
  return ed.getPublicKey(seed);
}
export function revenueAttesterPubkey(seed: Uint8Array = DEMO_REVENUE_ATTESTER_SEED): Uint8Array {
  return ed.getPublicKey(seed);
}

export interface AccreditedAttestation {
  envelope: string; // hex (92 bytes)
  signature: string; // hex (64 bytes — over ACCREDITED_DOMAIN ‖ envelope, NEW-2)
  issuer_pubkey: string; // hex (32 bytes — the accreditation provider)
}

/**
 * Mock accreditation provider: sign an "accredited = yes" credential for an investor. `subjectId` (the
 * investor's real identity) stays server-side and is NEVER committed (selective disclosure, like KYC).
 * NEW-2 hardening: the signature is over `ACCREDITED_DOMAIN ‖ envelope`, so an accreditation signature
 * can never be reinterpreted as the shape-identical KYC envelope. `issuer_id` is the provider pubkey
 * (the guest enforces `issuer_id == signing key`).
 */
export function attestAccredited(
  claim: { subjectId: Uint8Array; accreditedStatus?: bigint; nonce?: bigint; expiry?: bigint },
  seed: Uint8Array = DEMO_ACCREDITED_ISSUER_SEED,
): AccreditedAttestation {
  if (claim.subjectId.length !== 32) throw new Error("subjectId must be 32 bytes");
  const pub = ed.getPublicKey(seed);
  const envelope = buildIdentityEnvelope({
    claimType: CLAIM_TYPE_ACCREDITED,
    kycStatus: claim.accreditedStatus ?? 1n, // reuses the IdentityEnvelope `kyc_status` slot
    subjectId: claim.subjectId,
    issuerId: pub, // convention: issuer_id == issuer pubkey
    nonce: claim.nonce ?? 1n,
    expiry: claim.expiry ?? 9_999_999_999n,
  });
  // NEW-2: sign DOMAIN ‖ envelope (must match the guest's verify).
  const signed = new Uint8Array(ACCREDITED_DOMAIN.length + envelope.length);
  signed.set(ACCREDITED_DOMAIN, 0);
  signed.set(envelope, ACCREDITED_DOMAIN.length);
  const signature = ed.sign(signed, seed);
  if (!ed.verify(signature, signed, pub)) throw new Error("accredited self-verify failed");
  return { envelope: toHex(envelope), signature: toHex(signature), issuer_pubkey: toHex(pub) };
}

/**
 * Mock revenue auditor: sign a `revenue ≥ X` claim about the fundraise. `revenue` stays private (the ZK
 * proof hides it; only "≥ X" is revealed). Reuses the 60-byte ClaimEnvelope with claim_type = 6, so the
 * generic value≥threshold guest proves it. `issuer_id` is the auditor pubkey.
 */
export function attestRevenue(
  claim: { revenue: bigint; nonce?: bigint; expiry?: bigint },
  seed: Uint8Array = DEMO_REVENUE_ATTESTER_SEED,
): Attestation {
  return attest(
    {
      claimType: CLAIM_TYPE_REVENUE,
      value: claim.revenue,
      nonce: claim.nonce ?? 1n,
      expiry: claim.expiry ?? 9_999_999_999n,
    },
    seed,
  );
}

/** Derive a deterministic 32-byte subject_id for a demo investor (e.g. "ivy"). Private witness. */
export function demoInvestorId(label: string): Uint8Array {
  const h = sha512(new TextEncoder().encode(`zkorage-accredited-subject:${label}`));
  return h.slice(0, 32);
}

// ─────────────────────────── DR5 — data-room data-side teaser ───────────────────────────

// Mock "data-room appraiser" attester seed ([17u8;32]) — DISTINCT from PoR [7] / KYC [9] / payroll [11] /
// accredited [13] / revenue [15]. Vouches a teaser figure about a sealed document: signs a TeaserEnvelope
// (the 60-byte ClaimEnvelope, claim_type = 11, `value` = the PRIVATE figure, `nonce` = the field id). The
// DataRoom allowlists this pubkey (the third-party-truth anchor — a self-minted key is rejected).
export const DEMO_TEASER_ATTESTER_SEED = new Uint8Array(32).fill(17);

export function teaserAttesterPubkey(seed: Uint8Array = DEMO_TEASER_ATTESTER_SEED): Uint8Array {
  return ed.getPublicKey(seed);
}

/**
 * Mock data-room appraiser: sign a `figure ≥ X` teaser about a sealed document. `figure` stays private (the
 * ZK proof hides it; only "≥ X" is revealed). Reuses the 60-byte ClaimEnvelope with claim_type = 11, so the
 * generic value≥threshold guest proves it UNCHANGED. The appraiser signs `nonce = fieldTag` (1 = revenue),
 * so the field semantics are attester-vouched (not an owner label). `issuer_id` is the appraiser pubkey.
 */
export function attestTeaser(
  claim: { figure: bigint; fieldTag?: number; expiry?: bigint },
  seed: Uint8Array = DEMO_TEASER_ATTESTER_SEED,
): Attestation {
  return attest(
    {
      claimType: CLAIM_TYPE_TEASER,
      value: claim.figure,
      nonce: BigInt(claim.fieldTag ?? 1),
      expiry: claim.expiry ?? 9_999_999_999n,
    },
    seed,
  );
}

// CLI: `npm run sign-demo` — prints the PoR demo attestation + the KYC issuer pubkey.
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = attest({ claimType: 1, value: 1_000_000n, nonce: 1n, expiry: 9_999_999_999n });
  console.log(JSON.stringify(a, null, 2));
  console.log("kyc_issuer_pubkey =", toHex(kycIssuerPubkey()));
}
