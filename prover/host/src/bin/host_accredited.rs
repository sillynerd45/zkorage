// zkorage accredited-investor prover host (Week 8).
// Self-signs a demo accreditation credential (or reads a job), proves "accredited = YES" in the zkVM
// while keeping subject_id private, wraps STARK->Groth16, and emits {seal, image_id, journal_digest,
// journal} for on-chain verification by the `accredited` gate on Soroban.
//
// NEW-2 domain separation: the issuer signs `DOMAIN ‖ envelope` (NOT the bare envelope). The guest
// verifies over the same bytes; the backend attester must too. The envelope itself is the 92-byte
// identity-style shape with claim_type = 7.
use ed25519_dalek::{Signer, SigningKey};
use methods::{ACCREDITED_PREDICATE_ELF, ACCREDITED_PREDICATE_ID};
use host::encode_seal;
use risc0_zkvm::sha::Digest;
use risc0_zkvm::{ExecutorEnv, ProverOpts, default_executor, default_prover};
use sha2::{Digest as _, Sha256};
use std::fs;

const CLAIM_TYPE_ACCREDITED: u32 = 7;
/// NEW-2: must match the guest's DOMAIN exactly.
const DOMAIN: &[u8] = b"zkorage-accredited-v1\x00";

/// Build the 92-byte big-endian AccreditedEnvelope (must match the guest's layout byte-for-byte).
fn build_envelope(
    claim_type: u32,
    accredited_status: u64,
    subject_id: [u8; 32],
    issuer_id: [u8; 32],
    nonce: u64,
    expiry: u64,
) -> Vec<u8> {
    let mut v = Vec::with_capacity(92);
    v.extend_from_slice(&claim_type.to_be_bytes());
    v.extend_from_slice(&accredited_status.to_be_bytes());
    v.extend_from_slice(&subject_id);
    v.extend_from_slice(&issuer_id);
    v.extend_from_slice(&nonce.to_be_bytes());
    v.extend_from_slice(&expiry.to_be_bytes());
    v
}

/// The domain-separated message that is actually signed/verified: `DOMAIN ‖ envelope`.
fn signed_message(envelope: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(DOMAIN.len() + envelope.len());
    m.extend_from_slice(DOMAIN);
    m.extend_from_slice(envelope);
    m
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    // Inputs come from a job file when ZKORAGE_JOB is set (4 lines: envelope_hex / signature_hex /
    // issuer_pubkey_hex / accessor_hex) — the prover-service path; the signature is over DOMAIN ‖
    // envelope (the backend attester applies the prefix). Otherwise a self-signed demo accreditation
    // credential is used (standalone / acceptance testing).
    let (envelope, signature, issuer_pk_vec, accessor): (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) =
        if let Ok(job_path) = std::env::var("ZKORAGE_JOB") {
            let s = fs::read_to_string(&job_path).expect("read ZKORAGE_JOB file");
            let mut lines = s.lines();
            let envelope = hex::decode(lines.next().expect("envelope line").trim()).expect("envelope hex");
            let signature = hex::decode(lines.next().expect("signature line").trim()).expect("signature hex");
            let issuer_pk_vec = hex::decode(lines.next().expect("pubkey line").trim()).expect("pubkey hex");
            let accessor = hex::decode(lines.next().expect("accessor line").trim()).expect("accessor hex");
            (envelope, signature, issuer_pk_vec, accessor)
        } else {
            // Demo accreditation provider seed = [13u8;32] (distinct from PoR [7] / KYC [9] / payroll [11]).
            let sk = SigningKey::from_bytes(&[13u8; 32]);
            let issuer_pk = sk.verifying_key().to_bytes();
            let accredited_status: u64 = std::env::var("ZKORAGE_ACCREDITED_STATUS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1);
            // Demo subject (private) and accessor (public binding = a demo "investor wallet" key).
            let subject_id: [u8; 32] = [0x5Au8; 32];
            let accessor: [u8; 32] = std::env::var("ZKORAGE_ACCESSOR")
                .ok()
                .and_then(|h| hex::decode(h).ok())
                .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
                .unwrap_or([0xA1u8; 32]);
            let nonce: u64 = 1;
            let expiry: u64 = 9_999_999_999;
            // demo: issuer_id == issuer pubkey (the guest hard-asserts pk == issuer_id).
            let issuer_id: [u8; 32] = issuer_pk;
            let envelope =
                build_envelope(CLAIM_TYPE_ACCREDITED, accredited_status, subject_id, issuer_id, nonce, expiry);
            // NEW-2: sign DOMAIN ‖ envelope.
            let signature = sk.sign(&signed_message(&envelope)).to_bytes().to_vec();
            (envelope, signature, issuer_pk.to_vec(), accessor.to_vec())
        };

    let env = ExecutorEnv::builder()
        .write(&envelope)
        .unwrap()
        .write(&signature)
        .unwrap()
        .write(&issuer_pk_vec)
        .unwrap()
        .write(&accessor)
        .unwrap()
        .build()
        .unwrap();

    // Fast acceptance check (no proving): execute the guest and observe pass/panic.
    // `ZKORAGE_EXEC_ONLY=1 ZKORAGE_ACCREDITED_STATUS=0` demonstrates the not-accredited => no-receipt case.
    if std::env::var("ZKORAGE_EXEC_ONLY").is_ok() {
        let exec = default_executor();
        match exec.execute(env, ACCREDITED_PREDICATE_ELF) {
            Ok(session) => {
                println!("EXEC_OK: accredited -> receipt would be produced");
                println!("EXEC segments={}", session.segments.len());
            }
            Err(e) => println!("EXEC_FAIL (no receipt; not accredited): {e}"),
        }
        return;
    }

    eprintln!("[*] proving (STARK) + wrapping (Groth16)... first run pulls the docker image");
    let prover = default_prover();
    let prove_info = prover
        .prove_with_opts(env, ACCREDITED_PREDICATE_ELF, &ProverOpts::groth16())
        .expect("groth16 proving failed");
    eprintln!("STATS: {:#?}", prove_info.stats);
    let receipt = prove_info.receipt;

    // Off-chain self-check before going on-chain (catches version/param mismatch locally).
    receipt
        .verify(ACCREDITED_PREDICATE_ID)
        .expect("off-chain receipt.verify failed");
    eprintln!("[ok] off-chain receipt.verify passed");

    let seal = encode_seal(&receipt);
    let journal_bytes = receipt.journal.bytes.clone();
    let journal_digest: [u8; 32] = Sha256::digest(&journal_bytes).into();
    let image_id_digest: Digest = ACCREDITED_PREDICATE_ID.into();
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
    let out_path = std::env::var("ZKORAGE_OUT").unwrap_or_else(|_| "bundle_accredited.json".to_string());
    fs::write(&out_path, &bundle_json).unwrap();

    println!("WROTE {out_path}");
    println!("seal_len       = {}", seal.len());
    println!("image_id       = {image_id_hex}");
    println!("journal_digest = {journal_digest_hex}");
    println!("journal        = {journal_hex}");
}
