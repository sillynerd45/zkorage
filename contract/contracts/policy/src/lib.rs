//! # zkorage Proof-of-Reserves policy contract
//!
//! Binds a RISC Zero proof (`reserves ≥ supply`, reserves private) to **real on-chain facts** and
//! persists the verified result. It does NOT re-implement Groth16 — it **cross-calls the bare,
//! immutable [`RiscZeroVerifierClient`]** (deployed in Week 1) and adds the binding + policy layer.
//!
//! ## What `submit_proof_of_reserves` enforces (in order)
//! 1. **Image pin** — `image_id == Config.image_id`. *Mandatory for soundness:* the bare verifier is
//!    image-agnostic, so without pinning, a malicious guest that skips the signature check could
//!    forge a "valid" journal. The pinned id is the deterministic (Docker) guest build.
//! 2. **Digest recomputation** — `sha256(journal)` is recomputed **on-chain** and handed to the
//!    verifier. This is the crux of the binding: it guarantees the journal fields parsed below are
//!    exactly the ones the proof attests to (the bare verifier only ever sees the digest).
//! 3. **Cross-verify** — `verifier.verify(seal, image_id, digest)` must succeed.
//! 4. **Journal policy** — `result == true`, `claim_type == Config.claim_type`, issuer ∈ allowlist,
//!    `expiry > now` (freshness).
//! 5. **Supply binding** — `journal.supply == token.total_supply()` (cross-call). This is the whole
//!    point of Proof-of-Reserves: the proven threshold is the *real* circulating liability.
//! 6. **Persist** — store `VerifiedResult` (latest + per-issuer) and emit a `verified` event.
//!
//! `submit` is **permissionless**: the proof + bindings are the authorization; the source account
//! only pays fees. **Unaudited — demo only.**

#![no_std]

use risc0_interface::RiscZeroVerifierClient;
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, Address, Bytes, BytesN, Env, Map, Vec,
};

/// Journal wire layout (61 bytes, big-endian), committed by the guest. `value`/reserves ABSENT.
///   [0]      result     u8   (1 = true)
///   [1..5]   claim_type u32
///   [5..37]  issuer_id  [u8;32]
///   [37..45] supply     u64   (== threshold the guest proved reserves ≥)
///   [45..53] nonce      u64
///   [53..61] expiry     u64
const JOURNAL_LEN: u32 = 61;

// ~5s ledgers. Keep config + results comfortably alive for the demo window.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP: u32 = 30 * DAY_IN_LEDGERS;
const THRESHOLD: u32 = BUMP - DAY_IN_LEDGERS;

// Max page size for `get_history` — bounds a single read's storage footprint.
const MAX_PAGE: u32 = 50;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    ImageMismatch = 3,
    MalformedJournal = 4,
    ProofInvalid = 5,
    ResultNotTrue = 6,
    ClaimTypeMismatch = 7,
    IssuerNotAllowed = 8,
    Expired = 9,
    SupplyMismatch = 10,
    SupplyOutOfRange = 11,
    NotAdmin = 12,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Issuers,
    Latest,
    Result(BytesN<32>),
    /// Total number of verified results appended to the log (instance).
    Count,
    /// The i-th verified result in the append-only history (persistent).
    Log(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub verifier: Address,
    pub token: Address,
    pub image_id: BytesN<32>,
    pub claim_type: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedResult {
    /// Position in the append-only history log (0-based). See `get_history`.
    pub index: u32,
    pub result: bool,
    pub supply: u64,
    pub issuer_id: BytesN<32>,
    pub claim_type: u32,
    pub nonce: u64,
    pub expiry: u64,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct Verified {
    #[topic]
    pub issuer_id: BytesN<32>,
    pub index: u32,
    pub supply: u64,
    pub ledger: u32,
}

/// Minimal client for the demo SEP-41 token — we only need the supply read for the binding.
#[contractclient(name = "TokenClient")]
pub trait TokenContract {
    fn total_supply(env: Env) -> i128;
}

fn load_config(env: &Env) -> Result<Config, PolicyError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(PolicyError::NotInitialized)
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(THRESHOLD, BUMP);
}

fn be_u32(a: &[u8; 61], o: usize) -> u32 {
    u32::from_be_bytes([a[o], a[o + 1], a[o + 2], a[o + 3]])
}

fn be_u64(a: &[u8; 61], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&a[o..o + 8]);
    u64::from_be_bytes(b)
}

#[contract]
pub struct Policy;

