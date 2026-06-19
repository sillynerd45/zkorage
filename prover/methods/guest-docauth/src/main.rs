//! DR4 — document-authenticity (zkPDF in-engine: third-party truth on self-uploaded data). Proves,
//! WITHOUT revealing the document, that a statement SIGNED BY A THIRD PARTY (a bank's RSA-2048 cert)
//! attests a field value ≥ a public threshold:
//!   * RSA-2048 PKCS#1 v1.5 (SHA-256, e=65537) signature verification over `sha256(statement)` — the
//!     genuinely-new load-bearing ZK. The bank already signed the statement; the guest re-verifies that
//!     real signature in-zkVM (no attester we control, no foreign-VK bridge). Square-and-multiply modexp
//!     (16 squarings + 1 multiply) — the DR1 Ch0 de-risk measured 22 segments; NEVER crypto-bigint
//!     constant-time `pow` (329 seg).
//!   * Fixed-layout statement parse (no full PAdES/ASN.1 parser — documented hardening): extract the
//!     attested `value` (e.g. bank balance, minor units) and assert `value >= threshold`.
//! Commits a 113-byte journal binding the proven fact to a DataRoom room + the exact document (msg_digest)
//! + WHICH issuer signed (issuer_key_hash = sha256(n)). The statement bytes, the account, and the exact
//! value stay PRIVATE — only "value ≥ threshold", the threshold, the room, the doc hash, and the issuer
//! key hash are revealed (selective disclosure, the financial-claim shape reused from revenue/payroll).
use crypto_bigint::modular::runtime_mod::{DynResidue, DynResidueParams};
use crypto_bigint::{Encoding, U2048};
use risc0_zkvm::guest::env;
use sha2::{Digest, Sha256};

/// DR4 document-authenticity journal wire layout (113 bytes, big-endian). The statement bytes / account /
/// exact value are NEVER committed — that is the confidentiality property (only the predicate result is).
///   [0]        result          u8   = 1
///   [1..5]     claim_type      u32  = 10 (dataroom document-authenticity)
///   [5..9]     field_tag       u32  = 1  (which field was checked; 1 = account balance)
///   [9..17]    threshold       u64       (public floor X; value ≥ X proven)
///   [17..49]   issuer_key_hash [u8;32]   = sha256(n) — the gate pins it against an accepted-issuer allowlist
///   [49..81]   room_id         [u8;32]   (binds the fact to a DataRoom room)
///   [81..113]  msg_digest      [u8;32]   = sha256(statement) — binds the fact to the EXACT signed document
const CLAIM_TYPE_DOCAUTH: u32 = 10;
/// The only field DR4 supports today: an account balance (minor units, e.g. cents). The statement carries
/// its own `field_tag`; the guest asserts it matches so `value`'s meaning is pinned, and echoes it to the
/// journal so a verifier can interpret the proven fact ("balance ≥ X"). Future field_tags add predicates.
const FIELD_TAG_BALANCE: u32 = 1;
/// Fixed signed-statement layout (88 bytes). A real PAdES signature covers the PDF's signed byte range;
/// for the demo the issuer signs this canonical structured blob instead of a parsed PDF (the load-bearing
/// ZK — verifying a real RSA-2048 third-party signature — is identical; only the message framing differs).
const STATEMENT_LEN: usize = 88;
/// 16-byte domain magic at the head of the signed statement (binds the signature's domain; a signature over
/// some other RSA-signed blob can never be replayed as a zkorage bank statement).
const STATEMENT_DOMAIN: &[u8; 16] = b"zkorage-bankstmt";
/// The supported statement schema version (the guest is strict: a different version ⇒ no receipt).
const STATEMENT_VERSION: u32 = 1;
/// DER prefix for an EMSA-PKCS1-v1_5 SHA-256 DigestInfo (RFC 8017): the 19-byte AlgorithmIdentifier that
/// precedes the 32-byte message hash inside a valid SHA-256 RSA signature's recovered encoding.
const SHA256_DIGEST_INFO_PREFIX: [u8; 19] = [
    0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
    0x00, 0x04, 0x20,
];

fn read_u32_be(b: &[u8]) -> u32 {
    u32::from_be_bytes(b.try_into().expect("u32 slice"))
}
fn read_u64_be(b: &[u8]) -> u64 {
    u64::from_be_bytes(b.try_into().expect("u64 slice"))
}

