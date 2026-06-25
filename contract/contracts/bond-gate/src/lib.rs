//! # zkorage bond-gate contract (BA1 — anonymous per-requirement Bonded Access)
//!
//! The generalized successor to the BP5 tier-gate. Where the tier-gate hard-codes ONE token + ONE
//! `(threshold, X)` tier, the bond-gate keys everything by a **requirement id**:
//!
//!   `req_id = sha256(token(32) ‖ min_amount(i128, 16 BE) ‖ deadline(u64, 8 BE))`
//!
//! so each Data Room document/room can require its OWN bond (token, minimum amount, deadline) and many
//! requirements coexist in one contract. It binds a RISC Zero proof (claim_type 14) that asserts, WITHOUT
//! revealing which wallet / which lock / the exact amount, that the prover:
//!   1. is an enrolled member of `member_root` (a Merkle root the prover proved a path into), AND
//!   2. controls a bonded lock whose commitment is in `qual_root` (the indexer-published Merkle root over
//!      the commitments of every escrow lock that currently satisfies `token == req.token ∧ amount >=
//!      req.min_amount ∧ unlock_time >= req.deadline ∧ still-locked ∧ non-revocable`), AND
//!   3. a per-requirement nullifier (one UNLINKABLE grant per identity per requirement).
//!
//! ## Bond-implies-membership (Option A) — the gate is GENERALIZED, so it does NOT pin a member root
//! Unlike the tier-gate (which pins ONE enrolled-member set), the bond-gate serves many rooms, so it cannot
//! pin a single `member_root`. Instead it RECORDS the `member_root` the proof was checked against in the
//! grant, and the relying party (the DataRoom) supplies the room's authoritative eligible_root at read time
//! via the 3-arg [`is_granted_for`]. A grant therefore implies "enrolled member of the set whose root I
//! recorded" — and the DataRoom admits only when that recorded root equals the room's CURRENT eligible_root.
//! Soundness: a grant proven against a fake member set has `member_root != room.eligible_root` (so it admits
//! nobody), and forging a Merkle path to the room's REAL root requires being enrolled (sha256 preimage
//! resistance). Re-pinning the room's eligible_root rotates the binding, so stale grants drop (like DR2).
//!
//! ## Freshness is deadline-encoded (`now < deadline`) — and that is SOUND here
//! Qualifying locks are created NON-revocable (no early `unbond`), so "before the deadline" provably means
//! "still funded". The gate therefore never reads a specific lock (which would de-anonymize the member); it
//! relies only on `now < deadline` (on-chain time) + the proof. The grant is recorded with expiry = deadline
//! and [`is_granted_for`] is a pure deadline read. Why accepting an OLDER ring root stays sound: a
//! non-revocable, extend-only qualifying lock cannot LEAVE the set while `now < deadline` (withdraw/claim need
//! `now >= unlock_time >= deadline`), and the gate's own `now < deadline` freshness check covers the boundary.
//! This DEPENDS on the escrow being non-revocable + extend-only — never point the gate at an early-exit escrow.
//!
//! ## qual_root trust + bond-token precondition + anonymity floor
//! `qual_root` is published per `req_id` by an indexer (admin) via `set_qual_root` and is PUBLICLY AUDITABLE
//! (anyone recomputes it from the escrow's public `get_lock` state; the SDK ships a recompute). The gate keeps
//! a small RING of the last `RING_CAP` accepted roots per requirement (kills the publish-then-prove race).
//! Because the gate reads NO lock, the configured bond token MUST be clawback-disabled and not AUTH_REQUIRED
//! (enforced off-chain). A qualifying set of size 1 de-anonymizes by elimination, so the minimum-N floor is
//! enforced OFF-CHAIN (indexer refuses a root below N; backend refuses a proof below N; the UI warns).
//!
//! ## Permissionless submit (gasless for the anonymous member)
//! `submit_bond_proof` takes NO `require_auth`: the in-guest NEW-5 holder signature (`pk == accessor`, over
//! `DOMAIN ‖ context ‖ accessor`) is the accessor's off-chain consent, so a relayer can submit without the
//! member ever revealing or paying from a funded wallet. The grant is keyed to the consenting accessor.
//!
//! **Unaudited — demo only.**