#[contractimpl]
impl Policy {
    /// One-time setup. `image_id` is the canonical (deterministic) guest image; `claim_type` is `2`
    /// for Proof-of-Reserves; `issuers` is the initial ed25519 issuer-pubkey allowlist.
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier: Address,
        token: Address,
        image_id: BytesN<32>,
        claim_type: u32,
        issuers: Vec<BytesN<32>>,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, PolicyError::AlreadyInitialized);
        }
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                verifier,
                token,
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

    /// Verify a Proof-of-Reserves bundle, bind it to the on-chain token supply, and persist.
    /// See the module docs for the full enforcement order. Permissionless.
    pub fn submit_proof_of_reserves(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
    ) -> Result<VerifiedResult, PolicyError> {
        let cfg = load_config(&env)?;

        // (1) image pin — the proof MUST come from our canonical guest.
        if image_id != cfg.image_id {
            return Err(PolicyError::ImageMismatch);
        }

        // (2) recompute the journal digest on-chain (binds parsed fields to the proof).
        if journal.len() != JOURNAL_LEN {
            return Err(PolicyError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();

        // (3) cross-verify against the bare Groth16 verifier. Any non-Ok => invalid.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(PolicyError::ProofInvalid),
        }

        // (4) parse + policy-check the journal.
        let mut jb = [0u8; 61];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(PolicyError::ResultNotTrue);
        }
        let claim_type = be_u32(&jb, 1);
        if claim_type != cfg.claim_type {
            return Err(PolicyError::ClaimTypeMismatch);
        }
        let mut id = [0u8; 32];
        id.copy_from_slice(&jb[5..37]);
        let issuer_id = BytesN::from_array(&env, &id);
        let supply = be_u64(&jb, 37);
        let nonce = be_u64(&jb, 45);
        let expiry = be_u64(&jb, 53);

        let issuers: Map<BytesN<32>, bool> = env.storage().instance().get(&DataKey::Issuers).unwrap();
        if !issuers.get(issuer_id.clone()).unwrap_or(false) {
            return Err(PolicyError::IssuerNotAllowed);
        }
        let now = env.ledger().timestamp();
        if expiry <= now {
            return Err(PolicyError::Expired);
        }

        // (5) supply binding — the proven threshold must equal the REAL on-chain circulating supply.
        let ts: i128 = TokenClient::new(&env, &cfg.token).total_supply();
        if ts < 0 || ts > i128::from(u64::MAX) {
            return Err(PolicyError::SupplyOutOfRange);
        }
        if ts as u64 != supply {
            return Err(PolicyError::SupplyMismatch);
        }

        // (6) persist (append-only log + latest + per-issuer) and emit.
        // The log makes the full history independently listable on-chain (events expire ~7d).
        let index: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let vr = VerifiedResult {
            index,
            result: true,
            supply,
            issuer_id: issuer_id.clone(),
            claim_type,
            nonce,
            expiry,
            ledger: env.ledger().sequence(),
            timestamp: now,
        };
        let pstore = env.storage().persistent();
        pstore.set(&DataKey::Log(index), &vr);
        pstore.extend_ttl(&DataKey::Log(index), THRESHOLD, BUMP);
        pstore.set(&DataKey::Latest, &vr);
        pstore.extend_ttl(&DataKey::Latest, THRESHOLD, BUMP);
        pstore.set(&DataKey::Result(issuer_id.clone()), &vr);
        pstore.extend_ttl(&DataKey::Result(issuer_id.clone()), THRESHOLD, BUMP);
        env.storage()
            .instance()
            .set(&DataKey::Count, &index.saturating_add(1));
        bump_instance(&env);

        Verified {
            issuer_id,
            index,
            supply,
            ledger: vr.ledger,
        }
        .publish(&env);

        Ok(vr)
    }

    // ---- reads ----

    pub fn get_latest_result(env: Env) -> Option<VerifiedResult> {
        env.storage().persistent().get(&DataKey::Latest)
    }

    pub fn get_result(env: Env, issuer_id: BytesN<32>) -> Option<VerifiedResult> {
        env.storage().persistent().get(&DataKey::Result(issuer_id))
    }

    /// Total number of verified results in the append-only history.
    pub fn get_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    /// The verified result at history position `index` (0-based), if any.
    pub fn get_by_index(env: Env, index: u32) -> Option<VerifiedResult> {
        env.storage().persistent().get(&DataKey::Log(index))
    }

    /// A page of the append-only history, in order, from `start` (0-based).
    /// `limit` is clamped to `MAX_PAGE`; returns an empty Vec if `start` is past the end.
    pub fn get_history(env: Env, start: u32, limit: u32) -> Vec<VerifiedResult> {
        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let lim = if limit > MAX_PAGE { MAX_PAGE } else { limit };
        let mut out: Vec<VerifiedResult> = Vec::new(&env);
        if lim == 0 || start >= count {
            return out;
        }
        let end = {
            let want = start.saturating_add(lim);
            if want < count { want } else { count }
        };
        let mut i = start;
        while i < end {
            if let Some(vr) = env.storage().persistent().get(&DataKey::Log(i)) {
                out.push_back(vr);
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

    pub fn set_token(env: Env, token: Address) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.token = token;
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

    /// Admin-gated, in-place WASM upgrade. Soroban upgradeability is protocol-level
    /// (`update_current_contract_wasm`) — no proxy needed — so this is the same mechanism the OZ
    /// `upgradeable` module wraps, implemented natively to avoid an external dependency. Lets future
    /// weeks extend this policy **without changing its contract ID**. Storage is preserved, so new
    /// code MUST keep existing `DataKey`/struct shapes (add keys; never rename or retype). The new
    /// WASM only takes effect after this call returns (any migration runs in a later tx).
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, operator: Address) {
        let cfg = load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        if operator != cfg.admin {
            panic_with_error!(&env, PolicyError::NotAdmin);
        }
        operator.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        bump_instance(&env);
    }
}

#[cfg(test)]
mod test;
