// zkorage Confidential Data Room — DR1 "seal" guest (faithful encryption of a document key).
//
// The data owner's self-hosted prover holds the plaintext document and a fresh per-document symmetric
// key `K` (the blob = AEAD_K(plaintext), stored off-chain on R2). This guest **ECIES-seals `K` to a
// recipient's x25519 key IN-GUEST** (the same Option-B mechanism as W7 payroll) and **binds the sealed
// key to the document's identity + ciphertext hash**, so a decrypting recipient is cryptographically
// certain the `K` they recover is the one the prover committed to for *this* blob (faithful disclosure —
// no bait-and-switch). DR1 is **commitment-only** (no attester signature; the value is confidential
// sharing + provable integrity, not third-party truth — that arrives in DR4 zkTLS/zkPDF). The on-chain
// proof verification (DataRoom `put_document`) confirms the stored disclosure is a real guest output.
//
// `K` is PRIVATE (never committed in cleartext). The public journal carries only the document identity,
// the recipient target, the ciphertext hash, and the opaque ECIES disclosure (eph_pub / ct / tag).
use risc0_zkvm::guest::env;
use sha2::{Digest, Sha256};
use x25519_dalek::{x25519, X25519_BASEPOINT_BYTES};

const CLAIM_TYPE_DATAROOM_SEAL: u32 = 8;

// ECIES domain-separation tags (NEW-2 discipline). The recipient opener (backend/SDK) MUST match these.
const DOMAIN_KS: &[u8] = b"zkorage-dataroom-ecies-v1/ks";
const DOMAIN_TAG: &[u8] = b"zkorage-dataroom-seal-v1/tag";

fn main() {
    // Inputs (host writes in this order).
    // `doc_key` (K) is the PRIVATE 32-byte symmetric key the blob is AEAD-sealed under.
    let doc_key: Vec<u8> = env::read();
    // `recipient_pub` is the recipient's x25519 PUBLIC key — the disclosure target.
    let recipient_pub: Vec<u8> = env::read();
    // `content_hash` = sha256(ciphertext blob) — the public fetch-integrity anchor; bound into the tag.
    let content_hash: Vec<u8> = env::read();
    // `room_id` / `doc_id` identify the document (public; bound into the tag so a seal is non-portable).
    let room_id: Vec<u8> = env::read();
    let doc_id: Vec<u8> = env::read();
    // Prover-supplied ephemeral ECIES secret (host generates fresh per proof — MUST be fresh, else the
    // keystream repeats across documents). K is high-entropy, so no blinding is needed for tag hiding.
    let eph_secret: Vec<u8> = env::read();

    let k: [u8; 32] = doc_key.as_slice().try_into().expect("doc_key must be 32 bytes");
    let recipient_arr: [u8; 32] = recipient_pub
        .as_slice()
        .try_into()
        .expect("recipient_pub must be 32 bytes");
    let content_arr: [u8; 32] = content_hash
        .as_slice()
        .try_into()
        .expect("content_hash must be 32 bytes");
    let room_arr: [u8; 32] = room_id.as_slice().try_into().expect("room_id must be 32 bytes");
    let doc_arr: [u8; 32] = doc_id.as_slice().try_into().expect("doc_id must be 32 bytes");
    let eph_sk: [u8; 32] = eph_secret
        .as_slice()
        .try_into()
        .expect("eph_secret must be 32 bytes");

    // In-guest ECIES (Option B): seal K to the recipient. eph_pub = X25519(eph, BASE);
    // shared = X25519(eph, recipient_pub).
    let eph_pub: [u8; 32] = x25519(eph_sk, X25519_BASEPOINT_BYTES);
    let shared: [u8; 32] = x25519(eph_sk, recipient_arr);

    // keystream = sha256(DOMAIN_KS ‖ shared ‖ eph_pub ‖ ctr_be4); ct = K XOR keystream (K is 32 B = 1 block).
    let mut h = Sha256::new();
    h.update(DOMAIN_KS);
    h.update(shared);
    h.update(eph_pub);
    h.update(0u32.to_be_bytes());
    let block: [u8; 32] = h.finalize().into();
    let mut ct = [0u8; 32];
    for i in 0..32 {
        ct[i] = k[i] ^ block[i];
    }

    // Faithful tag = sha256(DOMAIN_TAG ‖ K ‖ content_hash ‖ room_id ‖ doc_id). The recipient recomputes
    // it after decrypt → definitive "faithful ✓" + wrong-key detection, and it binds K to THIS blob +
    // document (a seal for one document is not replayable to another).
    let mut th = Sha256::new();
    th.update(DOMAIN_TAG);
    th.update(k);
    th.update(content_arr);
    th.update(room_arr);
    th.update(doc_arr);
    let tag: [u8; 32] = th.finalize().into();

    // Commit the 229-byte PUBLIC journal. `K` is ABSENT (private). Layout:
    //   result(1) | claim_type(4) | room_id(32) | doc_id(32) | recipient_pub(32) | content_hash(32) |
    //   eph_pub(32) | ct(32) | tag(32)
    let mut journal = Vec::with_capacity(229);
    journal.push(1u8); // result = true (a faithful seal was produced)
    journal.extend_from_slice(&CLAIM_TYPE_DATAROOM_SEAL.to_be_bytes());
    journal.extend_from_slice(&room_arr);
    journal.extend_from_slice(&doc_arr);
    journal.extend_from_slice(&recipient_arr);
    journal.extend_from_slice(&content_arr);
    journal.extend_from_slice(&eph_pub);
    journal.extend_from_slice(&ct);
    journal.extend_from_slice(&tag);
    env::commit_slice(&journal);
}
