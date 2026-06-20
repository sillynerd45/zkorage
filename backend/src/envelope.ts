// Canonical ClaimEnvelope codec — MUST match the RISC0 guest byte layout exactly
// (prover/methods/guest/src/main.rs). Big-endian, fixed widths.
//
//   ClaimEnvelope (60 bytes, signed by the issuer):
//     [0..4]   claim_type : u32
//     [4..12]  value      : u64    (PRIVATE — never leaves the prover / never committed)
//     [12..44] issuer_id  : [u8;32]
//     [44..52] nonce      : u64
//     [52..60] expiry     : u64
//
//   PublicClaim journal (61 bytes, committed by the guest, value ABSENT):
//     [0]      result     : u8 (1 = true)
//     [1..5]   claim_type : u32
//     [5..37]  issuer_id  : [u8;32]
//     [37..45] threshold  : u64
//     [45..53] nonce      : u64
//     [53..61] expiry     : u64

export const ENVELOPE_LEN = 60;
export const JOURNAL_LEN = 61;

//   IdentityEnvelope (92 bytes, signed by the KYC issuer):
//     [0..4]    claim_type : u32     (= 3, identity / KYC)
//     [4..12]   kyc_status : u64     (1 = PASSED)
//     [12..44]  subject_id : [u8;32] (PRIVATE — the real identity; never committed)
//     [44..76]  issuer_id  : [u8;32] (the KYC provider's ed25519 pubkey)
//     [76..84]  nonce      : u64
//     [84..92]  expiry     : u64
//
//   IdentityJournal (85 bytes, committed by the guest, subject_id ABSENT):
//     [0]       result     : u8 (1 = true)
//     [1..5]    claim_type : u32
//     [5..37]   issuer_id  : [u8;32]
//     [37..69]  accessor   : [u8;32]  (public binding — who gets access)
//     [69..77]  nonce      : u64
//     [77..85]  expiry     : u64
export const IDENTITY_ENVELOPE_LEN = 92;
export const IDENTITY_JOURNAL_LEN = 85;
export const CLAIM_TYPE_IDENTITY = 3;

//   ComplianceJournal (117 bytes, committed by the compliance guest, subject_id ABSENT):
//     [0]        result     : u8 (1 = KYC passed AND not sanctioned)
//     [1..5]     claim_type : u32 (= 4, compliance)
//     [5..37]    issuer_id  : [u8;32] (the KYC provider's ed25519 pubkey)
//     [37..69]   deny_root  : [u8;32] (sanctions deny-list Merkle root the proof checked)
//     [69..101]  accessor   : [u8;32] (public binding — who gets access)
//     [101..109] nonce      : u64
//     [109..117] expiry     : u64
// (The KYC IdentityEnvelope — claim_type 3 — is reused unchanged as the signed credential.)
export const COMPLIANCE_JOURNAL_LEN = 117;
export const CLAIM_TYPE_COMPLIANCE = 4;

//   PayrollEnvelope (60 bytes, signed by the payroll attester) — SAME shape as ClaimEnvelope, the
//   `value` field is the salary (so `buildEnvelope` is reused with claimType = 5):
//     [0..4]   claim_type : u32 (= 5, payroll / proof-of-income)
//     [4..12]  salary     : u64 (PRIVATE — only the auditor learns it, encrypted)
//     [12..44] issuer_id  : [u8;32] (the payroll attester's ed25519 pubkey)
//     [44..52] nonce      : u64
//     [52..60] expiry     : u64
//
//   PayrollJournal (229 bytes, committed by the guest, salary ABSENT):
//     [0]        result      : u8 (1 = salary ≥ threshold)
//     [1..5]     claim_type  : u32 (= 5)
//     [5..37]    issuer_id   : [u8;32]
//     [37..45]   threshold   : u64 (the public income bar that was cleared)
//     [45..77]   accessor    : [u8;32] (public binding — the verified-income credential holder)
//     [77..109]  auditor_pub : [u8;32] (x25519 disclosure target — must be allow-listed)
//     [109..141] eph_pub     : [u8;32] (ECIES ephemeral x25519 public key)
//     [141..181] ct          : [u8;40] (ECIES ciphertext of salary_be8 ‖ blinding32)
//     [181..213] tag         : [u8;32] (sha256(DOMAIN_TAG ‖ salary ‖ blinding) — faithful-decrypt check)
//     [213..221] nonce       : u64
//     [221..229] expiry      : u64
export const PAYROLL_JOURNAL_LEN = 229;
export const CLAIM_TYPE_PAYROLL = 5;

