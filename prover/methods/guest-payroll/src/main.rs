use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use risc0_zkvm::guest::env;
use sha2::{Digest, Sha256};
use x25519_dalek::{x25519, X25519_BASEPOINT_BYTES};

/// PayrollEnvelope wire layout (60 bytes, big-endian), signed by the payroll attester — same shape as
/// the W1 ClaimEnvelope (the `value` field IS the salary):
///   [0..4]    claim_type : u32     (= 5, payroll / proof-of-income)
///   [4..12]   salary     : u64     (PRIVATE — never committed; only the auditor learns it, encrypted)
///   [12..44]  issuer_id  : [u8;32] (the payroll attester's ed25519 public key)
///   [44..52]  nonce      : u64
///   [52..60]  expiry     : u64
const ENVELOPE_LEN: usize = 60;
const CLAIM_TYPE_PAYROLL: u32 = 5;

/// ECIES domain-separation tags. The auditor opener (backend/SDK) MUST use these byte-for-byte.
const DOMAIN_KS: &[u8] = b"zkorage-payroll-ecies-v1/ks";
const DOMAIN_TAG: &[u8] = b"zkorage-payroll-ecies-v1/tag";

fn main() {
    // Inputs (written by the host in this exact order).
    let envelope: Vec<u8> = env::read();
    let sig_bytes: Vec<u8> = env::read();
    let pk_bytes: Vec<u8> = env::read();
    // `accessor` is the PUBLIC binding the holder chose (e.g. their Stellar account key). Committed so
    // the gate grants exactly this accessor (a stolen bundle is non-redirectable).
    let accessor: Vec<u8> = env::read();
    // `auditor_pub` is the auditor's x25519 PUBLIC key — the disclosure target. Committed so the gate
    // can require it to be allow-listed. Only the matching auditor SECRET (the view key) opens the ct.
    let auditor_pub: Vec<u8> = env::read();
    // `threshold` is the PUBLIC income bar (proof-of-income). Committed; the salary is proven ≥ it.
    let threshold: u64 = env::read();
    // Prover-supplied ephemeral randomness (the host generates fresh per proof — NOT through the
    // gateway). `eph_secret` MUST be fresh per proof (else the keystream repeats). `blinding` makes the
    // public `tag` hiding (salaries are low-entropy — without it the tag could be brute-forced).
    // TRUST NOTE: the guest does not assert `blinding != 0` / `eph_secret != 0`. The honest self-hosted
    // host always supplies CSPRNG values (host_payroll.rs `rand::thread_rng`), so the public-tag hiding
    // holds in practice. A malicious prover COULD pass a degenerate `blinding` (e.g. 0) and make the
    // public `tag` brute-forceable — but that only de-anonymizes THEIR OWN salary (they already know it)
    // and leaks no one else's data. Hardening (an in-guest `assert!(blinding != [0;32])`) is deferred
    // because it would re-pin the image_id; best bundled with the W7 review's NEW-2 envelope-v2 change.
    let eph_secret: Vec<u8> = env::read();
    let blinding: Vec<u8> = env::read();

    assert_eq!(envelope.len(), ENVELOPE_LEN, "bad envelope length");
    let accessor_arr: [u8; 32] = accessor.as_slice().try_into().expect("accessor must be 32 bytes");
    let auditor_arr: [u8; 32] = auditor_pub
        .as_slice()
        .try_into()
        .expect("auditor_pub must be 32 bytes");
    let eph_sk: [u8; 32] = eph_secret
        .as_slice()
        .try_into()
        .expect("eph_secret must be 32 bytes");
    let blind: [u8; 32] = blinding.as_slice().try_into().expect("blinding must be 32 bytes");

    // 1) Authenticate the payroll record: ed25519 over the envelope. Panics (=> no receipt) if invalid.
    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into().expect("pubkey must be 32 bytes");
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().expect("signature must be 64 bytes");
    let vk = VerifyingKey::from_bytes(&pk_arr).expect("invalid issuer public key");
    let sig = Signature::from_bytes(&sig_arr);
    vk.verify(&envelope, &sig).expect("signature verification failed");

    // 2) Parse. `salary` is read but DELIBERATELY never committed in cleartext (selective disclosure).
    let claim_type = u32::from_be_bytes(envelope[0..4].try_into().unwrap());
    let salary = u64::from_be_bytes(envelope[4..12].try_into().unwrap()); // PRIVATE
    let issuer_id: [u8; 32] = envelope[12..44].try_into().unwrap();
    let nonce = u64::from_be_bytes(envelope[44..52].try_into().unwrap());
    let expiry = u64::from_be_bytes(envelope[52..60].try_into().unwrap());

    // 2a) SOUNDNESS: the committed issuer_id MUST be the key that verified the signature (see the PoR
    //     guest) — binds the proof to the real payroll attester.
    assert_eq!(pk_arr, issuer_id, "issuer_id must equal the signing public key");
    // 2b) the credential must be a payroll claim.
    assert_eq!(claim_type, CLAIM_TYPE_PAYROLL, "not a payroll credential");

    // 3) The predicate: salary ≥ threshold. Panics (=> no receipt) when false — the receipt's EXISTENCE
    //    is the proof. The salary itself stays private.
    assert!(salary >= threshold, "predicate false: salary < threshold");

    // 4) Auditor selective disclosure — in-guest ECIES (Option B). The guest (NOT the employer) encrypts
    //    the signed salary to the auditor's x25519 key, so a decrypting auditor is certain the figure is
    //    the attester-signed one. eph_pub = X25519(eph_sk, BASE); shared = X25519(eph_sk, auditor_pub).
    let eph_pub: [u8; 32] = x25519(eph_sk, X25519_BASEPOINT_BYTES);
    let shared: [u8; 32] = x25519(eph_sk, auditor_arr);

    // plaintext = salary_be8 ‖ blinding32 (40 bytes).
    let mut pt = [0u8; 40];
    pt[0..8].copy_from_slice(&salary.to_be_bytes());
    pt[8..40].copy_from_slice(&blind);

    // keystream = sha256(DOMAIN_KS ‖ shared ‖ eph_pub ‖ ctr_be4) in counter mode; ct = pt XOR keystream.
    let mut ct = [0u8; 40];
    let mut produced = 0usize;
    let mut ctr: u32 = 0;
    while produced < 40 {
        let mut h = Sha256::new();
        h.update(DOMAIN_KS);
        h.update(shared);
        h.update(eph_pub);
        h.update(ctr.to_be_bytes());
        let block: [u8; 32] = h.finalize().into();
        let take = core::cmp::min(32, 40 - produced);
        for i in 0..take {
            ct[produced + i] = pt[produced + i] ^ block[i];
        }
        produced += take;
        ctr += 1;
    }

    // integrity tag = sha256(DOMAIN_TAG ‖ salary_be8 ‖ blinding32). The auditor recomputes it after
    // decrypt → definitive "faithful ✓" + wrong-key detection. `blinding` keeps the public tag hiding.
    let mut th = Sha256::new();
    th.update(DOMAIN_TAG);
    th.update(salary.to_be_bytes());
    th.update(blind);
    let tag: [u8; 32] = th.finalize().into();

    // 5) Commit the 229-byte PUBLIC payroll journal. `salary` is ABSENT (private). Layout:
    //    result(1) | claim_type(4) | issuer_id(32) | threshold(8) | accessor(32) | auditor_pub(32) |
    //    eph_pub(32) | ct(40) | tag(32) | nonce(8) | expiry(8)
    let mut journal = Vec::with_capacity(229);
    journal.push(1u8); // result = true (salary ≥ threshold)
    journal.extend_from_slice(&CLAIM_TYPE_PAYROLL.to_be_bytes());
    journal.extend_from_slice(&issuer_id);
    journal.extend_from_slice(&threshold.to_be_bytes());
    journal.extend_from_slice(&accessor_arr);
    journal.extend_from_slice(&auditor_arr);
    journal.extend_from_slice(&eph_pub);
    journal.extend_from_slice(&ct);
    journal.extend_from_slice(&tag);
    journal.extend_from_slice(&nonce.to_be_bytes());
    journal.extend_from_slice(&expiry.to_be_bytes());
    env::commit_slice(&journal);
}
