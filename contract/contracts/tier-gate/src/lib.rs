//! # zkorage tier-gate contract (BP5 — an anonymous bonded tier / membership expiring at X)
//!
//! The second Bonded-Proofs ZK product. Where BP3 (solvency) keeps the issuer PUBLIC and hides the reserve
//! composition, BP5 keeps the MEMBER anonymous. It binds a RISC Zero proof (claim_type 13) that asserts,
//! WITHOUT revealing which wallet / which lock / the exact amount:
//!   1. the prover is an enrolled member (`member_root`, an admin-pinned Merkle root), AND
//!   2. the prover controls a bonded lock that qualifies for a tier (`qual_root`, the indexer-published
//!      Merkle root over the commitments of all escrow locks that currently satisfy amount >= threshold ∧
//!      unlock_time >= X ∧ still-locked ∧ non-revocable), AND
//!   3. a per-context nullifier (one UNLINKABLE grant per identity per context).
//!
//! ## Freshness is deadline-encoded (`now < X`) — and that is SOUND here
//! Qualifying locks are created NON-revocable (no early `unbond`), so "before X" provably means "still
//! funded". The gate therefore never reads a specific lock (which would de-anonymize the member); it relies
//! only on `now < X` (on-chain time) + the proof. The grant is recorded with expiry X and `is_granted` is a
//! pure deadline read. (Contrast BP3, whose locks ARE revocable, so its gate must read `is_locked` live.)
//!
//! ## qual_root trust (the one soft spot, stated plainly)
//! `qual_root` is published by an indexer (admin) via `set_qual_root`. It is PUBLICLY AUDITABLE — anyone can
//! recompute it from the escrow's public `get_lock` state (the SDK ships `recomputeQualRoot`) and reject a
//! dishonest root. We do NOT use an indexer signature (it would only ADD a trust assumption that public
//! recomputation already removes). The gate keeps a small RING of the last `RING_CAP` accepted roots per
//! tier, so a proof against a root the indexer rotated away from a moment ago still verifies.
//!
//! Why accepting an OLD ring root is sound (the load-bearing invariant — stated precisely so a future
//! maintainer does not break it): a member named in an older accepted root can ONLY have left the qualifying
//! set by its lock ceasing to be live, and for a lock created `revocable = false` with `unlock_time >= X` the
//! ONLY way out is `withdraw`/`claim`, which the escrow rejects until `now >= unlock_time >= X`. So a lock
//! cannot depart the set while `now < X`. Combined with the gate's own `now < X` freshness check, every
//! prover against any ring root is provably still funded at submit time. (The earlier "the set only grows, so
//! old roots are subsets" framing was the WRONG reason — a withdraw at/after X does shrink the live set; what
//! actually saves us is that such a departure requires `now >= X`, which the freshness gate already rejects.)
//! This invariant DEPENDS on the escrow being non-revocable + extend-only — never relax those, and never
//! point the gate at an escrow with an early-exit path.
//!
//! ## Bond-token precondition (clawback / AUTH_REQUIRED)
//! Because the gate reads NO lock, it cannot observe a token clawback or de-authorization. The configured
//! bond token MUST therefore be clawback-disabled and not AUTH_REQUIRED — otherwise the issuer could empty a
//! bonded balance while `now < X` and the grant would survive against funds that no longer exist. zkorage's
//! zkUSD bond instance is clawback-disabled; verify this before pointing a tier at any other token.
//!
//! ## Anonymity-set size (the de-anonymization trap)
//! A qualifying set of size 1 de-anonymizes the prover by elimination. The gate cannot count members from a
//! Merkle root, so the minimum is enforced OFF-CHAIN (the indexer refuses to publish a root below N; the
//! backend refuses to build a proof below N; the UI surfaces the count + warns). A direct-prover bypass only
//! weakens the prover's OWN anonymity (it still cannot forge membership), so the incentive is self-aligned.
//!
//! ## Permissionless submit (gasless for the anonymous member)
//! `submit_tier_proof` takes NO `require_auth`: the in-guest NEW-5 holder signature (`pk == accessor`, over
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

