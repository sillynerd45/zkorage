// zkorage Confidential Data Room — DR4 document-authenticity prover host (zkPDF in-engine). Verifies a
// REAL third-party RSA-2048 PKCS#1 v1.5 (SHA-256, e=65537) signature over a fixed-layout 88-byte signed
// statement IN-ZKVM, asserts the attested value >= a public threshold, wraps STARK->Groth16, and emits
// {seal, image_id, journal_digest, journal} for on-chain admission by the DataRoom `attest_document_fact`.
// The statement bytes / account / exact value stay PRIVATE (only the predicate result + threshold are
// revealed). NO ed25519/x25519 here (RSA + sha256 only) so the canonical image_id reproduces cross-machine.
//
// Job mode (ZKORAGE_JOB set, 5 lines): n_hex(256B) / sig_hex(256B) / statement_hex(88B) / threshold(u64) /
// room_id_hex(32B) — the prover-service path: the backend's mock-bank issuer has already signed the
// statement. Otherwise a DEMO proof is produced: the host generates a fresh RSA-2048 keypair, builds a
// canonical statement, and signs it (the guest only VERIFIES — the host does the host-side RSA the bank
// would do in production).
use methods::{DOCAUTH_PREDICATE_ELF, DOCAUTH_PREDICATE_ID};
use host::encode_seal;
use risc0_zkvm::sha::Digest;
use risc0_zkvm::{ExecutorEnv, ProverOpts, default_executor, default_prover};
use rsa::traits::PublicKeyParts;
use rsa::{Pkcs1v15Sign, RsaPrivateKey, RsaPublicKey};
use sha2::{Digest as _, Sha256};
use std::fs;

const STATEMENT_LEN: usize = 88;
const STATEMENT_DOMAIN: &[u8; 16] = b"zkorage-bankstmt";
const STATEMENT_VERSION: u32 = 1;
const FIELD_TAG_BALANCE: u32 = 1;

fn hexn(s: &str, n: usize) -> Vec<u8> {
    let v = hex::decode(s.trim()).expect("hex");
    assert_eq!(v.len(), n, "expected {n} bytes");
    v
}

/// Left-pad a big-endian value to exactly 256 bytes (RSA-2048 modulus / signature width).
fn pad256(v: Vec<u8>) -> Vec<u8> {
    assert!(v.len() <= 256, "value wider than 2048 bits");
    let mut out = vec![0u8; 256];
    out[256 - v.len()..].copy_from_slice(&v);
    out
}

