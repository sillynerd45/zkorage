//! # zkorage Confidential Data Room contract (DR1 — data plane)
//!
//! The on-chain registry for a confidential data room. Phase DR1 (this scaffold + DR1 Chunk 1) is the
//! **data plane**: an owner creates a room, and documents are anchored as `(commitment, content_hash,
//! blob_pointer, recipient_pub)` — the ciphertext itself lives off-chain (Cloudflare R2) and is only
//! ever stored encrypted. Later slices extend this SAME contract in place (Soroban native upgrade,
//! storage preserved — add `DataKey`s, never retype):
//!   * **DR2** — per-room eligible-set Merkle `root` + a **nullifier set** (anonymous eligibility grant).
//!   * **DR3** — grant/recipient bindings the off-chain threshold-ECIES keyper committee watches.
//!   * **DR4** — bind a proven fact (signed-PDF / zkTLS) to a document.
//!   * **DR5** — a **teaser**: a public, ZK-verified fact about a SEALED document (`figure ≥ X`, doc unseen),
//!     vouched by an allowlisted appraiser; the auditor "redacted view" reuses `put_document` (seal to the
//!     auditor's key). No new guest — the teaser reuses the generic value≥threshold guest (claim_type 11).
//!
//! Like every zkorage gate, this contract does NOT re-implement Groth16: it **cross-calls the bare,
//! immutable [`RiscZeroVerifierClient`]** (Week 1, image-agnostic) and adds the data-room policy.
//!
//! ## Scope (DR1 scaffold)
//! `initialize` / `create_room` / reads / admin (`set_verifier` / `set_image_id` / `upgrade`).
//! `put_document` (which verifies the faithful-encryption proof and anchors a document) lands in DR1
//! Chunk 1 alongside the seal guest — its journal layout is pinned byte-exact across guest/contract/
//! backend/SDK/frontend at that point, so it is intentionally not stubbed with a fake unverified path.
//! **Unaudited — demo only.**

#![no_std]

use risc0_interface::RiscZeroVerifierClient;
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, Address, Bytes, BytesN, Env,
};

/// Seal journal wire layout (229 bytes, big-endian), committed by the DR1 seal guest. `K` is ABSENT.
///   [0]        result       u8   (1)
///   [1..5]     claim_type   u32  (8 = dataroom seal)
///   [5..37]    room_id      [u8;32]
///   [37..69]   doc_id       [u8;32]
///   [69..101]  recipient_pub[u8;32]
///   [101..133] content_hash [u8;32]
///   [133..165] eph_pub      [u8;32]
///   [165..197] ct           [u8;32]
///   [197..229] tag          [u8;32]
const JOURNAL_LEN: u32 = 229;

/// DR2 membership journal wire layout (165 bytes, big-endian), committed by the membership guest. The
/// eligible member's identity (id_secret/id_trapdoor/which leaf) is ABSENT — that is the anonymity.
///   [0]        result        u8   (1)
///   [1..5]     claim_type     u32  (9 = dataroom anonymous-eligibility membership)
///   [5..37]    room_id        [u8;32]  (which room; == the external_nullifier)
///   [37..69]   eligible_root  [u8;32]  (Merkle root the proof checked; pinned == room's EligibleRoot)
///   [69..101]  nullifier      [u8;32]  (one access per identity per room; recorded, reuse rejected)
///   [101..133] accessor       [u8;32]  (ed25519 grant target; == the in-guest holder signing key)
///   [133..165] recipient_pub  [u8;32]  (x25519 key the DR3 keypers seal shares to; bound by NEW-5)
const MEMBERSHIP_JOURNAL_LEN: u32 = 165;
/// Claim type the membership guest commits (PoR=2/KYC=3/compliance=4/payroll=5/revenue=6/accredited=7/
/// dataroom-seal=8/membership=9). Fixed in code (the contract pins it); the seal claim_type lives in Config.
const CLAIM_TYPE_MEMBERSHIP: u32 = 9;

/// DR4 document-authenticity journal wire layout (113 bytes, big-endian), committed by the docauth guest.
/// The signed statement / account / exact value are ABSENT — only the predicate result is revealed.
///   [0]        result          u8   (1)
///   [1..5]     claim_type       u32  (10 = dataroom document-authenticity)
///   [5..9]     field_tag        u32  (which field; 1 = account balance)
///   [9..17]    threshold        u64  (public floor X; value ≥ X proven)
///   [17..49]   issuer_key_hash  [u8;32]  (sha256(n) — WHICH third-party RSA issuer signed; pinned allowlist)
///   [49..81]   room_id          [u8;32]  (the DataRoom room the fact is bound to)
///   [81..113]  msg_digest       [u8;32]  (sha256(statement) — binds the fact to the EXACT signed document)
const DOCAUTH_JOURNAL_LEN: u32 = 113;
/// Claim type the docauth guest commits (10). Fixed in code; the contract pins it.
const CLAIM_TYPE_DOCAUTH: u32 = 10;

/// DR5 teaser journal wire layout (61 bytes, big-endian) — the SAME journal the generic value≥threshold
/// guest (`prover/methods/guest`) commits. DR5 reuses that guest UNCHANGED (no new guest): a dedicated
/// "data-room appraiser" attester ed25519-signs an envelope `{claim_type=11, value, issuer_id, nonce, expiry}`
/// where `nonce` carries the field id, and the guest proves `value ≥ threshold` while keeping `value` private.
///   [0]       result      u8   (1 = value ≥ threshold)
///   [1..5]    claim_type   u32  (11 = data-room teaser)
///   [5..37]   issuer_id    [u8;32]  (the appraiser attester's ed25519 public key; allowlisted = the anchor)
///   [37..45]  threshold    u64  (public floor X; value ≥ X proven, value ABSENT)
///   [45..53]  nonce        u64  (the attester-signed field id; low 32 bits read as `field_tag`)
///   [53..61]  expiry       u64  (teaser freshness; reject already-expired)
const TEASER_JOURNAL_LEN: u32 = 61;
/// Claim type the teaser commits (11). The generic guest is claim_type-agnostic (it commits whatever the
/// envelope was signed with); the appraiser signs `claim_type = 11`, and the contract pins it — so a
/// fundraise revenue proof (claim_type 6) over the same guest can NOT be ingested as a teaser.
const CLAIM_TYPE_TEASER: u32 = 11;