//   Week 8 — Fundraising (composition):
//   RevenueEnvelope reuses the 60-byte ClaimEnvelope (claim_type = 6, `value` = the PRIVATE revenue);
//   the generic guest commits the 61-byte journal with `threshold` = the public revenue floor X.
export const CLAIM_TYPE_REVENUE = 6;
//   AccreditedEnvelope reuses the 92-byte IdentityEnvelope (claim_type = 7, `kyc_status` field =
//   accredited_status, 1 = accredited); the journal is the 85-byte IdentityJournal shape (subject_id
//   ABSENT). NEW-2 hardening: the accreditation provider signs `ACCREDITED_DOMAIN ‖ envelope`, NOT the
//   bare envelope (must match prover/methods/guest-accredited/src/main.rs DOMAIN byte-for-byte).
export const CLAIM_TYPE_ACCREDITED = 7;
export const ACCREDITED_DOMAIN = new TextEncoder().encode("zkorage-accredited-v1\0"); // 22 bytes

//   DR5 — Confidential Data Room data-side teaser:
//   A TeaserEnvelope reuses the 60-byte ClaimEnvelope (claim_type = 11, `value` = the PRIVATE document
//   figure, `nonce` = the field id the appraiser signs so field semantics are attester-vouched). The
//   generic value≥threshold guest proves it UNCHANGED (no new guest); the DataRoom binds the public fact
//   (figure ≥ threshold) to a sealed document. claim_type 11 is distinct from the fundraise revenue (6).
export const CLAIM_TYPE_TEASER = 11;

//   BP3 — Bonded Proofs solvency gate:
//   A SolvencyEnvelope reuses the 60-byte ClaimEnvelope (claim_type = 12, `value` = the PRIVATE reserve
//   figure). The bonded reserve auditor signs `SOLVENCY_DOMAIN ‖ envelope` (NEW-2 domain separation, like
//   accredited), so a solvency attestation can never be reinterpreted as the byte-identical PoR envelope.
//   The solvency guest commits a 173-byte journal (the first 61 bytes are the PoR journal; the rest bind
//   the escrow lock + the two token roles). Must match prover/methods/guest-solvency/src/main.rs.
export const CLAIM_TYPE_SOLVENCY = 12;
export const SOLVENCY_DOMAIN = new TextEncoder().encode("zkorage-solvency-v1\0"); // 20 bytes
export const SOLVENCY_JOURNAL_LEN = 173;

export interface PublicSolvencyClaim {
  result: boolean;
  claimType: number;
  issuerId: string; // hex (the bonded reserve auditor)
  supply: bigint; // the proven liability (== supply_token.total_supply())
  nonce: bigint;
  expiry: bigint;
  escrow: string; // hex (32-byte escrow contract id)
  lockId: bigint; // u64
  minAmount: bigint; // u64
  bondToken: string; // hex (32-byte bond/collateral token id)
  supplyToken: string; // hex (32-byte supply/liability token id)
}