/// Build the canonical fixed-layout 88-byte signed bank statement (must match the guest layout byte-exact).
fn build_statement(account_ref: &[u8; 32], value: u64, issued_at: u64, expiry: u64) -> Vec<u8> {
    let mut m = Vec::with_capacity(STATEMENT_LEN);
    m.extend_from_slice(STATEMENT_DOMAIN); // [0..16]
    m.extend_from_slice(&STATEMENT_VERSION.to_be_bytes()); // [16..20]
    m.extend_from_slice(&FIELD_TAG_BALANCE.to_be_bytes()); // [20..24]
    m.extend_from_slice(account_ref); // [24..56]
    m.extend_from_slice(&value.to_be_bytes()); // [56..64]
    m.extend_from_slice(&issued_at.to_be_bytes()); // [64..72]
    m.extend_from_slice(&expiry.to_be_bytes()); // [72..80]
    m.extend_from_slice(b"USD\0\0\0\0\0"); // [80..88] currency
    assert_eq!(m.len(), STATEMENT_LEN);
    m
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    let (n_bytes, sig_bytes, statement, threshold, room_id): (Vec<u8>, Vec<u8>, Vec<u8>, u64, Vec<u8>) =
        if let Ok(job_path) = std::env::var("ZKORAGE_JOB") {
            let s = fs::read_to_string(&job_path).expect("read ZKORAGE_JOB file");
            let mut lines = s.lines();
            let n_bytes = hexn(lines.next().expect("n line"), 256);
            let sig_bytes = hexn(lines.next().expect("sig line"), 256);
            let statement = hexn(lines.next().expect("statement line"), STATEMENT_LEN);
            let threshold: u64 = lines
                .next()
                .expect("threshold line")
                .trim()
                .parse()
                .expect("threshold u64");
            let room_id = hexn(lines.next().expect("room_id line"), 32);
            (n_bytes, sig_bytes, statement, threshold, room_id)
        } else {
            // DEMO: generate a fresh RSA-2048 issuer key, build a statement, sign it. All values are
            // overridable so the acceptance script can drive specific balances / thresholds / rooms.
            let env_u64 = |name: &str, default: u64| -> u64 {
                std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
            };
            let env32 = |name: &str, default: [u8; 32]| -> [u8; 32] {
                std::env::var(name)
                    .ok()
                    .and_then(|h| hex::decode(h).ok())
                    .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
                    .unwrap_or(default)
            };
            let value = env_u64("ZKORAGE_VALUE", 5_000_000); // demo balance in minor units
            let threshold = env_u64("ZKORAGE_THRESHOLD", 1_000_000); // demo floor X
            let room_id = env32("ZKORAGE_ROOM_ID", [0x01u8; 32]);
            let account_ref = env32("ZKORAGE_ACCOUNT_REF", [0x44u8; 32]);
            let issued_at = env_u64("ZKORAGE_ISSUED_AT", 1_750_000_000);
            let expiry = env_u64("ZKORAGE_EXPIRY", 0);

            let mut rng = rand::thread_rng();
            let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("rsa keygen");
            let pub_key = RsaPublicKey::from(&priv_key);
            let statement = build_statement(&account_ref, value, issued_at, expiry);
            let hash = Sha256::digest(&statement);
            let sig = priv_key
                .sign(Pkcs1v15Sign::new::<Sha256>(), &hash)
                .expect("rsa sign");
            let n_bytes = pad256(pub_key.n().to_bytes_be());
            let sig_bytes = pad256(sig);
            (n_bytes, sig_bytes, statement, threshold, room_id.to_vec())
        };

    assert_eq!(n_bytes.len(), 256, "modulus must be 256 bytes");
    assert_eq!(sig_bytes.len(), 256, "signature must be 256 bytes");
    assert_eq!(statement.len(), STATEMENT_LEN, "statement must be 88 bytes");
    assert_eq!(room_id.len(), 32, "room_id must be 32 bytes");

    // Echo the public bindings (handy for the acceptance script / cross-checking the on-chain fact).
    let issuer_key_hash: [u8; 32] = Sha256::digest(&n_bytes).into();
    let msg_digest: [u8; 32] = Sha256::digest(&statement).into();
    eprintln!("[docauth] issuer_key_hash = {}", hex::encode(issuer_key_hash));
    eprintln!("[docauth] msg_digest      = {}", hex::encode(msg_digest));
    eprintln!("[docauth] threshold       = {threshold}");
    eprintln!("[docauth] room_id         = {}", hex::encode(&room_id));

    let env = ExecutorEnv::builder()
        .write(&n_bytes)
        .unwrap()
        .write(&sig_bytes)
        .unwrap()
        .write(&statement)
        .unwrap()
        .write(&threshold)
        .unwrap()
        .write(&room_id)
        .unwrap()
        .build()
        .unwrap();

    // Fast acceptance check (no proving): execute the guest and observe pass/panic + segment count
    // (the DR4 RSA-verify cost driver — DR1 Ch0 measured ~22 segments).
    if std::env::var("ZKORAGE_EXEC_ONLY").is_ok() {
        let exec = default_executor();
        match exec.execute(env, DOCAUTH_PREDICATE_ELF) {
            Ok(session) => {
                println!("EXEC_OK: valid RSA signature + value >= threshold -> receipt would be produced");
                println!("EXEC segments={}", session.segments.len());
                println!("EXEC journal={}", hex::encode(&session.journal.bytes));
            }
            Err(e) => println!("EXEC_FAIL (no receipt; bad sig / below threshold / malformed): {e}"),
        }
        return;
    }

    eprintln!("[*] proving (STARK) + wrapping (Groth16)... first run pulls the docker image");
    let prover = default_prover();
    let prove_info = prover
        .prove_with_opts(env, DOCAUTH_PREDICATE_ELF, &ProverOpts::groth16())
        .expect("groth16 proving failed");
    eprintln!("STATS: {:#?}", prove_info.stats);
    let receipt = prove_info.receipt;

    receipt
        .verify(DOCAUTH_PREDICATE_ID)
        .expect("off-chain receipt.verify failed");
    eprintln!("[ok] off-chain receipt.verify passed");

    let seal = encode_seal(&receipt);
    let journal_bytes = receipt.journal.bytes.clone();
    let journal_digest: [u8; 32] = Sha256::digest(&journal_bytes).into();
    let image_id_digest: Digest = DOCAUTH_PREDICATE_ID.into();
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
    let out_path = std::env::var("ZKORAGE_OUT").unwrap_or_else(|_| "bundle_docauth.json".to_string());
    fs::write(&out_path, &bundle_json).unwrap();

    println!("WROTE {out_path}");
    println!("seal_len       = {}", seal.len());
    println!("image_id       = {image_id_hex}");
    println!("journal_digest = {journal_digest_hex}");
    println!("journal        = {journal_hex}");
}
