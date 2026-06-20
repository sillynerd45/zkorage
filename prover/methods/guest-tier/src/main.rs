//! # tier_predicate (BP5) — anonymous bonded tier / membership expiring at X
//!
//! The second Bonded-Proofs ZK product. Where BP3 (solvency) keeps the ISSUER public and hides the reserve
//! composition, BP5 keeps the MEMBER anonymous: it proves, WITHOUT revealing which wallet, which lock, or
//! the exact amount, that the prover is BOTH an enrolled member AND controls a bonded lock that qualifies
//! for a tier (amount >= threshold, locked until >= X). One unlinkable grant per identity per context.
//!
//! It extends the DR2 membership guest with a SECOND Merkle membership — the qualifying-lock set:
//!   * NEW-5 accessor-auth: a holder ed25519 signature over `DOMAIN ‖ context ‖ accessor`, with the holder
//!     key asserted to EQUAL the accessor (an off-chain `require_auth` — the grant is locked to the
//!     consenting accessor without revealing or charging it on submit; a relayer pays). No `recipient_pub`
//!     here (there is no document to seal, unlike DR2/DR3), so this guest is ed25519+sha256 ONLY and its
//!     image_id reproduces cross-machine (the W8 finding).
//!   * Member membership: leaf `id_commitment = sha256(LEAF_TAG ‖ id_secret ‖ id_trapdoor)` folds up a
//!     depth-20 sha256 Merkle path to `member_root` (the enrolled set; the gate pins it == its config).
//!   * Qualifying membership: `c = sha256(QUAL_TAG ‖ id_secret ‖ ESCROW_LABEL)` is the SAME tag the
//!     depositor stored in the escrow lock's `commitment` field. The prover folds a second depth-20 path
//!     proving `c ∈ qual_root` (the indexer-published Merkle root over the commitments of all locks that
//!     currently satisfy amount >= threshold ∧ unlock_time >= X ∧ still-locked ∧ non-revocable). Knowing
//!     `id_secret` is the only way to derive `c`, so this binds "I am an enrolled member" and "I bonded a
//!     qualifying lock" to the SAME secret, without revealing which lock.
//!   * Nullifier `= sha256(NULLIFIER_TAG ‖ id_secret ‖ context)`: external_nullifier = context ⇒ one
//!     UNLINKABLE grant per identity per context. The gate records it and rejects reuse.
//!
//! Commits a 181-byte journal; id_secret/id_trapdoor/the two leaf indices stay PRIVATE (the anonymity).
//! Freshness is deadline-encoded (`now < X`), which is SOUND because qualifying locks are created
//! non-revocable (no early exit), so "before X" provably means "still funded" — no per-lock read, so the
//! verifier never learns which lock backs the grant.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use risc0_zkvm::guest::env;
use sha2::{Digest, Sha256};

/// BP5 tier-bonded journal wire layout (181 bytes, big-endian). The member's identity
/// (id_secret/id_trapdoor/which leaf in either tree) is NEVER committed — that is the anonymity.
///   [0]         result        u8   = 1
///   [1..5]      claim_type     u32  = 13 (anonymous bonded tier)
///   [5..37]     member_root    [u8;32]  (enrolled-member set; gate pins == its config)
///   [37..69]    qual_root      [u8;32]  (qualifying-lock set for (threshold, X); gate pins ∈ its ring)
///   [69..77]    threshold      u64      (the tier's bonded floor; selects the qual_root ring)
///   [77..85]    unlock_after   u64      (= X; selects the qual_root ring; gate checks now < X)
///   [85..117]   context        [u8;32]  (== the external_nullifier; the nullifier domain / tier label)
///   [117..149]  nullifier      [u8;32]  (gate records / rejects reuse → one grant per identity per context)
///   [149..181]  accessor       [u8;32]  (ed25519 grant target for is_granted; == the holder signing key)
const CLAIM_TYPE_TIER: u32 = 13;
/// Canonical Merkle depth for BOTH trees — each witness MUST carry exactly this many siblings (binds the
/// proof to the agreed tree size and keeps the index arithmetic overflow-free). Must equal the backend
/// tree builders' depth (member set + qualifying set).
const TREE_DEPTH: usize = 20;
/// Domain-separation tags so a member-leaf preimage, an internal-node preimage, a nullifier preimage, and
/// a qualifying-commitment preimage can never collide (all hash 32-byte secrets; the tag fixes the domain).
const LEAF_TAG: u8 = 0x00;
const NODE_TAG: u8 = 0x01;
const NULLIFIER_TAG: u8 = 0x02;
const QUAL_TAG: u8 = 0x03;
/// The fixed label that turns `id_secret` into the escrow `commitment` the depositor stores. The frontend
/// derives the SAME `c = sha256(QUAL_TAG ‖ id_secret ‖ ESCROW_LABEL)` at deposit time, so the indexer can
/// place it as a leaf in `qual_root` and the prover can prove membership in that root.
const ESCROW_LABEL: &[u8] = b"escrow";
/// Domain prefix for the NEW-5 holder signature (prevents cross-context signature replay; binds context).
const SIG_DOMAIN: &[u8] = b"zkorage-tier-bonded-v1";