// ~5s ledgers. Keep config + rooms + documents comfortably alive for the demo window.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP: u32 = 30 * DAY_IN_LEDGERS;
const THRESHOLD: u32 = BUMP - DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DataRoomError {
    // 1..=10 mirror the zkorage gate's proof/policy errors (DR1 Chunk 1 `put_document` uses 3..=9).
    NotInitialized = 1,
    AlreadyInitialized = 2,
    ImageMismatch = 3,
    MalformedJournal = 4,
    ProofInvalid = 5,
    ResultNotTrue = 6,
    ClaimTypeMismatch = 7,
    IssuerNotAllowed = 8,
    Expired = 9,
    NotAdmin = 10,
    // 11.. — data-room specific (stable across upgrades).
    RoomExists = 11,
    RoomNotFound = 12,
    NotRoomOwner = 13,
    DocExists = 14,
    // 15.. — DR2 anonymous-eligibility (membership + nullifier). Added in-place by the DR2 upgrade.
    NullifierUsed = 15,
    EligibleRootMismatch = 16,
    EligibleRootNotSet = 17,
    // 18.. — DR4 document-authenticity (zkPDF / signed-statement fact). Added in-place by the DR4 upgrade.
    // (Issuer-not-allowlisted reuses the gate-style `IssuerNotAllowed = 8`; image-not-pinned reuses
    // `ImageMismatch = 3` fail-closed, mirroring `request_access`.)
    DocFactExists = 18,
    // 19.. — DR5 faithful disclosure / data-side teaser. Added in-place by the DR5 upgrade. (Teaser-attester
    // not allowlisted reuses `IssuerNotAllowed = 8`; image-not-pinned reuses `ImageMismatch = 3` fail-closed;
    // an already-expired teaser reuses `Expired = 9`.)
    TeaserExists = 19,
    DocNotFound = 20,
    // 21.. — DR6 private-policy composition + revocation/rotation. Added in-place by the DR6 upgrade.
    /// The room has no composite-admission policy set yet.
    RoomPolicyNotSet = 21,
    /// The accessor lacks a currently-valid DR2 membership grant (the anonymity spine; stale-root or revoked).
    MembershipRequired = 22,
    /// The policy requires the compliance (KYC ∧ not-sanctioned) leg and the accessor is not granted on it.
    NotCompliant = 23,
    /// The policy requires the accredited leg and the accessor is not granted on it.
    NotAccredited = 24,
    /// The accessor has been revoked in this room (`revoke_access`).
    AccessRevoked = 25,
    /// No committee document exists at (room_id, doc_id) to rotate.
    CommitteeDocNotFound = 26,
    /// `set_room_policy`: a policy with no membership spine AND no gates would admit everyone (an
    /// unintentionally-open room); rejected so the anonymity-eligibility model can't be fat-fingered away.
    EmptyPolicy = 27,
    // 28.. — BA1 Bonded Access. Added in place by the BA1 upgrade.
    /// `set_bond_requirement` / `set_doc_bond_requirement`: a non-positive `min_amount` is not a bond claim.
    BadBondRequirement = 28,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    /// A room keyed by its 32-byte room_id (persistent). Presence == room exists.
    Room(BytesN<32>),
    /// Total number of rooms created (instance).
    RoomCount,
    /// A document keyed by (room_id, doc_id) (persistent). Presence == document anchored. (DR1 Ch1)
    Doc(BytesN<32>, BytesN<32>),
    /// Number of documents anchored in a room (persistent). (DR1 Ch1)
    DocCount(BytesN<32>),
    /// The i-th document id in a room's append-only log (persistent). (DR1 Ch1)
    DocLog(BytesN<32>, u32),
    // ---- DR2 (anonymous eligibility) — added in place; the DR1 Config is left untouched (no retype) ----
    /// The canonical membership guest image_id (admin-pinned). Separate from `Config.seal_image_id` so the
    /// DR1 Config struct keeps its exact stored shape across the upgrade. Absence ⇒ membership not enabled.
    MembershipImageId,
    /// A room's pinned eligible-set Merkle root (persistent). Set by the room owner; absence ⇒ no eligible
    /// set yet. Re-pinning rotates the set and (via `is_granted`) revokes grants proven against the old root.
    EligibleRoot(BytesN<32>),
    /// A spent nullifier in a room (persistent). Presence ⇒ used ⇒ a second access from the same identity
    /// is rejected (`NullifierUsed`).
    Nullifier(BytesN<32>, BytesN<32>),
    /// An access grant for (room_id, accessor) (persistent). Presence ⇒ access granted to this accessor.
    Grant(BytesN<32>, BytesN<32>),
    /// Number of access grants in a room's append-only grant log (persistent).
    GrantCount(BytesN<32>),
    /// The i-th access grant (by accessor) in a room's append-only grant log (persistent).
    GrantLog(BytesN<32>, u32),
    // ---- DR3 (threshold-ECIES committee documents) — added in place; existing keys untouched ----
    /// A committee-released document keyed by (room_id, doc_id) (persistent). Presence == anchored. Unlike a
    /// DR1 `Doc` (a single-recipient ECIES seal), a committee document carries NO on-chain key material: its
    /// key K is Shamir-split off-chain to the threshold keyper committee. It records only the ciphertext
    /// `content_hash` + a `sha256(K)` commitment + the off-chain pointer; the anonymous ACCESS decision is
    /// the DR2 grant. Separate keyspace from `Doc`, so a committee doc and a DR1 doc may reuse a doc_id.
    CommitteeDoc(BytesN<32>, BytesN<32>),
    /// Number of committee documents anchored in a room (persistent).
    CommitteeDocCount(BytesN<32>),
    /// The i-th committee document id in a room's append-only committee-doc log (persistent).
    CommitteeDocLog(BytesN<32>, u32),
    // ---- DR4 (document-authenticity: signed-PDF / zkPDF fact) — added in place; existing keys untouched ----
    /// The canonical DR4 docauth guest image_id (admin-pinned, instance). Separate from `Config.seal_image_id`
    /// and `MembershipImageId` so the existing stored shapes are preserved. Absence ⇒ docauth disabled
    /// (fail-closed: `attest_document_fact` rejects every proof with `ImageMismatch`).
    DocAuthImageId,
    /// An allowlisted third-party issuer, keyed by `issuer_key_hash = sha256(RSA modulus n)` (persistent).
    /// Presence ⇒ accepted (a KNOWN bank/issuer key). This is what makes the fact "third-party truth": a
    /// self-minted RSA key is rejected. Managed by the admin (`set_docauth_issuer`).
    DocAuthIssuer(BytesN<32>),
    /// A proven document fact keyed by (room_id, msg_digest) (persistent). Presence ⇒ a fact is anchored for
    /// this exact document. `msg_digest = sha256(statement)` binds it to the specific signed bytes.
    DocFact(BytesN<32>, BytesN<32>),
    /// Number of document facts anchored in a room (persistent).
    DocFactCount(BytesN<32>),
    /// The i-th document-fact msg_digest in a room's append-only fact log (persistent).
    DocFactLog(BytesN<32>, u32),
    // ---- DR5 (faithful disclosure / data-side teaser) — added in place; existing keys untouched ----
    /// The canonical DR5 teaser guest image_id (admin-pinned, instance) — the generic value≥threshold guest
    /// reused unchanged. Separate from the other image pins so the stored shapes are preserved. Absence ⇒
    /// teaser disabled (fail-closed: `attest_teaser` rejects every proof with `ImageMismatch`).
    TeaserImageId,
    /// An allowlisted "data-room appraiser" teaser attester, keyed by its ed25519 public key (= the journal's
    /// `issuer_id`) (persistent). Presence ⇒ accepted. This is the third-party-truth anchor for a teaser: a
    /// self-minted attester key is rejected, so the public fact is vouched by a KNOWN appraiser, not the owner.
    TeaserAttester(BytesN<32>),
    /// A teaser fact keyed by (room_id, doc_id) (persistent). Presence ⇒ a public, ZK-verified fact (the
    /// sealed document's figure ≥ threshold) is advertised for this document — without revealing the document.
    Teaser(BytesN<32>, BytesN<32>),
    /// Number of teasers anchored in a room (persistent).
    TeaserCount(BytesN<32>),
    /// The i-th teaser's doc_id in a room's append-only teaser log (persistent).
    TeaserLog(BytesN<32>, u32),
    // ---- DR6 (private-policy composition + revocation/rotation) — added in place; existing keys untouched ----
    /// A room's composite-admission policy (persistent); absence ⇒ admission fails closed (`RoomPolicyNotSet`).
    RoomPolicy(BytesN<32>),
    /// A revoked accessor in a room (persistent); presence ⇒ `is_granted` false (keypers refuse) + not admitted.
    Revoked(BytesN<32>, BytesN<32>),
    /// A composite-policy admission record for (room_id, accessor) (persistent; audit). `is_admitted` is live.
    Admission(BytesN<32>, BytesN<32>),
    /// Number of admissions in a room's append-only admission log (persistent).
    AdmissionCount(BytesN<32>),
    /// The i-th admitted accessor in a room's append-only admission log (persistent).
    AdmissionLog(BytesN<32>, u32),
    /// A committee document's key-rotation epoch (persistent), keyed by (room, doc); absent ⇒ 0. Bumped on rotate.
    KeyEpoch(BytesN<32>, BytesN<32>),
    // ---- Pattern 2: prove-a-policy self-serve, PER-DOCUMENT access policy — added in place ----
    /// A per-document composite-admission policy (persistent), keyed by (room, doc). Reuses the `RoomPolicy`
    /// struct. Absence ⇒ access for THIS committee document falls back to the room policy, then (if neither
    /// is set) to the bare DR2 membership grant — see `is_doc_admitted`. Set by the room owner.
    DocPolicy(BytesN<32>, BytesN<32>),
    // ---- BA1 Bonded Access (anonymous per-requirement bond gating) — added in place; existing keys untouched ----
    /// A room-level anonymous Bonded Access requirement (persistent), keyed by room. A SEPARATE struct +
    /// key (NOT a `RoomPolicy` field) so the existing stored `RoomPolicy` shape is preserved across this
    /// in-place upgrade. When set, the bond leg REPLACES the DR2 membership spine for the room's documents
    /// (the bond proof's `member_root` is the room's eligible_root, so it implies membership — see
    /// `is_doc_admitted`). Set by the room owner.
    BondReq(BytesN<32>),
    /// A per-document Bonded Access requirement (persistent), keyed by (room, doc). Overrides `BondReq(room)`
    /// for that committee document. Set by the room owner.
    BondReqDoc(BytesN<32>, BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    /// The bare RISC Zero Groth16 verifier (Week 1, image-agnostic).
    pub verifier: Address,
    /// The canonical DR1 "seal" guest image_id (faithful-encryption proof). Pinned for soundness.
    pub seal_image_id: BytesN<32>,
    /// Claim type for the data-room seal predicate (8; PoR=2/KYC=3/compliance=4/payroll=5/revenue=6/
    /// accredited=7).
    pub claim_type: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Room {
    /// Creation order (0-based).
    pub index: u32,
    pub room_id: BytesN<32>,
    /// The account that created the room (authenticated at creation).
    pub owner: Address,
    pub ledger: u32,
    pub timestamp: u64,
}

/// A document anchor. The ciphertext lives off-chain (R2); only these commitments + the ECIES
/// disclosure are on-chain. Written by `put_document` from a verified DR1 seal proof.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Document {
    /// Position in the room's append-only document log (0-based).
    pub index: u32,
    pub room_id: BytesN<32>,
    pub doc_id: BytesN<32>,
    /// The x25519 public key the document key K is ECIES-sealed to (DR1 single recipient; DR3 keypers).
    pub recipient_pub: BytesN<32>,
    /// sha256 of the stored ciphertext blob (lets a fetcher verify the bytes regardless of where
    /// R2/IPFS served them from); bound into the faithful tag.
    pub content_hash: BytesN<32>,
    /// ECIES ephemeral public key (recipient recomputes the shared secret from this).
    pub eph_pub: BytesN<32>,
    /// ECIES ciphertext of the 32-byte document key K (recipient XORs the keystream to recover K).
    pub ct: BytesN<32>,
    /// Faithful tag = sha256(DOMAIN ‖ K ‖ content_hash ‖ room_id ‖ doc_id); recipient recomputes after
    /// decrypt to confirm K is the attested key for THIS blob (no bait-and-switch).
    pub tag: BytesN<32>,
    /// Opaque off-chain pointer (e.g. an R2 object key or an IPFS CID), as raw bytes. NOT in the proof
    /// (the blob is content-addressed by `content_hash`); supplied by the owner and stored for retrieval.
    pub blob_pointer: Bytes,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct RoomCreated {
    #[topic]
    pub room_id: BytesN<32>,
    pub owner: Address,
    pub index: u32,
}

#[contractevent]
pub struct DocumentAnchored {
    #[topic]
    pub room_id: BytesN<32>,
    #[topic]
    pub doc_id: BytesN<32>,
    pub recipient_pub: BytesN<32>,
    pub content_hash: BytesN<32>,
    pub index: u32,
}

/// A DR2 anonymous-eligibility access grant. Written by `request_access` from a verified membership proof.
/// The grant reveals neither the member's identity nor WHICH eligible leaf they are — only the pseudonymous
/// `accessor` (and the `recipient_pub` the DR3 keypers will seal the key to). `eligible_root` records which
/// set snapshot it was proven against, so re-pinning the root revokes it (see `is_granted`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Grant {
    /// Position in the room's append-only grant log (0-based).
    pub index: u32,
    pub room_id: BytesN<32>,
    /// The ed25519 account access is granted to (the in-guest holder signature bound it; not on-chain auth'd).
    pub accessor: BytesN<32>,
    /// The x25519 receiving key the DR3 threshold-ECIES keypers will seal the document key to (bound by NEW-5).
    pub recipient_pub: BytesN<32>,
    /// The eligible-set Merkle root this grant was verified against (provenance + revocation anchor).
    pub eligible_root: BytesN<32>,
    /// The spent nullifier (audit; the per-room nullifier set also records presence).
    pub nullifier: BytesN<32>,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct AccessGranted {
    #[topic]
    pub room_id: BytesN<32>,
    #[topic]
    pub accessor: BytesN<32>,
    pub nullifier: BytesN<32>,
    pub eligible_root: BytesN<32>,
    pub index: u32,
}

/// A DR3 committee document. The document key `K` is Shamir-split off-chain to the threshold keyper
/// committee (no single party holds it); on-chain we keep only the ciphertext `content_hash`, a `sha256(K)`
/// commitment (lets the recipient verify their reconstruction BEFORE downloading the blob), and the
/// off-chain `blob_pointer`. There is NO ECIES seal and NO single recipient here — the committee releases
/// shares of `K` (each sealed to the proof-bound `recipient_pub`) only to whoever wins the DR2 grant.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitteeDocument {
    /// Position in the room's append-only committee-doc log (0-based).
    pub index: u32,
    pub room_id: BytesN<32>,
    pub doc_id: BytesN<32>,
    /// sha256 of the stored ciphertext blob (fetch + verify the bytes regardless of where they were served).
    pub content_hash: BytesN<32>,
    /// sha256(K) — a hiding-enough commitment (K is 32 high-entropy bytes) to the document key the committee
    /// holds shares of; the recipient checks `sha256(reconstructed K) == k_commitment` before AEAD-decrypt.
    pub k_commitment: BytesN<32>,
    /// Opaque off-chain pointer (R2 object key / IPFS CID), as raw bytes; the blob is content-addressed.
    pub blob_pointer: Bytes,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct CommitteeDocumentAnchored {
    #[topic]
    pub room_id: BytesN<32>,
    #[topic]
    pub doc_id: BytesN<32>,
    pub content_hash: BytesN<32>,
    pub k_commitment: BytesN<32>,
    pub index: u32,
}

/// A DR4 document-authenticity fact. Written by `attest_document_fact` from a verified docauth proof: a
/// third party (a bank) RSA-signed a statement, and the guest proved IN ZK that the signature is valid AND
/// the attested value meets a public floor — without revealing the statement. The on-chain record reveals
/// only the predicate (`value ≥ threshold`), the public `threshold`, WHICH issuer signed (`issuer_key_hash`,
/// allowlisted), and the exact document it is about (`msg_digest`). The statement, the account, and the
/// exact value stay private. This is "third-party truth on self-uploaded data": delete the ZK and the fact
/// is just the uploader's word.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentFact {
    /// Position in the room's append-only fact log (0-based).
    pub index: u32,
    pub room_id: BytesN<32>,
    /// sha256(statement) — binds the fact to the EXACT signed document bytes (the doc commitment).
    pub msg_digest: BytesN<32>,
    /// Which field the predicate is about (1 = account balance).
    pub field_tag: u32,
    /// The public floor X proven (`value ≥ X`). The exact value is NOT on-chain.
    pub threshold: u64,
    /// sha256(issuer RSA modulus n) — the allowlisted third-party key that signed (provenance of truth).
    pub issuer_key_hash: BytesN<32>,
    /// The room owner who attested the fact (authenticated at attestation).
    pub attester: Address,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct DocumentFactAttested {
    #[topic]
    pub room_id: BytesN<32>,
    #[topic]
    pub msg_digest: BytesN<32>,
    pub field_tag: u32,
    pub threshold: u64,
    pub issuer_key_hash: BytesN<32>,
    pub index: u32,
}

/// A DR5 **teaser** — a public, ZK-verified fact about a SEALED document that a counterparty can check
/// BEFORE getting access (or instead of it): "this sealed document's headline figure ≥ `threshold`", the
/// document never revealed. Written by `attest_teaser` from a verified generic value≥threshold proof
/// (claim_type 11) whose `attester` is an allowlisted appraiser. The exact figure is NOT on-chain — only the
/// proven predicate, the public floor, WHICH appraiser vouched, and the document it is about (bound by
/// `doc_id` + the anchored blob's `content_hash`). Delete the ZK and a teaser is just the owner's word.
///
/// SOUNDNESS NOTE (the honest binding boundary): the proof cryptographically commits to the *figure* (the
/// appraiser signed `figure ≥ threshold`), NOT to *which document* it is about — the generic journal carries
/// no room_id/doc_id. So the figure↔document linkage here is the **room owner's assertion** (gated by
/// `room.owner.require_auth()`), and `content_hash` is snapshotted from the anchored `Document` at attest
/// time. A relying party trusts: an allowlisted appraiser vouched this figure, and the room owner bound it to
/// this blob. (A different room owner cannot bind it into *their* room without their own auth.)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Teaser {
    /// Position in the room's append-only teaser log (0-based).
    pub index: u32,
    pub room_id: BytesN<32>,
    /// The sealed document this teaser advertises (its `Document.content_hash` is bound below).
    pub doc_id: BytesN<32>,
    /// sha256 of the sealed document's stored ciphertext blob — pulled from the anchored `Document`, so the
    /// teaser is bound to the EXACT released blob (the "bind released blob hash to proven facts" requirement).
    pub content_hash: BytesN<32>,
    /// Which figure the teaser is about (attester-signed via the envelope `nonce`; 1 = revenue).
    pub field_tag: u32,
    /// The public floor X proven (`figure ≥ X`). The exact figure is NOT on-chain.
    pub threshold: u64,
    /// The allowlisted appraiser attester's ed25519 public key that vouched the figure (provenance of truth).
    pub attester: BytesN<32>,
    /// Teaser freshness deadline (attester-signed); reads expose `is_teaser_valid` (expiry-aware).
    pub expiry: u64,
    /// The room owner who bound the teaser to the document (authenticated at attestation).
    pub asserter: Address,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct TeaserAttested {
    #[topic]
    pub room_id: BytesN<32>,
    #[topic]
    pub doc_id: BytesN<32>,
    pub field_tag: u32,
    pub threshold: u64,
    pub attester: BytesN<32>,
    pub index: u32,
}

/// A DR6 composite-admission policy. A requester is admitted only by satisfying ALL enabled legs, proven
/// anonymously (the DR2 membership leg hides which member; the gate legs commit only the pseudonymous
/// accessor). The policy is PUBLIC config; the privacy is in the requester's hidden attributes. Membership is
/// the spine; the two gates are opt-in per room and cross-called live via `is_granted`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomPolicy {
    /// Require the DR2 anonymous-eligibility membership spine. `true` in the demo (the anonymous flow); a
    /// gate-only room may set `false`, but a fully-empty policy (no membership AND no gates) is rejected
    /// (`EmptyPolicy`), so an "open to everyone" room can't be set.
    pub require_membership: bool,
    /// The compliance gate (KYC ∧ not-sanctioned) to AND against; `None` ⇒ leg not required.
    pub compliance_gate: Option<Address>,
    /// The accredited-investor gate to AND against; `None` ⇒ leg not required.
    pub accredited_gate: Option<Address>,
}

/// A DR6 composite-policy admission record (audit). Reveals only the pseudonymous accessor + which legs the
/// policy required — never identity, which member, the KYC subject, or accreditation. `is_admitted` is live.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Admission {
    pub index: u32,
    pub room_id: BytesN<32>,
    pub accessor: BytesN<32>,
    pub required_compliance: bool,
    pub required_accredited: bool,
    pub ledger: u32,
    pub timestamp: u64,
}

