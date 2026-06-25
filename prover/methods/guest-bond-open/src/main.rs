//! # bond_open_predicate (Room Management — TRUE bond-only Bonded Access)
//!
//! The "no-approval" sibling of `bond_predicate`. Where `bond_predicate` (claim_type 14) binds a member
//! tree (so a bond proof ALSO proves room membership — "Option A", which forces the reader to be approved),
//! this guest DROPS the member tree entirely and ADDS a proof-bound `recipient_pub`. So a reader who locked
//! a qualifying NON-revocable bond can open a room's documents with NO owner approval and NO membership
//! enrollment, while the DR3 keepers still seal the document key to a key they can trust.
//!
//! It proves, WITHOUT revealing which wallet, which lock, or the exact amount, that the prover controls a
//! bonded lock that qualifies for the requirement:
//!   * NEW-5 accessor-auth: a holder ed25519 signature over `DOMAIN ‖ context ‖ accessor ‖ recipient_pub`,
//!     with the holder key asserted to EQUAL the accessor (an off-chain `require_auth`; a relayer pays so
//!     the accessor is never charged/revealed on submit). Binding `recipient_pub` here is what lets the
//!     keepers seal the key to it safely even though the accessor is public on-chain — the recipient key is
//!     part of the signed, committed statement, so it can never be swapped for an attacker's key.
//!   * Qualifying membership: `c = sha256(QUAL_TAG ‖ id_secret ‖ ESCROW_LABEL)` is the SAME tag the depositor
//!     stored in the escrow lock's `commitment` (identical to `bond_predicate`). The prover folds a depth-20
//!     path proving `c ∈ qual_root` (the indexer-published root over every lock that currently satisfies
//!     `token == req.token ∧ amount >= req.min_amount ∧ unlock_time >= req.deadline ∧ still-locked ∧
//!     non-revocable`). Knowing `id_secret` is the only way to derive `c`, so the proof binds "I bonded a
//!     qualifying lock" without revealing which lock. Anonymity = the qualifying crowd for this `req_id`.
//!   * Nullifier `= sha256(NULLIFIER_TAG ‖ id_secret ‖ context)`: external_nullifier = context, the gate
//!     enforces `context == req_id` and keeps a SEPARATE nullifier keyspace from `bond_predicate`, so the
//!     two paths never collide and there is one UNLINKABLE bond-open grant per identity per requirement.
//!
//! Commits a 221-byte journal; id_secret/id_trapdoor/the qual leaf index stay PRIVATE (the anonymity).
//! Freshness is deadline-encoded (`now < deadline`), SOUND because qualifying locks are non-revocable.
//! `req_id = sha256(journal[37..93])` (token ‖ min_amount ‖ deadline) is byte-identical to the span
//! `bond_predicate` hashes, so the SAME indexer-published `qual_root`/ring applies to both. ed25519+sha256
//! ONLY ⇒ the image_id reproduces cross-machine.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use risc0_zkvm::guest::env;
use sha2::{Digest, Sha256};

