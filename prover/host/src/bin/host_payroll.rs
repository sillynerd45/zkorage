// zkorage payroll (confidential proof-of-income) prover host.
// Self-signs a demo payroll record (or reads a job), proves "salary ≥ threshold signed by an
// allow-listed attester" in the zkVM while keeping the salary private, encrypts the salary to the
// auditor's x25519 key IN-GUEST (Option B selective disclosure), wraps STARK->Groth16, and emits
// {seal, image_id, journal_digest, journal} for on-chain verification by the payroll gate.
use ed25519_dalek::{Signer, SigningKey};
use methods::{PAYROLL_PREDICATE_ELF, PAYROLL_PREDICATE_ID};
use rand::RngCore;
use host::encode_seal;
use risc0_zkvm::sha::Digest;
use risc0_zkvm::{ExecutorEnv, ProverOpts, default_executor, default_prover};
use sha2::{Digest as _, Sha256};
use std::fs;

const CLAIM_TYPE_PAYROLL: u32 = 5;

/// Build the 60-byte big-endian PayrollEnvelope (must match the guest's layout byte-for-byte).
fn build_envelope(
    claim_type: u32,
    salary: u64,
    issuer_id: [u8; 32],
    nonce: u64,
    expiry: u64,
) -> Vec<u8> {
    let mut v = Vec::with_capacity(60);
    v.extend_from_slice(&claim_type.to_be_bytes());
    v.extend_from_slice(&salary.to_be_bytes());
    v.extend_from_slice(&issuer_id);
    v.extend_from_slice(&nonce.to_be_bytes());
    v.extend_from_slice(&expiry.to_be_bytes());
    v
}

