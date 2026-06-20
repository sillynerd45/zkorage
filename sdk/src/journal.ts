// Canonical 61-byte public journal codec + helpers. Big-endian, fixed widths — MUST match the guest.
//   [0] result u8 | [1..5] claim_type u32 | [5..37] issuer_id [u8;32]
//   [37..45] supply u64 | [45..53] nonce u64 | [53..61] expiry u64
import { sha256 } from "@noble/hashes/sha256";
import type { DecodedJournal, DecodedIdentityJournal, DecodedComplianceJournal, DecodedPayrollJournal, DecodedDataroomSealJournal, DecodedMembershipJournal, DecodedDocauthJournal, DecodedTierJournal } from "./types.js";

export const JOURNAL_LEN = 61;
export const IDENTITY_JOURNAL_LEN = 85;
export const COMPLIANCE_JOURNAL_LEN = 117;
export const PAYROLL_JOURNAL_LEN = 229;
export const DATAROOM_SEAL_JOURNAL_LEN = 229;
export const MEMBERSHIP_JOURNAL_LEN = 165;
export const DOCAUTH_JOURNAL_LEN = 113;
export const TIER_JOURNAL_LEN = 181;

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  // Reject odd-length / non-hex up front — otherwise parseInt would silently truncate the last nibble or
  // coerce a non-hex byte to NaN→0, producing a wrong-length or zero-filled buffer with no error.
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error("invalid hex string");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Normalize whatever `scValToNative` returns for a bytes field (Buffer / Uint8Array / number[]) to hex. */
export function bytesToHex(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return toHex(v);
  if (Array.isArray(v)) return toHex(Uint8Array.from(v as number[]));
  return "";
}

export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

function beU64(a: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(a[o + i]);
  return v;
}

function beU32(a: Uint8Array, o: number): number {
  return ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0;
}

export function decodeJournal(hex: string): DecodedJournal | null {
  const b = fromHex(hex);
  if (b.length !== JOURNAL_LEN) return null;
  return {
    result: b[0] === 1,
    claimType: beU32(b, 1),
    issuerId: toHex(b.slice(5, 37)),
    supply: beU64(b, 37).toString(),
    nonce: beU64(b, 45).toString(),
    expiry: beU64(b, 53).toString(),
  };
}

/** Decode the 85-byte identity journal. `subject_id` is intentionally absent (hidden by the proof).
 *   [0] result u8 | [1..5] claim_type u32 | [5..37] issuer_id [u8;32]
 *   [37..69] accessor [u8;32] | [69..77] nonce u64 | [77..85] expiry u64 */
export function decodeIdentityJournal(hex: string): DecodedIdentityJournal | null {
  const b = fromHex(hex);
  if (b.length !== IDENTITY_JOURNAL_LEN) return null;
  return {
    result: b[0] === 1,
    claimType: beU32(b, 1),
    issuerId: toHex(b.slice(5, 37)),
    accessor: toHex(b.slice(37, 69)),
    nonce: beU64(b, 69).toString(),
    expiry: beU64(b, 77).toString(),
  };
}

/** Decode the 117-byte compliance journal. `subject_id` is intentionally absent (hidden by the proof).
 *   [0] result u8 | [1..5] claim_type u32 | [5..37] issuer_id [u8;32] | [37..69] deny_root [u8;32]
 *   [69..101] accessor [u8;32] | [101..109] nonce u64 | [109..117] expiry u64 */
export function decodeComplianceJournal(hex: string): DecodedComplianceJournal | null {
  const b = fromHex(hex);
  if (b.length !== COMPLIANCE_JOURNAL_LEN) return null;
  return {
    result: b[0] === 1,
    claimType: beU32(b, 1),
    issuerId: toHex(b.slice(5, 37)),
    denyRoot: toHex(b.slice(37, 69)),
    accessor: toHex(b.slice(69, 101)),
    nonce: beU64(b, 101).toString(),
    expiry: beU64(b, 109).toString(),
  };
}

/** Decode the 229-byte payroll journal. `salary` is absent (encrypted to the auditor's view key).
 *   [0] result u8 | [1..5] claim_type u32 | [5..37] issuer_id [u8;32] | [37..45] threshold u64
 *   [45..77] accessor [u8;32] | [77..109] auditor_pub [u8;32] | [109..141] eph_pub [u8;32]
 *   [141..181] ct [u8;40] | [181..213] tag [u8;32] | [213..221] nonce u64 | [221..229] expiry u64 */
