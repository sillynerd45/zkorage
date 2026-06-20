// zkorage solvency-bonded prover host (BP3).
// Self-signs a demo reserve attestation (or reads a job), proves `reserves >= supply` in the zkVM while
// keeping the reserve figure private, binds a specific escrow lock + the two token roles into the journal,
// wraps STARK->Groth16, and emits {seal, image_id, journal_digest, journal} for the solvency gate.
//
// Domain separation: the reserve auditor signs `DOMAIN || envelope` (NOT the bare envelope). The guest
// verifies over the same bytes; the backend attester must too. The envelope is the 60-byte PoR shape with
// claim_type = 12.
use ed25519_dalek::{Signer, SigningKey};
use host::encode_seal;
use methods::{SOLVENCY_PREDICATE_ELF, SOLVENCY_PREDICATE_ID};
use risc0_zkvm::sha::Digest;
use risc0_zkvm::{ExecutorEnv, ProverOpts, default_executor, default_prover};
use sha2::{Digest as _, Sha256};
use std::fs;

const CLAIM_TYPE_SOLVENCY: u32 = 12;
/// Must match the guest's DOMAIN exactly.
const DOMAIN: &[u8] = b"zkorage-solvency-v1\x00";

/// Build the 60-byte big-endian ClaimEnvelope (must match the guest's layout byte-for-byte).
fn build_envelope(claim_type: u32, value: u64, issuer_id: [u8; 32], nonce: u64, expiry: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(60);
    v.extend_from_slice(&claim_type.to_be_bytes());
    v.extend_from_slice(&value.to_be_bytes());
    v.extend_from_slice(&issuer_id);
    v.extend_from_slice(&nonce.to_be_bytes());
    v.extend_from_slice(&expiry.to_be_bytes());
    v
}