#![no_std]

use risc0_interface::RiscZeroVerifierClient;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Bytes, BytesN, Env, Vec,
};

/// BA1 bond journal wire layout (221 bytes, big-endian). The member's identity (id_secret/id_trapdoor/which
/// leaf in either tree) is NEVER committed — that is the anonymity. The token + min_amount + deadline ARE
/// committed (they identify the requirement); they sit contiguously at [69..125] so `req_id` is exactly
/// `sha256(journal[69..125])`.
///   [0]         result        u8   = 1
///   [1..5]      claim_type     u32  = 14
///   [5..37]     member_root    [u8;32]  (the enrolled set the proof checked; DataRoom binds == room root)
///   [37..69]    qual_root      [u8;32]  (qualifying-lock set for req_id; gate pins ∈ its ring)
///   [69..101]   token          [u8;32]  (the bond token's 32-byte contract id)
///   [101..117]  min_amount     i128 (16 BE)  (the requirement's minimum amount; > 0 enforced)
///   [117..125]  deadline       u64  (8 BE)   (= the freshness boundary; gate checks now < deadline)
///   [125..157]  context        [u8;32]  (== external_nullifier; gate enforces context == req_id)
///   [157..189]  nullifier      [u8;32]  (gate records / rejects reuse → one grant per identity per req)
///   [189..221]  accessor       [u8;32]  (ed25519 grant target for is_granted_for; == the holder signing key)
const JOURNAL_LEN: u32 = 221;
const CLAIM_TYPE_BOND: u32 = 14;
/// The contiguous (token ‖ min_amount ‖ deadline) span hashed to form `req_id`.
const REQ_LO: usize = 69;
const REQ_HI: usize = 125;

/// TRUE bond-only (no-approval) Bonded Access — the `bond_open_predicate` guest (claim_type 15). Same 221-byte
/// length, but the layout DROPS the member tree and ADDS a proof-bound `recipient_pub`, so a reader opens a
/// room with NO owner approval and NO membership enrollment. The req_id span (token ‖ min_amount ‖ deadline)
/// is byte-identical to `bond_predicate`'s, so the SAME `QualRing(req_id)` applies — one indexer serves both.
/// bond-open journal wire layout (221 bytes, big-endian):
///   [0]result · [1..5]claim_type(15) · [5..37]qual_root · [37..69]token · [69..85]min_amount(i128 16 BE) ·
///   [85..93]deadline(u64 8 BE) · [93..125]context · [125..157]nullifier · [157..189]accessor ·
///   [189..221]recipient_pub
const CLAIM_TYPE_BOND_OPEN: u32 = 15;
/// The contiguous (token ‖ min_amount ‖ deadline) span in the bond-OPEN journal hashed to form `req_id`.
const REQ_OPEN_LO: usize = 37;
const REQ_OPEN_HI: usize = 93;

/// How many recent accepted `qual_root`s the gate keeps per requirement (kills the publish-then-prove race).
/// Accepting an OLDER ring root stays sound (see the module docs): a non-revocable, extend-only qualifying
/// lock cannot LEAVE the set while `now < deadline` (withdraw/claim need `now >= unlock_time >= deadline`),
/// and the gate's own `now < deadline` freshness check covers the boundary.
const RING_CAP: u32 = 8;

// ~5s ledgers. Keep config + records comfortably alive for the demo window.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP: u32 = 30 * DAY_IN_LEDGERS;
const THRESHOLD: u32 = BUMP - DAY_IN_LEDGERS;

