// zkorage Confidential Data Room — DR1 seal prover host.
// Seals a document key K to a recipient's x25519 key IN-GUEST (faithful ECIES, W7 Option B), binding K
// to the document's content_hash/room_id/doc_id, wraps STARK->Groth16, and emits
// {seal, image_id, journal_digest, journal} for on-chain anchoring by the DataRoom `put_document`.
use methods::{DATAROOM_SEAL_PREDICATE_ELF, DATAROOM_SEAL_PREDICATE_ID};
use rand::RngCore;
use host::encode_seal;
use risc0_zkvm::sha::Digest;
use risc0_zkvm::{ExecutorEnv, ProverOpts, default_executor, default_prover};
use sha2::{Digest as _, Sha256};
use std::fs;

fn rand32() -> [u8; 32] {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b
}

fn hex32(s: &str) -> Vec<u8> {
    let v = hex::decode(s.trim()).expect("hex");
    assert_eq!(v.len(), 32, "expected 32 bytes");
    v
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    // Inputs come from a job file when ZKORAGE_JOB is set (5 lines: doc_key_hex / recipient_pubkey_hex /
    // content_hash_hex / room_id_hex / doc_id_hex) — the prover-service path. The ephemeral ECIES secret
    // is ALWAYS host-generated fresh per proof. Otherwise a demo seal is produced.
    let (doc_key, recipient_pub, content_hash, room_id, doc_id): (
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
    ) = if let Ok(job_path) = std::env::var("ZKORAGE_JOB") {
        let s = fs::read_to_string(&job_path).expect("read ZKORAGE_JOB file");
        let mut lines = s.lines();
        let doc_key = hex32(lines.next().expect("doc_key line"));
        let recipient_pub = hex32(lines.next().expect("recipient line"));
        let content_hash = hex32(lines.next().expect("content_hash line"));
        let room_id = hex32(lines.next().expect("room_id line"));
        let doc_id = hex32(lines.next().expect("doc_id line"));
        (doc_key, recipient_pub, content_hash, room_id, doc_id)
    } else {
        let doc_key = rand32().to_vec();
        // Demo recipient x25519 pubkey (overridable via ZKORAGE_RECIPIENT=hex32).
        let recipient_pub: Vec<u8> = std::env::var("ZKORAGE_RECIPIENT")
            .ok()
            .and_then(|h| hex::decode(h).ok())
            .filter(|v| v.len() == 32)
            .unwrap_or_else(|| [0xADu8; 32].to_vec());
        let content_hash = Sha256::digest(b"zkorage dataroom demo ciphertext").to_vec();
        let room_id = [0x01u8; 32].to_vec();
        let doc_id = [0x09u8; 32].to_vec();
        (doc_key, recipient_pub, content_hash, room_id, doc_id)
    };

    // Fresh ephemeral ECIES secret (per proof) — MUST be fresh, else the keystream repeats.
    let eph_secret = rand32().to_vec();

    let env = ExecutorEnv::builder()
        .write(&doc_key)
        .unwrap()
        .write(&recipient_pub)
        .unwrap()
        .write(&content_hash)
        .unwrap()
        .write(&room_id)
        .unwrap()
        .write(&doc_id)
        .unwrap()
        .write(&eph_secret)
        .unwrap()
        .build()
        .unwrap();

    if std::env::var("ZKORAGE_EXEC_ONLY").is_ok() {
        let exec = default_executor();
        match exec.execute(env, DATAROOM_SEAL_PREDICATE_ELF) {
            Ok(session) => {
                println!("EXEC_OK: seal produced");
                println!("EXEC segments={}", session.segments.len());
                println!("EXEC journal={}", hex::encode(&session.journal.bytes));
            }
            Err(e) => println!("EXEC_FAIL: {e}"),
        }
        return;
    }

    eprintln!("[*] proving (STARK) + wrapping (Groth16)... first run pulls the docker image");
    let prover = default_prover();
    let prove_info = prover
        .prove_with_opts(env, DATAROOM_SEAL_PREDICATE_ELF, &ProverOpts::groth16())
        .expect("groth16 proving failed");
    eprintln!("STATS: {:#?}", prove_info.stats);
    let receipt = prove_info.receipt;

    receipt
        .verify(DATAROOM_SEAL_PREDICATE_ID)
        .expect("off-chain receipt.verify failed");
    eprintln!("[ok] off-chain receipt.verify passed");

    let seal = encode_seal(&receipt);
    let journal_bytes = receipt.journal.bytes.clone();
    let journal_digest: [u8; 32] = Sha256::digest(&journal_bytes).into();
    let image_id_digest: Digest = DATAROOM_SEAL_PREDICATE_ID.into();
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
    let out_path = std::env::var("ZKORAGE_OUT").unwrap_or_else(|_| "bundle_dataroom_seal.json".to_string());
    fs::write(&out_path, &bundle_json).unwrap();

    println!("WROTE {out_path}");
    println!("seal_len       = {}", seal.len());
    println!("image_id       = {image_id_hex}");
    println!("journal_digest = {journal_digest_hex}");
    println!("journal        = {journal_hex}");
}