export function decodeSolvencyJournal(bytes: Uint8Array): PublicSolvencyClaim {
  if (bytes.length !== SOLVENCY_JOURNAL_LEN) {
    throw new Error(`solvency journal must be ${SOLVENCY_JOURNAL_LEN} bytes, got ${bytes.length}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    result: bytes[0] === 1,
    claimType: dv.getUint32(1, false),
    issuerId: toHex(bytes.slice(5, 37)),
    supply: dv.getBigUint64(37, false),
    nonce: dv.getBigUint64(45, false),
    expiry: dv.getBigUint64(53, false),
    escrow: toHex(bytes.slice(61, 93)),
    lockId: dv.getBigUint64(93, false),
    minAmount: dv.getBigUint64(101, false),
    bondToken: toHex(bytes.slice(109, 141)),
    supplyToken: toHex(bytes.slice(141, 173)),
  };
}

export interface PublicPayrollClaim {
  result: boolean;
  claimType: number;
  issuerId: string; // hex
  threshold: bigint;
  accessor: string; // hex (the public binding)
  auditorPub: string; // hex (the auditor x25519 disclosure target)
  ephPub: string; // hex (ECIES ephemeral pubkey)
  ct: string; // hex (40-byte ciphertext)
  tag: string; // hex (32-byte integrity tag)
  nonce: bigint;
  expiry: bigint;
}

export function decodePayrollJournal(bytes: Uint8Array): PublicPayrollClaim {
  if (bytes.length !== PAYROLL_JOURNAL_LEN) {
    throw new Error(`payroll journal must be ${PAYROLL_JOURNAL_LEN} bytes, got ${bytes.length}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    result: bytes[0] === 1,
    claimType: dv.getUint32(1, false),
    issuerId: toHex(bytes.slice(5, 37)),
    threshold: dv.getBigUint64(37, false),
    accessor: toHex(bytes.slice(45, 77)),
    auditorPub: toHex(bytes.slice(77, 109)),
    ephPub: toHex(bytes.slice(109, 141)),
    ct: toHex(bytes.slice(141, 181)),
    tag: toHex(bytes.slice(181, 213)),
    nonce: dv.getBigUint64(213, false),
    expiry: dv.getBigUint64(221, false),
  };
}

export interface ClaimEnvelope {
  claimType: number; // u32
  value: bigint; // u64 (private)
  issuerId: Uint8Array; // 32 bytes
  nonce: bigint; // u64
  expiry: bigint; // u64
}

export interface PublicClaim {
  result: boolean;
  claimType: number;
  issuerId: string; // hex
  threshold: bigint;
  nonce: bigint;
  expiry: bigint;
}

export function buildEnvelope(e: ClaimEnvelope): Uint8Array {
  if (e.issuerId.length !== 32) throw new Error("issuerId must be 32 bytes");
  const buf = new Uint8Array(ENVELOPE_LEN);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, e.claimType, false); // BE
  dv.setBigUint64(4, e.value, false);
  buf.set(e.issuerId, 12);
  dv.setBigUint64(44, e.nonce, false);
  dv.setBigUint64(52, e.expiry, false);
  return buf;
}

