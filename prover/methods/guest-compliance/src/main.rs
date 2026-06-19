use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use risc0_zkvm::guest::env;
use sha2::{Digest, Sha256};

/// KYC IdentityEnvelope wire layout (92 bytes, big-endian), signed by the KYC issuer — IDENTICAL to
/// Week 5 (we reuse the same KYC credential):
///   [0..4]    claim_type : u32     (= 3, KYC credential)
///   [4..12]   kyc_status : u64     (1 = PASSED)
///   [12..44]  subject_id : [u8;32] (PRIVATE — the real identity; NEVER committed)
///   [44..76]  issuer_id  : [u8;32] (the KYC provider's ed25519 public key)
///   [76..84]  nonce      : u64
///   [84..92]  expiry     : u64
const ENVELOPE_LEN: usize = 92;
const CLAIM_TYPE_KYC: u32 = 3; // the signed credential is a KYC claim
const CLAIM_TYPE_COMPLIANCE: u32 = 4; // the JOURNAL asserts "KYC'd ∧ not-sanctioned"
const KYC_PASSED: u64 = 1;
/// Canonical sanctions deny-list Merkle depth — the witness MUST declare exactly this (binds the proof
/// to the agreed tree size and makes the witness-length arithmetic overflow-free). Must equal the
/// backend `DENY_DEPTH` that built the on-chain root.
const TREE_DEPTH: usize = 20;
/// Domain-separation tags for the IMT hashes (prevent any leaf/internal-node preimage confusion).
const LEAF_TAG: u8 = 0x00;
const NODE_TAG: u8 = 0x01;

/// Compare two 32-byte big-endian uint256.
fn cmp_be(a: &[u8; 32], b: &[u8; 32]) -> core::cmp::Ordering {
    for i in 0..32 {
        if a[i] != b[i] {
            return a[i].cmp(&b[i]);
        }
    }
    core::cmp::Ordering::Equal
}

fn is_zero(a: &[u8; 32]) -> bool {
    a.iter().all(|&x| x == 0)
}

/// Internal Merkle node = sha256(NODE_TAG ‖ left ‖ right). The tag domain-separates internal nodes from
/// leaves (which use LEAF_TAG), so no leaf preimage can ever collide with an internal-node preimage.
fn hash_internal(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([NODE_TAG]);
    h.update(a);
    h.update(b);
    h.finalize().into()
}

