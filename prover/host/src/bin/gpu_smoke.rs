// zkorage PHASE-0 GPU make-or-break smoke test (risc0-5 upgrade).
//
// The ONLY question this answers: does GPU proving still crash in the Groth16 MSM on Blackwell sm_120
// under risc0 5.x's new `risc0-sppark` fork? (risc0 3.0.5 crashes in upstream sppark-0.1.15.)
//
// It self-signs a demo claim, runs the FULL pipeline (STARK + Groth16 shrink-wrap — the crash path),
// and verifies the receipt off-chain. NO encode_seal / NO risc0-ethereum-contracts (those are only for
// the on-chain seal format, post-proving, irrelevant to whether the GPU faults).
//
// Build + run on WSL2 with the CUDA feature + clean PATH:
//   cargo build --release -p host --bin gpu_smoke --features cuda
//   ./target/release/gpu_smoke
// CPU baseline (no GPU): drop `--features cuda`.
use ed25519_dalek::{Signer, SigningKey};
use methods::{CLAIM_PREDICATE_ELF, CLAIM_PREDICATE_ID};
use risc0_zkvm::{ExecutorEnv, ProverOpts, default_prover};

/// Build the 60-byte big-endian ClaimEnvelope (matches the guest's layout byte-for-byte).
fn build_envelope(claim_type: u32, value: u64, issuer_id: [u8; 32], nonce: u64, expiry: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(60);
    v.extend_from_slice(&claim_type.to_be_bytes());
    v.extend_from_slice(&value.to_be_bytes());
    v.extend_from_slice(&issuer_id);
    v.extend_from_slice(&nonce.to_be_bytes());
    v.extend_from_slice(&expiry.to_be_bytes());
    v
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    // Self-signed demo claim (value >= threshold => receipt is produced).
    let sk = SigningKey::from_bytes(&[7u8; 32]);
    let issuer_pk = sk.verifying_key().to_bytes();
    let envelope = build_envelope(1, 1_000_000, issuer_pk, 1, 9_999_999_999);
    let signature = sk.sign(&envelope).to_bytes().to_vec();
    let issuer_pk_vec = issuer_pk.to_vec();
    let threshold: u64 = 500_000;

    let env = ExecutorEnv::builder()
        .write(&envelope).unwrap()
        .write(&signature).unwrap()
        .write(&issuer_pk_vec).unwrap()
        .write(&threshold).unwrap()
        .build()
        .unwrap();

    eprintln!("[*] PHASE-0 GPU smoke: proving STARK + Groth16 shrink-wrap (the sppark MSM crash path)...");
    let prover = default_prover();
    let prove_info = prover
        .prove_with_opts(env, CLAIM_PREDICATE_ELF, &ProverOpts::groth16())
        .expect("groth16 proving failed");
    eprintln!("STATS: {:#?}", prove_info.stats);

    // Off-chain self-check: a real, verifiable Groth16 receipt was produced.
    prove_info
        .receipt
        .verify(CLAIM_PREDICATE_ID)
        .expect("off-chain receipt.verify failed");

    println!("=========================================================");
    println!("  PHASE-0 RESULT: GPU PROOF OK — no sppark crash on sm_120");
    println!("  receipt.verify(CLAIM_PREDICATE_ID) PASSED");
    println!("=========================================================");
}