export function decodeJournal(bytes: Uint8Array): PublicClaim {
  if (bytes.length !== JOURNAL_LEN) {
    throw new Error(`journal must be ${JOURNAL_LEN} bytes, got ${bytes.length}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    result: bytes[0] === 1,
    claimType: dv.getUint32(1, false),
    issuerId: toHex(bytes.slice(5, 37)),
    threshold: dv.getBigUint64(37, false),
    nonce: dv.getBigUint64(45, false),
    expiry: dv.getBigUint64(53, false),
  };
}

export interface IdentityEnvelope {
  claimType: number; // u32 (= 3)
  kycStatus: bigint; // u64 (1 = passed)
  subjectId: Uint8Array; // 32 bytes (private)
  issuerId: Uint8Array; // 32 bytes (KYC provider pubkey)
  nonce: bigint; // u64
  expiry: bigint; // u64
}

export interface PublicIdentityClaim {
  result: boolean;
  claimType: number;
  issuerId: string; // hex
  accessor: string; // hex (the public binding)
  nonce: bigint;
  expiry: bigint;
}

export function buildIdentityEnvelope(e: IdentityEnvelope): Uint8Array {
  if (e.subjectId.length !== 32) throw new Error("subjectId must be 32 bytes");
  if (e.issuerId.length !== 32) throw new Error("issuerId must be 32 bytes");
  const buf = new Uint8Array(IDENTITY_ENVELOPE_LEN);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, e.claimType, false); // BE
  dv.setBigUint64(4, e.kycStatus, false);
  buf.set(e.subjectId, 12);
  buf.set(e.issuerId, 44);
  dv.setBigUint64(76, e.nonce, false);
  dv.setBigUint64(84, e.expiry, false);
  return buf;
}

export function decodeIdentityJournal(bytes: Uint8Array): PublicIdentityClaim {
  if (bytes.length !== IDENTITY_JOURNAL_LEN) {
    throw new Error(`identity journal must be ${IDENTITY_JOURNAL_LEN} bytes, got ${bytes.length}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    result: bytes[0] === 1,
    claimType: dv.getUint32(1, false),
    issuerId: toHex(bytes.slice(5, 37)),
    accessor: toHex(bytes.slice(37, 69)),
    nonce: dv.getBigUint64(69, false),
    expiry: dv.getBigUint64(77, false),
  };
}

export interface PublicComplianceClaim {
  result: boolean;
  claimType: number;
  issuerId: string; // hex
  denyRoot: string; // hex (the sanctions deny-list root the proof checked against)
  accessor: string; // hex (the public binding)
  nonce: bigint;
  expiry: bigint;
}

export function decodeComplianceJournal(bytes: Uint8Array): PublicComplianceClaim {
  if (bytes.length !== COMPLIANCE_JOURNAL_LEN) {
    throw new Error(`compliance journal must be ${COMPLIANCE_JOURNAL_LEN} bytes, got ${bytes.length}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    result: bytes[0] === 1,
    claimType: dv.getUint32(1, false),
    issuerId: toHex(bytes.slice(5, 37)),
    denyRoot: toHex(bytes.slice(37, 69)),
    accessor: toHex(bytes.slice(69, 101)),
    nonce: dv.getBigUint64(101, false),
    expiry: dv.getBigUint64(109, false),
  };
}

//   DR1 — Confidential Data Room "seal" journal (229 bytes, committed by the seal guest; doc key K ABSENT):
//     [0]        result       : u8 (1 = a faithful seal was produced)
//     [1..5]     claim_type   : u32 (= 8, dataroom seal)
//     [5..37]    room_id      : [u8;32]
//     [37..69]   doc_id       : [u8;32]
//     [69..101]  recipient_pub: [u8;32] (x25519 disclosure target the key K is sealed to)
//     [101..133] content_hash : [u8;32] (sha256 of the stored ciphertext blob)
//     [133..165] eph_pub      : [u8;32] (ECIES ephemeral x25519 public key)
//     [165..197] ct           : [u8;32] (ECIES ciphertext of the 32-byte document key K)
//     [197..229] tag          : [u8;32] (sha256(DOMAIN_TAG ‖ K ‖ content_hash ‖ room_id ‖ doc_id))
// There is NO attester/issuer field — DR1 is commitment-only (the value is confidential sharing + provable
// integrity, not third-party truth, which arrives in DR4). Matches prover/methods/guest-dataroom-seal +
// contract/contracts/dataroom byte-for-byte.
export const DATAROOM_SEAL_JOURNAL_LEN = 229;
export const CLAIM_TYPE_DATAROOM_SEAL = 8;

export interface PublicDataroomSealClaim {
  result: boolean;
  claimType: number;
  roomId: string; // hex
  docId: string; // hex
  recipientPub: string; // hex (x25519 disclosure target)
  contentHash: string; // hex (sha256 of the stored ciphertext blob)
  ephPub: string; // hex (ECIES ephemeral pubkey)
  ct: string; // hex (32-byte ciphertext of K)
  tag: string; // hex (32-byte faithful-decrypt tag)
}

export function decodeDataroomSealJournal(bytes: Uint8Array): PublicDataroomSealClaim {
  if (bytes.length !== DATAROOM_SEAL_JOURNAL_LEN) {
    throw new Error(`dataroom seal journal must be ${DATAROOM_SEAL_JOURNAL_LEN} bytes, got ${bytes.length}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    result: bytes[0] === 1,
    claimType: dv.getUint32(1, false),
    roomId: toHex(bytes.slice(5, 37)),
    docId: toHex(bytes.slice(37, 69)),
    recipientPub: toHex(bytes.slice(69, 101)),
    contentHash: toHex(bytes.slice(101, 133)),
    ephPub: toHex(bytes.slice(133, 165)),
    ct: toHex(bytes.slice(165, 197)),
    tag: toHex(bytes.slice(197, 229)),
  };
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  // Reject odd-length / non-hex up front — otherwise parseInt would silently truncate the last nibble or
  // coerce a non-hex byte to NaN→0, producing a wrong-length or zero-filled buffer with no error.
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error("invalid hex string");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