fn rand32() -> [u8; 32] {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    // Inputs come from a job file when ZKORAGE_JOB is set (6 lines: envelope_hex / signature_hex /
    // issuer_pubkey_hex / accessor_hex / auditor_pubkey_hex / threshold) — the prover-service path.
    // Otherwise a self-signed demo payroll record is used (salary from ZKORAGE_SALARY, threshold from
    // ZKORAGE_THRESHOLD, accessor from ZKORAGE_ACCESSOR, auditor x25519 pubkey from ZKORAGE_AUDITOR).
    // The ephemeral ECIES randomness (eph_secret, blinding) is ALWAYS host-generated fresh per proof.
    let (envelope, signature, issuer_pk_vec, accessor, auditor_pub, threshold): (
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        u64,
    ) = if let Ok(job_path) = std::env::var("ZKORAGE_JOB") {
        let s = fs::read_to_string(&job_path).expect("read ZKORAGE_JOB file");
        let mut lines = s.lines();
        let envelope = hex::decode(lines.next().expect("envelope line").trim()).expect("envelope hex");
        let signature = hex::decode(lines.next().expect("signature line").trim()).expect("signature hex");
        let issuer_pk_vec = hex::decode(lines.next().expect("pubkey line").trim()).expect("pubkey hex");
        let accessor = hex::decode(lines.next().expect("accessor line").trim()).expect("accessor hex");
        let auditor_pub = hex::decode(lines.next().expect("auditor line").trim()).expect("auditor hex");
        let threshold: u64 = lines
            .next()
            .expect("threshold line")
            .trim()
            .parse()
            .expect("threshold u64");
        (envelope, signature, issuer_pk_vec, accessor, auditor_pub, threshold)
    } else {
        // Demo payroll attester seed = [11u8;32] (distinct from PoR [7], KYC [9]).
        let sk = SigningKey::from_bytes(&[11u8; 32]);
        let issuer_pk = sk.verifying_key().to_bytes();
        let salary: u64 = std::env::var("ZKORAGE_SALARY").ok().and_then(|s| s.parse().ok()).unwrap_or(6000);
        let threshold: u64 = std::env::var("ZKORAGE_THRESHOLD").ok().and_then(|s| s.parse().ok()).unwrap_or(5000);
        let accessor: [u8; 32] = std::env::var("ZKORAGE_ACCESSOR")
            .ok()
            .and_then(|h| hex::decode(h).ok())
            .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
            .unwrap_or([0xA1u8; 32]);
        let auditor_pub: [u8; 32] = std::env::var("ZKORAGE_AUDITOR")
            .ok()
            .and_then(|h| hex::decode(h).ok())
            .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
            .unwrap_or([0xADu8; 32]);
        let nonce: u64 = 1;
        let expiry: u64 = 9_999_999_999;
        let issuer_id: [u8; 32] = issuer_pk; // guest hard-asserts pk == issuer_id
        let envelope = build_envelope(CLAIM_TYPE_PAYROLL, salary, issuer_id, nonce, expiry);
        let signature = sk.sign(&envelope).to_bytes().to_vec();
        (envelope, signature, issuer_pk.to_vec(), accessor.to_vec(), auditor_pub.to_vec(), threshold)
    };

    // Fresh ephemeral ECIES randomness (per proof). eph_secret MUST be fresh (else keystream reuse);
    // blinding keeps the public tag hiding.
    let eph_secret = rand32().to_vec();
    let blinding = rand32().to_vec();

    let env = ExecutorEnv::builder()
        .write(&envelope)
        .unwrap()
        .write(&signature)
        .unwrap()
        .write(&issuer_pk_vec)
        .unwrap()
        .write(&accessor)
        .unwrap()
        .write(&auditor_pub)
        .unwrap()
        .write(&threshold)
        .unwrap()
        .write(&eph_secret)
        .unwrap()
        .write(&blinding)
        .unwrap()
        .build()
        .unwrap();

    // Fast acceptance check (no proving): execute the guest and observe pass/panic. Prints the committed
    // journal so the disclosure (eph_pub/ct/tag) + threshold can be cross-checked against the backend.
    // `ZKORAGE_EXEC_ONLY=1 ZKORAGE_SALARY=1 ZKORAGE_THRESHOLD=5000` demonstrates salary < threshold =>
    // no receipt.
    if std::env::var("ZKORAGE_EXEC_ONLY").is_ok() {
        let exec = default_executor();
        match exec.execute(env, PAYROLL_PREDICATE_ELF) {
            Ok(session) => {
                println!("EXEC_OK: salary >= threshold -> receipt would be produced");
                println!("EXEC segments={}", session.segments.len());
                println!("EXEC journal={}", hex::encode(&session.journal.bytes));
            }
            Err(e) => println!("EXEC_FAIL (no receipt; salary < threshold or bad input): {e}"),
        }
        return;
    }

    eprintln!("[*] proving (STARK) + wrapping (Groth16)... first run pulls the docker image");
    let prover = default_prover();
    let prove_info = prover
        .prove_with_opts(env, PAYROLL_PREDICATE_ELF, &ProverOpts::groth16())
        .expect("groth16 proving failed");
    eprintln!("STATS: {:#?}", prove_info.stats);
    let receipt = prove_info.receipt;

    // Off-chain self-check before going on-chain (catches version/param mismatch locally).
    receipt
        .verify(PAYROLL_PREDICATE_ID)
        .expect("off-chain receipt.verify failed");
    eprintln!("[ok] off-chain receipt.verify passed");

    let seal = encode_seal(&receipt);
    let journal_bytes = receipt.journal.bytes.clone();
    let journal_digest: [u8; 32] = Sha256::digest(&journal_bytes).into();
    let image_id_digest: Digest = PAYROLL_PREDICATE_ID.into();
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
    let out_path = std::env::var("ZKORAGE_OUT").unwrap_or_else(|_| "bundle_payroll.json".to_string());
    fs::write(&out_path, &bundle_json).unwrap();

    println!("WROTE {out_path}");
    println!("seal_len       = {}", seal.len());
    println!("image_id       = {image_id_hex}");
    println!("journal_digest = {journal_digest_hex}");
    println!("journal        = {journal_hex}");
}
