//! # zkorage fundraise-access contract (Week 8 — the composition finale)
//!
//! Gates access to a fundraise on **BOTH** legs of the zkorage engine at once:
//!   - **(a) the investor is an accredited investor** — a RISC Zero identity-style proof verified by
//!     the separate `accredited` gate (cross-called here), and
//!   - **(b) the fundraise has proven `revenue ≥ X`** — a RISC Zero value≥threshold financial proof
//!     ingested by THIS contract (the generic `claim_predicate` guest, `claim_type = 6`, revenue
//!     attested by an allow-listed auditor; revenue stays private, `X` is the public threshold).
//!
//! This is the **composition**: a financial proof (verified in-contract) AND an identity proof
//! (verified in a cross-called gate) combine into one access decision. The two facts are about
//! **different subjects** — the *investor* is accredited; the *fundraise/company* has revenue ≥ X — so
//! they are two independent proofs AND'd on-chain, not one combined proof.
//!
//! ## Revenue ingest — `submit_revenue_proof` (mirrors the PoR policy, minus the supply oracle)
//! Image pin → recompute `sha256(journal)` on-chain → cross-verify the bare Groth16 verifier →
//! `result == true`, `claim_type == 6`, auditor ∈ allowlist, **`journal.threshold == Config.threshold`
//! (= X)**, `expiry > now`. Stores a freshness-stamped `RevenueRecord`. The contract PINS `X`, so a
//! prover cannot lower the bar; the auditor signs the private revenue `R`, so a prover cannot inflate
//! it. (PoR binds the proven threshold to the on-chain token supply; revenue isn't on-chain, so the
//! binding is instead "the proven threshold equals the fundraise's configured `X`".)
//!
//! ## The AND — `can_access` (live) / `request_investor_access` (records the admission)
//! `is_revenue_verified()` (record exists ∧ `expiry > now`) **AND** the `accredited` gate's
//! `is_granted(accessor)` (itself freshness-aware) — **both legs re-evaluated live**, so access drops
//! if either the revenue proof or the accreditation credential expires. `request_investor_access` is
//! the permissionless action that requires both legs true NOW and writes an append-only admission
//! record + event (the on-chain history channel, consistent with every prior use-case).
//!
//! ## Scope / limitations (demo)
//! - **Single fundraise per contract instance** (one `X`, one auditor allowlist). A multi-fundraise
//!   deployment would key state by a `fundraise_id` and bind it inside the revenue envelope.
//! - **Revenue proof is not bound to a specific fundraise id** — the contract's own config (pinned `X`
//!   + auditor allowlist) IS the binding; with one instance that is exact.
//! - `accessor` is not authenticated (inherited from the accredited gate); nullifier deferred; trusted
//!   admin with no timelock. **Unaudited — demo only.**

#![no_std]

use risc0_interface::RiscZeroVerifierClient;
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, Address, Bytes, BytesN, Env, Map, Vec,
};

/// Revenue journal wire layout (61 bytes, big-endian) — the generic `claim_predicate` guest commits
/// it; `value` (the real revenue) is ABSENT/private.
///   [0]      result     u8   (1 = true)
///   [1..5]   claim_type u32  (= 6, revenue)
///   [5..37]  issuer_id  [u8;32]  (the revenue auditor's ed25519 pubkey; == the signing key)
///   [37..45] threshold  u64   (the public revenue floor X the guest proved revenue ≥)
///   [45..53] nonce      u64
///   [53..61] expiry     u64
const JOURNAL_LEN: u32 = 61;

// ~5s ledgers. Keep config + records comfortably alive for the demo window.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP: u32 = 30 * DAY_IN_LEDGERS;
const THRESHOLD: u32 = BUMP - DAY_IN_LEDGERS;