/// Internal Merkle node = sha256(NODE_TAG ‖ left ‖ right) — shared by both trees (leaves are domain-tagged,
/// so reusing the node tag across trees is unambiguous).
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
    // Inputs (written by the host in this exact order). id_secret/id_trapdoor/both leaf indices are PRIVATE.
    let sig_bytes: Vec<u8> = env::read(); // 64 — holder ed25519 signature
    let pk_bytes: Vec<u8> = env::read(); // 32 — holder verifying key (asserted == accessor)
    let accessor: Vec<u8> = env::read(); // 32 — public grant target (Stellar account key)
    let id_secret: Vec<u8> = env::read(); // 32 — PRIVATE
    let id_trapdoor: Vec<u8> = env::read(); // 32 — PRIVATE
    let context: Vec<u8> = env::read(); // 32 — external_nullifier / tier label
    let threshold: u64 = env::read(); // public tier floor (committed verbatim; gate selects the ring)
    let unlock_after: u64 = env::read(); // = X (committed verbatim; gate checks now < X)
    let member_siblings: Vec<u8> = env::read(); // TREE_DEPTH * 32 — member-set Merkle path, bottom -> top
    // PRIVATE — only the low TREE_DEPTH bits drive path direction; the gateway rejects >= 2^TREE_DEPTH at the
    // public boundary so a valid-but-out-of-range index can't reach a prover.
    let member_leaf_index: u32 = env::read();
    let qual_siblings: Vec<u8> = env::read(); // TREE_DEPTH * 32 — qualifying-set Merkle path, bottom -> top
    let qual_leaf_index: u32 = env::read(); // PRIVATE — low-leaf position in the qualifying tree

    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into().expect("pk must be 32 bytes");
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().expect("sig must be 64 bytes");
    let accessor_arr: [u8; 32] = accessor.as_slice().try_into().expect("accessor must be 32 bytes");
    let id_secret_arr: [u8; 32] = id_secret.as_slice().try_into().expect("id_secret must be 32 bytes");
    let id_trapdoor_arr: [u8; 32] = id_trapdoor
        .as_slice()
        .try_into()
        .expect("id_trapdoor must be 32 bytes");
    let context_arr: [u8; 32] = context.as_slice().try_into().expect("context must be 32 bytes");
    assert_eq!(member_siblings.len(), TREE_DEPTH * 32, "member siblings length must be depth*32");
    assert_eq!(qual_siblings.len(), TREE_DEPTH * 32, "qual siblings length must be depth*32");

    // 1) NEW-5 accessor-auth. The holder signs DOMAIN ‖ context ‖ accessor with the accessor's OWN ed25519
    //    key; asserting pk == accessor makes this an off-chain `require_auth`: the grant is locked to the
    //    accessor whose key consented, without revealing or charging the accessor on submit (a relayer pays
    //    fees). Panics (=> no receipt) if invalid.
    assert_eq!(pk_arr, accessor_arr, "holder key must equal the accessor (pk == accessor)");
    let vk = VerifyingKey::from_bytes(&pk_arr).expect("invalid holder public key");
    let mut signed = Vec::with_capacity(SIG_DOMAIN.len() + 64);
    signed.extend_from_slice(SIG_DOMAIN);
    signed.extend_from_slice(&context_arr);
    signed.extend_from_slice(&accessor_arr);
    vk.verify(&signed, &Signature::from_bytes(&sig_arr))
        .expect("holder signature verification failed");

    // 2) Member membership. leaf = id_commitment = sha256(LEAF_TAG ‖ id_secret ‖ id_trapdoor); fold the
    //    depth-20 path to member_root. A non-member has no path to the pinned root (SHA-256 preimage
    //    resistance). WHICH leaf stays hidden.
    let mut lh = Sha256::new();
    lh.update([LEAF_TAG]);
    lh.update(&id_secret_arr);
    lh.update(&id_trapdoor_arr);
    let member_leaf: [u8; 32] = lh.finalize().into();
    let member_root = fold_root(&member_leaf, &member_siblings, member_leaf_index);

    // 3) Qualifying membership. The qualifying-lock commitment is c = sha256(QUAL_TAG ‖ id_secret ‖
    //    ESCROW_LABEL) — the SAME value the depositor stored in the escrow lock's `commitment`. Fold the
    //    second depth-20 path proving c ∈ qual_root. Only the holder of id_secret can produce c, so this
    //    binds the member to a bonded qualifying lock WITHOUT revealing which lock.
    let mut qh = Sha256::new();
    qh.update([QUAL_TAG]);
    qh.update(&id_secret_arr);
    qh.update(ESCROW_LABEL);
    let qual_leaf: [u8; 32] = qh.finalize().into();
    let qual_root = fold_root(&qual_leaf, &qual_siblings, qual_leaf_index);

    // 4) Nullifier = sha256(NULLIFIER_TAG ‖ id_secret ‖ context). external_nullifier = context ⇒ one
    //    unlinkable grant per identity per context: same identity + same context ⇒ same nullifier ⇒ the
    //    gate's second submit reverts #NullifierUsed; different contexts ⇒ different nullifiers (unlinkable).
    let mut nh = Sha256::new();
    nh.update([NULLIFIER_TAG]);
    nh.update(&id_secret_arr);
    nh.update(&context_arr);
    let nullifier: [u8; 32] = nh.finalize().into();

    // 5) Commit the 181-byte PUBLIC journal. id_secret/id_trapdoor/both leaf indices are ABSENT (anonymity).
    let mut journal = Vec::with_capacity(181);
    journal.push(1u8); // result = true (enrolled member ∧ bonded qualifying lock ∧ fresh nullifier candidate)
    journal.extend_from_slice(&CLAIM_TYPE_TIER.to_be_bytes());
    journal.extend_from_slice(&member_root);
    journal.extend_from_slice(&qual_root);
    journal.extend_from_slice(&threshold.to_be_bytes());
    journal.extend_from_slice(&unlock_after.to_be_bytes());
    journal.extend_from_slice(&context_arr);
    journal.extend_from_slice(&nullifier);
    journal.extend_from_slice(&accessor_arr);
    env::commit_slice(&journal);
}