fn main() {
    // Inputs (written by the host in this exact order).
    let envelope: Vec<u8> = env::read();
    let sig_bytes: Vec<u8> = env::read();
    let pk_bytes: Vec<u8> = env::read();
    // `accessor` is the PUBLIC binding the holder chose (e.g. their Stellar account key). Not signed by
    // the issuer; committed so the on-chain gate grants exactly this accessor (non-redirectable bundle).
    let accessor: Vec<u8> = env::read();
    // The non-membership witness — the prover builds it from the PUBLIC deny-list. The guest recomputes
    // the Merkle root and commits it; the on-chain gate pins the authoritative root, so a forged path is
    // rejected on-chain and a sanctioned subject has no bracketing low-leaf (=> this guest panics below).
    let witness: Vec<u8> = env::read();

    assert_eq!(envelope.len(), ENVELOPE_LEN, "bad envelope length");
    let accessor_arr: [u8; 32] = accessor.as_slice().try_into().expect("accessor must be 32 bytes");

    // 1) Authenticate the KYC credential: ed25519 over the envelope. Panics (=> no receipt) if invalid.
    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into().expect("pubkey must be 32 bytes");
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().expect("signature must be 64 bytes");
    let vk = VerifyingKey::from_bytes(&pk_arr).expect("invalid issuer public key");
    let sig = Signature::from_bytes(&sig_arr);
    vk.verify(&envelope, &sig).expect("signature verification failed");

    // 2) Parse the envelope. `subject_id` is read but DELIBERATELY never committed (selective disclosure).
    let claim_type = u32::from_be_bytes(envelope[0..4].try_into().unwrap());
    let kyc_status = u64::from_be_bytes(envelope[4..12].try_into().unwrap());
    let subject_id: [u8; 32] = envelope[12..44].try_into().unwrap(); // PRIVATE
    let issuer_id: [u8; 32] = envelope[44..76].try_into().unwrap();
    let nonce = u64::from_be_bytes(envelope[76..84].try_into().unwrap());
    let expiry = u64::from_be_bytes(envelope[84..92].try_into().unwrap());

    // 2a) SOUNDNESS: the committed issuer_id MUST be the key that verified the signature (see the PoR
    //     guest). Binds the proof to the real KYC provider.
    assert_eq!(pk_arr, issuer_id, "issuer_id must equal the signing public key");
    // 2b) KYC predicate: the credential must be a KYC claim attesting PASSED.
    assert_eq!(claim_type, CLAIM_TYPE_KYC, "not a KYC credential");
    assert_eq!(kyc_status, KYC_PASSED, "predicate false: KYC not passed");

    // 3) NON-MEMBERSHIP in the sanctions deny-list (Indexed Merkle Tree, sha256). Soundness rests on the
    //    on-chain root pin + SHA-256 preimage resistance (a forged leaf or wrong path cannot hash to the
    //    authoritative `deny_root`) AND on this guest reconstructing — not echoing — the root. Hardening:
    //    leaf/internal nodes are explicitly domain-separated (LEAF_TAG/NODE_TAG), and `depth` is pinned to
    //    TREE_DEPTH (so the witness length is fixed and overflow-free, and the proof attests non-membership
    //    in a tree of the AGREED size). Witness layout (BE):
    //      [0..32]   low_value        (the low-leaf's value)
    //      [32..64]  low_next_value   (its stored next pointer; all-zero = end / +∞)
    //      [64..68]  low_next_index   u32
    //      [68..72]  leaf_index       u32   (low-leaf position; its bits drive path direction)
    //      [72..76]  depth            u32   (asserted == TREE_DEPTH)
    //      [76 ..]   siblings         depth * 32 bytes, bottom -> top
    assert!(witness.len() >= 76, "witness too short");
    let low_value: [u8; 32] = witness[0..32].try_into().unwrap();
    let low_next_value: [u8; 32] = witness[32..64].try_into().unwrap();
    let low_next_index = u32::from_be_bytes(witness[64..68].try_into().unwrap());
    let leaf_index = u32::from_be_bytes(witness[68..72].try_into().unwrap());
    let depth = u32::from_be_bytes(witness[72..76].try_into().unwrap()) as usize;
    assert_eq!(depth, TREE_DEPTH, "unexpected merkle depth");
    assert_eq!(witness.len(), 76 + depth * 32, "witness length mismatch for depth");

    // 3a) Range check: low_value < subject < low_next_value (or low_next_value == 0 ⇒ subject is past the
    //     largest sanctioned value). A SANCTIONED subject has an exact leaf, so no low-leaf brackets it
    //     ⇒ one of these asserts fails ⇒ no receipt (the ✗ case).
    let x = subject_id;
    assert!(
        cmp_be(&low_value, &x) == core::cmp::Ordering::Less,
        "subject <= low_value (membership or bad witness)"
    );
    if !is_zero(&low_next_value) {
        assert!(
            cmp_be(&x, &low_next_value) == core::cmp::Ordering::Less,
            "subject >= next_value (membership or bad witness)"
        );
    }

    // 3b) Merkle path: leaf = sha256(LEAF_TAG ‖ low_value ‖ low_next_value ‖ low_next_index_be4); walk
    //     bottom->top with the tagged internal hash.
    let mut leaf_input = [0u8; 69];
    leaf_input[0] = LEAF_TAG;
    leaf_input[1..33].copy_from_slice(&low_value);
    leaf_input[33..65].copy_from_slice(&low_next_value);
    leaf_input[65..69].copy_from_slice(&low_next_index.to_be_bytes());
    let mut node: [u8; 32] = Sha256::digest(leaf_input).into();
    for i in 0..depth {
        let off = 76 + i * 32;
        let sib: [u8; 32] = witness[off..off + 32].try_into().unwrap();
        let bit = (leaf_index >> i) & 1;
        node = if bit == 0 {
            hash_internal(&node, &sib)
        } else {
            hash_internal(&sib, &node)
        };
    }
    let deny_root = node;

    // 4) Commit the 117-byte PUBLIC compliance journal. `subject_id` is ABSENT (identity hidden);
    //    `deny_root` is present so the gate can pin it against the authoritative on-chain root.
    //    Layout: result(1) | claim_type(4) | issuer_id(32) | deny_root(32) | accessor(32) | nonce(8) | expiry(8)
    let mut journal = Vec::with_capacity(117);
    journal.push(1u8); // result = true (KYC passed AND not sanctioned)
    journal.extend_from_slice(&CLAIM_TYPE_COMPLIANCE.to_be_bytes());
    journal.extend_from_slice(&issuer_id);
    journal.extend_from_slice(&deny_root);
    journal.extend_from_slice(&accessor_arr);
    journal.extend_from_slice(&nonce.to_be_bytes());
    journal.extend_from_slice(&expiry.to_be_bytes());
    env::commit_slice(&journal);
}
