// zkorage Week-1 prover host.
// Self-signs a demo claim envelope, proves the predicate in the zkVM, wraps STARK->Groth16,
// and emits {seal, image_id, journal_digest, journal} for on-chain verification on Soroban.
use ed25519_dalek::{Signer, SigningKey};
use host::encode_seal;
use methods::{CLAIM_PREDICATE_ELF, CLAIM_PREDICATE_ID};
use risc0_zkvm::sha::Digest;
use risc0_zkvm::{ExecutorEnv, ProverOpts, default_executor, default_prover};
use sha2::{Digest as _, Sha256};
use std::fs;

/// Build the 60-byte big-endian ClaimEnvelope (must match the guest's layout byte-for-byte).
fn build_envelope(
    claim_type: u32,
    value: u64,
    issuer_id: [u8; 32],
    nonce: u64,
    expiry: u64,
) -> Vec<u8> {
    let mut v = Vec::with_capacity(60);
    v.extend_from_slice(&claim_type.to_be_bytes());
    v.extend_from_slice(&value.to_be_bytes());
    v.extend_from_slice(&issuer_id);
    v.extend_from_slice(&nonce.to_be_bytes());
    v.extend_from_slice(&expiry.to_be_bytes());
    v
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    // Inputs come from a job file when ZKORAGE_JOB is set (4 lines: envelope_hex /
    // signature_hex / issuer_pubkey_hex / threshold) — this is the prover-service path.
    // Otherwise a self-signed demo claim is used (standalone / acceptance testing).
    let (envelope, signature, issuer_pk_vec, threshold): (Vec<u8>, Vec<u8>, Vec<u8>, u64) =
        if let Ok(job_path) = std::env::var("ZKORAGE_JOB") {
            let s = fs::read_to_string(&job_path).expect("read ZKORAGE_JOB file");
            let mut lines = s.lines();
            let envelope = hex::decode(lines.next().expect("envelope line").trim()).expect("envelope hex");
            let signature = hex::decode(lines.next().expect("signature line").trim()).expect("signature hex");
            let issuer_pk_vec = hex::decode(lines.next().expect("pubkey line").trim()).expect("pubkey hex");
            let threshold: u64 = lines.next().expect("threshold line").trim().parse().expect("threshold u64");
            (envelope, signature, issuer_pk_vec, threshold)
        } else {
            let sk = SigningKey::from_bytes(&[7u8; 32]);
            let issuer_pk = sk.verifying_key().to_bytes();
            let claim_type: u32 = 1;
            let value: u64 = env_u64("ZKORAGE_VALUE", 1_000_000);
            let threshold: u64 = env_u64("ZKORAGE_THRESHOLD", 500_000);
            let issuer_id: [u8; 32] = issuer_pk; // demo: issuer_id = issuer pubkey
            let nonce: u64 = 1;
            let expiry: u64 = 9_999_999_999;
            let envelope = build_envelope(claim_type, value, issuer_id, nonce, expiry);
            let signature = sk.sign(&envelope).to_bytes().to_vec();
            (envelope, signature, issuer_pk.to_vec(), threshold)
        };

    let env = ExecutorEnv::builder()
        .write(&envelope)
        .unwrap()
        .write(&signature)
        .unwrap()
        .write(&issuer_pk_vec)
        .unwrap()
        .write(&threshold)
        .unwrap()
        .build()
        .unwrap();

    // Fast acceptance check (no proving): execute the guest and observe pass/panic.
    // `ZKORAGE_EXEC_ONLY=1 ZKORAGE_VALUE=400000` demonstrates the value<threshold => no-receipt case.
    if std::env::var("ZKORAGE_EXEC_ONLY").is_ok() {
        let exec = default_executor();
        match exec.execute(env, CLAIM_PREDICATE_ELF) {
            Ok(session) => {
                println!(
                    "EXEC_OK: predicate satisfied (value >= threshold {threshold}) -> receipt would be produced"
                );
                println!("EXEC segments={}", session.segments.len());
                println!("EXEC segment_detail={:#?}", session.segments);
            }
            Err(e) => {
                println!("EXEC_FAIL (no receipt; value < threshold {threshold}): {e}")
            }
        }
        return;
    }

    eprintln!("[*] proving (STARK) + wrapping (Groth16)... first run pulls the docker image");
    let prover = default_prover();
    let prove_info = prover
        .prove_with_opts(env, CLAIM_PREDICATE_ELF, &ProverOpts::groth16())
        .expect("groth16 proving failed");
    eprintln!("STATS: {:#?}", prove_info.stats);
    let receipt = prove_info.receipt;

    // G4 — off-chain self-check before going on-chain (catches version/param mismatch locally).
    receipt
        .verify(CLAIM_PREDICATE_ID)
        .expect("off-chain receipt.verify failed");
    eprintln!("[ok] off-chain receipt.verify passed");

    let seal = encode_seal(&receipt);
    let journal_bytes = receipt.journal.bytes.clone();
    let journal_digest: [u8; 32] = Sha256::digest(&journal_bytes).into();
    let image_id_digest: Digest = CLAIM_PREDICATE_ID.into();
    let image_id: [u8; 32] = image_id_digest
        .as_bytes()
        .try_into()
        .expect("image id must be 32 bytes");

    let seal_hex = hex::encode(&seal);
    let image_id_hex = hex::encode(image_id);
    let journal_digest_hex = hex::encode(journal_digest);
    let journal_hex = hex::encode(&journal_bytes);

    let bundle_json = format!(
        "{{\n  \"seal\": \"{seal_hex}\",\n  \"image_id\": \"{image_id_hex}\",\n  \"journal_digest\": \"{journal_digest_hex}\",\n  \"journal\": \"{journal_hex}\"\n}}\n"
    );
    // Service path writes the bundle to ZKORAGE_OUT; standalone writes proof.txt + bundle.json.
    let out_path = std::env::var("ZKORAGE_OUT").unwrap_or_else(|_| "bundle.json".to_string());
    fs::write(&out_path, &bundle_json).unwrap();
    if std::env::var("ZKORAGE_OUT").is_err() {
        fs::write(
            "proof.txt",
            format!("{seal_hex}\n{image_id_hex}\n{journal_digest_hex}\n"),
        )
        .unwrap();
    }

    println!("WROTE {out_path}");
    println!("seal_len       = {}", seal.len());
    println!("image_id       = {image_id_hex}");
    println!("journal_digest = {journal_digest_hex}");
    println!("journal        = {journal_hex}");
}
