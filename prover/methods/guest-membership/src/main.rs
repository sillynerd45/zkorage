//! DR2 — anonymous eligibility + nullifier (the marquee load-bearing ZK). Proves, WITHOUT revealing the
//! identity or WHICH eligible member it is:
//!   * NEW-5 accessor-auth: a holder ed25519 signature over `DOMAIN ‖ room_id ‖ accessor ‖ recipient_pub`,
//!     with the holder key asserted to EQUAL the accessor — an off-chain `require_auth` (gasless, no
//!     accessor reveal/charge on submit; a relayer pays). Locks the grant to the consenting accessor.
//!   * Membership: leaf `id_commitment = sha256(LEAF_TAG ‖ id_secret ‖ id_trapdoor)` folds up a depth-20
//!     sha256 Merkle path to an eligible-set root, recomputed here and committed (the gate pins it against
//!     the room's eligible root). A non-member has no path to the pinned root.
//!   * Nullifier `= sha256(NULLIFIER_TAG ‖ id_secret ‖ room_id)`: external_nullifier = room_id ⇒ one
//!     UNLINKABLE access per identity per room. The gate records it and rejects reuse (#NullifierUsed).
//! Commits a 165-byte journal; id_secret/id_trapdoor/leaf_index stay PRIVATE. ~2 zkVM segments (DR1 Ch0).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use risc0_zkvm::guest::env;
use sha2::{Digest, Sha256};

/// DR2 membership+nullifier journal wire layout (165 bytes, big-endian). The eligible member's identity
/// (id_secret/id_trapdoor/which leaf) is NEVER committed — that is the anonymity property.
///   [0]        result        u8   = 1
///   [1..5]     claim_type     u32  = 9 (dataroom anonymous-eligibility membership)
///   [5..37]    room_id        [u8;32]   (== the external_nullifier; the gate looks up the room by this)
///   [37..69]   eligible_root  [u8;32]   (recomputed from the Merkle path; gate pins == room's root)
///   [69..101]  nullifier      [u8;32]   (gate records / rejects reuse → one access per identity per room)
///   [101..133] accessor       [u8;32]   (ed25519 grant target for is_granted; == the holder signing key)
///   [133..165] recipient_pub  [u8;32]   (x25519 receiving key for the DR3 keypers; bound by NEW-5)
const CLAIM_TYPE_MEMBERSHIP: u32 = 9;
/// Canonical eligible-set Merkle depth — the witness MUST carry exactly this many siblings (binds the
/// proof to the agreed tree size and keeps the index arithmetic overflow-free). Must equal the backend
/// tree builder's depth.
const TREE_DEPTH: usize = 20;
/// Domain-separation tags so a leaf preimage, an internal-node preimage, and a nullifier preimage can
/// never collide (all three hash 32-byte secrets; the tag fixes the domain). Mirrors the W6 IMT discipline.
const LEAF_TAG: u8 = 0x00;
const NODE_TAG: u8 = 0x01;
const NULLIFIER_TAG: u8 = 0x02;
/// Domain prefix for the NEW-5 holder signature (prevents cross-context signature replay; binds the room).
const SIG_DOMAIN: &[u8] = b"zkorage-dataroom-access-v1";

/// Internal Merkle node = sha256(NODE_TAG ‖ left ‖ right).
fn hash_internal(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([NODE_TAG]);
    h.update(a);
    h.update(b);
    h.finalize().into()
}