/// BP5 tier-bonded journal wire layout (181 bytes, big-endian). The member's identity (id_secret/
/// id_trapdoor/which leaf in either tree) is NEVER committed — that is the anonymity.
///   [0]         result        u8   = 1
///   [1..5]      claim_type     u32  = 13
///   [5..37]     member_root    [u8;32]
///   [37..69]    qual_root      [u8;32]
///   [69..77]    threshold      u64
///   [77..85]    unlock_after   u64  (= X; the gate checks now < X)
///   [85..117]   context        [u8;32]  (== the external_nullifier; the tier/season label)
///   [117..149]  nullifier      [u8;32]
///   [149..181]  accessor       [u8;32]
const JOURNAL_LEN: u32 = 181;
const CLAIM_TYPE_TIER: u32 = 13;

/// How many recent accepted `qual_root`s the gate keeps per tier (kills the publish-then-prove race). Why
/// accepting an OLDER ring root stays sound is the load-bearing invariant spelled out in the module docs
/// above: a non-revocable, extend-only qualifying lock cannot LEAVE the set while `now < X` (withdraw/claim
/// need `now >= unlock_time >= X`), and the gate's own `now < X` freshness check covers the boundary. (NOT
/// the "the set only grows, so an older root is a subset" reason — a withdraw at/after X does shrink the live
/// set; what saves us is that such a departure requires `now >= X`, which the freshness gate already rejects.)
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
pub enum TierError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    ImageMismatch = 3,
    MalformedJournal = 4,
    ProofInvalid = 5,
    ResultNotTrue = 6,
    ClaimTypeMismatch = 7,
    /// The enrolled-member root has not been set yet (fail closed until the admin enrolls a set).
    MemberRootNotSet = 8,
    /// `journal.member_root` != the configured enrolled-member root.
    MemberRootMismatch = 9,
    /// `journal.qual_root` is not among the recent accepted roots for `(threshold, X)`.
    QualRootUnknown = 10,
    /// `now >= X`: the bonded deadline has passed (the lock is no longer provably still-funded).
    DeadlinePassed = 11,
    /// This nullifier was already used for a grant (one grant per identity per context).
    NullifierUsed = 12,
    NotAdmin = 13,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    /// The enrolled-member set root (persistent; set by the admin/owner; fail-closed when absent).
    MemberRoot,
    /// The recent accepted `qual_root` ring for a tier keyed by (threshold, X) (persistent).
    QualRing(u64, u64),
    /// A used nullifier (persistent). Presence == used.
    Nullifier(BytesN<32>),
    /// The grant keyed to an accessor's raw 32-byte ed25519 key (persistent; mirrors the KYC gate +
    /// DataRoom convention — NOT a Soroban Address). Presence == was admitted; validity is `now < X`.
    Grant(BytesN<32>),
    /// Latest grant (persistent).
    Latest,
    /// Total number of grants appended to the log (instance).
    Count,
    /// The i-th grant in the append-only history (persistent).
    Log(u32),
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
pub struct TierGrant {
    /// Position in the append-only history (0-based).
    pub index: u32,
    /// The consenting accessor's raw 32-byte ed25519 key (committed in-proof + bound by the in-guest holder
    /// sig). Mirrors the KYC gate / DataRoom convention (a public key, not a Soroban Address).
    pub accessor: BytesN<32>,
    /// The tier's bonded floor the proof asserted.
    pub threshold: u64,
    /// = X: the bonded deadline; ALSO this grant's expiry (`is_granted` true iff `now < unlock_after`).
    pub unlock_after: u64,
    /// The nullifier context (tier / season label).
    pub context: BytesN<32>,
    /// The recorded nullifier (one grant per identity per context).
    pub nullifier: BytesN<32>,
    /// The enrolled-member root the proof was checked against (audit trail).
    pub member_root: BytesN<32>,
    /// The qualifying-set root the proof was checked against (audit trail; recomputable from public state).
    pub qual_root: BytesN<32>,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct TierGranted {
    #[topic]
    pub accessor: BytesN<32>,
    pub index: u32,
    pub threshold: u64,
    pub unlock_after: u64,
    pub ledger: u32,
}

#[contractevent]
pub struct QualRootSet {
    pub threshold: u64,
    pub unlock_after: u64,
    pub qual_root: BytesN<32>,
    pub ring_len: u32,
}

/// Minimal client for the bare image-agnostic Groth16 verifier (same cross-call the other gates use).
fn load_config(env: &Env) -> Result<Config, TierError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(TierError::NotInitialized)
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(THRESHOLD, BUMP);
}

