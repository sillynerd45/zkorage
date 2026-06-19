extern crate std;

use soroban_sdk::{Bytes, BytesN, Env};
use std::println;

use crate::{RiscZeroGroth16Verifier, RiscZeroGroth16VerifierClient};

/// Test seal data (v5 risc0 5.0.0-rc.1 Groth16 proof; selector ef6cb709). 260 bytes.
/// Regenerated from a real v5 canonical-claim proof when the verifier was redeployed for risc0
/// 5.0.0-rc.1 (the prior v3 vector with selector 73c457ba no longer verifies on the new verifier).
const TEST_SEAL: [u8; 260] = [
    239, 108, 183, 9, 46, 137, 101, 28, 185, 57, 6, 50, 132, 98, 248, 73,
    146, 152, 74, 25, 73, 131, 6, 215, 19, 191, 232, 162, 150, 104, 139, 230,
    252, 128, 48, 208, 46, 217, 216, 77, 103, 100, 111, 104, 250, 136, 109, 99,
    129, 186, 66, 242, 117, 71, 35, 56, 109, 167, 190, 202, 112, 55, 217, 109,
    132, 129, 38, 99, 32, 93, 73, 145, 110, 217, 9, 77, 15, 252, 68, 74,
    218, 119, 122, 166, 247, 41, 243, 59, 105, 84, 10, 117, 57, 174, 184, 228,
    85, 28, 30, 104, 35, 235, 71, 161, 50, 66, 122, 219, 73, 156, 245, 5,
    48, 100, 181, 63, 66, 203, 3, 185, 6, 153, 92, 141, 141, 164, 148, 44,
    45, 128, 109, 196, 11, 68, 51, 134, 61, 35, 15, 219, 173, 115, 70, 42,
    218, 186, 166, 39, 200, 53, 149, 220, 209, 215, 172, 216, 198, 192, 191, 141,
    35, 100, 246, 162, 32, 226, 35, 20, 121, 32, 185, 25, 235, 62, 254, 44,
    35, 93, 129, 183, 130, 121, 141, 8, 136, 224, 39, 102, 34, 19, 40, 196,
    253, 108, 193, 39, 36, 55, 55, 180, 182, 56, 186, 251, 117, 18, 241, 58,
    51, 246, 17, 54, 156, 111, 128, 37, 109, 77, 245, 12, 180, 16, 146, 30,
    199, 31, 132, 181, 40, 193, 189, 57, 144, 5, 82, 38, 68, 51, 133, 175,
    148, 126, 75, 245, 96, 129, 66, 5, 106, 160, 89, 204, 110, 174, 138, 102,
    194, 8, 224, 24,
];

/// Test image ID = v5 canonical claim guest (973c983125ad3a9f...)
const TEST_IMAGE_ID: [u8; 32] = [
    151, 60, 152, 49, 37, 173, 58, 159, 17, 91, 47, 77, 141, 18, 236, 57,
    227, 241, 177, 7, 241, 92, 87, 100, 63, 114, 186, 243, 111, 146, 53, 2,
];

/// Test journal = the v5 claim journal (raw bytes); journal_digest = sha256(TEST_JOURNAL).
const TEST_JOURNAL: [u8; 61] = [
    1, 0, 0, 0, 2, 234, 74, 108, 99, 226, 156, 82, 10, 190, 245, 80,
    123, 19, 46, 197, 249, 149, 71, 118, 174, 190, 190, 123, 146, 66, 30, 234,
    105, 20, 70, 210, 44, 0, 0, 9, 24, 78, 114, 160, 0, 0, 0, 0,
    0, 0, 0, 0, 1, 0, 0, 0, 2, 84, 11, 227, 255,
];

/// Helper to setup test environment and client
fn setup_test() -> (Env, RiscZeroGroth16VerifierClient<'static>) {
    let env = Env::default();
    let contract_id = env.register(RiscZeroGroth16Verifier, ());
    let client = RiscZeroGroth16VerifierClient::new(&env, &contract_id);
    (env, client)
}

/// Helper to prepare test inputs
fn prepare_inputs(env: &Env) -> (Bytes, BytesN<32>, BytesN<32>) {
    let seal = Bytes::from_slice(env, &TEST_SEAL);
    let image_id = BytesN::from_array(env, &TEST_IMAGE_ID);
    let journal_digest = env.crypto().sha256(&Bytes::from_slice(env, &TEST_JOURNAL));
    (seal, image_id, journal_digest.into())
}

#[test]
fn test_verify_proof() {
    let (env, client) = setup_test();
    let (seal, image_id, journal_digest) = prepare_inputs(&env);

    assert_eq!(client.verify(&seal, &image_id, &journal_digest), ());
}

// ============================================================================
// BENCHMARKS - Gas Consumption Tracking
// ============================================================================

/// Prints full budget in a formatted way
fn print_budget(env: &Env, label: &str) {
    let budget = env.cost_estimate().budget();

    println!("\n========== BENCHMARK: {} ==========", label);
    budget.print();
    println!("==========================================\n");
}

#[test]
fn bench_verify() {
    let (env, client) = setup_test();
    let (seal, image_id, journal_digest) = prepare_inputs(&env);

    // Run verification
    assert_eq!(client.verify(&seal, &image_id, &journal_digest), ());

    // Print results
    print_budget(&env, "verify()");
}

#[test]
fn bench_verify_integrity() {
    let (env, client) = setup_test();
    let (seal, image_id, journal_digest) = prepare_inputs(&env);

    // Build receipt manually
    let claim = risc0_interface::ReceiptClaim::new(&env, image_id, journal_digest);
    let receipt = risc0_interface::Receipt {
        seal,
        claim_digest: claim.digest(&env),
    };

    // Run verification
    assert_eq!(client.verify_integrity(&receipt), ());

    // Print results
    print_budget(&env, "verify_integrity()");
}

#[test]
fn bench_receipt_claim_digest() {
    let (env, _client) = setup_test();
    let image_id = BytesN::from_array(&env, &TEST_IMAGE_ID);
    let journal_digest: BytesN<32> = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, &TEST_JOURNAL))
        .into();

    // Build claim and compute digest
    let claim = risc0_interface::ReceiptClaim::new(&env, image_id, journal_digest);
    let _digest = claim.digest(&env);

    // Print results
    print_budget(&env, "ReceiptClaim::digest()");
}