/// A BA1 anonymous Bonded Access requirement. A reader who locked a qualifying NON-revocable bond (this
/// token, at least `min_amount`, until at least `deadline`) proves it ANONYMOUSLY (no wallet, no lock id, no
/// exact amount) and the document key release proceeds. `req_id = sha256(token_id ‖ min_amount ‖ deadline)`
/// is the bond gate's per-requirement key; the DataRoom passes it (plus the room's eligible_root) to the
/// gate's 3-arg `is_granted_for`, so a single bond proof proves BOTH room membership AND the bond (Option A).
/// `token`/`min_amount`/`deadline` are stored for display + a self-describing on-chain record; `req_id` (the
/// precomputed binding) and `gate` (the cross-call target) are what enforcement uses.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondRequirement {
    /// The deployed bond gate to cross-call (the BA1 generalized gate).
    pub gate: Address,
    /// `req_id = sha256(token_id ‖ min_amount ‖ deadline)` — the bond gate's per-requirement key.
    pub req_id: BytesN<32>,
    /// The required bond token (SEP-41 / SAC). Display + self-description; the binding is via `req_id`.
    pub token: Address,
    /// The minimum bonded amount (base units). Display; the binding is via `req_id`.
    pub min_amount: i128,
    /// The deadline the bond must stay locked until (unix seconds). Display; the binding is via `req_id`.
    pub deadline: u64,
}

#[contractevent]
pub struct BondRequirementSet {
    #[topic]
    pub room_id: BytesN<32>,
    #[topic]
    pub doc_id: BytesN<32>,
    pub gate: Address,
    pub req_id: BytesN<32>,
    pub min_amount: i128,
    pub deadline: u64,
    /// `false` when this is a per-room requirement (doc_id is the room's own id as a placeholder).
    pub per_document: bool,
}

#[contractevent]
pub struct RoomPolicySet {
    #[topic]
    pub room_id: BytesN<32>,
    pub require_membership: bool,
    pub has_compliance: bool,
    pub has_accredited: bool,
}

#[contractevent]
pub struct DocPolicySet {
    #[topic]
    pub room_id: BytesN<32>,
    #[topic]
    pub doc_id: BytesN<32>,
    pub require_membership: bool,
    pub has_compliance: bool,
    pub has_accredited: bool,
}

#[contractevent]
pub struct RoomAdmitted {
    #[topic]
    pub room_id: BytesN<32>,
    #[topic]
    pub accessor: BytesN<32>,
    pub required_compliance: bool,
    pub required_accredited: bool,
    pub index: u32,
}

#[contractevent]
pub struct AccessRevocationChanged {
    #[topic]
    pub room_id: BytesN<32>,
    #[topic]
    pub accessor: BytesN<32>,
    pub revoked: bool,
}

#[contractevent]
pub struct CommitteeKeyRotated {
    #[topic]
    pub room_id: BytesN<32>,
    #[topic]
    pub doc_id: BytesN<32>,
    pub content_hash: BytesN<32>,
    pub k_commitment: BytesN<32>,
    pub key_epoch: u32,
}

/// Minimal client for a zkorage access gate (`compliance` / `accredited`) — DR6 cross-calls only `is_granted`
/// for the composite AND. `try_is_granted` (auto-generated) keeps it fail-closed (W8 fundraise pattern).
#[contractclient(name = "GateClient")]
pub trait GateInterface {
    fn is_granted(env: Env, accessor: BytesN<32>) -> bool;
}

/// Minimal client for the BA1 bond gate — the 3-arg `is_granted_for(accessor, req_id, member_root)`. The
/// DataRoom passes the room's CURRENT eligible_root as `member_root`, so the gate confirms the bond proof was
/// checked against THIS room's member set (bond-implies-membership, Option A). `try_is_granted_for`
/// (auto-generated) keeps the cross-call fail-closed (a reverting/foreign gate ⇒ not admitted).
#[contractclient(name = "BondGateClient")]
pub trait BondGateInterface {
    fn is_granted_for(env: Env, accessor: BytesN<32>, req_id: BytesN<32>, member_root: BytesN<32>) -> bool;
}

fn be_u32(a: &[u8], o: usize) -> u32 {
    u32::from_be_bytes([a[o], a[o + 1], a[o + 2], a[o + 3]])
}

fn be_u64(a: &[u8], o: usize) -> u64 {
    u64::from_be_bytes([
        a[o], a[o + 1], a[o + 2], a[o + 3], a[o + 4], a[o + 5], a[o + 6], a[o + 7],
    ])
}

fn bytesn32(env: &Env, a: &[u8], o: usize) -> BytesN<32> {
    let mut b = [0u8; 32];
    b.copy_from_slice(&a[o..o + 32]);
    BytesN::from_array(env, &b)
}

fn load_config(env: &Env) -> Result<Config, DataRoomError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(DataRoomError::NotInitialized)
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(THRESHOLD, BUMP);
}

/// The BA1 bond leg: true iff the room has a pinned eligible_root AND the bond gate grants `accessor` for
/// `req.req_id` against THAT root. Because the bond proof's `member_root` is the room's eligible_root
/// (Option A), a satisfied bond leg ALSO proves room membership, so it REPLACES the DR2 membership spine.
/// Fail-closed: no eligible_root ⇒ false; a reverting / foreign / wrong-root gate ⇒ false (`try_*`).
fn bond_leg_ok(env: &Env, room_id: &BytesN<32>, req: &BondRequirement, accessor: &BytesN<32>) -> bool {
    let root: BytesN<32> = match env
        .storage()
        .persistent()
        .get(&DataKey::EligibleRoot(room_id.clone()))
    {
        Some(r) => r,
        None => return false,
    };
    matches!(
        BondGateClient::new(env, &req.gate).try_is_granted_for(accessor, &req.req_id, &root),
        Ok(Ok(true))
    )
}

#[contract]
pub struct DataRoom;