fn be_u32(a: &[u8; 181], o: usize) -> u32 {
    u32::from_be_bytes([a[o], a[o + 1], a[o + 2], a[o + 3]])
}

fn be_u64(a: &[u8; 181], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&a[o..o + 8]);
    u64::from_be_bytes(b)
}

fn bytes32(env: &Env, a: &[u8; 181], o: usize) -> BytesN<32> {
    let mut b = [0u8; 32];
    b.copy_from_slice(&a[o..o + 32]);
    BytesN::from_array(env, &b)
}

#[contract]
pub struct TierGate;

#[contractimpl]
impl TierGate {
    /// One-time setup. `verifier` is the deployed bare Groth16 verifier; `image_id` is the canonical tier
    /// guest image; `claim_type` is 13. The enrolled-member root + the per-tier qual roots are set
    /// afterwards (`set_member_root` / `set_qual_root`), so the gate fails closed until it is enrolled.
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier: Address,
        image_id: BytesN<32>,
        claim_type: u32,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, TierError::AlreadyInitialized);
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

    /// Verify an anonymous bonded-tier proof, bind it to the enrolled-member root + a recent qualifying root
    /// + the deadline, reject nullifier reuse, and record a grant keyed to the consenting accessor. See the
    /// module docs for the full enforcement order. PERMISSIONLESS (the in-guest holder sig is the consent).
    pub fn submit_tier_proof(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
    ) -> Result<TierGrant, TierError> {
        let cfg = load_config(&env)?;

        // (1) image pin (the bare verifier is image-agnostic, so pinning is mandatory for soundness).
        if image_id != cfg.image_id {
            return Err(TierError::ImageMismatch);
        }

        // (2) recompute the journal digest on-chain (binds parsed fields to the proof).
        if journal.len() != JOURNAL_LEN {
            return Err(TierError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();

        // (3) cross-verify against the bare Groth16 verifier.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(TierError::ProofInvalid),
        }

        // (4) parse + policy-check the journal.
        let mut jb = [0u8; 181];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(TierError::ResultNotTrue);
        }
        let claim_type = be_u32(&jb, 1);
        if claim_type != cfg.claim_type || claim_type != CLAIM_TYPE_TIER {
            return Err(TierError::ClaimTypeMismatch);
        }
        let member_root = bytes32(&env, &jb, 5);
        let qual_root = bytes32(&env, &jb, 37);
        let threshold = be_u64(&jb, 69);
        let unlock_after = be_u64(&jb, 77);
        let context = bytes32(&env, &jb, 85);
        let nullifier = bytes32(&env, &jb, 117);
        let accessor = bytes32(&env, &jb, 149);

        // (5) enrolled-member binding (fail closed if the set has not been pinned yet).
        let enrolled: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::MemberRoot)
            .ok_or(TierError::MemberRootNotSet)?;
        if member_root != enrolled {
            return Err(TierError::MemberRootMismatch);
        }

        // (6) qualifying-set binding — the proven root must be a recent accepted root for THIS tier.
        let ring: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::QualRing(threshold, unlock_after))
            .unwrap_or_else(|| Vec::new(&env));
        if !ring.iter().any(|r| r == qual_root) {
            return Err(TierError::QualRootUnknown);
        }

        // (7) freshness — deadline-encoded (sound because qualifying locks are non-revocable).
        let now = env.ledger().timestamp();
        if now >= unlock_after {
            return Err(TierError::DeadlinePassed);
        }

        // (8) nullifier — one grant per identity per context.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier.clone()))
        {
            return Err(TierError::NullifierUsed);
        }

        // (9) record the nullifier + the grant (keyed to the accessor, expiring at X) + append the log + emit.
        let index: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let grant = TierGrant {
            index,
            accessor: accessor.clone(),
            threshold,
            unlock_after,
            context,
            nullifier: nullifier.clone(),
            member_root,
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
        pstore.set(&DataKey::Grant(accessor.clone()), &grant);
        pstore.extend_ttl(&DataKey::Grant(accessor.clone()), THRESHOLD, BUMP);
        env.storage()
            .instance()
            .set(&DataKey::Count, &index.saturating_add(1));
        bump_instance(&env);

        TierGranted {
            accessor,
            index,
            threshold,
            unlock_after,
            ledger: grant.ledger,
        }
        .publish(&env);

        Ok(grant)
    }

    // ---- reads ----

    /// **The live tier decision.** True iff `accessor` has a recorded tier grant whose bonded deadline X has
    /// not passed (`now < X`). Deadline-encoded — sound because qualifying locks are non-revocable, so the
    /// member is provably still funded until X. Permissionless.
    pub fn is_granted(env: Env, accessor: BytesN<32>) -> bool {
        let grant: TierGrant = match env.storage().persistent().get(&DataKey::Grant(accessor)) {
            Some(g) => g,
            None => return false,
        };
        env.ledger().timestamp() < grant.unlock_after
    }

    /// The raw stored grant for an accessor (regardless of current validity — use `is_granted` for the live
    /// decision).
    pub fn get_grant(env: Env, accessor: BytesN<32>) -> Option<TierGrant> {
        env.storage().persistent().get(&DataKey::Grant(accessor))
    }

    pub fn is_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Nullifier(nullifier))
    }

    pub fn get_member_root(env: Env) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::MemberRoot)
    }

    /// The recent accepted `qual_root` ring for a tier (oldest first). Recomputable + auditable from public
    /// escrow state.
    pub fn get_qual_ring(env: Env, threshold: u64, unlock_after: u64) -> Vec<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::QualRing(threshold, unlock_after))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Whether a specific `qual_root` is currently accepted for a tier.
    pub fn is_qual_root_accepted(
        env: Env,
        threshold: u64,
        unlock_after: u64,
        qual_root: BytesN<32>,
    ) -> bool {
        Self::get_qual_ring(env, threshold, unlock_after)
            .iter()
            .any(|r| r == qual_root)
    }

    pub fn get_latest(env: Env) -> Option<TierGrant> {
        env.storage().persistent().get(&DataKey::Latest)
    }

    pub fn get_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    pub fn get_by_index(env: Env, index: u32) -> Option<TierGrant> {
        env.storage().persistent().get(&DataKey::Log(index))
    }

    /// A page of the append-only history, in order, from `start` (0-based). `limit` clamped to `MAX_PAGE`.
    pub fn get_history(env: Env, start: u32, limit: u32) -> Vec<TierGrant> {
        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let lim = if limit > MAX_PAGE { MAX_PAGE } else { limit };
        let mut out: Vec<TierGrant> = Vec::new(&env);
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

    /// Pin / rotate the enrolled-member set root. Rotating does NOT retroactively revoke existing grants
    /// (they stand until their own X); it only changes which root a NEW proof must match.
    pub fn set_member_root(env: Env, member_root: BytesN<32>) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        let p = env.storage().persistent();
        p.set(&DataKey::MemberRoot, &member_root);
        p.extend_ttl(&DataKey::MemberRoot, THRESHOLD, BUMP);
        bump_instance(&env);
    }

    /// Publish the current `qual_root` for a tier `(threshold, X)`. Appends to a bounded ring (most-recent
    /// `RING_CAP` kept). The root is publicly auditable: anyone recomputes it from the escrow's `get_lock`
    /// state and rejects a dishonest one. Admin-gated (the indexer operator). Idempotent: re-publishing the
    /// same head root is a no-op (no duplicate ring entry).
    pub fn set_qual_root(env: Env, threshold: u64, unlock_after: u64, qual_root: BytesN<32>) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        let key = DataKey::QualRing(threshold, unlock_after);
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
            threshold,
            unlock_after,
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
            panic_with_error!(&env, TierError::NotAdmin);
        }
        operator.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        bump_instance(&env);
    }
}

#[cfg(test)]
mod test;
