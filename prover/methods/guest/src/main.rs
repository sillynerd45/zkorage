use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use risc0_zkvm::guest::env;

/// ClaimEnvelope wire layout (60 bytes, big-endian), signed by the issuer:
///   [0..4]   claim_type : u32
///   [4..12]  value      : u64    (PRIVATE — never committed to the journal)
///   [12..44] issuer_id  : [u8;32]
///   [44..52] nonce      : u64
///   [52..60] expiry     : u64
const ENVELOPE_LEN: usize = 60;

fn main() {
    // Inputs (written by the host in this exact order).
    let envelope: Vec<u8> = env::read();
    let sig_bytes: Vec<u8> = env::read();
    let pk_bytes: Vec<u8> = env::read();
    let threshold: u64 = env::read();

    assert_eq!(envelope.len(), ENVELOPE_LEN, "bad envelope length");

    // 1) Authenticate the claim: ed25519 over the envelope. Panics (=> no receipt) if invalid.
    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into().expect("pubkey must be 32 bytes");
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().expect("signature must be 64 bytes");
    let vk = VerifyingKey::from_bytes(&pk_arr).expect("invalid issuer public key");
    let sig = Signature::from_bytes(&sig_arr);
    vk.verify(&envelope, &sig).expect("signature verification failed");

    // 2) Parse the envelope fields.
    let claim_type = u32::from_be_bytes(envelope[0..4].try_into().unwrap());
    let value = u64::from_be_bytes(envelope[4..12].try_into().unwrap());
    let issuer_id: [u8; 32] = envelope[12..44].try_into().unwrap();
    let nonce = u64::from_be_bytes(envelope[44..52].try_into().unwrap());
    let expiry = u64::from_be_bytes(envelope[52..60].try_into().unwrap());

    // 2a) SOUNDNESS: the committed issuer_id MUST be the key that actually verified the signature.
    //     Without this, a prover could verify the envelope under their OWN key while committing a
    //     different (allow-listed) issuer_id — forging a claim attributed to that issuer. The system
    //     convention is `issuer_id == issuer pubkey` (the on-chain allowlist is keyed by the pubkey),
    //     so this binds the proof to the real signer. Panics (=> no receipt) on mismatch.
    assert_eq!(pk_arr, issuer_id, "issuer_id must equal the signing public key");

    // 3) The predicate. Panics (=> no receipt) when false — a valid receipt's EXISTENCE is the proof.
    assert!(value >= threshold, "predicate false: value < threshold");

    // 4) Commit the PUBLIC journal. `value` is intentionally ABSENT (stays private — the ZK property).
    //    Layout (61 bytes): result(1) | claim_type(4) | issuer_id(32) | threshold(8) | nonce(8) | expiry(8)
    let mut journal = Vec::with_capacity(61);
    journal.push(1u8); // result = true
    journal.extend_from_slice(&claim_type.to_be_bytes());
    journal.extend_from_slice(&issuer_id);
    journal.extend_from_slice(&threshold.to_be_bytes());
    journal.extend_from_slice(&nonce.to_be_bytes());
    journal.extend_from_slice(&expiry.to_be_bytes());
    env::commit_slice(&journal);
}
