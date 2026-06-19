//! # zkorage compliance gate contract (KYC ∧ not-sanctioned)
//!
//! Accepts a RISC Zero proof that an **allow-listed KYC provider attested `kyc = passed`** for some
//! subject **AND** that the same (hidden) subject is **not** in a sanctions deny-list — **without the
//! subject's identity ever appearing** — and grants on-chain access to the bound `accessor`. Like the
//! Week-5 KYC gate, it does NOT re-implement Groth16: it **cross-calls the bare, immutable
//! [`RiscZeroVerifierClient`]** (deployed in Week 1) and adds the compliance-policy + access layer.
//!
//! ## What this adds over the W5 KYC gate
//! The combined `compliance_predicate` guest proves KYC **and** non-membership in ONE proof (so both
//! bind to the same hidden `subject_id`), recomputes the deny-list **Merkle root** from a prover-supplied
//! witness, and commits it. This contract stores the **authoritative `deny_root`** (admin-managed) and
//! checks the proof's committed root equals it (32-byte equality — **no on-chain hashing**). The hash is
//! SHA-256 (RISC0 has a sha256 precompile ⇒ 1 segment vs ~28 for Poseidon-BN254); since the gate only
//! compares roots, the in-guest hash is a pure guest↔backend choice and equally sound.
//!
//! ## What `request_access` enforces (in order)
//! 1. **Image pin** — `image_id == Config.image_id` (the canonical compliance guest). Soundness-critical.
//! 2. **Digest recomputation** — `sha256(journal)` is recomputed on-chain and handed to the verifier.
//! 3. **Cross-verify** — `verifier.verify(seal, image_id, digest)` must succeed.
//! 4. **Journal policy** — `result == true`, `claim_type == Config.claim_type` (compliance),
//!    `deny_root == Config.deny_root` (the proof checked the CURRENT sanctions list), the KYC issuer ∈
//!    allowlist, `expiry > now`.
//! 5. **Grant** — store an `AccessRecord` keyed by the public `accessor` (latest + per-accessor +
//!    append-only log) and emit `access_granted`.
//!
//! A SANCTIONED subject has an exact deny-list leaf, so the guest finds no bracketing low-leaf and
//! **produces no receipt** — there is nothing to submit. A valid proof checked against a STALE root is
//! rejected here (`DenyRootMismatch`). Identity is never on-chain; a stolen bundle is non-redirectable
//! (`accessor` is fixed inside the proof). Permissionless; the source account only pays fees.
//!
//! ## Scope / limitations (demo)
//! - **`accessor` is NOT authenticated by the proof** (same as W5) — a grant proves *"a valid KYC'd,
//!   not-sanctioned credential exists and its holder chose this accessor"*, not that the accessor's
//!   owner is the subject. Harden with an in-guest holder signature or `accessor.require_auth()`.
//! - **Nullifier deferred** — one compliant identity can still bind many accessors (sybil).
//! - **Trusted admin** — `set_image_id` / `set_verifier` / `set_deny_root` repoint trust anchors with no
//!   timelock. The deny-list root is admin-pinned (the backend tree-builder is the authority).
//! **Unaudited — demo only.**

#![no_std]

use risc0_interface::RiscZeroVerifierClient;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Bytes, BytesN, Env, Map, Vec,
};

/// Compliance journal wire layout (117 bytes, big-endian), committed by the guest. `subject_id` ABSENT.
///   [0]        result      u8   (1 = true: KYC passed AND not sanctioned)
///   [1..5]     claim_type  u32  (4 = compliance)
///   [5..37]    issuer_id   [u8;32]  (the KYC provider's ed25519 pubkey; == the signing key)
///   [37..69]   deny_root   [u8;32]  (sanctions deny-list Merkle root the proof checked against)
///   [69..101]  accessor    [u8;32]  (public binding — who receives access)
///   [101..109] nonce       u64
///   [109..117] expiry      u64
const JOURNAL_LEN: u32 = 117;