#[contractimpl]
impl DataRoom {
    /// One-time setup. `seal_image_id` is the canonical DR1 seal guest image; `claim_type` is `8`.
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier: Address,
        seal_image_id: BytesN<32>,
        claim_type: u32,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, DataRoomError::AlreadyInitialized);
        }
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                verifier,
                seal_image_id,
                claim_type,
            },
        );
        bump_instance(&env);
    }

    /// Create a room owned by `owner` (authenticated). Reverts if `room_id` already exists.
    ///
    /// Permissionless at the contract level (any account may create a room it owns); in the DR1 demo the
    /// only authorizer is the backend's admin key, so rooms are admin-created by deployment convention.
    /// `room_id` is caller-chosen and first-writer-wins, and there is no per-owner cap. If room creation is
    /// ever opened to the public (DR2 "anonymous eligibility"), add a cap/deposit and namespace `room_id`
    /// by owner (e.g. `sha256(owner ‖ label)`) to prevent label squatting / unbounded-growth griefing.
    pub fn create_room(env: Env, owner: Address, room_id: BytesN<32>) -> Room {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        owner.require_auth();
        let pstore = env.storage().persistent();
        if pstore.has(&DataKey::Room(room_id.clone())) {
            panic_with_error!(&env, DataRoomError::RoomExists);
        }
        let index: u32 = env.storage().instance().get(&DataKey::RoomCount).unwrap_or(0);
        let room = Room {
            index,
            room_id: room_id.clone(),
            owner: owner.clone(),
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        pstore.set(&DataKey::Room(room_id.clone()), &room);
        pstore.extend_ttl(&DataKey::Room(room_id.clone()), THRESHOLD, BUMP);
        env.storage()
            .instance()
            .set(&DataKey::RoomCount, &index.saturating_add(1));
        bump_instance(&env);

        RoomCreated {
            room_id,
            owner,
            index,
        }
        .publish(&env);

        room
    }

    /// Anchor a document into a room from a verified DR1 seal proof. Enforcement (in order):
    /// 1. **Image pin** — `image_id == Config.seal_image_id` (the canonical seal guest).
    /// 2. **Digest recomputation** — `sha256(journal)` on-chain, binding the parsed fields to the proof.
    /// 3. **Cross-verify** — the bare Groth16 verifier must accept the seal.
    /// 4. **Journal policy** — `result == 1`, `claim_type == Config.claim_type` (8).
    /// 5. **Room + owner** — the journal's `room_id` must exist and its **owner must authorize** (only the
    ///    room owner anchors documents); the `doc_id` must be new.
    /// 6. **Store** — keep the document anchor (content_hash + the ECIES disclosure the recipient opens)
    ///    keyed by `(room_id, doc_id)`, append to the room's log, and emit `document_anchored`.
    /// `blob_pointer` is the off-chain pointer (R2 key / IPFS CID); the blob is content-addressed by
    /// `content_hash`, so the pointer is metadata, not part of the proof.
    pub fn put_document(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
        blob_pointer: Bytes,
    ) -> Result<Document, DataRoomError> {
        let cfg = load_config(&env)?;

        // (1) image pin.
        if image_id != cfg.seal_image_id {
            return Err(DataRoomError::ImageMismatch);
        }
        // (2) recompute the journal digest on-chain.
        if journal.len() != JOURNAL_LEN {
            return Err(DataRoomError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();
        // (3) cross-verify against the bare Groth16 verifier.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(DataRoomError::ProofInvalid),
        }
        // (4) parse + policy-check. Length checked in (2), so copy_into_slice cannot trap.
        let mut jb = [0u8; 229];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(DataRoomError::ResultNotTrue);
        }
        if be_u32(&jb, 1) != cfg.claim_type {
            return Err(DataRoomError::ClaimTypeMismatch);
        }
        let room_id = bytesn32(&env, &jb, 5);
        let doc_id = bytesn32(&env, &jb, 37);
        let recipient_pub = bytesn32(&env, &jb, 69);
        let content_hash = bytesn32(&env, &jb, 101);
        let eph_pub = bytesn32(&env, &jb, 133);
        let ct = bytesn32(&env, &jb, 165);
        let tag = bytesn32(&env, &jb, 197);

        // (5) room must exist; only its owner may anchor; doc_id must be new.
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .ok_or(DataRoomError::RoomNotFound)?;
        room.owner.require_auth();
        if pstore.has(&DataKey::Doc(room_id.clone(), doc_id.clone())) {
            return Err(DataRoomError::DocExists);
        }

        // (6) store + append to the room's document log + emit.
        let index: u32 = pstore
            .get(&DataKey::DocCount(room_id.clone()))
            .unwrap_or(0);
        let doc = Document {
            index,
            room_id: room_id.clone(),
            doc_id: doc_id.clone(),
            recipient_pub: recipient_pub.clone(),
            content_hash: content_hash.clone(),
            eph_pub,
            ct,
            tag,
            blob_pointer,
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        pstore.set(&DataKey::Doc(room_id.clone(), doc_id.clone()), &doc);
        pstore.extend_ttl(&DataKey::Doc(room_id.clone(), doc_id.clone()), THRESHOLD, BUMP);
        pstore.set(&DataKey::DocLog(room_id.clone(), index), &doc_id);
        pstore.extend_ttl(&DataKey::DocLog(room_id.clone(), index), THRESHOLD, BUMP);
        pstore.set(&DataKey::DocCount(room_id.clone()), &index.saturating_add(1));
        pstore.extend_ttl(&DataKey::DocCount(room_id.clone()), THRESHOLD, BUMP);
        bump_instance(&env);

        DocumentAnchored {
            room_id,
            doc_id,
            recipient_pub,
            content_hash,
            index,
        }
        .publish(&env);

        Ok(doc)
    }

    // ---- DR2: anonymous eligibility (membership + nullifier) ----

    /// Pin (or rotate) a room's eligible-set Merkle root. Only the room owner may set it. The backend
    /// builds the sha256 membership tree of `id_commitment`s and computes the root; this is the
    /// authoritative root a membership proof's committed root MUST equal. Re-pinning a NEW root rotates
    /// the set and immediately revokes any grant proven against the old root (see `is_granted`), like the
    /// compliance gate's `deny_root`.
    pub fn set_eligible_root(env: Env, room_id: BytesN<32>, root: BytesN<32>) {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, DataRoomError::RoomNotFound));
        room.owner.require_auth();
        pstore.set(&DataKey::EligibleRoot(room_id.clone()), &root);
        pstore.extend_ttl(&DataKey::EligibleRoot(room_id), THRESHOLD, BUMP);
        bump_instance(&env);
    }

    /// Admit an accessor to a room by verifying an **anonymous-eligibility** membership proof, recording the
    /// nullifier, and granting access — WITHOUT revealing the member's identity or which eligible leaf they
    /// are. Enforcement (in order):
    /// 1. **Image pin** — `image_id == MembershipImageId` (the canonical membership guest; must be set).
    /// 2. **Digest recomputation** — `sha256(journal)` on-chain, binding the parsed fields to the proof.
    /// 3. **Cross-verify** — the bare Groth16 verifier must accept the proof.
    /// 4. **Journal policy** — `result == 1`, `claim_type == 9`.
    /// 5. **Eligibility** — the journal's `room_id` must exist, the room must have a pinned `EligibleRoot`,
    ///    and the journal's `eligible_root` must equal it (the proof checked the CURRENT eligible set).
    /// 6. **Nullifier** — the journal's `nullifier` must be UNUSED in this room (else `NullifierUsed`); it is
    ///    then recorded → one access per identity per room.
    /// 7. **Grant** — store the `Grant` keyed by `(room_id, accessor)`, append to the room's grant log, emit.
    /// **Permissionless** — no `require_auth`: the in-guest NEW-5 holder signature (pk == accessor) already
    /// authenticated the accessor's consent off-chain, so a relayer can submit + pay fees without revealing
    /// or charging the (anonymous) accessor. The on-chain record reveals neither identity nor which member.
    pub fn request_access(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
    ) -> Result<Grant, DataRoomError> {
        let cfg = load_config(&env)?;

        // (1) image pin — the proof MUST come from our canonical membership guest (must be pinned).
        let pinned: Option<BytesN<32>> = env.storage().instance().get(&DataKey::MembershipImageId);
        match pinned {
            Some(p) if p == image_id => {}
            _ => return Err(DataRoomError::ImageMismatch),
        }
        // (2) recompute the journal digest on-chain.
        if journal.len() != MEMBERSHIP_JOURNAL_LEN {
            return Err(DataRoomError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();
        // (3) cross-verify against the bare Groth16 verifier.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(DataRoomError::ProofInvalid),
        }
        // (4) parse + policy-check. Length checked in (2), so copy_into_slice cannot trap.
        let mut jb = [0u8; 165];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(DataRoomError::ResultNotTrue);
        }
        if be_u32(&jb, 1) != CLAIM_TYPE_MEMBERSHIP {
            return Err(DataRoomError::ClaimTypeMismatch);
        }
        let room_id = bytesn32(&env, &jb, 5);
        let eligible_root = bytesn32(&env, &jb, 37);
        let nullifier = bytesn32(&env, &jb, 69);
        let accessor = bytesn32(&env, &jb, 101);
        let recipient_pub = bytesn32(&env, &jb, 133);

        // (5) eligibility — room exists, has a pinned root, and the proof checked THAT root.
        let pstore = env.storage().persistent();
        if !pstore.has(&DataKey::Room(room_id.clone())) {
            return Err(DataRoomError::RoomNotFound);
        }
        let pinned_root: BytesN<32> = pstore
            .get(&DataKey::EligibleRoot(room_id.clone()))
            .ok_or(DataRoomError::EligibleRootNotSet)?;
        if eligible_root != pinned_root {
            return Err(DataRoomError::EligibleRootMismatch);
        }

        // (6) nullifier — reject reuse; record on first use (one access per identity per room).
        if pstore.has(&DataKey::Nullifier(room_id.clone(), nullifier.clone())) {
            return Err(DataRoomError::NullifierUsed);
        }
        pstore.set(&DataKey::Nullifier(room_id.clone(), nullifier.clone()), &true);
        pstore.extend_ttl(
            &DataKey::Nullifier(room_id.clone(), nullifier.clone()),
            THRESHOLD,
            BUMP,
        );

        // (7) grant + append to the room's grant log + emit.
        let index: u32 = pstore.get(&DataKey::GrantCount(room_id.clone())).unwrap_or(0);
        let grant = Grant {
            index,
            room_id: room_id.clone(),
            accessor: accessor.clone(),
            recipient_pub,
            eligible_root: eligible_root.clone(),
            nullifier: nullifier.clone(),
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        pstore.set(&DataKey::Grant(room_id.clone(), accessor.clone()), &grant);
        pstore.extend_ttl(
            &DataKey::Grant(room_id.clone(), accessor.clone()),
            THRESHOLD,
            BUMP,
        );
        pstore.set(&DataKey::GrantLog(room_id.clone(), index), &accessor);
        pstore.extend_ttl(&DataKey::GrantLog(room_id.clone(), index), THRESHOLD, BUMP);
        pstore.set(&DataKey::GrantCount(room_id.clone()), &index.saturating_add(1));
        pstore.extend_ttl(&DataKey::GrantCount(room_id.clone()), THRESHOLD, BUMP);
        bump_instance(&env);

        AccessGranted {
            room_id,
            accessor,
            nullifier,
            eligible_root,
            index,
        }
        .publish(&env);

        Ok(grant)
    }

    // ---- DR3: threshold-ECIES committee documents ----

    /// Anchor a **committee document** — one whose key `K` is Shamir-split off-chain to the threshold keyper
    /// committee (DR3), NOT sealed to a single recipient. The room OWNER (the dealer that split `K`) records
    /// the ciphertext `content_hash`, a `sha256(K)` commitment, and the off-chain `blob_pointer`. There is no
    /// on-chain key material and no ZK proof in THIS call — faithfulness is enforced off-chain (the recipient
    /// checks `sha256(reconstructed K) == k_commitment` and AES-GCM authenticates the blob against
    /// `content_hash`), and the ANONYMOUS access decision is the DR2 grant (`request_access` / `is_granted`).
    /// Enforcement: the room must exist; **only its owner may anchor** (`require_auth`); `doc_id` must be new
    /// in the committee keyspace (distinct from `put_document`'s `Doc`, so a committee doc and a DR1 doc may
    /// reuse a doc_id without colliding).
    pub fn put_committee_document(
        env: Env,
        room_id: BytesN<32>,
        doc_id: BytesN<32>,
        content_hash: BytesN<32>,
        k_commitment: BytesN<32>,
        blob_pointer: Bytes,
    ) -> Result<CommitteeDocument, DataRoomError> {
        load_config(&env)?;
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .ok_or(DataRoomError::RoomNotFound)?;
        room.owner.require_auth();
        if pstore.has(&DataKey::CommitteeDoc(room_id.clone(), doc_id.clone())) {
            return Err(DataRoomError::DocExists);
        }

        let index: u32 = pstore
            .get(&DataKey::CommitteeDocCount(room_id.clone()))
            .unwrap_or(0);
        let doc = CommitteeDocument {
            index,
            room_id: room_id.clone(),
            doc_id: doc_id.clone(),
            content_hash: content_hash.clone(),
            k_commitment: k_commitment.clone(),
            blob_pointer,
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        pstore.set(&DataKey::CommitteeDoc(room_id.clone(), doc_id.clone()), &doc);
        pstore.extend_ttl(&DataKey::CommitteeDoc(room_id.clone(), doc_id.clone()), THRESHOLD, BUMP);
        pstore.set(&DataKey::CommitteeDocLog(room_id.clone(), index), &doc_id);
        pstore.extend_ttl(&DataKey::CommitteeDocLog(room_id.clone(), index), THRESHOLD, BUMP);
        pstore.set(&DataKey::CommitteeDocCount(room_id.clone()), &index.saturating_add(1));
        pstore.extend_ttl(&DataKey::CommitteeDocCount(room_id.clone()), THRESHOLD, BUMP);
        bump_instance(&env);

        CommitteeDocumentAnchored {
            room_id,
            doc_id,
            content_hash,
            k_commitment,
            index,
        }
        .publish(&env);

        Ok(doc)
    }

    // ---- DR4: document-authenticity (signed-PDF / zkPDF fact) ----

    /// Anchor a **document-authenticity fact** from a verified docauth proof: a third party (a bank) signed a
    /// statement with its RSA-2048 key, and the docauth guest proved IN ZK that the signature is valid AND the
    /// attested value meets a public floor — WITHOUT revealing the statement. Enforcement (in order):
    /// 1. **Image pin** — `image_id == DocAuthImageId` (the canonical docauth guest; must be set, else
    ///    fail-closed `ImageMismatch`).
    /// 2. **Digest recomputation** — `sha256(journal)` on-chain, binding the parsed fields to the proof.
    /// 3. **Cross-verify** — the bare Groth16 verifier must accept the proof.
    /// 4. **Journal policy** — `result == 1`, `claim_type == 10`.
    /// 5. **Room + owner** — the journal's `room_id` must exist and its **owner must authorize** (only the room
    ///    owner attests facts about their documents); analogous to `put_document`.
    /// 6. **Issuer allowlist** — `issuer_key_hash` must be an allowlisted issuer (`set_docauth_issuer`). This
    ///    is what makes the fact *third-party truth*: a self-minted RSA key is rejected (`IssuerNotAllowed`).
    /// 7. **Dedup** — `(room_id, msg_digest)` must be new (else `DocFactExists`) → one canonical fact per doc.
    /// 8. **Store** — keep the `DocumentFact` keyed by `(room_id, msg_digest)`, append to the room's fact log,
    ///    emit `document_fact_attested`.
    /// The exact value, the account, and the statement bytes are NEVER on-chain — only the proven predicate.
    pub fn attest_document_fact(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
    ) -> Result<DocumentFact, DataRoomError> {
        let cfg = load_config(&env)?;

        // (1) image pin — the proof MUST come from our canonical docauth guest (must be pinned; fail-closed).
        let pinned: Option<BytesN<32>> = env.storage().instance().get(&DataKey::DocAuthImageId);
        match pinned {
            Some(p) if p == image_id => {}
            _ => return Err(DataRoomError::ImageMismatch),
        }
        // (2) recompute the journal digest on-chain.
        if journal.len() != DOCAUTH_JOURNAL_LEN {
            return Err(DataRoomError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();
        // (3) cross-verify against the bare Groth16 verifier.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(DataRoomError::ProofInvalid),
        }
        // (4) parse + policy-check. Length checked in (2), so copy_into_slice cannot trap.
        let mut jb = [0u8; 113];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(DataRoomError::ResultNotTrue);
        }
        if be_u32(&jb, 1) != CLAIM_TYPE_DOCAUTH {
            return Err(DataRoomError::ClaimTypeMismatch);
        }
        let field_tag = be_u32(&jb, 5);
        let threshold = be_u64(&jb, 9);
        let issuer_key_hash = bytesn32(&env, &jb, 17);
        let room_id = bytesn32(&env, &jb, 49);
        let msg_digest = bytesn32(&env, &jb, 81);

        // (5) room must exist; only its owner may attest facts about its documents.
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .ok_or(DataRoomError::RoomNotFound)?;
        room.owner.require_auth();

        // (6) issuer allowlist — the RSA key that signed must be a KNOWN, accepted third-party issuer.
        if !pstore.has(&DataKey::DocAuthIssuer(issuer_key_hash.clone())) {
            return Err(DataRoomError::IssuerNotAllowed);
        }

        // (7) dedup — one canonical fact per (room, document).
        if pstore.has(&DataKey::DocFact(room_id.clone(), msg_digest.clone())) {
            return Err(DataRoomError::DocFactExists);
        }

        // (8) store + append to the room's fact log + emit.
        let index: u32 = pstore
            .get(&DataKey::DocFactCount(room_id.clone()))
            .unwrap_or(0);
        let fact = DocumentFact {
            index,
            room_id: room_id.clone(),
            msg_digest: msg_digest.clone(),
            field_tag,
            threshold,
            issuer_key_hash: issuer_key_hash.clone(),
            attester: room.owner,
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        pstore.set(&DataKey::DocFact(room_id.clone(), msg_digest.clone()), &fact);
        pstore.extend_ttl(&DataKey::DocFact(room_id.clone(), msg_digest.clone()), THRESHOLD, BUMP);
        pstore.set(&DataKey::DocFactLog(room_id.clone(), index), &msg_digest);
        pstore.extend_ttl(&DataKey::DocFactLog(room_id.clone(), index), THRESHOLD, BUMP);
        pstore.set(&DataKey::DocFactCount(room_id.clone()), &index.saturating_add(1));
        pstore.extend_ttl(&DataKey::DocFactCount(room_id.clone()), THRESHOLD, BUMP);
        bump_instance(&env);

        DocumentFactAttested {
            room_id,
            msg_digest,
            field_tag,
            threshold,
            issuer_key_hash,
            index,
        }
        .publish(&env);

        Ok(fact)
    }

    // ---- DR5: faithful disclosure / data-side teaser ----

    /// Anchor a **teaser** — a public, ZK-verified fact about a SEALED document (`figure ≥ threshold`) that a
    /// counterparty can check without ever seeing the document. Reuses the generic value≥threshold guest
    /// (claim_type 11) — NO new guest. The auditor "redacted view" side of DR5 needs no new contract method:
    /// it is an ordinary `put_document` whose `recipient_pub` is the auditor's x25519 key (the redacted blob is
    /// integrity-faithfully sealed to the auditor off-chain). Enforcement (in order):
    /// 1. **Image pin** — `image_id == TeaserImageId` (the canonical generic guest; must be set, else
    ///    fail-closed `ImageMismatch`).
    /// 2. **Digest recomputation** — `sha256(journal)` on-chain, binding the parsed fields to the proof.
    /// 3. **Cross-verify** — the bare Groth16 verifier must accept the proof.
    /// 4. **Journal policy** — `result == 1`, `claim_type == 11` (a fundraise revenue proof, claim_type 6, is
    ///    rejected here).
    /// 5. **Room + owner** — the `room_id` (call arg) must exist and its **owner must authorize** (only the room
    ///    owner advertises facts about their documents). The teaser↔document linkage is the owner's assertion;
    ///    the *figure* is the appraiser's (the attester allowlist below). The owner already controls the room.
    /// 6. **Document binding** — the referenced `(room_id, doc_id)` `Document` must exist; its `content_hash`
    ///    is recorded so the teaser is bound to the EXACT released blob (not a free-floating claim).
    /// 7. **Attester allowlist** — the `attester` (journal `issuer_id`) must be an allowlisted appraiser
    ///    (`set_teaser_attester`). This is what makes the figure *third-party truth*: a self-minted attester key
    ///    is rejected (`IssuerNotAllowed`).
    /// 8. **Freshness** — the attester-signed `expiry` must be in the future (else `Expired`).
    /// 9. **Dedup** — one teaser per `(room_id, doc_id)` (else `TeaserExists`).
    /// 10. **Store** — keep the `Teaser`, append to the room's teaser log, emit `teaser_attested`.
    /// The exact figure is NEVER on-chain — only the proven predicate, the public floor, and the appraiser key.
    pub fn attest_teaser(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
        room_id: BytesN<32>,
        doc_id: BytesN<32>,
    ) -> Result<Teaser, DataRoomError> {
        let cfg = load_config(&env)?;

        // (1) image pin — the proof MUST come from our canonical generic guest (must be pinned; fail-closed).
        let pinned: Option<BytesN<32>> = env.storage().instance().get(&DataKey::TeaserImageId);
        match pinned {
            Some(p) if p == image_id => {}
            _ => return Err(DataRoomError::ImageMismatch),
        }
        // (2) recompute the journal digest on-chain.
        if journal.len() != TEASER_JOURNAL_LEN {
            return Err(DataRoomError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();
        // (3) cross-verify against the bare Groth16 verifier.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(DataRoomError::ProofInvalid),
        }
        // (4) parse + policy-check. Length checked in (2), so copy_into_slice cannot trap.
        let mut jb = [0u8; 61];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(DataRoomError::ResultNotTrue);
        }
        if be_u32(&jb, 1) != CLAIM_TYPE_TEASER {
            return Err(DataRoomError::ClaimTypeMismatch);
        }
        let attester = bytesn32(&env, &jb, 5);
        let threshold = be_u64(&jb, 37);
        // The attester signs `nonce = field_tag` (a u32 field id in the low 32 bits); offset 49 = low word.
        let field_tag = be_u32(&jb, 49);
        let expiry = be_u64(&jb, 53);

        // (5) room must exist; only its owner may advertise facts about its documents.
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .ok_or(DataRoomError::RoomNotFound)?;
        room.owner.require_auth();

        // (6) document binding — the sealed document must exist; bind the teaser to its on-chain blob hash.
        let document: Document = pstore
            .get(&DataKey::Doc(room_id.clone(), doc_id.clone()))
            .ok_or(DataRoomError::DocNotFound)?;
        let content_hash = document.content_hash;

        // (7) attester allowlist — the figure must be vouched by a KNOWN appraiser (self-minted key rejected).
        if !pstore.has(&DataKey::TeaserAttester(attester.clone())) {
            return Err(DataRoomError::IssuerNotAllowed);
        }

        // (8) freshness — reject an already-expired teaser.
        if expiry <= env.ledger().timestamp() {
            return Err(DataRoomError::Expired);
        }

        // (9) dedup — one teaser per (room, document).
        if pstore.has(&DataKey::Teaser(room_id.clone(), doc_id.clone())) {
            return Err(DataRoomError::TeaserExists);
        }

        // (10) store + append to the room's teaser log + emit.
        let index: u32 = pstore
            .get(&DataKey::TeaserCount(room_id.clone()))
            .unwrap_or(0);
        let teaser = Teaser {
            index,
            room_id: room_id.clone(),
            doc_id: doc_id.clone(),
            content_hash,
            field_tag,
            threshold,
            attester: attester.clone(),
            expiry,
            asserter: room.owner,
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        pstore.set(&DataKey::Teaser(room_id.clone(), doc_id.clone()), &teaser);
        pstore.extend_ttl(&DataKey::Teaser(room_id.clone(), doc_id.clone()), THRESHOLD, BUMP);
        pstore.set(&DataKey::TeaserLog(room_id.clone(), index), &doc_id);
        pstore.extend_ttl(&DataKey::TeaserLog(room_id.clone(), index), THRESHOLD, BUMP);
        pstore.set(&DataKey::TeaserCount(room_id.clone()), &index.saturating_add(1));
        pstore.extend_ttl(&DataKey::TeaserCount(room_id.clone()), THRESHOLD, BUMP);
        bump_instance(&env);

        TeaserAttested {
            room_id,
            doc_id,
            field_tag,
            threshold,
            attester,
            index,
        }
        .publish(&env);

        Ok(teaser)
    }

    // ---- DR6: private-policy composition + revocation/rotation ----

    /// Set (or replace) a room's composite-admission policy (room-owner auth). `require_membership` keeps the
    /// DR2 anonymity spine (pass `true`); the gate args are the optional compliance/accredited gates to AND
    /// against (`None` ⇒ leg not required). The policy is public; the requester's attributes stay private.
    pub fn set_room_policy(
        env: Env,
        room_id: BytesN<32>,
        require_membership: bool,
        compliance_gate: Option<Address>,
        accredited_gate: Option<Address>,
    ) {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, DataRoomError::RoomNotFound));
        room.owner.require_auth();
        let has_compliance = compliance_gate.is_some();
        let has_accredited = accredited_gate.is_some();
        // Reject a no-op policy that would admit EVERYONE (no membership spine and no gate legs) — that
        // defeats the anonymous-eligibility model and is almost always a fat-finger. At least one leg required.
        if !require_membership && !has_compliance && !has_accredited {
            panic_with_error!(&env, DataRoomError::EmptyPolicy);
        }
        let policy = RoomPolicy {
            require_membership,
            compliance_gate,
            accredited_gate,
        };
        pstore.set(&DataKey::RoomPolicy(room_id.clone()), &policy);
        pstore.extend_ttl(&DataKey::RoomPolicy(room_id.clone()), THRESHOLD, BUMP);
        bump_instance(&env);

        RoomPolicySet {
            room_id,
            require_membership,
            has_compliance,
            has_accredited,
        }
        .publish(&env);
    }

    /// Set (or replace) a PER-DOCUMENT composite-admission policy for a committee document (room-owner auth).
    /// This is the Pattern-2 "prove-a-policy self-serve" knob: it mirrors `set_room_policy` but is keyed by
    /// (room, doc), so different documents in the same room can require different conditions. The committee
    /// document must already exist (`CommitteeDocNotFound`). `require_membership` keeps the DR2 anonymity
    /// spine; a key-release document MUST require it so a proof-bound `recipient_pub` exists (from the DR2
    /// grant) for the keypers to seal shares to. The gate args are the optional compliance/accredited gates
    /// to AND against (`None` ⇒ leg not required). An empty policy (no membership AND no gates) is rejected
    /// (`EmptyPolicy`). The policy is PUBLIC config; the requester's attributes stay private. Absence of a
    /// per-document policy falls back to the room policy, then to bare membership (see `is_doc_admitted`).
    pub fn set_doc_policy(
        env: Env,
        room_id: BytesN<32>,
        doc_id: BytesN<32>,
        require_membership: bool,
        compliance_gate: Option<Address>,
        accredited_gate: Option<Address>,
    ) {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, DataRoomError::RoomNotFound));
        room.owner.require_auth();
        // The committee document must exist (a policy on a missing document is meaningless / a fat-finger).
        if !pstore.has(&DataKey::CommitteeDoc(room_id.clone(), doc_id.clone())) {
            panic_with_error!(&env, DataRoomError::CommitteeDocNotFound);
        }
        let has_compliance = compliance_gate.is_some();
        let has_accredited = accredited_gate.is_some();
        // Same guard as set_room_policy: reject an empty policy that would admit EVERYONE.
        if !require_membership && !has_compliance && !has_accredited {
            panic_with_error!(&env, DataRoomError::EmptyPolicy);
        }
        let policy = RoomPolicy {
            require_membership,
            compliance_gate,
            accredited_gate,
        };
        pstore.set(&DataKey::DocPolicy(room_id.clone(), doc_id.clone()), &policy);
        pstore.extend_ttl(&DataKey::DocPolicy(room_id.clone(), doc_id.clone()), THRESHOLD, BUMP);
        bump_instance(&env);

        DocPolicySet {
            room_id,
            doc_id,
            require_membership,
            has_compliance,
            has_accredited,
        }
        .publish(&env);
    }

    // ---- BA1: anonymous Bonded Access (per-requirement bond gating) ----

    /// Set (or replace) a room-level Bonded Access requirement (room-owner auth). When set, opening any of
    /// the room's documents requires an anonymous bond proof for `req_id`, and that proof ALSO proves room
    /// membership (Option A — the bond guest's `member_root` is the room's eligible_root), so the DR2
    /// membership spine is not separately required. `req_id = sha256(token_id ‖ min_amount ‖ deadline)` is
    /// precomputed off-chain (the backend's `reqId`, the SAME function the qual-root indexer uses, so they
    /// agree); `token`/`min_amount`/`deadline` are stored for display. The room MUST have a pinned
    /// eligible_root (the bond leg fails closed otherwise — see `is_doc_admitted`). Clear with
    /// `clear_bond_requirement`.
    pub fn set_bond_requirement(
        env: Env,
        room_id: BytesN<32>,
        gate: Address,
        req_id: BytesN<32>,
        token: Address,
        min_amount: i128,
        deadline: u64,
    ) {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, DataRoomError::RoomNotFound));
        room.owner.require_auth();
        if min_amount <= 0 {
            panic_with_error!(&env, DataRoomError::BadBondRequirement);
        }
        let req = BondRequirement {
            gate: gate.clone(),
            req_id: req_id.clone(),
            token,
            min_amount,
            deadline,
        };
        pstore.set(&DataKey::BondReq(room_id.clone()), &req);
        pstore.extend_ttl(&DataKey::BondReq(room_id.clone()), THRESHOLD, BUMP);
        bump_instance(&env);

        BondRequirementSet {
            room_id: room_id.clone(),
            doc_id: room_id,
            gate,
            req_id,
            min_amount,
            deadline,
            per_document: false,
        }
        .publish(&env);
    }

    /// Set (or replace) a PER-DOCUMENT Bonded Access requirement (room-owner auth), overriding `BondReq(room)`
    /// for this committee document. The committee document must already exist (`CommitteeDocNotFound`). Same
    /// semantics as `set_bond_requirement`. Clear with `clear_doc_bond_requirement`.
    pub fn set_doc_bond_requirement(
        env: Env,
        room_id: BytesN<32>,
        doc_id: BytesN<32>,
        gate: Address,
        req_id: BytesN<32>,
        token: Address,
        min_amount: i128,
        deadline: u64,
    ) {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, DataRoomError::RoomNotFound));
        room.owner.require_auth();
        if !pstore.has(&DataKey::CommitteeDoc(room_id.clone(), doc_id.clone())) {
            panic_with_error!(&env, DataRoomError::CommitteeDocNotFound);
        }
        if min_amount <= 0 {
            panic_with_error!(&env, DataRoomError::BadBondRequirement);
        }
        let req = BondRequirement {
            gate: gate.clone(),
            req_id: req_id.clone(),
            token,
            min_amount,
            deadline,
        };
        pstore.set(&DataKey::BondReqDoc(room_id.clone(), doc_id.clone()), &req);
        pstore.extend_ttl(&DataKey::BondReqDoc(room_id.clone(), doc_id.clone()), THRESHOLD, BUMP);
        bump_instance(&env);

        BondRequirementSet {
            room_id,
            doc_id,
            gate,
            req_id,
            min_amount,
            deadline,
            per_document: true,
        }
        .publish(&env);
    }

    /// Remove a room-level Bonded Access requirement (room-owner auth). The room's documents fall back to
    /// their per-document bond requirement (if any), else the policy / bare membership.
    pub fn clear_bond_requirement(env: Env, room_id: BytesN<32>) {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, DataRoomError::RoomNotFound));
        room.owner.require_auth();
        pstore.remove(&DataKey::BondReq(room_id));
        bump_instance(&env);
    }

    /// Remove a per-document Bonded Access requirement (room-owner auth).
    pub fn clear_doc_bond_requirement(env: Env, room_id: BytesN<32>, doc_id: BytesN<32>) {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, DataRoomError::RoomNotFound));
        room.owner.require_auth();
        pstore.remove(&DataKey::BondReqDoc(room_id, doc_id));
        bump_instance(&env);
    }

    /// A room-level Bonded Access requirement, if set (public config).
    pub fn get_bond_requirement(env: Env, room_id: BytesN<32>) -> Option<BondRequirement> {
        env.storage().persistent().get(&DataKey::BondReq(room_id))
    }

    /// A per-document Bonded Access requirement, if set (else the room requirement applies; public config).
    pub fn get_doc_bond_requirement(
        env: Env,
        room_id: BytesN<32>,
        doc_id: BytesN<32>,
    ) -> Option<BondRequirement> {
        env.storage()
            .persistent()
            .get(&DataKey::BondReqDoc(room_id, doc_id))
    }

    /// Admit `accessor` by enforcing the room's composite policy — the anonymous composite-policy AND. In
    /// order (all bound to the same pseudonymous accessor): policy set (else `RoomPolicyNotSet`); not revoked
    /// (else `AccessRevoked`); valid DR2 membership grant if required (else `MembershipRequired`); compliance
    /// gate grants it if `policy.compliance_gate` set (else `NotCompliant`); accredited gate likewise (else
    /// `NotAccredited`). Gate cross-calls use `try_is_granted` (fail-closed). Records an `Admission` + emits.
    /// Permissionless (the membership leg's NEW-5 holder sig already authenticated the accessor off-chain).
    pub fn request_room_admission(
        env: Env,
        room_id: BytesN<32>,
        accessor: BytesN<32>,
    ) -> Result<Admission, DataRoomError> {
        load_config(&env)?;
        let pstore = env.storage().persistent();

        // (1) policy must be set (room existence is implied: a policy can only be set on an existing room).
        let policy: RoomPolicy = pstore
            .get(&DataKey::RoomPolicy(room_id.clone()))
            .ok_or(DataRoomError::RoomPolicyNotSet)?;

        // (2) explicit revocation check (clearer error than the is_granted=false path below).
        if pstore.has(&DataKey::Revoked(room_id.clone(), accessor.clone())) {
            return Err(DataRoomError::AccessRevoked);
        }

        // (3) membership — the anonymity spine (always required for an anonymous admission).
        if policy.require_membership && !Self::is_granted(env.clone(), room_id.clone(), accessor.clone()) {
            return Err(DataRoomError::MembershipRequired);
        }

        // (4) compliance leg (KYC ∧ not-sanctioned), cross-called live, fail-closed.
        let required_compliance = policy.compliance_gate.is_some();
        if let Some(gate) = policy.compliance_gate {
            let granted = matches!(
                GateClient::new(&env, &gate).try_is_granted(&accessor),
                Ok(Ok(true))
            );
            if !granted {
                return Err(DataRoomError::NotCompliant);
            }
        }

        // (5) accredited leg, cross-called live, fail-closed.
        let required_accredited = policy.accredited_gate.is_some();
        if let Some(gate) = policy.accredited_gate {
            let granted = matches!(
                GateClient::new(&env, &gate).try_is_granted(&accessor),
                Ok(Ok(true))
            );
            if !granted {
                return Err(DataRoomError::NotAccredited);
            }
        }

        // (6) record the admission (append-only log + per-accessor) + emit. DEDUP: since this call is
        // permissionless, append to the room's admission LOG only on the FIRST admission for an accessor
        // (so it can't be re-called to inflate the log/count); a re-admission just refreshes the
        // per-accessor record at its original log index.
        let prior: Option<Admission> = pstore.get(&DataKey::Admission(room_id.clone(), accessor.clone()));
        let index: u32 = match &prior {
            Some(a) => {
                // Re-admission: keep the original log slot but still re-extend the log + count TTLs so the
                // whole admission record set ages TOGETHER with the per-accessor record (else a long-lived
                // room refreshed only via re-admission could evict AdmissionLog/AdmissionCount while the
                // Admission record persists — an audit-log read asymmetry). Guard with `has` first:
                // `extend_ttl` traps on an absent/archived entry, and a record written by a PRIOR wasm (which
                // did not re-extend these) could have outlived them — skip rather than trap on legacy state.
                if pstore.has(&DataKey::AdmissionLog(room_id.clone(), a.index)) {
                    pstore.extend_ttl(&DataKey::AdmissionLog(room_id.clone(), a.index), THRESHOLD, BUMP);
                }
                if pstore.has(&DataKey::AdmissionCount(room_id.clone())) {
                    pstore.extend_ttl(&DataKey::AdmissionCount(room_id.clone()), THRESHOLD, BUMP);
                }
                a.index
            }
            None => {
                let i: u32 = pstore.get(&DataKey::AdmissionCount(room_id.clone())).unwrap_or(0);
                pstore.set(&DataKey::AdmissionLog(room_id.clone(), i), &accessor);
                pstore.extend_ttl(&DataKey::AdmissionLog(room_id.clone(), i), THRESHOLD, BUMP);
                pstore.set(&DataKey::AdmissionCount(room_id.clone()), &i.saturating_add(1));
                pstore.extend_ttl(&DataKey::AdmissionCount(room_id.clone()), THRESHOLD, BUMP);
                i
            }
        };
        let admission = Admission {
            index,
            room_id: room_id.clone(),
            accessor: accessor.clone(),
            required_compliance,
            required_accredited,
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        pstore.set(&DataKey::Admission(room_id.clone(), accessor.clone()), &admission);
        pstore.extend_ttl(&DataKey::Admission(room_id.clone(), accessor.clone()), THRESHOLD, BUMP);
        bump_instance(&env);

        RoomAdmitted {
            room_id,
            accessor,
            required_compliance,
            required_accredited,
            index,
        }
        .publish(&env);

        Ok(admission)
    }

    /// Surgically revoke (`revoked = true`) or restore (`false`) an accessor in a room (room-owner auth). A
    /// revoked accessor's DR2 `is_granted` returns false at once → the DR3 keypers refuse shares and
    /// `is_admitted` drops — without re-pinning the eligible root (others unaffected) or a guest change. The
    /// revoked member can't re-enter (their room nullifier is spent). Rotate the committee doc so already-held
    /// shares are useless against the new ciphertext.
    pub fn revoke_access(env: Env, room_id: BytesN<32>, accessor: BytesN<32>, revoked: bool) {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, DataRoomError::RoomNotFound));
        room.owner.require_auth();
        if revoked {
            pstore.set(&DataKey::Revoked(room_id.clone(), accessor.clone()), &true);
            pstore.extend_ttl(&DataKey::Revoked(room_id.clone(), accessor.clone()), THRESHOLD, BUMP);
        } else {
            pstore.remove(&DataKey::Revoked(room_id.clone(), accessor.clone()));
        }
        bump_instance(&env);

        AccessRevocationChanged {
            room_id,
            accessor,
            revoked,
        }
        .publish(&env);
    }

    /// Rotate a committee document's key in place (room-owner auth): the dealer re-split a FRESH K′ to the
    /// keypers and re-encrypted the blob, so this records the new `content_hash`, `sha256(K′)` commitment, and
    /// `blob_pointer`, and bumps `KeyEpoch`. The doc must exist (else `CommitteeDocNotFound`). Honest members
    /// re-collect new shares (grant still valid) → K′; a revoked member's `is_granted` is false so keypers
    /// refuse, and the old K is useless against the re-encrypted blob. No on-chain key material, no ZK here.
    pub fn rotate_committee_document(
        env: Env,
        room_id: BytesN<32>,
        doc_id: BytesN<32>,
        content_hash: BytesN<32>,
        k_commitment: BytesN<32>,
        blob_pointer: Bytes,
    ) -> Result<CommitteeDocument, DataRoomError> {
        load_config(&env)?;
        let pstore = env.storage().persistent();
        let room: Room = pstore
            .get(&DataKey::Room(room_id.clone()))
            .ok_or(DataRoomError::RoomNotFound)?;
        room.owner.require_auth();
        let existing: CommitteeDocument = pstore
            .get(&DataKey::CommitteeDoc(room_id.clone(), doc_id.clone()))
            .ok_or(DataRoomError::CommitteeDocNotFound)?;

        // Bump the key epoch (absent ⇒ original key 0 ⇒ first rotation is 1).
        let key_epoch: u32 = pstore
            .get::<_, u32>(&DataKey::KeyEpoch(room_id.clone(), doc_id.clone()))
            .unwrap_or(0)
            .saturating_add(1);

        // Update the record in place (struct shape unchanged — index/room/doc preserved; key material replaced).
        let doc = CommitteeDocument {
            index: existing.index,
            room_id: room_id.clone(),
            doc_id: doc_id.clone(),
            content_hash: content_hash.clone(),
            k_commitment: k_commitment.clone(),
            blob_pointer,
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        pstore.set(&DataKey::CommitteeDoc(room_id.clone(), doc_id.clone()), &doc);
        pstore.extend_ttl(&DataKey::CommitteeDoc(room_id.clone(), doc_id.clone()), THRESHOLD, BUMP);
        pstore.set(&DataKey::KeyEpoch(room_id.clone(), doc_id.clone()), &key_epoch);
        pstore.extend_ttl(&DataKey::KeyEpoch(room_id.clone(), doc_id.clone()), THRESHOLD, BUMP);
        bump_instance(&env);

        CommitteeKeyRotated {
            room_id,
            doc_id,
            content_hash,
            k_commitment,
            key_epoch,
        }
        .publish(&env);

        Ok(doc)
    }

    // ---- reads ----

    pub fn get_room(env: Env, room_id: BytesN<32>) -> Option<Room> {
        env.storage().persistent().get(&DataKey::Room(room_id))
    }

    pub fn get_room_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::RoomCount).unwrap_or(0)
    }

    pub fn get_document(env: Env, room_id: BytesN<32>, doc_id: BytesN<32>) -> Option<Document> {
        env.storage().persistent().get(&DataKey::Doc(room_id, doc_id))
    }

    pub fn get_doc_count(env: Env, room_id: BytesN<32>) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::DocCount(room_id))
            .unwrap_or(0)
    }

    /// The document at the room's log position `index` (0-based), if any.
    pub fn get_doc_by_index(env: Env, room_id: BytesN<32>, index: u32) -> Option<Document> {
        let doc_id: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::DocLog(room_id.clone(), index))?;
        env.storage().persistent().get(&DataKey::Doc(room_id, doc_id))
    }

    pub fn get_config(env: Env) -> Config {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e))
    }

    // ---- DR2 reads ----

    /// True iff this accessor holds a **currently-valid** access grant in the room: it is NOT revoked
    /// (DR6 `revoke_access`), a grant exists, AND it was proven against the room's CURRENT eligible root
    /// (`grant.eligible_root == room's EligibleRoot`). Re-pinning the root (`set_eligible_root`, e.g.
    /// rotating the whole set) immediately revokes stale grants; DR6 `revoke_access` revokes one accessor
    /// surgically. This is the live access decision a relying party (or the DR3 keypers) should gate on, so
    /// a revoked accessor is refused key shares at once. `get_grant` returns the raw record regardless.
    pub fn is_granted(env: Env, room_id: BytesN<32>, accessor: BytesN<32>) -> bool {
        let pstore = env.storage().persistent();
        // DR6: a surgically-revoked accessor is denied immediately (keypers + is_admitted gate on this).
        if pstore.has(&DataKey::Revoked(room_id.clone(), accessor.clone())) {
            return false;
        }
        let grant: Option<Grant> = pstore.get(&DataKey::Grant(room_id.clone(), accessor));
        match grant {
            Some(g) => match pstore.get::<_, BytesN<32>>(&DataKey::EligibleRoot(room_id)) {
                Some(root) => g.eligible_root == root,
                None => false,
            },
            None => false,
        }
    }

    /// The raw stored grant for (room_id, accessor), regardless of root rotation (use `is_granted` for the
    /// freshness-aware live decision).
    pub fn get_grant(env: Env, room_id: BytesN<32>, accessor: BytesN<32>) -> Option<Grant> {
        env.storage().persistent().get(&DataKey::Grant(room_id, accessor))
    }

    /// Number of access grants in a room's append-only grant log.
    pub fn get_grant_count(env: Env, room_id: BytesN<32>) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::GrantCount(room_id))
            .unwrap_or(0)
    }

    /// The grant at the room's grant-log position `index` (0-based), if any.
    pub fn get_grant_by_index(env: Env, room_id: BytesN<32>, index: u32) -> Option<Grant> {
        let accessor: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::GrantLog(room_id.clone(), index))?;
        env.storage().persistent().get(&DataKey::Grant(room_id, accessor))
    }

    /// True iff `nullifier` has already been spent in `room_id` (a second access from the same identity
    /// would be rejected `NullifierUsed`).
    pub fn is_nullifier_used(env: Env, room_id: BytesN<32>, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(room_id, nullifier))
    }

    /// A room's pinned eligible-set Merkle root, if set.
    pub fn get_eligible_root(env: Env, room_id: BytesN<32>) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::EligibleRoot(room_id))
    }

    /// The pinned canonical membership guest image_id, if membership has been enabled.
    pub fn get_membership_image_id(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::MembershipImageId)
    }

    // ---- DR3 reads ----

    /// The committee document anchored at (room_id, doc_id), if any.
    pub fn get_committee_document(
        env: Env,
        room_id: BytesN<32>,
        doc_id: BytesN<32>,
    ) -> Option<CommitteeDocument> {
        env.storage()
            .persistent()
            .get(&DataKey::CommitteeDoc(room_id, doc_id))
    }

    /// Number of committee documents anchored in a room.
    pub fn get_committee_doc_count(env: Env, room_id: BytesN<32>) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::CommitteeDocCount(room_id))
            .unwrap_or(0)
    }

    /// The committee document at the room's committee-doc-log position `index` (0-based), if any.
    pub fn get_committee_doc_by_index(
        env: Env,
        room_id: BytesN<32>,
        index: u32,
    ) -> Option<CommitteeDocument> {
        let doc_id: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::CommitteeDocLog(room_id.clone(), index))?;
        env.storage()
            .persistent()
            .get(&DataKey::CommitteeDoc(room_id, doc_id))
    }

    // ---- DR4 reads ----

    /// The proven document fact for (room_id, msg_digest), if any. Anyone can read it (and re-verify the
    /// proof off-chain); it reveals only the predicate, the threshold, the issuer key hash, and the doc hash.
    pub fn get_document_fact(
        env: Env,
        room_id: BytesN<32>,
        msg_digest: BytesN<32>,
    ) -> Option<DocumentFact> {
        env.storage()
            .persistent()
            .get(&DataKey::DocFact(room_id, msg_digest))
    }

    /// Number of document facts anchored in a room.
    pub fn get_doc_fact_count(env: Env, room_id: BytesN<32>) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::DocFactCount(room_id))
            .unwrap_or(0)
    }

    /// The document fact at the room's fact-log position `index` (0-based), if any.
    pub fn get_doc_fact_by_index(
        env: Env,
        room_id: BytesN<32>,
        index: u32,
    ) -> Option<DocumentFact> {
        let msg_digest: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::DocFactLog(room_id.clone(), index))?;
        env.storage()
            .persistent()
            .get(&DataKey::DocFact(room_id, msg_digest))
    }

    /// The pinned canonical docauth guest image_id, if DR4 document-authenticity has been enabled.
    pub fn get_docauth_image_id(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::DocAuthImageId)
    }

    /// True iff `issuer_key_hash` (= sha256 of an RSA modulus) is an allowlisted third-party issuer.
    pub fn is_docauth_issuer_allowed(env: Env, issuer_key_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::DocAuthIssuer(issuer_key_hash))
    }

    // ---- DR5 reads ----

    /// The teaser anchored for (room_id, doc_id), if any. Anyone can read it (and re-verify the proof
    /// off-chain); it reveals only the predicate, the threshold, the appraiser key, and the document hash.
    pub fn get_teaser(env: Env, room_id: BytesN<32>, doc_id: BytesN<32>) -> Option<Teaser> {
        env.storage().persistent().get(&DataKey::Teaser(room_id, doc_id))
    }

    /// Number of teasers anchored in a room.
    pub fn get_teaser_count(env: Env, room_id: BytesN<32>) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::TeaserCount(room_id))
            .unwrap_or(0)
    }

    /// The teaser at the room's teaser-log position `index` (0-based), if any.
    pub fn get_teaser_by_index(env: Env, room_id: BytesN<32>, index: u32) -> Option<Teaser> {
        let doc_id: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::TeaserLog(room_id.clone(), index))?;
        env.storage().persistent().get(&DataKey::Teaser(room_id, doc_id))
    }

    /// True iff a teaser exists for (room_id, doc_id) AND it has not expired (the live "is this fact still
    /// advertised" decision; `get_teaser` returns the raw record regardless of expiry). NOTE: this does NOT
    /// re-check that `teaser.attester` is *still* allowlisted (removing an appraiser revokes only FUTURE
    /// teasers — like DR4's issuer removal). A consumer wanting a fully-live trust decision should also call
    /// `is_teaser_attester_allowed(get_teaser(..).attester)`.
    pub fn is_teaser_valid(env: Env, room_id: BytesN<32>, doc_id: BytesN<32>) -> bool {
        let t: Option<Teaser> = env.storage().persistent().get(&DataKey::Teaser(room_id, doc_id));
        match t {
            Some(teaser) => teaser.expiry > env.ledger().timestamp(),
            None => false,
        }
    }

    /// True iff `attester` (an ed25519 public key) is an allowlisted teaser appraiser.
    pub fn is_teaser_attester_allowed(env: Env, attester: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::TeaserAttester(attester))
    }

    /// The pinned canonical DR5 teaser guest image_id, if teasers have been enabled.
    pub fn get_teaser_image_id(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::TeaserImageId)
    }

    // ---- DR6 reads ----

    /// A room's composite-admission policy, if set.
    pub fn get_room_policy(env: Env, room_id: BytesN<32>) -> Option<RoomPolicy> {
        env.storage().persistent().get(&DataKey::RoomPolicy(room_id))
    }

    /// The composed admission decision (live). True iff the room has a policy and/or a Bonded Access
    /// requirement AND `accessor` currently satisfies every enabled leg: not revoked; EITHER a satisfied bond
    /// leg (which ALSO proves room membership — Option A) when a `BondReq` is set, OR a valid DR2 membership
    /// grant (if the policy requires it); and the configured compliance/accredited gates each currently grant
    /// it (cross-called live, fail-closed). Drops the moment any leg is revoked or expires; does NOT require a
    /// prior `request_room_admission`.
    pub fn is_admitted(env: Env, room_id: BytesN<32>, accessor: BytesN<32>) -> bool {
        let pstore = env.storage().persistent();
        let bond_req: Option<BondRequirement> = pstore.get(&DataKey::BondReq(room_id.clone()));
        let policy: Option<RoomPolicy> = pstore.get(&DataKey::RoomPolicy(room_id.clone()));
        // Nothing configured -> not admitted (unchanged: is_admitted requires explicit config).
        if bond_req.is_none() && policy.is_none() {
            return false;
        }
        // Revocation drops access regardless of the legs (matches `request_room_admission`).
        if pstore.has(&DataKey::Revoked(room_id.clone(), accessor.clone())) {
            return false;
        }
        match &bond_req {
            // Bond implies membership (Option A): the bond leg REPLACES the DR2 membership spine.
            Some(req) => {
                if !bond_leg_ok(&env, &room_id, req, &accessor) {
                    return false;
                }
            }
            // No bond requirement: the existing membership spine (if the policy requires it).
            None => {
                if let Some(p) = &policy {
                    if p.require_membership
                        && !Self::is_granted(env.clone(), room_id.clone(), accessor.clone())
                    {
                        return false;
                    }
                }
            }
        }
        // Additional compliance/accredited legs from the policy (if any), ANDed on top.
        if let Some(p) = policy {
            if let Some(gate) = p.compliance_gate {
                if !matches!(
                    GateClient::new(&env, &gate).try_is_granted(&accessor),
                    Ok(Ok(true))
                ) {
                    return false;
                }
            }
            if let Some(gate) = p.accredited_gate {
                if !matches!(
                    GateClient::new(&env, &gate).try_is_granted(&accessor),
                    Ok(Ok(true))
                ) {
                    return false;
                }
            }
        }
        true
    }

    /// The composed PER-DOCUMENT admission decision (live) — the Pattern-2 self-serve key-release gate the
    /// DR3 keypers read. The effective **Bonded Access requirement** is `BondReqDoc(room, doc)` if set, else
    /// `BondReq(room)`; the effective **policy** is `DocPolicy(room, doc)` if set, else `RoomPolicy(room)`.
    /// If a bond requirement is set, its bond leg REPLACES the DR2 membership spine (a satisfied bond proof
    /// also proves membership — Option A); otherwise the policy's membership spine applies. If NEITHER a bond
    /// requirement NOR a policy is set, access falls back to the bare DR2 membership grant (`is_granted`) so
    /// PRE-Bonded committee documents keep their original behavior (no migration). Then the same compliance/
    /// accredited AND as `is_admitted`. Not revoked is enforced first. Fail-closed throughout (`try_*`); drops
    /// the moment any leg is revoked, expires, or the room's eligible_root is rotated away.
    pub fn is_doc_admitted(
        env: Env,
        room_id: BytesN<32>,
        doc_id: BytesN<32>,
        accessor: BytesN<32>,
    ) -> bool {
        let pstore = env.storage().persistent();
        // Revocation drops access first, regardless of which legs the effective config has.
        if pstore.has(&DataKey::Revoked(room_id.clone(), accessor.clone())) {
            return false;
        }
        // Effective bond requirement: per-document, else per-room.
        let bond_req: Option<BondRequirement> =
            match pstore.get(&DataKey::BondReqDoc(room_id.clone(), doc_id.clone())) {
                Some(r) => Some(r),
                None => pstore.get(&DataKey::BondReq(room_id.clone())),
            };
        // Effective policy: per-document, else per-room.
        let policy: Option<RoomPolicy> =
            match pstore.get(&DataKey::DocPolicy(room_id.clone(), doc_id.clone())) {
                Some(p) => Some(p),
                None => pstore.get(&DataKey::RoomPolicy(room_id.clone())),
            };
        // Neither configured -> the bare DR2 membership fallback (legacy docs unchanged).
        if bond_req.is_none() && policy.is_none() {
            return Self::is_granted(env.clone(), room_id, accessor);
        }
        match &bond_req {
            // Bond implies membership (Option A): the bond leg REPLACES the DR2 membership spine.
            Some(req) => {
                if !bond_leg_ok(&env, &room_id, req, &accessor) {
                    return false;
                }
            }
            // No bond requirement: the existing membership spine (if the policy requires it).
            None => {
                if let Some(p) = &policy {
                    if p.require_membership
                        && !Self::is_granted(env.clone(), room_id.clone(), accessor.clone())
                    {
                        return false;
                    }
                }
            }
        }
        // Additional compliance/accredited legs from the policy (if any), ANDed on top.
        if let Some(p) = policy {
            if let Some(gate) = p.compliance_gate {
                if !matches!(
                    GateClient::new(&env, &gate).try_is_granted(&accessor),
                    Ok(Ok(true))
                ) {
                    return false;
                }
            }
            if let Some(gate) = p.accredited_gate {
                if !matches!(
                    GateClient::new(&env, &gate).try_is_granted(&accessor),
                    Ok(Ok(true))
                ) {
                    return false;
                }
            }
        }
        true
    }

    /// A committee document's per-document policy, if set (else access falls back to the room policy, then
    /// membership; see `is_doc_admitted`). Public config.
    pub fn get_doc_policy(
        env: Env,
        room_id: BytesN<32>,
        doc_id: BytesN<32>,
    ) -> Option<RoomPolicy> {
        env.storage()
            .persistent()
            .get(&DataKey::DocPolicy(room_id, doc_id))
    }

    /// True iff `accessor` has been surgically revoked in this room (`revoke_access`).
    pub fn is_access_revoked(env: Env, room_id: BytesN<32>, accessor: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Revoked(room_id, accessor))
    }

    /// The raw stored admission record (audit; use `is_admitted` for the live decision).
    pub fn get_admission(env: Env, room_id: BytesN<32>, accessor: BytesN<32>) -> Option<Admission> {
        env.storage()
            .persistent()
            .get(&DataKey::Admission(room_id, accessor))
    }

    /// Number of admissions in a room's append-only admission log.
    pub fn get_admission_count(env: Env, room_id: BytesN<32>) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::AdmissionCount(room_id))
            .unwrap_or(0)
    }

    /// The admission at the room's admission-log position `index` (0-based), if any.
    pub fn get_admission_by_index(env: Env, room_id: BytesN<32>, index: u32) -> Option<Admission> {
        let accessor: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::AdmissionLog(room_id.clone(), index))?;
        env.storage()
            .persistent()
            .get(&DataKey::Admission(room_id, accessor))
    }

    /// A committee document's current key-rotation epoch (0 = original key; bumped on each rotate).
    pub fn get_committee_key_epoch(env: Env, room_id: BytesN<32>, doc_id: BytesN<32>) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::KeyEpoch(room_id, doc_id))
            .unwrap_or(0)
    }

    // ---- admin (require_auth) ----

    pub fn set_image_id(env: Env, seal_image_id: BytesN<32>) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.seal_image_id = seal_image_id;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    pub fn set_verifier(env: Env, verifier: Address) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.verifier = verifier;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Pin (or re-pin) the canonical DR2 membership guest image_id (claim_type 9). Admin-gated. Enables
    /// `request_access`; until set, `request_access` rejects every proof (`ImageMismatch`, fail-closed).
    /// Stored under its OWN `DataKey` (not in `Config`) so the DR1 Config struct shape is preserved across
    /// the in-place upgrade.
    pub fn set_membership_image_id(env: Env, membership_image_id: BytesN<32>) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::MembershipImageId, &membership_image_id);
        bump_instance(&env);
    }

    /// Pin (or re-pin) the canonical DR4 docauth guest image_id (claim_type 10). Admin-gated. Enables
    /// `attest_document_fact`; until set, it rejects every proof (`ImageMismatch`, fail-closed). Stored under
    /// its OWN `DataKey` (not in `Config`) so the existing stored shapes are preserved across the in-place
    /// upgrade.
    pub fn set_docauth_image_id(env: Env, docauth_image_id: BytesN<32>) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::DocAuthImageId, &docauth_image_id);
        bump_instance(&env);
    }

    /// Add (`allowed = true`) or remove (`allowed = false`) an allowlisted third-party docauth issuer, keyed
    /// by `issuer_key_hash = sha256(RSA modulus n)`. Admin-gated. This is the trust anchor for DR4: only facts
    /// signed by an allowlisted issuer (a KNOWN bank/authority) are accepted, so a self-minted RSA key can't
    /// forge "third-party truth". Removing a key revokes future attestations from it (existing facts persist).
    pub fn set_docauth_issuer(env: Env, issuer_key_hash: BytesN<32>, allowed: bool) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        let pstore = env.storage().persistent();
        if allowed {
            pstore.set(&DataKey::DocAuthIssuer(issuer_key_hash.clone()), &true);
            pstore.extend_ttl(&DataKey::DocAuthIssuer(issuer_key_hash), THRESHOLD, BUMP);
        } else {
            pstore.remove(&DataKey::DocAuthIssuer(issuer_key_hash));
        }
        bump_instance(&env);
    }

    /// Pin (or re-pin) the canonical DR5 teaser guest image_id (the generic value≥threshold guest, claim_type
    /// 11). Admin-gated. Enables `attest_teaser`; until set, it rejects every proof (`ImageMismatch`,
    /// fail-closed). Stored under its OWN `DataKey` (not in `Config`) so the existing stored shapes are
    /// preserved across the in-place upgrade.
    pub fn set_teaser_image_id(env: Env, teaser_image_id: BytesN<32>) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::TeaserImageId, &teaser_image_id);
        bump_instance(&env);
    }

    /// Add (`allowed = true`) or remove (`allowed = false`) an allowlisted "data-room appraiser" teaser
    /// attester, keyed by its ed25519 public key. Admin-gated. This is the trust anchor for DR5 teasers: only
    /// facts vouched by an allowlisted appraiser are accepted, so a self-minted key can't forge a public fact.
    /// Removing a key revokes future teasers from it (existing teasers persist).
    pub fn set_teaser_attester(env: Env, attester: BytesN<32>, allowed: bool) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        let pstore = env.storage().persistent();
        if allowed {
            pstore.set(&DataKey::TeaserAttester(attester.clone()), &true);
            pstore.extend_ttl(&DataKey::TeaserAttester(attester), THRESHOLD, BUMP);
        } else {
            pstore.remove(&DataKey::TeaserAttester(attester));
        }
        bump_instance(&env);
    }

    /// Admin-gated, in-place WASM upgrade (same native `update_current_contract_wasm` mechanism as the
    /// other zkorage contracts). Storage is preserved, so new code MUST keep existing `DataKey`/struct
    /// shapes (add keys; never rename or retype) — this is what lets DR2–DR4 extend the room in place.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, operator: Address) {
        let cfg = load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        if operator != cfg.admin {
            panic_with_error!(&env, DataRoomError::NotAdmin);
        }
        operator.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        bump_instance(&env);
    }
}

#[cfg(test)]
mod test;
