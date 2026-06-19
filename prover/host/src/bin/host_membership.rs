// zkorage Confidential Data Room — DR2 membership+nullifier prover host (anonymous eligibility).
// Proves a depth-20 sha256-Merkle membership in a room's eligible set + a per-room nullifier + a NEW-5
// in-guest holder signature (accessor-auth), keeping the identity (id_secret/id_trapdoor/which leaf)
// PRIVATE, wraps STARK->Groth16, and emits {seal, image_id, journal_digest, journal} for on-chain
// admission by the DataRoom `request_access`. NO x25519/ECIES here (ed25519+sha256 only) so the canonical
// image_id reproduces cross-machine (W8 finding); the key-release ECIES lives off-chain in DR3.
use ed25519_dalek::{Signer, SigningKey};
use methods::{MEMBERSHIP_PREDICATE_ELF, MEMBERSHIP_PREDICATE_ID};
use host::encode_seal;
use risc0_zkvm::sha::Digest;
use risc0_zkvm::{ExecutorEnv, ProverOpts, default_executor, default_prover};
use sha2::{Digest as _, Sha256};
use std::fs;

const TREE_DEPTH: usize = 20;
const LEAF_TAG: u8 = 0x00;
const NODE_TAG: u8 = 0x01;
const NULLIFIER_TAG: u8 = 0x02;
const SIG_DOMAIN: &[u8] = b"zkorage-dataroom-access-v1";

fn hex32(s: &str) -> Vec<u8> {
    let v = hex::decode(s.trim()).expect("hex");
    assert_eq!(v.len(), 32, "expected 32 bytes");
    v
}

fn arr32(v: &[u8]) -> [u8; 32] {
    v.try_into().expect("32 bytes")
}

/// Leaf / id_commitment = sha256(LEAF_TAG ‖ id_secret ‖ id_trapdoor) — must match the guest + backend.
fn leaf_commitment(id_secret: &[u8; 32], id_trapdoor: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([LEAF_TAG]);
    h.update(id_secret);
    h.update(id_trapdoor);
    h.finalize().into()
}

/// Internal node = sha256(NODE_TAG ‖ left ‖ right).
fn node(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([NODE_TAG]);
    h.update(a);
    h.update(b);
    h.finalize().into()
}

/// Nullifier = sha256(NULLIFIER_TAG ‖ id_secret ‖ room_id) (external_nullifier = room_id).
fn nullifier(id_secret: &[u8; 32], room_id: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([NULLIFIER_TAG]);
    h.update(id_secret);
    h.update(room_id);
    h.finalize().into()
}