// ~5s ledgers. Keep config + grants comfortably alive for the demo window.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP: u32 = 30 * DAY_IN_LEDGERS;
const THRESHOLD: u32 = BUMP - DAY_IN_LEDGERS;

// Max page size for `get_history` — bounds a single read's storage footprint.
const MAX_PAGE: u32 = 50;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ComplianceError {
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
    DenyRootMismatch = 11,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Issuers,
    Latest,
    /// Access record for a given accessor (persistent). Presence == access granted.
    Access(BytesN<32>),
    /// Total number of access grants appended to the log (instance).
    Count,
    /// The i-th access grant in the append-only history (persistent).
    Log(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub verifier: Address,
    pub image_id: BytesN<32>,
    pub claim_type: u32,
    /// The authoritative sanctions deny-list Merkle root. A proof's committed root MUST equal this.
    pub deny_root: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccessRecord {
    /// Position in the append-only history log (0-based). See `get_history`.
    pub index: u32,
    /// The public binding the proof grants access to (e.g. a Stellar account's ed25519 key).
    pub accessor: BytesN<32>,
    /// The KYC provider that attested the (hidden) subject — checked against the allowlist.
    pub issuer_id: BytesN<32>,
    /// The deny-list root this grant was verified against (provenance of the sanctions snapshot).
    pub deny_root: BytesN<32>,
    pub claim_type: u32,
    pub nonce: u64,
    pub expiry: u64,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct AccessGranted {
    #[topic]
    pub accessor: BytesN<32>,
    pub issuer_id: BytesN<32>,
    pub index: u32,
    pub ledger: u32,
}

fn load_config(env: &Env) -> Result<Config, ComplianceError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(ComplianceError::NotInitialized)
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(THRESHOLD, BUMP);
}

fn be_u32(a: &[u8; 117], o: usize) -> u32 {
    u32::from_be_bytes([a[o], a[o + 1], a[o + 2], a[o + 3]])
}

fn be_u64(a: &[u8; 117], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&a[o..o + 8]);
    u64::from_be_bytes(b)
}

#[contract]
pub struct Compliance;

#[contractimpl]
impl Compliance {
    /// One-time setup. `image_id` is the canonical (deterministic) compliance guest image; `claim_type`
    /// is `4` for compliance; `deny_root` is the initial sanctions deny-list Merkle root (the backend
    /// tree-builder computes it); `issuers` is the initial allow-listed KYC-provider ed25519 pubkeys.
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier: Address,
        image_id: BytesN<32>,
        claim_type: u32,
        deny_root: BytesN<32>,
        issuers: Vec<BytesN<32>>,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, ComplianceError::AlreadyInitialized);
        }
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                verifier,
                image_id,
                claim_type,
                deny_root,
            },
        );
        let mut map: Map<BytesN<32>, bool> = Map::new(&env);
        for k in issuers.iter() {
            map.set(k, true);
        }
        env.storage().instance().set(&DataKey::Issuers, &map);
        bump_instance(&env);
    }

    /// Verify a compliance proof (KYC ∧ not-sanctioned) and grant access to the bound `accessor`. See
    /// the module docs for the full enforcement order. Permissionless. The subject is never revealed.
    pub fn request_access(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
    ) -> Result<AccessRecord, ComplianceError> {
        let cfg = load_config(&env)?;

        // (1) image pin — the proof MUST come from our canonical compliance guest.
        if image_id != cfg.image_id {
            return Err(ComplianceError::ImageMismatch);
        }

        // (2) recompute the journal digest on-chain (binds parsed fields to the proof).
        if journal.len() != JOURNAL_LEN {
            return Err(ComplianceError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();

        // (3) cross-verify against the bare Groth16 verifier. Any non-Ok => invalid.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(ComplianceError::ProofInvalid),
        }

        // (4) parse + policy-check the journal. `jb` is exactly JOURNAL_LEN and the length was checked
        // in step (2), so `copy_into_slice` (which panics on a length mismatch) cannot trap here.
        let mut jb = [0u8; 117];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(ComplianceError::ResultNotTrue);
        }
        let claim_type = be_u32(&jb, 1);
        if claim_type != cfg.claim_type {
            return Err(ComplianceError::ClaimTypeMismatch);
        }
        let mut id = [0u8; 32];
        id.copy_from_slice(&jb[5..37]);
        let issuer_id = BytesN::from_array(&env, &id);
        let mut dr = [0u8; 32];
        dr.copy_from_slice(&jb[37..69]);
        let deny_root = BytesN::from_array(&env, &dr);
        let mut acc = [0u8; 32];
        acc.copy_from_slice(&jb[69..101]);
        let accessor = BytesN::from_array(&env, &acc);
        let nonce = be_u64(&jb, 101);
        let expiry = be_u64(&jb, 109);

        // (4a) the proof must have checked non-membership against the CURRENT authoritative deny-list.
        if deny_root != cfg.deny_root {
            return Err(ComplianceError::DenyRootMismatch);
        }

        let issuers: Map<BytesN<32>, bool> = env.storage().instance().get(&DataKey::Issuers).unwrap();
        if !issuers.get(issuer_id.clone()).unwrap_or(false) {
            return Err(ComplianceError::IssuerNotAllowed);
        }
        let now = env.ledger().timestamp();
        if expiry <= now {
            return Err(ComplianceError::Expired);
        }

        // (5) grant (append-only log + latest + per-accessor) and emit. Re-granting an accessor
        // OVERWRITES its keyed `Access` record with the latest grant AND appends a NEW history entry.
        let index: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let rec = AccessRecord {
            index,
            accessor: accessor.clone(),
            issuer_id: issuer_id.clone(),
            deny_root,
            claim_type,
            nonce,
            expiry,
            ledger: env.ledger().sequence(),
            timestamp: now,
        };
        let pstore = env.storage().persistent();
        pstore.set(&DataKey::Log(index), &rec);
        pstore.extend_ttl(&DataKey::Log(index), THRESHOLD, BUMP);
        pstore.set(&DataKey::Latest, &rec);
        pstore.extend_ttl(&DataKey::Latest, THRESHOLD, BUMP);
        pstore.set(&DataKey::Access(accessor.clone()), &rec);
        pstore.extend_ttl(&DataKey::Access(accessor.clone()), THRESHOLD, BUMP);
        env.storage()
            .instance()
            .set(&DataKey::Count, &index.saturating_add(1));
        bump_instance(&env);

        AccessGranted {
            accessor,
            issuer_id,
            index,
            ledger: rec.ledger,
        }
        .publish(&env);

        Ok(rec)
    }

    // ---- reads ----

    /// True iff this accessor holds a **currently-valid** compliance access grant: a grant exists, its
    /// credential's `expiry` has not passed, **AND** it was verified against the CURRENT sanctions
    /// deny-list root (`record.deny_root == Config.deny_root`). The deny-root check makes admin
    /// re-pinning the list (`set_deny_root`, e.g. a newly-sanctioned entity) **immediately revoke** any
    /// stale grant — the subject must re-prove against the new list. This is the **live access-control
    /// decision** a relying party should gate on. `get_access` returns the raw stored record regardless
    /// (for audit: "was compliant as of `record.deny_root`").
    pub fn is_granted(env: Env, accessor: BytesN<32>) -> bool {
        let rec: Option<AccessRecord> = env.storage().persistent().get(&DataKey::Access(accessor));
        match rec {
            Some(r) => {
                let cfg = match load_config(&env) {
                    Ok(c) => c,
                    Err(_) => return false,
                };
                r.expiry > env.ledger().timestamp() && r.deny_root == cfg.deny_root
            }
            None => false,
        }
    }

    /// The raw stored access record for an accessor (regardless of expiry — use `is_granted` for the
    /// freshness-aware live decision). Re-granting an accessor overwrites this with the latest grant.
    pub fn get_access(env: Env, accessor: BytesN<32>) -> Option<AccessRecord> {
        env.storage().persistent().get(&DataKey::Access(accessor))
    }

    pub fn get_latest_access(env: Env) -> Option<AccessRecord> {
        env.storage().persistent().get(&DataKey::Latest)
    }

    /// Total number of access grants in the append-only history.
    pub fn get_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    /// The access grant at history position `index` (0-based), if any.
    pub fn get_by_index(env: Env, index: u32) -> Option<AccessRecord> {
        env.storage().persistent().get(&DataKey::Log(index))
    }

    /// A page of the append-only history, in order, from `start` (0-based). `limit` is clamped to
    /// `MAX_PAGE`; returns an empty Vec if `start` is past the end. Pruned indices are skipped (the page
    /// can be shorter than `limit`), so use each record's own `.index` as the canonical position.
    pub fn get_history(env: Env, start: u32, limit: u32) -> Vec<AccessRecord> {
        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let lim = if limit > MAX_PAGE { MAX_PAGE } else { limit };
        let mut out: Vec<AccessRecord> = Vec::new(&env);
        if lim == 0 || start >= count {
            return out;
        }
        let end = {
            let want = start.saturating_add(lim);
            if want < count { want } else { count }
        };
        let mut i = start;
        while i < end {
            if let Some(rec) = env.storage().persistent().get(&DataKey::Log(i)) {
                out.push_back(rec);
            }
            i += 1;
        }
        out
    }

    pub fn get_config(env: Env) -> Config {
        load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e))
    }

    pub fn is_issuer_allowed(env: Env, issuer_id: BytesN<32>) -> bool {
        let issuers: Map<BytesN<32>, bool> = env
            .storage()
            .instance()
            .get(&DataKey::Issuers)
            .unwrap_or_else(|| Map::new(&env));
        issuers.get(issuer_id).unwrap_or(false)
    }

    /// The current authoritative sanctions deny-list Merkle root.
    pub fn get_deny_root(env: Env) -> BytesN<32> {
        Self::get_config(env).deny_root
    }

    // ---- admin (require_auth) ----

    pub fn add_issuer(env: Env, issuer_id: BytesN<32>) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        let mut issuers: Map<BytesN<32>, bool> =
            env.storage().instance().get(&DataKey::Issuers).unwrap();
        issuers.set(issuer_id, true);
        env.storage().instance().set(&DataKey::Issuers, &issuers);
        bump_instance(&env);
    }

    pub fn remove_issuer(env: Env, issuer_id: BytesN<32>) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        let mut issuers: Map<BytesN<32>, bool> =
            env.storage().instance().get(&DataKey::Issuers).unwrap();
        issuers.remove(issuer_id);
        env.storage().instance().set(&DataKey::Issuers, &issuers);
        bump_instance(&env);
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

    /// Update the authoritative sanctions deny-list root. Admin-gated. Mirrors the issuer allowlist /
    /// `set_image_id`: the backend tree-builder recomputes the root when the sanctions list changes and
    /// the admin pins the new root here. Proofs checked against the OLD root are then rejected
    /// (`DenyRootMismatch`) — a fresh proof must be generated against the new list.
    pub fn set_deny_root(env: Env, deny_root: BytesN<32>) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.deny_root = deny_root;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Admin-gated, in-place WASM upgrade (protocol-level `update_current_contract_wasm`). Lets future
    /// weeks extend this gate **without changing its contract ID**. Storage is preserved, so new code
    /// MUST keep existing `DataKey`/struct shapes (add keys; never rename or retype).
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, operator: Address) {
        let cfg = load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        if operator != cfg.admin {
            panic_with_error!(&env, ComplianceError::NotAdmin);
        }
        operator.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        bump_instance(&env);
    }
}

#[cfg(test)]
mod test;