/// bond-open journal wire layout (221 bytes, big-endian). The member's identity (id_secret/id_trapdoor/which
/// qual leaf) is NEVER committed — that is the anonymity. token + min_amount + deadline sit contiguously at
/// [37..93] so the gate computes `req_id = sha256(journal[37..93])` (the SAME bytes `bond_predicate` hashes).
///   [0]         result        u8   = 1
///   [1..5]      claim_type     u32  = 15 (TRUE bond-only Bonded Access)
///   [5..37]     qual_root      [u8;32]  (qualifying-lock set for the requirement; gate pins ∈ its ring)
///   [37..69]    token          [u8;32]  (the bond token's 32-byte contract id; component of req_id)
///   [69..85]    min_amount     i128 (16 BE)  (the requirement's minimum amount; component of req_id)
///   [85..93]    deadline       u64  (8 BE)   (= the freshness boundary; gate checks now < deadline)
///   [93..125]   context        [u8;32]  (== external_nullifier; gate enforces context == req_id)
///   [125..157]  nullifier      [u8;32]  (gate records / rejects reuse → one grant per identity per req)
///   [157..189]  accessor       [u8;32]  (ed25519 grant target; == the holder signing key)
///   [189..221]  recipient_pub  [u8;32]  (x25519 receiving key for the DR3 keypers; bound by NEW-5)
const CLAIM_TYPE_BOND_OPEN: u32 = 15;
/// Canonical Merkle depth for the qualifying tree — the witness MUST carry exactly this many siblings.
const TREE_DEPTH: usize = 20;
/// Domain-separation tags (shared with `bond_predicate`): an internal-node preimage, a nullifier preimage,
/// and a qualifying-commitment preimage can never collide (all hash 32-byte secrets; the tag fixes the
/// domain).
const NODE_TAG: u8 = 0x01;
const NULLIFIER_TAG: u8 = 0x02;
const QUAL_TAG: u8 = 0x03;
/// The fixed label that turns `id_secret` into the escrow `commitment` the depositor stores — IDENTICAL to
/// `bond_predicate`, so a single bonded lock qualifies for BOTH paths (the qual sets merge by req_id).
const ESCROW_LABEL: &[u8] = b"escrow";
/// Domain prefix for the NEW-5 holder signature. DISTINCT from `bond_predicate`'s (`zkorage-bond-access-v1`)
/// and DR2's (`zkorage-dataroom-access-v1`), so a signature for one context can never be replayed as another.
const SIG_DOMAIN: &[u8] = b"zkorage-bond-open-v1";

/// Internal Merkle node = sha256(NODE_TAG ‖ left ‖ right).
fn hash_internal(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([NODE_TAG]);
    h.update(a);
    h.update(b);
    h.finalize().into()
}

/// Fold a leaf up a depth-20 Merkle path (siblings bottom -> top) using `leaf_index`'s low bits for
/// direction, returning the recomputed root.
fn fold_root(leaf: &[u8; 32], siblings: &[u8], leaf_index: u32) -> [u8; 32] {
    let mut node = *leaf;
    for i in 0..TREE_DEPTH {
        let off = i * 32;
        let sib: [u8; 32] = siblings[off..off + 32].try_into().unwrap();
        let bit = (leaf_index >> i) & 1;
        node = if bit == 0 {
            hash_internal(&node, &sib)
        } else {
            hash_internal(&sib, &node)
        };
    }
    node
}

