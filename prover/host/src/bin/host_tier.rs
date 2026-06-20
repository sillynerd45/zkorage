// zkorage Bonded Proofs — BP5 anonymous tier prover host.
// Proves an enrolled-member Merkle membership (member_root) AND a qualifying-lock Merkle membership
// (qual_root, over c = sha256(QUAL_TAG ‖ id_secret ‖ "escrow"), the same commitment the depositor stored
// in the escrow lock) + a per-context nullifier + a NEW-5 in-guest holder signature (accessor-auth),
// keeping the identity (id_secret/id_trapdoor/both leaf indices) PRIVATE, wraps STARK->Groth16, and emits
// {seal, image_id, journal_digest, journal} for the on-chain tier gate. ed25519+sha256 ONLY (no x25519),
// so the canonical image_id reproduces cross-machine (W8 finding).
use ed25519_dalek::{Signer, SigningKey};
use host::encode_seal;
use methods::{TIER_PREDICATE_ELF, TIER_PREDICATE_ID};
use risc0_zkvm::sha::Digest;
use risc0_zkvm::{ExecutorEnv, ProverOpts, default_executor, default_prover};
use sha2::{Digest as _, Sha256};
use std::fs;

const TREE_DEPTH: usize = 20;
const LEAF_TAG: u8 = 0x00;
const NODE_TAG: u8 = 0x01;
const NULLIFIER_TAG: u8 = 0x02;
const QUAL_TAG: u8 = 0x03;
const ESCROW_LABEL: &[u8] = b"escrow";
const SIG_DOMAIN: &[u8] = b"zkorage-tier-bonded-v1";

fn hex32(s: &str) -> Vec<u8> {
    let v = hex::decode(s.trim()).expect("hex");
    assert_eq!(v.len(), 32, "expected 32 bytes");
    v
}

fn arr32(v: &[u8]) -> [u8; 32] {
    v.try_into().expect("32 bytes")
}

/// Member leaf / id_commitment = sha256(LEAF_TAG ‖ id_secret ‖ id_trapdoor) — must match guest + backend.
fn member_leaf(id_secret: &[u8; 32], id_trapdoor: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([LEAF_TAG]);
    h.update(id_secret);
    h.update(id_trapdoor);
    h.finalize().into()
}