fn main() {
    // Inputs (written by the host in this exact order). The statement bytes are PRIVATE.
    let n_bytes: Vec<u8> = env::read(); // 256 — issuer RSA modulus (big-endian); its hash is the on-chain key id
    let sig_bytes: Vec<u8> = env::read(); // 256 — RSA signature (big-endian)
    let statement: Vec<u8> = env::read(); // 88 — PRIVATE signed bank statement (fixed layout)
    let threshold: u64 = env::read(); // public floor X; the gate echoes it into the on-chain fact
    let room_id: Vec<u8> = env::read(); // 32 — DataRoom room the fact is bound to

    assert_eq!(n_bytes.len(), 256, "modulus must be 256 bytes (RSA-2048)");
    assert_eq!(sig_bytes.len(), 256, "signature must be 256 bytes (RSA-2048)");
    assert_eq!(statement.len(), STATEMENT_LEN, "statement must be the fixed 88-byte layout");
    let room_arr: [u8; 32] = room_id.as_slice().try_into().expect("room_id must be 32 bytes");

    // 1) Compute the message digest the signature must cover. CRITICAL: the guest hashes the statement
    //    ITSELF (it does not trust an input hash) so the verified signature is bound to the SAME bytes the
    //    `value >= threshold` predicate is evaluated over — no value/signature mismatch is possible.
    let msg_digest: [u8; 32] = Sha256::digest(&statement).into();

    // 2) RSA-2048 PKCS#1 v1.5 verify: m = s^e mod n, e = 65537 = 2^16 + 1. e is PUBLIC, so plain
    //    variable-time square-and-multiply (16 squarings + 1 multiply = 17 modmuls) is sound and cheap —
    //    NEVER crypto-bigint's constant-time `pow` (~2048 modmuls = 329 seg, DR1 Ch0). Panics (⇒ no
    //    receipt) on any structural mismatch — only a real signature by the holder of `n` produces a proof.
    //    PRODUCTION-HARDENING (DR4 review LOW-1/LOW-2, non-exploitable under the trusted-admin allowlist
    //    model — a malicious even/zero modulus or a non-canonical s>=n would have to be allowlisted by the
    //    admin, equivalent to trusting an attacker key): a future image should also assert `n` is odd
    //    (n_bytes[255] & 1 == 1, so Montgomery form is valid) and `s < n` (canonical signature). Adding
    //    these changes the canonical image_id, so they are deferred to the next re-pin rather than retro-
    //    fitted into the deployed demo image 6deb084f….
    let n = U2048::from_be_slice(&n_bytes);
    let s = U2048::from_be_slice(&sig_bytes);
    let params = DynResidueParams::new(&n);
    let s_mont = DynResidue::new(&s, params);
    let mut acc = s_mont; // s^1
    for _ in 0..16 {
        acc = acc.square(); // -> s^(2^16) = s^65536
    }
    let m = (acc * s_mont).retrieve(); // s^65536 * s = s^65537
    let em = m.to_be_bytes(); // [u8; 256] — the recovered EMSA-PKCS1-v1_5 encoding

    // EMSA-PKCS1-v1_5 structure: 0x00 0x01 || PS(0xFF..) || 0x00 || DigestInfo(19) || H(32)
    assert_eq!(em[0], 0x00, "em[0]");
    assert_eq!(em[1], 0x01, "em[1]");
    let tail = 19 + 32; // DigestInfo prefix + SHA-256 digest
    let sep = 256 - tail - 1; // index of the 0x00 separator after the 0xFF padding string
    assert_eq!(em[sep], 0x00, "separator");
    for i in 2..sep {
        assert_eq!(em[i], 0xff, "PS padding"); // full-length padding string (rejects truncated forgeries)
    }
    assert_eq!(&em[sep + 1..sep + 1 + 19], &SHA256_DIGEST_INFO_PREFIX, "DigestInfo");
    assert_eq!(&em[sep + 1 + 19..], &msg_digest[..], "message hash matches the signed statement");

    // 3) Parse the fixed-layout signed statement and extract the attested value. The signature above proves
    //    these bytes were attested by the issuer; here we read the field the predicate is about.
    assert_eq!(&statement[0..16], STATEMENT_DOMAIN, "statement domain magic");
    let version = read_u32_be(&statement[16..20]);
    assert_eq!(version, STATEMENT_VERSION, "unsupported statement version");
    let field_tag = read_u32_be(&statement[20..24]);
    assert_eq!(field_tag, FIELD_TAG_BALANCE, "DR4 supports the balance field only");
    // statement[24..56] = account_ref (PRIVATE — proves a real account exists without revealing it).
    let value = read_u64_be(&statement[56..64]);
    // statement[64..72] issued_at, [72..80] expiry, [80..88] currency — part of the signed blob; freshness
    // enforcement (expiry vs ledger time) is a documented DR6 hardening, intentionally not gated here.

    // 4) The predicate: the attested value meets the public floor. value stays PRIVATE; only the boolean
    //    result + the threshold are revealed (the revenue/payroll selective-disclosure shape).
    assert!(value >= threshold, "attested value below threshold");

    // 5) issuer_key_hash commits WHICH issuer signed without putting the 256-byte modulus on-chain — the
    //    gate pins this against its accepted-issuer allowlist (the bank's known public key).
    let issuer_key_hash: [u8; 32] = Sha256::digest(&n_bytes).into();

    // 6) Commit the 113-byte PUBLIC journal. statement/account_ref/value are ABSENT (confidentiality).
    let mut journal = Vec::with_capacity(113);
    journal.push(1u8); // result = true (a valid third-party signature attests value ≥ threshold)
    journal.extend_from_slice(&CLAIM_TYPE_DOCAUTH.to_be_bytes());
    journal.extend_from_slice(&field_tag.to_be_bytes());
    journal.extend_from_slice(&threshold.to_be_bytes());
    journal.extend_from_slice(&issuer_key_hash);
    journal.extend_from_slice(&room_arr);
    journal.extend_from_slice(&msg_digest);
    env::commit_slice(&journal);
}