export function decodePayrollJournal(hex: string): DecodedPayrollJournal | null {
  const b = fromHex(hex);
  if (b.length !== PAYROLL_JOURNAL_LEN) return null;
  return {
    result: b[0] === 1,
    claimType: beU32(b, 1),
    issuerId: toHex(b.slice(5, 37)),
    threshold: beU64(b, 37).toString(),
    accessor: toHex(b.slice(45, 77)),
    auditorPub: toHex(b.slice(77, 109)),
    ephPub: toHex(b.slice(109, 141)),
    ct: toHex(b.slice(141, 181)),
    tag: toHex(b.slice(181, 213)),
    nonce: beU64(b, 213).toString(),
    expiry: beU64(b, 221).toString(),
  };
}

/** Decode the 229-byte DR1 data-room "seal" journal. The document key `K` is absent (sealed by ECIES).
 *  Distinct from the (also 229-byte) payroll journal — different layout / no attester.
 *   [0] result u8 | [1..5] claim_type u32 (=8) | [5..37] room_id [u8;32] | [37..69] doc_id [u8;32]
 *   [69..101] recipient_pub [u8;32] | [101..133] content_hash [u8;32] | [133..165] eph_pub [u8;32]
 *   [165..197] ct [u8;32] | [197..229] tag [u8;32] */
export function decodeDataroomSealJournal(hex: string): DecodedDataroomSealJournal | null {
  const b = fromHex(hex);
  if (b.length !== DATAROOM_SEAL_JOURNAL_LEN) return null;
  return {
    result: b[0] === 1,
    claimType: beU32(b, 1),
    roomId: toHex(b.slice(5, 37)),
    docId: toHex(b.slice(37, 69)),
    recipientPub: toHex(b.slice(69, 101)),
    contentHash: toHex(b.slice(101, 133)),
    ephPub: toHex(b.slice(133, 165)),
    ct: toHex(b.slice(165, 197)),
    tag: toHex(b.slice(197, 229)),
  };
}

/** Decode the 165-byte DR2 anonymous-eligibility "membership" journal. The member's identity
 *  (id_secret/id_trapdoor/which leaf) is absent — anonymity. Commits only public, pseudonymous fields.
 *   [0] result u8 | [1..5] claim_type u32 (=9) | [5..37] room_id [u8;32] | [37..69] eligible_root [u8;32]
 *   [69..101] nullifier [u8;32] | [101..133] accessor [u8;32] | [133..165] recipient_pub [u8;32] */
export function decodeMembershipJournal(hex: string): DecodedMembershipJournal | null {
  const b = fromHex(hex);
  if (b.length !== MEMBERSHIP_JOURNAL_LEN) return null;
  return {
    result: b[0] === 1,
    claimType: beU32(b, 1),
    roomId: toHex(b.slice(5, 37)),
    eligibleRoot: toHex(b.slice(37, 69)),
    nullifier: toHex(b.slice(69, 101)),
    accessor: toHex(b.slice(101, 133)),
    recipientPub: toHex(b.slice(133, 165)),
  };
}

/** Decode the 181-byte BP5 tier journal (anonymous bonded tier). MUST match the guest layout:
 *  result(1) | claim_type(4)=13 | member_root(32) | qual_root(32) | threshold(u64) | unlock_after(u64) |
 *  context(32) | nullifier(32) | accessor(32). The identity / which lock are absent — that is the anonymity. */
export function decodeTierJournal(hex: string): DecodedTierJournal | null {
  const b = fromHex(hex);
  if (b.length !== TIER_JOURNAL_LEN) return null;
  return {
    result: b[0] === 1,
    claimType: beU32(b, 1),
    memberRoot: toHex(b.slice(5, 37)),
    qualRoot: toHex(b.slice(37, 69)),
    threshold: beU64(b, 69).toString(),
    unlockAfter: beU64(b, 77).toString(),
    context: toHex(b.slice(85, 117)),
    nullifier: toHex(b.slice(117, 149)),
    accessor: toHex(b.slice(149, 181)),
  };
}

/** Decode the 113-byte DR4 docauth journal (document-authenticity fact). MUST match the guest layout:
 *  result(1) | claim_type(4)=10 | field_tag(4) | threshold(u64) | issuer_key_hash(32) | room_id(32) |
 *  msg_digest(32). The statement / account / exact value are absent — only the proven predicate. */
export function decodeDocauthJournal(hex: string): DecodedDocauthJournal | null {
  const b = fromHex(hex);
  if (b.length !== DOCAUTH_JOURNAL_LEN) return null;
  return {
    result: b[0] === 1,
    claimType: beU32(b, 1),
    fieldTag: beU32(b, 5),
    threshold: beU64(b, 9).toString(),
    issuerKeyHash: toHex(b.slice(17, 49)),
    roomId: toHex(b.slice(49, 81)),
    msgDigest: toHex(b.slice(81, 113)),
  };
}
