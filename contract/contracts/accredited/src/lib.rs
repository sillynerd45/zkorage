//! # zkorage accredited-investor gate contract
//!
//! Accepts a RISC Zero proof that an **allow-listed accreditation provider attested
//! `accredited = yes`** for some investor — **without the investor's identity ever appearing** — and
//! grants on-chain access to the `accessor` the proof is bound to. It is a faithful clone of the
//! Week-5 relying-party KYC gate (the gate is claim-type-parametric: `claim_type` lives in `Config`
//! and is set at `initialize`); the only differences are the accreditation framing and the pinned
//! `claim_type = 7` (accredited-investor credential, an identity sibling of KYC's `claim_type = 3`).
//!
//! Like the KYC gate, it does NOT re-implement Groth16: it **cross-calls the bare, immutable
//! [`RiscZeroVerifierClient`]** (deployed in Week 1) and adds the accreditation-policy + access layer.
//! This contract is the **identity leg** of the Week-8 fundraising composition: the `fundraise`
//! contract cross-calls [`Accredited::is_granted`] to AND "investor is accredited" with "the fundraise
//! has proven revenue ≥ X".
//!
//! ## What `request_access` enforces (in order)
//! 1. **Image pin** — `image_id == Config.image_id` (the canonical `guest-accredited` Docker build).
//!    Mandatory for soundness: the bare verifier is image-agnostic.
//! 2. **Digest recomputation** — `sha256(journal)` recomputed **on-chain** and handed to the verifier.
//! 3. **Cross-verify** — `verifier.verify(seal, image_id, digest)` must succeed.
//! 4. **Journal policy** — `result == true`, `claim_type == Config.claim_type` (= 7, accredited), the
//!    accreditation provider ∈ allowlist, `expiry > now` (freshness).
//! 5. **Grant** — store an `AccessRecord` keyed by the **public `accessor`** committed in the proof
//!    (latest + per-accessor + append-only log) and emit an `access_granted` event.
//!
//! The investor's identity is **never** on-chain (selective disclosure). A stolen bundle is **not
//! redirectable**: `accessor` is fixed inside the proof. `request_access` is **permissionless**.
//!
//! ## Scope / limitations (demo)
//! - **`accessor` is NOT authenticated by the proof** (same as the KYC gate): a grant proves *"a valid
//!   accredited-investor credential from an allow-listed provider exists, and its holder chose this
//!   accessor"* — not *"the accessor's owner is the accredited investor."* Hardening: an in-guest
//!   holder signature over `accessor`, or `accessor.require_auth()` here (trades away the gasless flow).
//! - **Nullifier deferred** — one accredited identity can still bind many accessors (sybil).
//! - **Trusted admin** — `set_image_id` / `set_verifier` repoint trust anchors with no timelock.
//! **Unaudited — demo only.**

#![no_std]

use risc0_interface::RiscZeroVerifierClient;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Bytes, BytesN, Env, Map, Vec,
};

/// Accredited (identity-style) journal wire layout (85 bytes, big-endian), committed by the guest.
/// `subject_id` (the investor's real identity) is ABSENT — selective disclosure.
///   [0]      result     u8   (1 = true)
///   [1..5]   claim_type u32  (7 = accredited-investor)
///   [5..37]  issuer_id  [u8;32]  (the accreditation provider's ed25519 pubkey; == the signing key)
///   [37..69] accessor   [u8;32]  (public binding — who receives access)
///   [69..77] nonce      u64
///   [77..85] expiry     u64
const JOURNAL_LEN: u32 = 85;

// ~5s ledgers. Keep config + grants comfortably alive for the demo window.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP: u32 = 30 * DAY_IN_LEDGERS;
const THRESHOLD: u32 = BUMP - DAY_IN_LEDGERS;

// Max page size for `get_history` — bounds a single read's storage footprint.
const MAX_PAGE: u32 = 50;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AccreditedError {
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
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccessRecord {
    /// Position in the append-only history log (0-based). See `get_history`.
    pub index: u32,
    /// The public binding the proof grants access to (e.g. a Stellar account's ed25519 key).
    pub accessor: BytesN<32>,
    /// The accreditation provider that attested the (hidden) investor — checked against the allowlist.
    pub issuer_id: BytesN<32>,
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

fn load_config(env: &Env) -> Result<Config, AccreditedError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(AccreditedError::NotInitialized)
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(THRESHOLD, BUMP);
}

fn be_u32(a: &[u8; 85], o: usize) -> u32 {
    u32::from_be_bytes([a[o], a[o + 1], a[o + 2], a[o + 3]])
}

fn be_u64(a: &[u8; 85], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&a[o..o + 8]);
    u64::from_be_bytes(b)
}

