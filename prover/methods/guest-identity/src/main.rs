use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use risc0_zkvm::guest::env;

/// IdentityEnvelope wire layout (92 bytes, big-endian), signed by the KYC issuer:
///   [0..4]    claim_type : u32     (= 3, identity / KYC)
///   [4..12]   kyc_status : u64     (1 = PASSED — the predicate input)
///   [12..44]  subject_id : [u8;32] (PRIVATE — the real identity; NEVER committed to the journal)
///   [44..76]  issuer_id  : [u8;32] (the KYC provider's ed25519 public key)
///   [76..84]  nonce      : u64
///   [84..92]  expiry     : u64
const ENVELOPE_LEN: usize = 92;
const CLAIM_TYPE_IDENTITY: u32 = 3;
const KYC_PASSED: u64 = 1;

fn main() {
    // Inputs (written by the host in this exact order).
    let envelope: Vec<u8> = env::read();
    let sig_bytes: Vec<u8> = env::read();
    let pk_bytes: Vec<u8> = env::read();
    // `accessor` is a PUBLIC binding chosen by the credential holder (e.g. their Stellar account key).
    // It is NOT signed by the issuer — the holder binds their own access to their own handle. The guest
    // commits it so the on-chain gate can grant access to exactly this accessor; because it is fixed
    // inside the proof, a stolen bundle only ever grants the original holder's accessor (non-transferable).
    let accessor: Vec<u8> = env::read();

    assert_eq!(envelope.len(), ENVELOPE_LEN, "bad envelope length");
    let accessor_arr: [u8; 32] = accessor.as_slice().try_into().expect("accessor must be 32 bytes");

    // 1) Authenticate the credential: ed25519 over the envelope. Panics (=> no receipt) if invalid.
    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into().expect("pubkey must be 32 bytes");
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().expect("signature must be 64 bytes");
    let vk = VerifyingKey::from_bytes(&pk_arr).expect("invalid issuer public key");
    let sig = Signature::from_bytes(&sig_arr);
    vk.verify(&envelope, &sig).expect("signature verification failed");

    // 2) Parse the envelope fields. `subject_id` is read but DELIBERATELY never committed.
    let claim_type = u32::from_be_bytes(envelope[0..4].try_into().unwrap());
    let kyc_status = u64::from_be_bytes(envelope[4..12].try_into().unwrap());
    let _subject_id: [u8; 32] = envelope[12..44].try_into().unwrap(); // PRIVATE — selective disclosure
    let issuer_id: [u8; 32] = envelope[44..76].try_into().unwrap();
    let nonce = u64::from_be_bytes(envelope[76..84].try_into().unwrap());
    let expiry = u64::from_be_bytes(envelope[84..92].try_into().unwrap());

    // 2a) SOUNDNESS: the committed issuer_id MUST be the key that actually verified the signature
    //     (see the PoR guest for the full rationale). Binds the proof to the real KYC provider.
    assert_eq!(pk_arr, issuer_id, "issuer_id must equal the signing public key");

    // 3) The predicate: the credential must attest KYC = PASSED, and it must be an identity claim.
    //    Panics (=> no receipt) when false — a valid receipt's EXISTENCE is the proof.
    assert_eq!(claim_type, CLAIM_TYPE_IDENTITY, "not an identity claim");
    assert_eq!(kyc_status, KYC_PASSED, "predicate false: KYC not passed");

    // 4) Commit the PUBLIC journal. `subject_id` is ABSENT (stays private — the ZK property);
    //    `accessor` is committed so the gate can bind the grant. `kyc_status` is not committed —
    //    `result = true` already encodes that the predicate passed.
    //    Layout (85 bytes): result(1) | claim_type(4) | issuer_id(32) | accessor(32) | nonce(8) | expiry(8)
    let mut journal = Vec::with_capacity(85);
    journal.push(1u8); // result = true
    journal.extend_from_slice(&claim_type.to_be_bytes());
    journal.extend_from_slice(&issuer_id);
    journal.extend_from_slice(&accessor_arr);
    journal.extend_from_slice(&nonce.to_be_bytes());
    journal.extend_from_slice(&expiry.to_be_bytes());
    env::commit_slice(&journal);
}