// Max page size for `get_history` — bounds a single read's storage footprint.
const MAX_PAGE: u32 = 50;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BondError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    ImageMismatch = 3,
    MalformedJournal = 4,
    ProofInvalid = 5,
    ResultNotTrue = 6,
    ClaimTypeMismatch = 7,
    /// `journal.qual_root` is not among the recent accepted roots for `req_id`.
    QualRootUnknown = 8,
    /// `now >= deadline`: the bonded deadline has passed (the lock is no longer provably still-funded).
    DeadlinePassed = 9,
    /// This nullifier was already used for a grant (one grant per identity per requirement).
    NullifierUsed = 10,
    /// `journal.context != req_id`: the nullifier domain was not bound to this exact requirement.
    ContextMismatch = 11,
    /// `min_amount <= 0`: a zero/negative floor is not a bond claim (closes a direct-submit bypass).
    BadMinAmount = 12,
    NotAdmin = 13,
    /// `submit_bond_open_proof` was called before the bond-OPEN guest image was pinned (`set_open_image_id`).
    OpenImageNotSet = 14,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    /// The recent accepted `qual_root` ring for a requirement keyed by `req_id` (persistent).
    QualRing(BytesN<32>),
    /// A used nullifier (persistent). Presence == used.
    Nullifier(BytesN<32>),
    /// The grant keyed by (accessor, req_id) (persistent). Presence == was admitted; validity is
    /// `now < deadline` AND the supplied member_root matches the recorded one (see `is_granted_for`).
    Grant(BytesN<32>, BytesN<32>),
    /// Latest grant (persistent).
    Latest,
    /// Total number of grants appended to the log (instance).
    Count,
    /// The i-th grant in the append-only history (persistent).
    Log(u32),
    // ---- TRUE bond-only (no-approval) path. SEPARATE keyspaces from the bond-implies-membership path above,
    // so a person can hold both an `is_granted` (membership-bound) grant AND an `is_open_granted` grant for
    // the same req_id without a false NullifierUsed collision. ----
    /// The pinned bond-OPEN guest image (persistent). Distinct from `Config.image_id` (the bond image).
    OpenImageId,
    /// A used bond-OPEN nullifier (persistent). Presence == used. Separate from `Nullifier`.
    NullifierOpen(BytesN<32>),
    /// A bond-OPEN grant keyed by (accessor, req_id) (persistent). Presence == admitted; validity is
    /// `now < deadline` (see `is_open_granted`). Carries the proof-bound `recipient_pub`.
    OpenGrant(BytesN<32>, BytesN<32>),
    /// Latest bond-OPEN grant (persistent).
    OpenLatest,
    /// Total number of bond-OPEN grants appended (instance).
    OpenCount,
    /// The i-th bond-OPEN grant in the append-only history (persistent).
    OpenLog(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub verifier: Address,
    pub image_id: BytesN<32>,
    pub claim_type: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondGrant {
    /// Position in the append-only history (0-based).
    pub index: u32,
    /// The consenting accessor's raw 32-byte ed25519 key (committed in-proof + bound by the in-guest holder
    /// sig). A public key, not a Soroban Address (mirrors the KYC gate / DataRoom convention).
    pub accessor: BytesN<32>,
    /// The requirement id = sha256(token ‖ min_amount ‖ deadline) this grant is bound to.
    pub req_id: BytesN<32>,
    /// The enrolled-member root the proof was checked against. The relying party binds this == its current
    /// member set at read time (the "bond implies membership" check). Re-pinning the set drops this grant.
    pub member_root: BytesN<32>,
    /// The bond token's 32-byte contract id (audit; component of req_id).
    pub token: BytesN<32>,
    /// The requirement's minimum amount (audit; component of req_id).
    pub min_amount: i128,
    /// = deadline: the bonded freshness boundary; ALSO this grant's expiry (`is_granted_for` true iff
    /// `now < deadline`).
    pub deadline: u64,
    /// The recorded nullifier (one grant per identity per requirement).
    pub nullifier: BytesN<32>,
    /// The qualifying-set root the proof was checked against (audit; recomputable from public state).
    pub qual_root: BytesN<32>,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct BondGranted {
    #[topic]
    pub accessor: BytesN<32>,
    #[topic]
    pub req_id: BytesN<32>,
    pub index: u32,
    pub min_amount: i128,
    pub deadline: u64,
    pub ledger: u32,
}

/// A TRUE bond-only grant (claim_type 15). Like `BondGrant` but it records NO `member_root` (there is no
/// membership requirement) and it DOES record the proof-bound `recipient_pub` the DR3 keepers seal the
/// document key to (read back via `get_open_recipient_pub`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondOpenGrant {
    /// Position in the bond-open append-only history (0-based).
    pub index: u32,
    /// The consenting accessor's raw 32-byte ed25519 key (committed in-proof + bound by the holder sig).
    pub accessor: BytesN<32>,
    /// The requirement id = sha256(token ‖ min_amount ‖ deadline) this grant is bound to.
    pub req_id: BytesN<32>,
    /// The bond token's 32-byte contract id (audit; component of req_id).
    pub token: BytesN<32>,
    /// The requirement's minimum amount (audit; component of req_id).
    pub min_amount: i128,
    /// = deadline: the bonded freshness boundary; ALSO this grant's expiry (`is_open_granted` true iff
    /// `now < deadline`).
    pub deadline: u64,
    /// The recorded bond-open nullifier (one grant per identity per requirement, separate keyspace).
    pub nullifier: BytesN<32>,
    /// The qualifying-set root the proof was checked against (audit; recomputable from public state).
    pub qual_root: BytesN<32>,
    /// The proof-bound x25519 receiving key the DR3 keepers seal the document key to (bound by the in-guest
    /// holder signature, so it cannot be swapped even though the accessor is public).
    pub recipient_pub: BytesN<32>,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct BondOpenGranted {
    #[topic]
    pub accessor: BytesN<32>,
    #[topic]
    pub req_id: BytesN<32>,
    pub index: u32,
    pub min_amount: i128,
    pub deadline: u64,
    pub ledger: u32,
}

#[contractevent]
pub struct QualRootSet {
    #[topic]
    pub req_id: BytesN<32>,
    pub qual_root: BytesN<32>,
    pub ring_len: u32,
}

fn load_config(env: &Env) -> Result<Config, BondError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(BondError::NotInitialized)
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(THRESHOLD, BUMP);
}

fn be_u32(a: &[u8; 221], o: usize) -> u32 {
    u32::from_be_bytes([a[o], a[o + 1], a[o + 2], a[o + 3]])
}

fn be_u64(a: &[u8; 221], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&a[o..o + 8]);
    u64::from_be_bytes(b)
}