#[contract]
pub struct Accredited;

#[contractimpl]
impl Accredited {
    /// One-time setup. `image_id` is the canonical (deterministic) `guest-accredited` image;
    /// `claim_type` is `7` for accredited-investor; `issuers` is the initial allow-listed
    /// accreditation-provider ed25519 pubkeys.
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier: Address,
        image_id: BytesN<32>,
        claim_type: u32,
        issuers: Vec<BytesN<32>>,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, AccreditedError::AlreadyInitialized);
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
        let mut map: Map<BytesN<32>, bool> = Map::new(&env);
        for k in issuers.iter() {
            map.set(k, true);
        }
        env.storage().instance().set(&DataKey::Issuers, &map);
        bump_instance(&env);
    }

    /// Verify an accredited-investor proof and grant access to the bound `accessor`. See the module
    /// docs for the full enforcement order. Permissionless. The investor's identity is never revealed.
    pub fn request_access(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
    ) -> Result<AccessRecord, AccreditedError> {
        let cfg = load_config(&env)?;

        // (1) image pin — the proof MUST come from our canonical accredited guest.
        if image_id != cfg.image_id {
            return Err(AccreditedError::ImageMismatch);
        }

        // (2) recompute the journal digest on-chain (binds parsed fields to the proof).
        if journal.len() != JOURNAL_LEN {
            return Err(AccreditedError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();

        // (3) cross-verify against the bare Groth16 verifier. Any non-Ok => invalid.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(AccreditedError::ProofInvalid),
        }

        // (4) parse + policy-check the journal. `jb` is exactly JOURNAL_LEN and the length was checked
        // in step (2), so `copy_into_slice` (which panics on a length mismatch) cannot trap here.
        let mut jb = [0u8; 85];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(AccreditedError::ResultNotTrue);
        }
        let claim_type = be_u32(&jb, 1);
        if claim_type != cfg.claim_type {
            return Err(AccreditedError::ClaimTypeMismatch);
        }
        let mut id = [0u8; 32];
        id.copy_from_slice(&jb[5..37]);
        let issuer_id = BytesN::from_array(&env, &id);
        let mut acc = [0u8; 32];
        acc.copy_from_slice(&jb[37..69]);
        let accessor = BytesN::from_array(&env, &acc);
        let nonce = be_u64(&jb, 69);
        let expiry = be_u64(&jb, 77);

        let issuers: Map<BytesN<32>, bool> = env.storage().instance().get(&DataKey::Issuers).unwrap();
        if !issuers.get(issuer_id.clone()).unwrap_or(false) {
            return Err(AccreditedError::IssuerNotAllowed);
        }
        let now = env.ledger().timestamp();
        if expiry <= now {
            return Err(AccreditedError::Expired);
        }

        // (5) grant (append-only log + latest + per-accessor) and emit. Re-granting an accessor
        // OVERWRITES its keyed `Access` record with the latest grant AND appends a NEW history entry.
        let index: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let rec = AccessRecord {
            index,
            accessor: accessor.clone(),
            issuer_id: issuer_id.clone(),
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

    /// True iff this accessor holds a **currently-valid** accredited-investor access grant: a grant
    /// exists AND its credential's `expiry` has not passed (re-checked against ledger time on every
    /// read). This is the **live access-control decision** the `fundraise` contract AND's against its
    /// own revenue check. `get_access` returns the raw record regardless of expiry (audit/history).
    pub fn is_granted(env: Env, accessor: BytesN<32>) -> bool {
        let rec: Option<AccessRecord> = env.storage().persistent().get(&DataKey::Access(accessor));
        match rec {
            Some(r) => r.expiry > env.ledger().timestamp(),
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

    /// A page of the append-only history, in order, from `start` (0-based).
    /// `limit` is clamped to `MAX_PAGE`; returns an empty Vec if `start` is past the end.
    /// Pruned indices are skipped (the page can be shorter than `limit` even within range), so use
    /// each record's own `.index` field as the canonical history position — not its offset in the Vec.
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

    /// Admin-gated, in-place WASM upgrade (same native `update_current_contract_wasm` mechanism as the
    /// KYC gate / PoR policy). Storage is preserved, so new code MUST keep existing `DataKey`/struct
    /// shapes (add keys; never rename or retype).
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, operator: Address) {
        let cfg = load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        if operator != cfg.admin {
            panic_with_error!(&env, AccreditedError::NotAdmin);
        }
        operator.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        bump_instance(&env);
    }
}

#[cfg(test)]
mod test;