fn main() {
    // Inputs (written by the host in this exact order). id_secret/id_trapdoor/the qual leaf index are PRIVATE.
    let sig_bytes: Vec<u8> = env::read(); // 64 — holder ed25519 signature
    let pk_bytes: Vec<u8> = env::read(); // 32 — holder verifying key (asserted == accessor)
    let accessor: Vec<u8> = env::read(); // 32 — public grant target (Stellar account key)
    let recipient_pub: Vec<u8> = env::read(); // 32 — x25519 key the DR3 keypers seal shares to
    let id_secret: Vec<u8> = env::read(); // 32 — PRIVATE
    let id_trapdoor: Vec<u8> = env::read(); // 32 — PRIVATE (kept in the witness for identity parity; unused here)
    let context: Vec<u8> = env::read(); // 32 — external_nullifier (gate enforces == req_id)
    let token: Vec<u8> = env::read(); // 32 — the bond token's contract id (committed verbatim)
    // 16 — min_amount as i128 big-endian bytes (committed verbatim; the gate parses i128 + selects the ring).
    let min_amount: Vec<u8> = env::read();
    let deadline: u64 = env::read(); // requirement deadline (committed verbatim; gate checks now < deadline)
    let qual_siblings: Vec<u8> = env::read(); // TREE_DEPTH * 32 — qualifying-set Merkle path, bottom -> top
    let qual_leaf_index: u32 = env::read(); // PRIVATE — low-leaf position in the qualifying tree

    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into().expect("pk must be 32 bytes");
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().expect("sig must be 64 bytes");
    let accessor_arr: [u8; 32] = accessor.as_slice().try_into().expect("accessor must be 32 bytes");
    let recipient_arr: [u8; 32] = recipient_pub
        .as_slice()
        .try_into()
        .expect("recipient_pub must be 32 bytes");
    let id_secret_arr: [u8; 32] = id_secret.as_slice().try_into().expect("id_secret must be 32 bytes");
    let _id_trapdoor_arr: [u8; 32] = id_trapdoor
        .as_slice()
        .try_into()
        .expect("id_trapdoor must be 32 bytes");
    let context_arr: [u8; 32] = context.as_slice().try_into().expect("context must be 32 bytes");
    let token_arr: [u8; 32] = token.as_slice().try_into().expect("token must be 32 bytes");
    let min_amount_arr: [u8; 16] = min_amount.as_slice().try_into().expect("min_amount must be 16 bytes");
    assert_eq!(qual_siblings.len(), TREE_DEPTH * 32, "qual siblings length must be depth*32");

    // 1) NEW-5 accessor-auth. The holder signs DOMAIN ‖ context ‖ accessor ‖ recipient_pub with the
    //    accessor's OWN ed25519 key; asserting pk == accessor makes this an off-chain `require_auth` and
    //    binds the recipient key into the consented statement (so the keepers can seal to it). Panics (=> no
    //    receipt) if the signature is bad.
    assert_eq!(pk_arr, accessor_arr, "holder key must equal the accessor (pk == accessor)");
    let vk = VerifyingKey::from_bytes(&pk_arr).expect("invalid holder public key");
    let mut signed = Vec::with_capacity(SIG_DOMAIN.len() + 96);
    signed.extend_from_slice(SIG_DOMAIN);
    signed.extend_from_slice(&context_arr);
    signed.extend_from_slice(&accessor_arr);
    signed.extend_from_slice(&recipient_arr);
    vk.verify(&signed, &Signature::from_bytes(&sig_arr))
        .expect("holder signature verification failed");

    // 2) Qualifying membership. c = sha256(QUAL_TAG ‖ id_secret ‖ ESCROW_LABEL) — the SAME value the depositor
    //    stored in the escrow lock's `commitment`. Fold the depth-20 path proving c ∈ qual_root. Only the
    //    holder of id_secret can produce c, so this binds the member to a bonded qualifying lock WITHOUT
    //    revealing which lock.
    let mut qh = Sha256::new();
    qh.update([QUAL_TAG]);
    qh.update(&id_secret_arr);
    qh.update(ESCROW_LABEL);
    let qual_leaf: [u8; 32] = qh.finalize().into();
    let qual_root = fold_root(&qual_leaf, &qual_siblings, qual_leaf_index);

    // 3) Nullifier = sha256(NULLIFIER_TAG ‖ id_secret ‖ context). external_nullifier = context (the gate
    //    enforces context == req_id) ⇒ one unlinkable bond-open grant per identity per requirement.
    let mut nh = Sha256::new();
    nh.update([NULLIFIER_TAG]);
    nh.update(&id_secret_arr);
    nh.update(&context_arr);
    let nullifier: [u8; 32] = nh.finalize().into();

    // 4) Commit the 221-byte PUBLIC journal. id_secret/id_trapdoor/the qual leaf index are ABSENT (anonymity).
    let mut journal = Vec::with_capacity(221);
    journal.push(1u8); // result = true (bonded qualifying lock ∧ holder sig ∧ fresh nullifier candidate)
    journal.extend_from_slice(&CLAIM_TYPE_BOND_OPEN.to_be_bytes());
    journal.extend_from_slice(&qual_root);
    journal.extend_from_slice(&token_arr);
    journal.extend_from_slice(&min_amount_arr);
    journal.extend_from_slice(&deadline.to_be_bytes());
    journal.extend_from_slice(&context_arr);
    journal.extend_from_slice(&nullifier);
    journal.extend_from_slice(&accessor_arr);
    journal.extend_from_slice(&recipient_arr);
    env::commit_slice(&journal);
}