/// The domain-separated message that is actually signed/verified: `DOMAIN || envelope`.
fn signed_message(envelope: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(DOMAIN.len() + envelope.len());
    m.extend_from_slice(DOMAIN);
    m.extend_from_slice(envelope);
    m
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

/// Decode a 32-byte hex value, or fall back to `fill`-repeated bytes for the demo path.
fn hex32_or(s: Option<String>, fill: u8) -> Vec<u8> {
    s.and_then(|h| hex::decode(h.trim()).ok())
        .filter(|v| v.len() == 32)
        .unwrap_or_else(|| vec![fill; 32])
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    // Inputs come from a job file when ZKORAGE_JOB is set (9 lines: envelope_hex / signature_hex /
    // issuer_pubkey_hex / threshold / escrow_hex / lock_id / min_amount / bond_token_hex /
    // supply_token_hex) — the prover-service path; the signature is over DOMAIN || envelope (the backend
    // attester applies the prefix). Otherwise a self-signed demo reserve attestation is used.
    let (envelope, signature, issuer_pk_vec, threshold, escrow, lock_id, min_amount, bond_token, supply_token): (
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        u64,
        Vec<u8>,
        u64,
        u64,
        Vec<u8>,
        Vec<u8>,
    ) = if let Ok(job_path) = std::env::var("ZKORAGE_JOB") {
        let s = fs::read_to_string(&job_path).expect("read ZKORAGE_JOB file");
        let mut lines = s.lines();
        let envelope = hex::decode(lines.next().expect("envelope line").trim()).expect("envelope hex");
        let signature = hex::decode(lines.next().expect("signature line").trim()).expect("signature hex");
        let issuer_pk_vec = hex::decode(lines.next().expect("pubkey line").trim()).expect("pubkey hex");
        let threshold: u64 = lines.next().expect("threshold line").trim().parse().expect("threshold u64");
        let escrow = hex::decode(lines.next().expect("escrow line").trim()).expect("escrow hex");
        let lock_id: u64 = lines.next().expect("lock_id line").trim().parse().expect("lock_id u64");
        let min_amount: u64 = lines.next().expect("min_amount line").trim().parse().expect("min_amount u64");
        let bond_token = hex::decode(lines.next().expect("bond_token line").trim()).expect("bond_token hex");
        let supply_token =
            hex::decode(lines.next().expect("supply_token line").trim()).expect("supply_token hex");
        (envelope, signature, issuer_pk_vec, threshold, escrow, lock_id, min_amount, bond_token, supply_token)
    } else {
        // Demo bonded reserve auditor seed = [19u8;32] (distinct from PoR [7] / KYC [9] / payroll [11] /
        // accredited [13] / revenue [15] / appraiser [17]).
        let sk = SigningKey::from_bytes(&[19u8; 32]);
        let issuer_pk = sk.verifying_key().to_bytes();
        let value: u64 = env_u64("ZKORAGE_VALUE", 10_000_000_000_000); // reserves (private)
        let threshold: u64 = env_u64("ZKORAGE_THRESHOLD", 10_000_000_000_000); // = supply
        let issuer_id: [u8; 32] = issuer_pk; // demo: issuer_id == issuer pubkey (guest asserts pk==issuer_id)
        let nonce: u64 = 1;
        let expiry: u64 = 9_999_999_999;
        let envelope = build_envelope(CLAIM_TYPE_SOLVENCY, value, issuer_id, nonce, expiry);
        let signature = sk.sign(&signed_message(&envelope)).to_bytes().to_vec();
        let escrow = hex32_or(std::env::var("ZKORAGE_ESCROW").ok(), 0xE5);
        let lock_id: u64 = env_u64("ZKORAGE_LOCK_ID", 1);
        let min_amount: u64 = env_u64("ZKORAGE_MIN_AMOUNT", 1);
        let bond_token = hex32_or(std::env::var("ZKORAGE_BOND_TOKEN").ok(), 0xB0);
        let supply_token = hex32_or(std::env::var("ZKORAGE_SUPPLY_TOKEN").ok(), 0x5b);
        (envelope, signature, issuer_pk.to_vec(), threshold, escrow, lock_id, min_amount, bond_token, supply_token)
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
        .write(&escrow)
        .unwrap()
        .write(&lock_id)
        .unwrap()
        .write(&min_amount)
        .unwrap()
        .write(&bond_token)
        .unwrap()
        .write(&supply_token)
        .unwrap()
        .build()
        .unwrap();

    // Fast acceptance check (no proving): execute the guest and observe pass/panic.
    // `ZKORAGE_EXEC_ONLY=1 ZKORAGE_VALUE=1` demonstrates the reserves<supply => no-receipt case.
    if std::env::var("ZKORAGE_EXEC_ONLY").is_ok() {
        let exec = default_executor();
        match exec.execute(env, SOLVENCY_PREDICATE_ELF) {
            Ok(session) => {
                println!("EXEC_OK: solvency predicate satisfied (reserves >= supply) -> receipt would be produced");
                println!("EXEC segments={}", session.segments.len());
            }
            Err(e) => println!("EXEC_FAIL (no receipt; reserves < supply): {e}"),
        }
        return;
    }

    eprintln!("[*] proving (STARK) + wrapping (Groth16)... first run pulls the docker image");
    let prover = default_prover();
    let prove_info = prover
        .prove_with_opts(env, SOLVENCY_PREDICATE_ELF, &ProverOpts::groth16())
        .expect("groth16 proving failed");
    eprintln!("STATS: {:#?}", prove_info.stats);
    let receipt = prove_info.receipt;

    // Off-chain self-check before going on-chain (catches version/param mismatch locally).
    receipt
        .verify(SOLVENCY_PREDICATE_ID)
        .expect("off-chain receipt.verify failed");
    eprintln!("[ok] off-chain receipt.verify passed");

    let seal = encode_seal(&receipt);
    let journal_bytes = receipt.journal.bytes.clone();
    let journal_digest: [u8; 32] = Sha256::digest(&journal_bytes).into();
    let image_id_digest: Digest = SOLVENCY_PREDICATE_ID.into();
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
    let out_path = std::env::var("ZKORAGE_OUT").unwrap_or_else(|_| "bundle_solvency.json".to_string());
    fs::write(&out_path, &bundle_json).unwrap();

    println!("WROTE {out_path}");
    println!("seal_len       = {}", seal.len());
    println!("image_id       = {image_id_hex}");
    println!("journal_digest = {journal_digest_hex}");
    println!("journal        = {journal_hex}");
}