// Max page size for `get_history` — bounds a single read's storage footprint.
const MAX_PAGE: u32 = 50;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FundraiseError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    ImageMismatch = 3,
    MalformedJournal = 4,
    ProofInvalid = 5,
    ResultNotTrue = 6,
    ClaimTypeMismatch = 7,
    IssuerNotAllowed = 8,
    Expired = 9,
    /// `journal.threshold` (the proven revenue floor) != the fundraise's configured `X`.
    ThresholdMismatch = 10,
    /// `request_investor_access`: the fundraise has no currently-valid revenue proof.
    RevenueNotVerified = 11,
    /// `request_investor_access`: the investor is not a currently-accredited holder of `accessor`.
    NotAccredited = 12,
    NotAdmin = 13,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    /// Revenue auditor allowlist.
    Issuers,
    /// The latest verified revenue proof (the financial leg). Re-proving overwrites it.
    Revenue,
    /// Latest investor admission (persistent).
    Latest,
    /// Investor admission record for a given accessor (persistent). Presence == was admitted.
    Access(BytesN<32>),
    /// Total number of investor admissions appended to the log (instance).
    Count,
    /// The i-th investor admission in the append-only history (persistent).
    Log(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub verifier: Address,
    /// The `accredited` gate this fundraise AND's against (cross-called `is_granted`).
    pub accredited_gate: Address,
    /// Canonical image of the generic value≥threshold guest used for the revenue claim.
    pub revenue_image_id: BytesN<32>,
    /// Claim type accepted for the revenue proof (= 6).
    pub revenue_claim_type: u32,
    /// The public revenue floor `X` the proof's committed threshold must equal.
    pub revenue_threshold: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevenueRecord {
    /// The proven revenue floor X (== `Config.revenue_threshold` at submission time).
    pub threshold: u64,
    /// The revenue auditor that signed the (private) revenue figure — checked against the allowlist.
    pub issuer_id: BytesN<32>,
    pub claim_type: u32,
    pub nonce: u64,
    pub expiry: u64,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvestorAccess {
    /// Position in the append-only admission history (0-based).
    pub index: u32,
    /// The public binding admitted (e.g. a Stellar account's ed25519 key).
    pub accessor: BytesN<32>,
    /// The revenue floor X in force when this investor was admitted (snapshot).
    pub revenue_threshold: u64,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct InvestorAdmitted {
    #[topic]
    pub accessor: BytesN<32>,
    pub index: u32,
    pub revenue_threshold: u64,
    pub ledger: u32,
}

/// Minimal client for the `accredited` gate — we only need the live access decision for the AND.
#[contractclient(name = "AccreditedGateClient")]
pub trait AccreditedGateInterface {
    fn is_granted(env: Env, accessor: BytesN<32>) -> bool;
}

fn load_config(env: &Env) -> Result<Config, FundraiseError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(FundraiseError::NotInitialized)
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
pub struct Fundraise;

#[contractimpl]
impl Fundraise {
    /// One-time setup. `accredited_gate` is the deployed `accredited` gate contract; `revenue_image_id`
    /// is the canonical generic-guest image; `revenue_claim_type` is `6`; `revenue_threshold` is the
    /// public revenue floor `X`; `issuers` is the initial allow-listed revenue-auditor ed25519 pubkeys.
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier: Address,
        accredited_gate: Address,
        revenue_image_id: BytesN<32>,
        revenue_claim_type: u32,
        revenue_threshold: u64,
        issuers: Vec<BytesN<32>>,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, FundraiseError::AlreadyInitialized);
        }
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                verifier,
                accredited_gate,
                revenue_image_id,
                revenue_claim_type,
                revenue_threshold,
            },
        );
        let mut map: Map<BytesN<32>, bool> = Map::new(&env);
        for k in issuers.iter() {
            map.set(k, true);
        }
        env.storage().instance().set(&DataKey::Issuers, &map);
        bump_instance(&env);
    }

    /// Ingest a `revenue ≥ X` proof (the financial leg). See the module docs for the enforcement order.
    /// Permissionless — the proof + the pinned `X`/allowlist are the authorization.
    pub fn submit_revenue_proof(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
    ) -> Result<RevenueRecord, FundraiseError> {
        let cfg = load_config(&env)?;

        // (1) image pin — the proof MUST come from our canonical generic guest.
        if image_id != cfg.revenue_image_id {
            return Err(FundraiseError::ImageMismatch);
        }

        // (2) recompute the journal digest on-chain (binds parsed fields to the proof).
        if journal.len() != JOURNAL_LEN {
            return Err(FundraiseError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();

        // (3) cross-verify against the bare Groth16 verifier. Any non-Ok => invalid.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(FundraiseError::ProofInvalid),
        }

        // (4) parse + policy-check the journal.
        let mut jb = [0u8; 61];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(FundraiseError::ResultNotTrue);
        }
        let claim_type = be_u32(&jb, 1);
        if claim_type != cfg.revenue_claim_type {
            return Err(FundraiseError::ClaimTypeMismatch);
        }
        let mut id = [0u8; 32];
        id.copy_from_slice(&jb[5..37]);
        let issuer_id = BytesN::from_array(&env, &id);
        let threshold = be_u64(&jb, 37);
        let nonce = be_u64(&jb, 45);
        let expiry = be_u64(&jb, 53);

        let issuers: Map<BytesN<32>, bool> = env.storage().instance().get(&DataKey::Issuers).unwrap();
        if !issuers.get(issuer_id.clone()).unwrap_or(false) {
            return Err(FundraiseError::IssuerNotAllowed);
        }
        // (5) threshold binding — the proven revenue floor must equal the fundraise's pinned `X`.
        if threshold != cfg.revenue_threshold {
            return Err(FundraiseError::ThresholdMismatch);
        }
        let now = env.ledger().timestamp();
        if expiry <= now {
            return Err(FundraiseError::Expired);
        }

        // (6) store the latest verified revenue (the financial leg). Re-proving overwrites.
        let rec = RevenueRecord {
            threshold,
            issuer_id,
            claim_type,
            nonce,
            expiry,
            ledger: env.ledger().sequence(),
            timestamp: now,
        };
        let pstore = env.storage().persistent();
        pstore.set(&DataKey::Revenue, &rec);
        pstore.extend_ttl(&DataKey::Revenue, THRESHOLD, BUMP);
        bump_instance(&env);

        Ok(rec)
    }

    /// Admit an investor to the fundraise — the permissionless **AND** action. Requires, NOW: a
    /// currently-valid revenue proof AND a currently-valid accreditation grant for `accessor` (cross-
    /// called on the `accredited` gate). Records an append-only admission + emits `investor_admitted`.
    pub fn request_investor_access(
        env: Env,
        accessor: BytesN<32>,
    ) -> Result<InvestorAccess, FundraiseError> {
        let cfg = load_config(&env)?;

        // Leg (b): the fundraise's revenue proof must be currently valid.
        if !Self::is_revenue_verified(env.clone()) {
            return Err(FundraiseError::RevenueNotVerified);
        }
        // Leg (a): the investor must be a currently-accredited holder of `accessor` (cross-call).
        // `try_is_granted` keeps this fail-closed even if the gate is misconfigured (a hard trap from a
        // broken gate would otherwise revert the tx with an opaque error; here any non-Ok(true) => denied).
        let granted = matches!(
            AccreditedGateClient::new(&env, &cfg.accredited_gate).try_is_granted(&accessor),
            Ok(Ok(true))
        );
        if !granted {
            return Err(FundraiseError::NotAccredited);
        }

        // Record the admission (append-only log + latest + per-accessor) and emit.
        let index: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let rec = InvestorAccess {
            index,
            accessor: accessor.clone(),
            revenue_threshold: cfg.revenue_threshold,
            ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
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

        InvestorAdmitted {
            accessor,
            index,
            revenue_threshold: rec.revenue_threshold,
            ledger: rec.ledger,
        }
        .publish(&env);

        Ok(rec)
    }

    // ---- reads ----

    /// **The composed access decision (live).** True iff the fundraise has a currently-valid revenue
    /// proof AND `accessor` is a currently-accredited investor (cross-called). Re-evaluated on every
    /// read — drops if either leg expires. A relying party (the fundraise UI) gates on this; it does
    /// NOT require a prior `request_investor_access` (that only writes the auditable admission record).
    pub fn can_access(env: Env, accessor: BytesN<32>) -> bool {
        if !Self::is_revenue_verified(env.clone()) {
            return false;
        }
        let cfg = match load_config(&env) {
            Ok(c) => c,
            Err(_) => return false,
        };
        // `try_is_granted` keeps this read TOTAL — a misconfigured `accredited_gate` yields `false`
        // (denied) instead of trapping the whole simulate, so a relying party always gets a clean answer.
        matches!(
            AccreditedGateClient::new(&env, &cfg.accredited_gate).try_is_granted(&accessor),
            Ok(Ok(true))
        )
    }

    /// True iff the fundraise has a currently-valid revenue proof: a record exists, `expiry > now`, AND
    /// its proven floor still equals the **current** pinned `X`. The financial leg of the AND,
    /// freshness-aware — so a stale proof stops gating, and an admin `set_threshold` to a NEW `X`
    /// immediately revokes a proof that cleared the OLD floor (until a fresh proof matching the new `X`).
    pub fn is_revenue_verified(env: Env) -> bool {
        let rec: RevenueRecord = match env.storage().persistent().get(&DataKey::Revenue) {
            Some(r) => r,
            None => return false,
        };
        if rec.expiry <= env.ledger().timestamp() {
            return false;
        }
        match load_config(&env) {
            Ok(cfg) => rec.threshold == cfg.revenue_threshold,
            Err(_) => false,
        }
    }

    /// The latest verified revenue record (regardless of expiry — use `is_revenue_verified` for the
    /// freshness-aware decision). The real revenue figure is never stored (only the proven floor X).
    pub fn get_revenue_record(env: Env) -> Option<RevenueRecord> {
        env.storage().persistent().get(&DataKey::Revenue)
    }

    /// The raw stored admission record for an accessor (regardless of current validity — use
    /// `can_access` for the live decision).
    pub fn get_investor_access(env: Env, accessor: BytesN<32>) -> Option<InvestorAccess> {
        env.storage().persistent().get(&DataKey::Access(accessor))
    }

    pub fn get_latest_access(env: Env) -> Option<InvestorAccess> {
        env.storage().persistent().get(&DataKey::Latest)
    }

    /// Total number of investor admissions in the append-only history.
    pub fn get_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    pub fn get_by_index(env: Env, index: u32) -> Option<InvestorAccess> {
        env.storage().persistent().get(&DataKey::Log(index))
    }

    /// A page of the append-only admission history, in order, from `start` (0-based). `limit` is
    /// clamped to `MAX_PAGE`. Use each record's own `.index` as the canonical position (pruned
    /// indices are skipped).
    pub fn get_history(env: Env, start: u32, limit: u32) -> Vec<InvestorAccess> {
        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let lim = if limit > MAX_PAGE { MAX_PAGE } else { limit };
        let mut out: Vec<InvestorAccess> = Vec::new(&env);
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

    pub fn set_image_id(env: Env, revenue_image_id: BytesN<32>) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.revenue_image_id = revenue_image_id;
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

    /// Repoint the revenue floor `X`. Note: an already-stored revenue record keeps its own
    /// `threshold` snapshot; a NEW `submit_revenue_proof` must match the new `X`.
    pub fn set_threshold(env: Env, revenue_threshold: u64) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.revenue_threshold = revenue_threshold;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Repoint the `accredited` gate this fundraise AND's against.
    pub fn set_accredited_gate(env: Env, accredited_gate: Address) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.accredited_gate = accredited_gate;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Admin-gated, in-place WASM upgrade (same native `update_current_contract_wasm` mechanism as the
    /// other zkorage contracts). Storage preserved — new code MUST keep existing `DataKey`/struct
    /// shapes (add keys; never rename or retype).
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, operator: Address) {
        let cfg = load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        if operator != cfg.admin {
            panic_with_error!(&env, FundraiseError::NotAdmin);
        }
        operator.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        bump_instance(&env);
    }
}

#[cfg(test)]
mod test;