fn be_i128(a: &[u8; 221], o: usize) -> i128 {
    let mut b = [0u8; 16];
    b.copy_from_slice(&a[o..o + 16]);
    i128::from_be_bytes(b)
}

fn bytes32(env: &Env, a: &[u8; 221], o: usize) -> BytesN<32> {
    let mut b = [0u8; 32];
    b.copy_from_slice(&a[o..o + 32]);
    BytesN::from_array(env, &b)
}

#[contract]
pub struct BondGate;

#[contractimpl]
impl BondGate {
    /// One-time setup. `verifier` is the deployed bare Groth16 verifier; `image_id` is the canonical bond
    /// guest image; `claim_type` is 14. Per-requirement qual roots are published afterwards (`set_qual_root`),
    /// so the gate fails closed (no accepted root) until an indexer publishes one.
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier: Address,
        image_id: BytesN<32>,
        claim_type: u32,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, BondError::AlreadyInitialized);
        }
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                verifier,
                image_id,
                claim_type,
            },
        );
        bump_instance(&env);
    }

    /// Verify an anonymous Bonded-Access proof, recompute `req_id` on-chain, bind it to a recent qualifying
    /// root + the deadline, reject nullifier reuse, and record a grant keyed to `(accessor, req_id)`. The
    /// `member_root` the proof checked is RECORDED (not pinned here) — the relying party binds it to its room
    /// at read time via `is_granted_for`. PERMISSIONLESS (the in-guest holder sig is the consent).
    pub fn submit_bond_proof(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
    ) -> Result<BondGrant, BondError> {
        let cfg = load_config(&env)?;

        // (1) image pin (the bare verifier is image-agnostic, so pinning is mandatory for soundness).
        if image_id != cfg.image_id {
            return Err(BondError::ImageMismatch);
        }

        // (2) recompute the journal digest on-chain (binds parsed fields to the proof).
        if journal.len() != JOURNAL_LEN {
            return Err(BondError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();

        // (3) cross-verify against the bare Groth16 verifier.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(BondError::ProofInvalid),
        }

        // (4) parse + policy-check the journal.
        let mut jb = [0u8; 221];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(BondError::ResultNotTrue);
        }
        let claim_type = be_u32(&jb, 1);
        if claim_type != cfg.claim_type || claim_type != CLAIM_TYPE_BOND {
            return Err(BondError::ClaimTypeMismatch);
        }
        let member_root = bytes32(&env, &jb, 5);
        let qual_root = bytes32(&env, &jb, 37);
        let token = bytes32(&env, &jb, 69);
        let min_amount = be_i128(&jb, 101);
        let deadline = be_u64(&jb, 117);
        let context = bytes32(&env, &jb, 125);
        let nullifier = bytes32(&env, &jb, 157);
        let accessor = bytes32(&env, &jb, 189);

        // (5) a zero/negative floor is not a bond claim (closes a direct-submit bypass of the backend guard).
        if min_amount <= 0 {
            return Err(BondError::BadMinAmount);
        }

        // (6) recompute req_id = sha256(token ‖ min_amount ‖ deadline) over the contiguous committed span,
        // and require the nullifier context to be bound to it (so the nullifier is per-requirement).
        let req_input = Bytes::from_slice(&env, &jb[REQ_LO..REQ_HI]);
        let req_id: BytesN<32> = env.crypto().sha256(&req_input).into();
        if context != req_id {
            return Err(BondError::ContextMismatch);
        }

        // (7) qualifying-set binding — the proven root must be a recent accepted root for THIS requirement.
        let ring: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::QualRing(req_id.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        if !ring.iter().any(|r| r == qual_root) {
            return Err(BondError::QualRootUnknown);
        }

        // (8) freshness — deadline-encoded (sound because qualifying locks are non-revocable).
        let now = env.ledger().timestamp();
        if now >= deadline {
            return Err(BondError::DeadlinePassed);
        }

        // (9) nullifier — one grant per identity per requirement.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier.clone()))
        {
            return Err(BondError::NullifierUsed);
        }

        // (10) record the nullifier + the grant (keyed to (accessor, req_id), expiring at deadline) + log + emit.
        let index: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let grant = BondGrant {
            index,
            accessor: accessor.clone(),
            req_id: req_id.clone(),
            member_root,
            token,
            min_amount,
            deadline,
            nullifier: nullifier.clone(),
            qual_root,
            ledger: env.ledger().sequence(),
            timestamp: now,
        };

        let pstore = env.storage().persistent();
        pstore.set(&DataKey::Nullifier(nullifier), &true);
        pstore.extend_ttl(&DataKey::Nullifier(grant.nullifier.clone()), THRESHOLD, BUMP);
        pstore.set(&DataKey::Log(index), &grant);
        pstore.extend_ttl(&DataKey::Log(index), THRESHOLD, BUMP);
        pstore.set(&DataKey::Latest, &grant);
        pstore.extend_ttl(&DataKey::Latest, THRESHOLD, BUMP);
        pstore.set(&DataKey::Grant(accessor.clone(), req_id.clone()), &grant);
        pstore.extend_ttl(
            &DataKey::Grant(accessor.clone(), req_id.clone()),
            THRESHOLD,
            BUMP,
        );
        env.storage()
            .instance()
            .set(&DataKey::Count, &index.saturating_add(1));
        bump_instance(&env);

        BondGranted {
            accessor,
            req_id,
            index,
            min_amount,
            deadline,
            ledger: grant.ledger,
        }
        .publish(&env);

        Ok(grant)
    }

    /// TRUE bond-only (no-approval) admission. Verifies a `bond_open_predicate` proof (claim_type 15),
    /// recompute `req_id`, bind it to a recent qualifying root + the deadline, reject bond-open nullifier
    /// reuse, and record a grant keyed to `(accessor, req_id)` that carries the proof-bound `recipient_pub`.
    /// NO `member_root` is recorded or required (that is what makes it approval-free). Reuses the SAME
    /// `QualRing(req_id)` as `submit_bond_proof` (identical req_id span), so one indexer serves both paths.
    /// PERMISSIONLESS (the in-guest holder sig is the consent).
    pub fn submit_bond_open_proof(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
    ) -> Result<BondOpenGrant, BondError> {
        let cfg = load_config(&env)?;

        // (1) image pin against the SEPARATE bond-open image (set via set_open_image_id). Fails closed if
        // the bond-open guest was never pinned.
        let open_image: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::OpenImageId)
            .ok_or(BondError::OpenImageNotSet)?;
        if image_id != open_image {
            return Err(BondError::ImageMismatch);
        }

        // (2) recompute the journal digest on-chain (binds parsed fields to the proof).
        if journal.len() != JOURNAL_LEN {
            return Err(BondError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();

        // (3) cross-verify against the bare Groth16 verifier.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(BondError::ProofInvalid),
        }

        // (4) parse + policy-check the bond-open journal layout.
        let mut jb = [0u8; 221];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(BondError::ResultNotTrue);
        }
        let claim_type = be_u32(&jb, 1);
        if claim_type != CLAIM_TYPE_BOND_OPEN {
            return Err(BondError::ClaimTypeMismatch);
        }
        let qual_root = bytes32(&env, &jb, 5);
        let token = bytes32(&env, &jb, 37);
        let min_amount = be_i128(&jb, 69);
        let deadline = be_u64(&jb, 85);
        let context = bytes32(&env, &jb, 93);
        let nullifier = bytes32(&env, &jb, 125);
        let accessor = bytes32(&env, &jb, 157);
        let recipient_pub = bytes32(&env, &jb, 189);

        // (5) a zero/negative floor is not a bond claim (closes a direct-submit bypass of the backend guard).
        if min_amount <= 0 {
            return Err(BondError::BadMinAmount);
        }

        // (6) recompute req_id over the bond-open contiguous span (token ‖ min_amount ‖ deadline), and require
        // the nullifier context to be bound to it (so the nullifier is per-requirement).
        let req_input = Bytes::from_slice(&env, &jb[REQ_OPEN_LO..REQ_OPEN_HI]);
        let req_id: BytesN<32> = env.crypto().sha256(&req_input).into();
        if context != req_id {
            return Err(BondError::ContextMismatch);
        }

        // (7) qualifying-set binding — the proven root must be a recent accepted root for THIS requirement
        // (the SAME ring the bond-implies-membership path publishes; identical req_id span).
        let ring: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::QualRing(req_id.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        if !ring.iter().any(|r| r == qual_root) {
            return Err(BondError::QualRootUnknown);
        }

        // (8) freshness — deadline-encoded (sound because qualifying locks are non-revocable).
        let now = env.ledger().timestamp();
        if now >= deadline {
            return Err(BondError::DeadlinePassed);
        }

        // (9) bond-open nullifier — one grant per identity per requirement (separate keyspace).
        if env
            .storage()
            .persistent()
            .has(&DataKey::NullifierOpen(nullifier.clone()))
        {
            return Err(BondError::NullifierUsed);
        }

        // (10) record the nullifier + the grant (keyed to (accessor, req_id), expiring at deadline) + log + emit.
        let index: u32 = env.storage().instance().get(&DataKey::OpenCount).unwrap_or(0);
        let grant = BondOpenGrant {
            index,
            accessor: accessor.clone(),
            req_id: req_id.clone(),
            token,
            min_amount,
            deadline,
            nullifier: nullifier.clone(),
            qual_root,
            recipient_pub,
            ledger: env.ledger().sequence(),
            timestamp: now,
        };

        let pstore = env.storage().persistent();
        pstore.set(&DataKey::NullifierOpen(nullifier), &true);
        pstore.extend_ttl(&DataKey::NullifierOpen(grant.nullifier.clone()), THRESHOLD, BUMP);
        pstore.set(&DataKey::OpenLog(index), &grant);
        pstore.extend_ttl(&DataKey::OpenLog(index), THRESHOLD, BUMP);
        pstore.set(&DataKey::OpenLatest, &grant);
        pstore.extend_ttl(&DataKey::OpenLatest, THRESHOLD, BUMP);
        pstore.set(&DataKey::OpenGrant(accessor.clone(), req_id.clone()), &grant);
        pstore.extend_ttl(
            &DataKey::OpenGrant(accessor.clone(), req_id.clone()),
            THRESHOLD,
            BUMP,
        );
        env.storage()
            .instance()
            .set(&DataKey::OpenCount, &index.saturating_add(1));
        bump_instance(&env);

        BondOpenGranted {
            accessor,
            req_id,
            index,
            min_amount,
            deadline,
            ledger: grant.ledger,
        }
        .publish(&env);

        Ok(grant)
    }

    // ---- reads ----

    /// **The live Bonded-Access decision the DataRoom reads.** True iff `accessor` holds a grant for `req_id`
    /// whose deadline has not passed (`now < deadline`) AND whose recorded `member_root` equals the supplied
    /// `member_root` (the relying party passes its CURRENT room eligible_root, so the bond proof implies
    /// membership of THIS room and a root rotation drops the grant). Deadline-encoded — sound because
    /// qualifying locks are non-revocable. Permissionless.
    pub fn is_granted_for(
        env: Env,
        accessor: BytesN<32>,
        req_id: BytesN<32>,
        member_root: BytesN<32>,
    ) -> bool {
        let grant: BondGrant = match env
            .storage()
            .persistent()
            .get(&DataKey::Grant(accessor, req_id))
        {
            Some(g) => g,
            None => return false,
        };
        env.ledger().timestamp() < grant.deadline && grant.member_root == member_root
    }

    /// The member-root-agnostic liveness read: true iff `accessor` holds an unexpired grant for `req_id`,
    /// regardless of which member set it was proven against. Use `is_granted_for` for the room-binding
    /// decision; this is for the standalone bonded-access view / debugging.
    pub fn is_granted(env: Env, accessor: BytesN<32>, req_id: BytesN<32>) -> bool {
        let grant: BondGrant = match env
            .storage()
            .persistent()
            .get(&DataKey::Grant(accessor, req_id))
        {
            Some(g) => g,
            None => return false,
        };
        env.ledger().timestamp() < grant.deadline
    }

    /// The raw stored grant for `(accessor, req_id)` (regardless of current validity — use `is_granted_for`
    /// for the live decision).
    pub fn get_grant(env: Env, accessor: BytesN<32>, req_id: BytesN<32>) -> Option<BondGrant> {
        env.storage().persistent().get(&DataKey::Grant(accessor, req_id))
    }

    /// **The live TRUE bond-only decision the DataRoom reads.** True iff `accessor` holds a bond-open grant
    /// for `req_id` whose deadline has not passed. There is NO `member_root` binding here (that is the point):
    /// a reader who proved a qualifying bond is admitted with no approval. Deadline-encoded (sound because
    /// qualifying locks are non-revocable). Permissionless.
    pub fn is_open_granted(env: Env, accessor: BytesN<32>, req_id: BytesN<32>) -> bool {
        let grant: BondOpenGrant = match env
            .storage()
            .persistent()
            .get(&DataKey::OpenGrant(accessor, req_id))
        {
            Some(g) => g,
            None => return false,
        };
        env.ledger().timestamp() < grant.deadline
    }

    /// The raw stored bond-open grant for `(accessor, req_id)`.
    pub fn get_open_grant(env: Env, accessor: BytesN<32>, req_id: BytesN<32>) -> Option<BondOpenGrant> {
        env.storage().persistent().get(&DataKey::OpenGrant(accessor, req_id))
    }

    /// The proof-bound `recipient_pub` for a bond-open grant (the 32 bytes the DR3 keepers seal to). Returns
    /// `None` if there is no grant. A cheap cross-contract read for the DataRoom's `admission_recipient_pub`.
    pub fn get_open_recipient_pub(
        env: Env,
        accessor: BytesN<32>,
        req_id: BytesN<32>,
    ) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get::<DataKey, BondOpenGrant>(&DataKey::OpenGrant(accessor, req_id))
            .map(|g| g.recipient_pub)
    }

    pub fn is_open_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::NullifierOpen(nullifier))
    }

    pub fn get_open_latest(env: Env) -> Option<BondOpenGrant> {
        env.storage().persistent().get(&DataKey::OpenLatest)
    }

    pub fn get_open_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::OpenCount).unwrap_or(0)
    }

    pub fn get_open_by_index(env: Env, index: u32) -> Option<BondOpenGrant> {
        env.storage().persistent().get(&DataKey::OpenLog(index))
    }

    pub fn is_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Nullifier(nullifier))
    }

    /// The recent accepted `qual_root` ring for a requirement (oldest first). Recomputable + auditable from
    /// public escrow state.
    pub fn get_qual_ring(env: Env, req_id: BytesN<32>) -> Vec<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::QualRing(req_id))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Whether a specific `qual_root` is currently accepted for a requirement.
    pub fn is_qual_root_accepted(env: Env, req_id: BytesN<32>, qual_root: BytesN<32>) -> bool {
        Self::get_qual_ring(env, req_id)
            .iter()
            .any(|r| r == qual_root)
    }

    pub fn get_latest(env: Env) -> Option<BondGrant> {
        env.storage().persistent().get(&DataKey::Latest)
    }

    pub fn get_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    pub fn get_by_index(env: Env, index: u32) -> Option<BondGrant> {
        env.storage().persistent().get(&DataKey::Log(index))
    }

    /// A page of the append-only history, in order, from `start` (0-based). `limit` clamped to `MAX_PAGE`.
    pub fn get_history(env: Env, start: u32, limit: u32) -> Vec<BondGrant> {
        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let lim = if limit > MAX_PAGE { MAX_PAGE } else { limit };
        let mut out: Vec<BondGrant> = Vec::new(&env);
        if lim == 0 || start >= count {
            return out;
        }
        let end = {
            let want = start.saturating_add(lim);
            if want < count { want } else { count }
        };
        let mut i = start;
        while i < end {
            if let Some(g) = env.storage().persistent().get(&DataKey::Log(i)) {
                out.push_back(g);
            }
            i += 1;
        }
        out
    }

    pub fn get_config(env: Env) -> Config {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e))
    }

    // ---- admin (require_auth) ----

    /// Publish the current `qual_root` for a requirement `req_id`. Appends to a bounded ring (most-recent
    /// `RING_CAP` kept). The root is publicly auditable: anyone recomputes it from the escrow's `get_lock`
    /// state and rejects a dishonest one. Admin-gated (the indexer operator). Idempotent: re-publishing the
    /// same head root is a no-op (no duplicate ring entry).
    pub fn set_qual_root(env: Env, req_id: BytesN<32>, qual_root: BytesN<32>) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        let key = DataKey::QualRing(req_id.clone());
        let mut ring: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        // No-op if it is already the most-recent root (avoids churning the ring on a re-publish).
        if ring.last().map(|r| r == qual_root).unwrap_or(false) {
            return;
        }
        ring.push_back(qual_root.clone());
        while ring.len() > RING_CAP {
            ring.remove(0);
        }
        let ring_len = ring.len();
        let p = env.storage().persistent();
        p.set(&key, &ring);
        p.extend_ttl(&key, THRESHOLD, BUMP);
        bump_instance(&env);

        QualRootSet {
            req_id,
            qual_root,
            ring_len,
        }
        .publish(&env);
    }

    pub fn set_image_id(env: Env, image_id: BytesN<32>) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.image_id = image_id;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Pin the canonical bond-OPEN guest image (claim_type 15), enabling `submit_bond_open_proof`. Stored
    /// separately from `Config.image_id` (the bond image). Admin-gated.
    pub fn set_open_image_id(env: Env, image_id: BytesN<32>) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        env.storage().instance().set(&DataKey::OpenImageId, &image_id);
        bump_instance(&env);
    }

    /// The pinned bond-OPEN guest image, if set (else `None` — `submit_bond_open_proof` fails closed).
    pub fn get_open_image_id(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::OpenImageId)
    }

    pub fn set_verifier(env: Env, verifier: Address) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.verifier = verifier;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Admin-gated, in-place WASM upgrade (same native `update_current_contract_wasm` mechanism as the other
    /// zkorage contracts). Storage preserved — new code MUST keep existing `DataKey`/struct shapes (add
    /// keys; never rename or retype).
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, operator: Address) {
        let cfg = load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        if operator != cfg.admin {
            panic_with_error!(&env, BondError::NotAdmin);
        }
        operator.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        bump_instance(&env);
    }
}

#[cfg(test)]
mod test;