/// Qualifying-lock commitment = sha256(QUAL_TAG ‖ id_secret ‖ "escrow") — the value the depositor stored
/// in the escrow lock's `commitment`. Must match guest + frontend + backend byte-for-byte.
fn qual_commitment(id_secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([QUAL_TAG]);
    h.update(id_secret);
    h.update(ESCROW_LABEL);
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

/// Nullifier = sha256(NULLIFIER_TAG ‖ id_secret ‖ context) (external_nullifier = context).
fn nullifier(id_secret: &[u8; 32], context: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([NULLIFIER_TAG]);
    h.update(id_secret);
    h.update(context);
    h.finalize().into()
}

/// Build a DEMO zero-subtree witness with `member_leaf_val` at index 0 and `empty` in every other slot.
/// Returns (siblings bottom->top, root). The backend builds the same-shaped tree with real leaves at
/// arbitrary indices.
fn demo_witness(leaf: &[u8; 32], empty: &[u8; 32]) -> (Vec<u8>, [u8; 32]) {
    let mut z = *empty; // empty-subtree root at the current level
    let mut siblings = Vec::with_capacity(TREE_DEPTH * 32);
    let mut cur = *leaf;
    for _ in 0..TREE_DEPTH {
        siblings.extend_from_slice(&z); // leaf is the left child, sibling on the right
        cur = node(&cur, &z);
        z = node(&z, &z); // next-level empty-subtree root
    }
    (siblings, cur)
}

fn fold_root(leaf: &[u8; 32], siblings: &[u8], leaf_index: u32) -> [u8; 32] {
    let mut cur = *leaf;
    for i in 0..TREE_DEPTH {
        let sib = arr32(&siblings[i * 32..i * 32 + 32]);
        cur = if (leaf_index >> i) & 1 == 0 {
            node(&cur, &sib)
        } else {
            node(&sib, &cur)
        };
    }
    cur
}

#[allow(clippy::type_complexity)]
fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::filter::EnvFilter::from_default_env())
        .init();

    // Inputs come from a job file when ZKORAGE_JOB is set (12 lines, in this order):
    //   sig_hex / pk_hex / accessor_hex / id_secret_hex / id_trapdoor_hex / context_hex /
    //   threshold (u64) / unlock_after (u64) / member_siblings_hex (depth*32) / member_leaf_index (u32) /
    //   qual_siblings_hex (depth*32) / qual_leaf_index (u32)
    // — the prover-service path: the backend has already signed (NEW-5) and built BOTH Merkle witnesses.
    // Otherwise a DEMO proof is produced (the host self-signs a holder key with pk == accessor and builds
    // zero-subtree witnesses at index 0 for both trees).
    let (
        sig,
        pk,
        accessor,
        id_secret,
        id_trapdoor,
        context,
        threshold,
        unlock_after,
        member_siblings,
        member_leaf_index,
        qual_siblings,
        qual_leaf_index,
    ): (
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        u64,
        u64,
        Vec<u8>,
        u32,
        Vec<u8>,
        u32,
    ) = if let Ok(job_path) = std::env::var("ZKORAGE_JOB") {
        let s = fs::read_to_string(&job_path).expect("read ZKORAGE_JOB file");
        let mut lines = s.lines();
        let sig = hex::decode(lines.next().expect("sig line").trim()).expect("sig hex");
        let pk = hex32(lines.next().expect("pk line"));
        let accessor = hex32(lines.next().expect("accessor line"));
        let id_secret = hex32(lines.next().expect("id_secret line"));
        let id_trapdoor = hex32(lines.next().expect("id_trapdoor line"));
        let context = hex32(lines.next().expect("context line"));
        let threshold: u64 = lines.next().expect("threshold line").trim().parse().expect("threshold u64");
        let unlock_after: u64 = lines
            .next()
            .expect("unlock_after line")
            .trim()
            .parse()
            .expect("unlock_after u64");
        let member_siblings =
            hex::decode(lines.next().expect("member_siblings line").trim()).expect("member_siblings hex");
        let member_leaf_index: u32 = lines
            .next()
            .expect("member_leaf_index line")
            .trim()
            .parse()
            .expect("member_leaf_index u32");
        let qual_siblings =
            hex::decode(lines.next().expect("qual_siblings line").trim()).expect("qual_siblings hex");
        let qual_leaf_index: u32 = lines
            .next()
            .expect("qual_leaf_index line")
            .trim()
            .parse()
            .expect("qual_leaf_index u32");
        assert_eq!(sig.len(), 64, "sig must be 64 bytes");
        assert_eq!(member_siblings.len(), TREE_DEPTH * 32, "member_siblings must be depth*32 bytes");
        assert_eq!(qual_siblings.len(), TREE_DEPTH * 32, "qual_siblings must be depth*32 bytes");
        (
            sig,
            pk,
            accessor,
            id_secret,
            id_trapdoor,
            context,
            threshold,
            unlock_after,
            member_siblings,
            member_leaf_index,
            qual_siblings,
            qual_leaf_index,
        )
    } else {
        // Demo identity / context — overridable so an acceptance script can drive specific values.
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
        let context = env32("ZKORAGE_CONTEXT", [0x07u8; 32]);
        let threshold: u64 = std::env::var("ZKORAGE_THRESHOLD")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1_000);
        let unlock_after: u64 = std::env::var("ZKORAGE_UNLOCK_AFTER")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(9_999_999_999);

        // NEW-5: the holder signs DOMAIN ‖ context ‖ accessor; accessor == pk (own key).
        let sk = SigningKey::from_bytes(&holder_seed);
        let accessor = sk.verifying_key().to_bytes();
        let mut signed = Vec::with_capacity(SIG_DOMAIN.len() + 64);
        signed.extend_from_slice(SIG_DOMAIN);
        signed.extend_from_slice(&context);
        signed.extend_from_slice(&accessor);
        let sig = sk.sign(&signed).to_bytes().to_vec();

        let ml = member_leaf(&id_secret, &id_trapdoor);
        let empty_member = member_leaf(&[0u8; 32], &[0u8; 32]);
        let (member_siblings, _mr) = demo_witness(&ml, &empty_member);

        let qc = qual_commitment(&id_secret);
        let empty_qual = [0u8; 32]; // qualifying-tree empty sentinel (matches the backend builder)
        let (qual_siblings, _qr) = demo_witness(&qc, &empty_qual);

        (
            sig,
            accessor.to_vec(),
            accessor.to_vec(),
            id_secret.to_vec(),
            id_trapdoor.to_vec(),
            context.to_vec(),
            threshold,
            unlock_after,
            member_siblings,
            0u32,
            qual_siblings,
            0u32,
        )
    };

    // Compute both roots + the nullifier host-side too (for cross-check / pinning).
    let mr = fold_root(&member_leaf(&arr32(&id_secret), &arr32(&id_trapdoor)), &member_siblings, member_leaf_index);
    let qr = fold_root(&qual_commitment(&arr32(&id_secret)), &qual_siblings, qual_leaf_index);
    let nf = nullifier(&arr32(&id_secret), &arr32(&context));
    eprintln!("[tier] member_root = {}", hex::encode(mr));
    eprintln!("[tier] qual_root   = {}", hex::encode(qr));
    eprintln!("[tier] nullifier   = {}", hex::encode(nf));
    eprintln!("[tier] accessor    = {}", hex::encode(&accessor));

    let env = ExecutorEnv::builder()
        .write(&sig)
        .unwrap()
        .write(&pk)
        .unwrap()
        .write(&accessor)
        .unwrap()
        .write(&id_secret)
        .unwrap()
        .write(&id_trapdoor)
        .unwrap()
        .write(&context)
        .unwrap()
        .write(&threshold)
        .unwrap()
        .write(&unlock_after)
        .unwrap()
        .write(&member_siblings)
        .unwrap()
        .write(&member_leaf_index)
        .unwrap()
        .write(&qual_siblings)
        .unwrap()
        .write(&qual_leaf_index)
        .unwrap()
        .build()
        .unwrap();

    // Fast acceptance check (no proving): execute the guest and observe pass/panic + segment count.
    if std::env::var("ZKORAGE_EXEC_ONLY").is_ok() {
        let exec = default_executor();
        match exec.execute(env, TIER_PREDICATE_ELF) {
            Ok(session) => {
                println!("EXEC_OK: member ∧ qualifying ∧ holder sig OK -> receipt would be produced");
                println!("EXEC segments={}", session.segments.len());
                println!("EXEC journal={}", hex::encode(&session.journal.bytes));
            }
            Err(e) => println!("EXEC_FAIL (no receipt; bad sig / non-member / non-qualifying / malformed): {e}"),
        }
        return;
    }

    eprintln!("[*] proving (STARK) + wrapping (Groth16)... first run pulls the docker image");
    let prover = default_prover();
    let prove_info = prover
        .prove_with_opts(env, TIER_PREDICATE_ELF, &ProverOpts::groth16())
        .expect("groth16 proving failed");
    eprintln!("STATS: {:#?}", prove_info.stats);
    let receipt = prove_info.receipt;

    receipt
        .verify(TIER_PREDICATE_ID)
        .expect("off-chain receipt.verify failed");
    eprintln!("[ok] off-chain receipt.verify passed");

    let seal = encode_seal(&receipt);
    let journal_bytes = receipt.journal.bytes.clone();
    let journal_digest: [u8; 32] = Sha256::digest(&journal_bytes).into();
    let image_id_digest: Digest = TIER_PREDICATE_ID.into();
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
    let out_path = std::env::var("ZKORAGE_OUT").unwrap_or_else(|_| "bundle_tier.json".to_string());
    fs::write(&out_path, &bundle_json).unwrap();

    println!("WROTE {out_path}");
    println!("seal_len       = {}", seal.len());
    println!("image_id       = {image_id_hex}");
    println!("journal_digest = {journal_digest_hex}");
    println!("journal        = {journal_hex}");
}