fn main() {
    // Inputs (written by the host in this exact order). id_secret/id_trapdoor/leaf_index are PRIVATE.
    let sig_bytes: Vec<u8> = env::read(); // 64 — holder ed25519 signature
    let pk_bytes: Vec<u8> = env::read(); // 32 — holder verifying key (asserted == accessor)
    let accessor: Vec<u8> = env::read(); // 32 — public grant target (Stellar account key)
    let recipient_pub: Vec<u8> = env::read(); // 32 — x25519 key the DR3 keypers seal shares to
    let id_secret: Vec<u8> = env::read(); // 32 — PRIVATE
    let id_trapdoor: Vec<u8> = env::read(); // 32 — PRIVATE
    let room_id: Vec<u8> = env::read(); // 32 — external_nullifier; the gate looks up the room
    let siblings: Vec<u8> = env::read(); // TREE_DEPTH * 32 — Merkle path siblings, bottom -> top
    // PRIVATE — low-leaf position; only its low TREE_DEPTH bits drive path direction (bits ≥ depth are
    // unused and never committed). The gateway rejects leaf_index ≥ 2^TREE_DEPTH at the public boundary so a
    // valid-but-out-of-range index can't reach a prover; an in-guest `assert(leaf_index < 2^TREE_DEPTH)` is
    // the belt-and-suspenders production hardening (deferred — it would change the pinned image_id).
    let leaf_index: u32 = env::read();

    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into().expect("pk must be 32 bytes");
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().expect("sig must be 64 bytes");
    let accessor_arr: [u8; 32] = accessor.as_slice().try_into().expect("accessor must be 32 bytes");
    let recipient_arr: [u8; 32] = recipient_pub
        .as_slice()
        .try_into()
        .expect("recipient_pub must be 32 bytes");
    let id_secret_arr: [u8; 32] = id_secret.as_slice().try_into().expect("id_secret must be 32 bytes");
    let id_trapdoor_arr: [u8; 32] = id_trapdoor
        .as_slice()
        .try_into()
        .expect("id_trapdoor must be 32 bytes");
    let room_arr: [u8; 32] = room_id.as_slice().try_into().expect("room_id must be 32 bytes");
    assert_eq!(siblings.len(), TREE_DEPTH * 32, "siblings length must be depth*32");

    // 1) NEW-5 accessor-auth. The holder signs DOMAIN ‖ room_id ‖ accessor ‖ recipient_pub with the
    //    accessor's OWN ed25519 key; asserting pk == accessor makes this an off-chain `require_auth`:
    //    the grant is locked to the accessor whose key consented AND bound recipient_pub, without revealing
    //    or charging the accessor on submit (a relayer pays fees). Panics (=> no receipt) if invalid.
    assert_eq!(pk_arr, accessor_arr, "holder key must equal the accessor (pk == accessor)");
    let vk = VerifyingKey::from_bytes(&pk_arr).expect("invalid holder public key");
    let mut signed = Vec::with_capacity(SIG_DOMAIN.len() + 96);
    signed.extend_from_slice(SIG_DOMAIN);
    signed.extend_from_slice(&room_arr);
    signed.extend_from_slice(&accessor_arr);
    signed.extend_from_slice(&recipient_arr);
    vk.verify(&signed, &Signature::from_bytes(&sig_arr))
        .expect("holder signature verification failed");

    // 2) Membership. leaf = id_commitment = sha256(LEAF_TAG ‖ id_secret ‖ id_trapdoor); fold the depth-20
    //    Merkle path (tagged internal nodes) bottom -> top. The resulting root is committed and pinned
    //    on-chain against the room's eligible-set root, so a forged path (non-member) yields a DIFFERENT
    //    root and is rejected on-chain by SHA-256 preimage resistance. WHICH leaf stays hidden.
    let mut lh = Sha256::new();
    lh.update([LEAF_TAG]);
    lh.update(&id_secret_arr);
    lh.update(&id_trapdoor_arr);
    let mut node: [u8; 32] = lh.finalize().into();
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
    let eligible_root = node;

    // 3) Nullifier = sha256(NULLIFIER_TAG ‖ id_secret ‖ room_id). external_nullifier = room_id ⇒ one
    //    unlinkable access per identity per room: same identity + same room ⇒ same nullifier ⇒ the gate's
    //    second request reverts #NullifierUsed; different rooms ⇒ different nullifiers (cross-room unlinkable).
    let mut nh = Sha256::new();
    nh.update([NULLIFIER_TAG]);
    nh.update(&id_secret_arr);
    nh.update(&room_arr);
    let nullifier: [u8; 32] = nh.finalize().into();

    // 4) Commit the 165-byte PUBLIC journal. id_secret/id_trapdoor/leaf_index are ABSENT (anonymity).
    let mut journal = Vec::with_capacity(165);
    journal.push(1u8); // result = true (eligible member; fresh nullifier candidate)
    journal.extend_from_slice(&CLAIM_TYPE_MEMBERSHIP.to_be_bytes());
    journal.extend_from_slice(&room_arr);
    journal.extend_from_slice(&eligible_root);
    journal.extend_from_slice(&nullifier);
    journal.extend_from_slice(&accessor_arr);
    journal.extend_from_slice(&recipient_arr);
    env::commit_slice(&journal);
}