/// Build a DEMO eligible-set witness: a depth-20 tree with the member at index 0 and every other slot the
/// canonical "empty" leaf = sha256(LEAF_TAG ‖ 0^32 ‖ 0^32) (a zero-subtree / incremental-Merkle tree). The
/// member is always the left child (leaf_index = 0, all bits 0). Returns (siblings bottom->top, root).
/// The backend (DR2 Ch3) builds the same-shaped tree with real members at arbitrary indices.
fn demo_witness(member_leaf: &[u8; 32]) -> (Vec<u8>, [u8; 32]) {
    let mut z = leaf_commitment(&[0u8; 32], &[0u8; 32]); // empty subtree root at the current level
    let mut siblings = Vec::with_capacity(TREE_DEPTH * 32);
    let mut cur = *member_leaf;
    for _ in 0..TREE_DEPTH {
        siblings.extend_from_slice(&z); // member is the left child, so the sibling is on the right
        cur = node(&cur, &z);
        z = node(&z, &z); // next-level empty-subtree root
    }
    (siblings, cur)
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    // Inputs come from a job file when ZKORAGE_JOB is set (9 lines, in this order):
    //   sig_hex / pk_hex / accessor_hex / recipient_pubkey_hex / id_secret_hex / id_trapdoor_hex /
    //   room_id_hex / siblings_hex (depth*32) / leaf_index (decimal u32)
    // — the prover-service path: the backend/client has already signed (NEW-5) and built the Merkle
    // witness from the public eligible set. Otherwise a DEMO membership proof is produced (the host
    // self-signs a holder key with pk == accessor and builds a zero-subtree witness at index 0).
    let (sig, pk, accessor, recipient_pub, id_secret, id_trapdoor, room_id, siblings, leaf_index): (
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        u32,
    ) = if let Ok(job_path) = std::env::var("ZKORAGE_JOB") {
        let s = fs::read_to_string(&job_path).expect("read ZKORAGE_JOB file");
        let mut lines = s.lines();
        let sig = hex::decode(lines.next().expect("sig line").trim()).expect("sig hex");
        let pk = hex32(lines.next().expect("pk line"));
        let accessor = hex32(lines.next().expect("accessor line"));
        let recipient_pub = hex32(lines.next().expect("recipient line"));
        let id_secret = hex32(lines.next().expect("id_secret line"));
        let id_trapdoor = hex32(lines.next().expect("id_trapdoor line"));
        let room_id = hex32(lines.next().expect("room_id line"));
        let siblings = hex::decode(lines.next().expect("siblings line").trim()).expect("siblings hex");
        let leaf_index: u32 = lines
            .next()
            .expect("leaf_index line")
            .trim()
            .parse()
            .expect("leaf_index u32");
        assert_eq!(sig.len(), 64, "sig must be 64 bytes");
        assert_eq!(siblings.len(), TREE_DEPTH * 32, "siblings must be depth*32 bytes");
        (sig, pk, accessor, recipient_pub, id_secret, id_trapdoor, room_id, siblings, leaf_index)
    } else {
        // Demo identity / room / recipient — all overridable so the acceptance script can drive specific
        // values (e.g. SAME id_secret + room with DIFFERENT holder seeds → same nullifier, two accessors).
        let env32 = |name: &str, default: [u8; 32]| -> [u8; 32] {
            std::env::var(name)
                .ok()
                .and_then(|h| hex::decode(h).ok())
                .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
                .unwrap_or(default)
        };
        let holder_seed = env32("ZKORAGE_HOLDER_SEED", [0x03u8; 32]);
        let id_secret = env32("ZKORAGE_ID_SECRET", [0x11u8; 32]);
        let id_trapdoor = env32("ZKORAGE_ID_TRAPDOOR", [0x22u8; 32]);
        let room_id = env32("ZKORAGE_ROOM_ID", [0x01u8; 32]);
        let recipient_pub = env32("ZKORAGE_RECIPIENT", [0xADu8; 32]);

        // NEW-5: the holder signs DOMAIN ‖ room_id ‖ accessor ‖ recipient_pub; accessor == pk (own key).
        let sk = SigningKey::from_bytes(&holder_seed);
        let accessor = sk.verifying_key().to_bytes();
        let mut signed = Vec::with_capacity(SIG_DOMAIN.len() + 96);
        signed.extend_from_slice(SIG_DOMAIN);
        signed.extend_from_slice(&room_id);
        signed.extend_from_slice(&accessor);
        signed.extend_from_slice(&recipient_pub);
        let sig = sk.sign(&signed).to_bytes().to_vec();

        let member_leaf = leaf_commitment(&id_secret, &id_trapdoor);
        let (siblings, _root) = demo_witness(&member_leaf);
        (
            sig,
            accessor.to_vec(),
            accessor.to_vec(),
            recipient_pub.to_vec(),
            id_secret.to_vec(),
            id_trapdoor.to_vec(),
            room_id.to_vec(),
            siblings,
            0u32,
        )
    };

    // Compute the root + nullifier host-side too (so they can be cross-checked / pinned on-chain).
    let member_leaf = leaf_commitment(&arr32(&id_secret), &arr32(&id_trapdoor));
    let root = {
        let mut cur = member_leaf;
        for i in 0..TREE_DEPTH {
            let sib = arr32(&siblings[i * 32..i * 32 + 32]);
            cur = if (leaf_index >> i) & 1 == 0 {
                node(&cur, &sib)
            } else {
                node(&sib, &cur)
            };
        }
        cur
    };
    let nf = nullifier(&arr32(&id_secret), &arr32(&room_id));
    eprintln!("[membership] eligible_root = {}", hex::encode(root));
    eprintln!("[membership] nullifier     = {}", hex::encode(nf));
    eprintln!("[membership] accessor      = {}", hex::encode(&accessor));

    let env = ExecutorEnv::builder()
        .write(&sig)
        .unwrap()
        .write(&pk)
        .unwrap()
        .write(&accessor)
        .unwrap()
        .write(&recipient_pub)
        .unwrap()
        .write(&id_secret)
        .unwrap()
        .write(&id_trapdoor)
        .unwrap()
        .write(&room_id)
        .unwrap()
        .write(&siblings)
        .unwrap()
        .write(&leaf_index)
        .unwrap()
        .build()
        .unwrap();

    // Fast acceptance check (no proving): execute the guest and observe pass/panic + segment count.
    if std::env::var("ZKORAGE_EXEC_ONLY").is_ok() {
        let exec = default_executor();
        match exec.execute(env, MEMBERSHIP_PREDICATE_ELF) {
            Ok(session) => {
                println!("EXEC_OK: eligible member + holder sig OK -> receipt would be produced");
                println!("EXEC segments={}", session.segments.len());
                println!("EXEC journal={}", hex::encode(&session.journal.bytes));
            }
            Err(e) => println!("EXEC_FAIL (no receipt; bad sig / non-member / malformed): {e}"),
        }
        return;
    }

    eprintln!("[*] proving (STARK) + wrapping (Groth16)... first run pulls the docker image");
    let prover = default_prover();
    let prove_info = prover
        .prove_with_opts(env, MEMBERSHIP_PREDICATE_ELF, &ProverOpts::groth16())
        .expect("groth16 proving failed");
    eprintln!("STATS: {:#?}", prove_info.stats);
    let receipt = prove_info.receipt;

    receipt
        .verify(MEMBERSHIP_PREDICATE_ID)
        .expect("off-chain receipt.verify failed");
    eprintln!("[ok] off-chain receipt.verify passed");

    let seal = encode_seal(&receipt);
    let journal_bytes = receipt.journal.bytes.clone();
    let journal_digest: [u8; 32] = Sha256::digest(&journal_bytes).into();
    let image_id_digest: Digest = MEMBERSHIP_PREDICATE_ID.into();
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
    let out_path = std::env::var("ZKORAGE_OUT").unwrap_or_else(|_| "bundle_membership.json".to_string());
    fs::write(&out_path, &bundle_json).unwrap();

    println!("WROTE {out_path}");
    println!("seal_len       = {}", seal.len());
    println!("image_id       = {image_id_hex}");
    println!("journal_digest = {journal_digest_hex}");
    println!("journal        = {journal_hex}");
}
