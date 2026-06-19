//! # zkorage payroll gate contract (Confidential Proof-of-Income + Auditor View-Key)
//!
//! Accepts a RISC Zero proof that an **allow-listed payroll attester signed a salary** and that the
//! (hidden) salary is **≥ a public threshold** — **without the salary ever appearing** — and grants an
//! on-chain "income-verified" record to the bound `accessor`. Like the Week-5/6 gates, it does NOT
//! re-implement Groth16: it **cross-calls the bare, immutable [`RiscZeroVerifierClient`]** (deployed in
//! Week 1) and adds the payroll-policy + access layer.
//!
//! ## The claim (pure proof-of-income — the salary stays confidential)
//! The `payroll_predicate` guest verifies the attester's ed25519 signature over a `PayrollEnvelope`
//! (claim_type 5), asserts `salary ≥ threshold`, and commits a journal that **records the cleared
//! `threshold`** (the public bar) but **never the salary**. There is no on-chain "market rate" — the
//! contracted rate is confidential between employee and company. The relying party reads the cleared
//! threshold and decides whether it clears their own bar (a lender/landlord income requirement, etc.).
//!
//! ## Auditor selective disclosure (the Week-7 new bit) — Option B, in-guest ECIES
//! The same guest **encrypts the signed salary to an auditor's x25519 key** (ECDH + sha256 KDF/keystream)
//! and commits `(auditor_pub, eph_pub, ct, tag)` in the PUBLIC journal. The proof binds the ciphertext to
//! the signed salary, so an allow-listed auditor who decrypts with their **view key** recovers the
//! **exact confidential salary** and is mathematically certain it is the attester-signed figure (the
//! guest, not the employer, produced the ciphertext). The `tag = sha256(DOMAIN_TAG ‖ salary ‖ blinding)`
//! lets the auditor confirm the decrypt (definitive "faithful ✓" / wrong-key detection). The public sees
//! only the IND-CPA ciphertext. This gate pins an **auditor allowlist**: a proof's `auditor_pub` MUST be
//! allow-listed (so disclosures only go to authorized auditors).
//!
//! ## What `submit_payroll_proof` enforces (in order)
//! 1. **Image pin** — `image_id == Config.image_id` (the canonical payroll guest). Soundness-critical.
//! 2. **Digest recomputation** — `sha256(journal)` recomputed on-chain and handed to the verifier.
//! 3. **Cross-verify** — `verifier.verify(seal, image_id, digest)` must succeed.
//! 4. **Journal policy** — `result == true`, `claim_type == Config.claim_type` (payroll), the attester ∈
//!    issuer allowlist, `expiry > now`, and `auditor_pub ∈ auditor allowlist`.
//! 5. **Grant** — store an income-verified record keyed by `accessor` (latest + per-accessor +
//!    append-only log), carrying the cleared `threshold` + the auditor disclosure, and emit.
//!
//! ## Scope / limitations (demo)
//! - **`accessor` (and `auditor_pub`) are NOT authenticated by the proof** (extends the W5/W6 caveat) — a
//!   grant proves *"a valid attester-signed salary ≥ threshold exists and its holder chose this accessor
//!   and this disclosure target"*, not that the accessor's owner is the employee. In W7 this gains a
//!   **confidentiality** dimension: anyone holding a signed payroll envelope could route its salary
//!   disclosure to any allow-listed auditor key (incl. one they control). Benign under the self-host
//!   trust model (the prover owns the plaintext), but harden with an in-guest holder signature over
//!   `accessor`/`auditor_pub` or `accessor.require_auth()` (trades away the gasless/permissionless flow).
//! - **No anti-replay at the gate** — `submit_payroll_proof` is permissionless and the envelope `nonce`
//!   is committed but **informational only** (no uniqueness/monotonicity check). A third party can replay
//!   a valid bundle to re-grant the same accessor + append history (the auditor total dedups by accessor,
//!   so it is unaffected; `Count`/log can be inflated). **Nullifier deferred** (one credential → many
//!   accessors / sybil); a nullifier or consumed-seal set closes both.
//! - **Trusted admin** — `set_image_id` / `set_verifier` / issuer & auditor allowlists repoint trust
//!   anchors with no timelock.
//! **Unaudited — demo only.**

#![no_std]

use risc0_interface::RiscZeroVerifierClient;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Bytes, BytesN, Env, Map, Vec,
};

/// Payroll journal wire layout (229 bytes, big-endian), committed by the guest. `salary` ABSENT.
///   [0]        result      u8   (1 = true: salary ≥ threshold)
///   [1..5]     claim_type  u32  (5 = payroll / proof-of-income)
///   [5..37]    issuer_id   [u8;32]  (the payroll attester's ed25519 pubkey; == the signing key)
///   [37..45]   threshold   u64  (the public income bar that was cleared)
///   [45..77]   accessor    [u8;32]  (public binding — the verified-income credential holder)
///   [77..109]  auditor_pub [u8;32]  (x25519 disclosure target — must be allow-listed)
///   [109..141] eph_pub     [u8;32]  (ECIES ephemeral x25519 public key)
///   [141..181] ct          [u8;40]  (ECIES ciphertext of salary_be8 ‖ blinding32)
///   [181..213] tag         [u8;32]  (sha256(DOMAIN_TAG ‖ salary ‖ blinding) — faithful-decrypt check)
///   [213..221] nonce       u64
///   [221..229] expiry      u64
const JOURNAL_LEN: u32 = 229;

// ~5s ledgers. Keep config + grants comfortably alive for the demo window.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP: u32 = 30 * DAY_IN_LEDGERS;
const THRESHOLD_TTL: u32 = BUMP - DAY_IN_LEDGERS;

// Max page size for `get_history` — bounds a single read's storage footprint.
const MAX_PAGE: u32 = 50;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PayrollError {
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
    AuditorNotAllowed = 11,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Issuers,
    /// Allow-listed auditor x25519 public keys (disclosure targets).
    Auditors,
    Latest,
    /// Income-verified record for a given accessor (persistent). Presence == granted.
    Access(BytesN<32>),
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
pub struct AccessRecord {
    /// Position in the append-only history log (0-based). See `get_history`.
    pub index: u32,
    /// The public binding the proof grants to (e.g. a Stellar account's ed25519 key).
    pub accessor: BytesN<32>,
    /// The payroll attester that signed the (hidden) salary — checked against the allowlist.
    pub issuer_id: BytesN<32>,
    /// The public income bar that the (hidden) salary cleared.
    pub threshold: u64,
    /// The auditor x25519 key the salary was encrypted to (checked against the auditor allowlist).
    pub auditor_pub: BytesN<32>,
    /// ECIES ephemeral public key.
    pub eph_pub: BytesN<32>,
    /// ECIES ciphertext of `salary_be8 ‖ blinding32` (40 bytes) — only the auditor can decrypt.
    pub ct: BytesN<40>,
    /// `sha256(DOMAIN_TAG ‖ salary ‖ blinding)` — the auditor recomputes after decrypt (faithful check).
    pub tag: BytesN<32>,
    pub claim_type: u32,
    pub nonce: u64,
    pub expiry: u64,
    pub ledger: u32,
    pub timestamp: u64,
}

/// The auditor-facing disclosure blob (a thin projection of `AccessRecord`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Disclosure {
    pub auditor_pub: BytesN<32>,
    pub eph_pub: BytesN<32>,
    pub ct: BytesN<40>,
    pub tag: BytesN<32>,
}

#[contractevent]
pub struct IncomeVerified {
    #[topic]
    pub accessor: BytesN<32>,
    pub issuer_id: BytesN<32>,
    pub threshold: u64,
    pub index: u32,
    pub ledger: u32,
}

fn load_config(env: &Env) -> Result<Config, PayrollError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(PayrollError::NotInitialized)
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(THRESHOLD_TTL, BUMP);
}

fn be_u32(a: &[u8; 229], o: usize) -> u32 {
    u32::from_be_bytes([a[o], a[o + 1], a[o + 2], a[o + 3]])
}

fn be_u64(a: &[u8; 229], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&a[o..o + 8]);
    u64::from_be_bytes(b)
}

#[contract]
pub struct Payroll;

#[contractimpl]
impl Payroll {
    /// One-time setup. `image_id` is the canonical (deterministic) payroll guest image; `claim_type`
    /// is `5` for payroll; `issuers` is the initial allow-listed payroll-attester ed25519 pubkeys;
    /// `auditors` is the initial allow-listed auditor x25519 public keys (disclosure targets).
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier: Address,
        image_id: BytesN<32>,
        claim_type: u32,
        issuers: Vec<BytesN<32>>,
        auditors: Vec<BytesN<32>>,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, PayrollError::AlreadyInitialized);
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
        let mut imap: Map<BytesN<32>, bool> = Map::new(&env);
        for k in issuers.iter() {
            imap.set(k, true);
        }
        env.storage().instance().set(&DataKey::Issuers, &imap);
        let mut amap: Map<BytesN<32>, bool> = Map::new(&env);
        for k in auditors.iter() {
            amap.set(k, true);
        }
        env.storage().instance().set(&DataKey::Auditors, &amap);
        bump_instance(&env);
    }

    /// Verify a payroll proof (salary ≥ threshold) and grant an income-verified record to the bound
    /// `accessor`, carrying the auditor disclosure. See the module docs for the full enforcement order.
    /// Permissionless. The salary is never revealed (only the auditor's view key opens it).
    pub fn submit_payroll_proof(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
    ) -> Result<AccessRecord, PayrollError> {
        let cfg = load_config(&env)?;

        // (1) image pin — the proof MUST come from our canonical payroll guest.
        if image_id != cfg.image_id {
            return Err(PayrollError::ImageMismatch);
        }

        // (2) recompute the journal digest on-chain (binds parsed fields to the proof).
        if journal.len() != JOURNAL_LEN {
            return Err(PayrollError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();

        // (3) cross-verify against the bare Groth16 verifier. Any non-Ok => invalid.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(PayrollError::ProofInvalid),
        }

        // (4) parse + policy-check the journal. `jb` is exactly JOURNAL_LEN and the length was checked
        // in step (2), so `copy_into_slice` (which panics on a length mismatch) cannot trap here.
        let mut jb = [0u8; 229];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(PayrollError::ResultNotTrue);
        }
        let claim_type = be_u32(&jb, 1);
        if claim_type != cfg.claim_type {
            return Err(PayrollError::ClaimTypeMismatch);
        }
        let mut id = [0u8; 32];
        id.copy_from_slice(&jb[5..37]);
        let issuer_id = BytesN::from_array(&env, &id);
        let threshold = be_u64(&jb, 37);
        let mut acc = [0u8; 32];
        acc.copy_from_slice(&jb[45..77]);
        let accessor = BytesN::from_array(&env, &acc);
        let mut aud = [0u8; 32];
        aud.copy_from_slice(&jb[77..109]);
        let auditor_pub = BytesN::from_array(&env, &aud);
        let mut eph = [0u8; 32];
        eph.copy_from_slice(&jb[109..141]);
        let eph_pub = BytesN::from_array(&env, &eph);
        let mut ctb = [0u8; 40];
        ctb.copy_from_slice(&jb[141..181]);
        let ct = BytesN::from_array(&env, &ctb);
        let mut tagb = [0u8; 32];
        tagb.copy_from_slice(&jb[181..213]);
        let tag = BytesN::from_array(&env, &tagb);
        let nonce = be_u64(&jb, 213);
        let expiry = be_u64(&jb, 221);

        let issuers: Map<BytesN<32>, bool> = env.storage().instance().get(&DataKey::Issuers).unwrap();
        if !issuers.get(issuer_id.clone()).unwrap_or(false) {
            return Err(PayrollError::IssuerNotAllowed);
        }
        let now = env.ledger().timestamp();
        if expiry <= now {
            return Err(PayrollError::Expired);
        }
        // (4a) the disclosure must target an allow-listed auditor.
        let auditors: Map<BytesN<32>, bool> =
            env.storage().instance().get(&DataKey::Auditors).unwrap();
        if !auditors.get(auditor_pub.clone()).unwrap_or(false) {
            return Err(PayrollError::AuditorNotAllowed);
        }

        // (5) grant (append-only log + latest + per-accessor) and emit. Re-granting an accessor
        // OVERWRITES its keyed `Access` record with the latest grant AND appends a NEW history entry.
        let index: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let rec = AccessRecord {
            index,
            accessor: accessor.clone(),
            issuer_id: issuer_id.clone(),
            threshold,
            auditor_pub,
            eph_pub,
            ct,
            tag,
            claim_type,
            nonce,
            expiry,
            ledger: env.ledger().sequence(),
            timestamp: now,
        };
        let pstore = env.storage().persistent();
        pstore.set(&DataKey::Log(index), &rec);
        pstore.extend_ttl(&DataKey::Log(index), THRESHOLD_TTL, BUMP);
        pstore.set(&DataKey::Latest, &rec);
        pstore.extend_ttl(&DataKey::Latest, THRESHOLD_TTL, BUMP);
        pstore.set(&DataKey::Access(accessor.clone()), &rec);
        pstore.extend_ttl(&DataKey::Access(accessor.clone()), THRESHOLD_TTL, BUMP);
        env.storage()
            .instance()
            .set(&DataKey::Count, &index.saturating_add(1));
        bump_instance(&env);

        IncomeVerified {
            accessor,
            issuer_id,
            threshold,
            index,
            ledger: rec.ledger,
        }
        .publish(&env);

        Ok(rec)
    }

    // ---- reads ----

    /// True iff this accessor holds a **currently-valid** income-verified grant: a grant exists and its
    /// credential's `expiry` has not passed. This is the **live decision** a relying party gates on.
    /// `get_access` returns the raw stored record regardless of expiry (for audit).
    pub fn is_granted(env: Env, accessor: BytesN<32>) -> bool {
        let rec: Option<AccessRecord> = env.storage().persistent().get(&DataKey::Access(accessor));
        match rec {
            Some(r) => r.expiry > env.ledger().timestamp(),
            None => false,
        }
    }

    /// The raw stored income-verified record for an accessor (regardless of expiry — use `is_granted`
    /// for the freshness-aware live decision). Re-granting overwrites this with the latest grant.
    pub fn get_access(env: Env, accessor: BytesN<32>) -> Option<AccessRecord> {
        env.storage().persistent().get(&DataKey::Access(accessor))
    }

    /// The auditor-facing disclosure for an accessor (a projection of the stored record).
    pub fn get_disclosure(env: Env, accessor: BytesN<32>) -> Option<Disclosure> {
        let rec: Option<AccessRecord> = env.storage().persistent().get(&DataKey::Access(accessor));
        rec.map(|r| Disclosure {
            auditor_pub: r.auditor_pub,
            eph_pub: r.eph_pub,
            ct: r.ct,
            tag: r.tag,
        })
    }

    pub fn get_latest_access(env: Env) -> Option<AccessRecord> {
        env.storage().persistent().get(&DataKey::Latest)
    }

    /// Total number of grants in the append-only history.
    pub fn get_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    /// The grant at history position `index` (0-based), if any.
    pub fn get_by_index(env: Env, index: u32) -> Option<AccessRecord> {
        env.storage().persistent().get(&DataKey::Log(index))
    }

    /// A page of the append-only history, in order, from `start` (0-based). `limit` clamped to
    /// `MAX_PAGE`; empty Vec if `start` is past the end. Use each record's own `.index` as the position.
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

    pub fn is_auditor_allowed(env: Env, auditor_pub: BytesN<32>) -> bool {
        let auditors: Map<BytesN<32>, bool> = env
            .storage()
            .instance()
            .get(&DataKey::Auditors)
            .unwrap_or_else(|| Map::new(&env));
        auditors.get(auditor_pub).unwrap_or(false)
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

    pub fn add_auditor(env: Env, auditor_pub: BytesN<32>) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        let mut auditors: Map<BytesN<32>, bool> =
            env.storage().instance().get(&DataKey::Auditors).unwrap();
        auditors.set(auditor_pub, true);
        env.storage().instance().set(&DataKey::Auditors, &auditors);
        bump_instance(&env);
    }

    pub fn remove_auditor(env: Env, auditor_pub: BytesN<32>) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        let mut auditors: Map<BytesN<32>, bool> =
            env.storage().instance().get(&DataKey::Auditors).unwrap();
        auditors.remove(auditor_pub);
        env.storage().instance().set(&DataKey::Auditors, &auditors);
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

    /// Admin-gated, in-place WASM upgrade (protocol-level `update_current_contract_wasm`). Storage is
    /// preserved, so new code MUST keep existing `DataKey`/struct shapes (add keys; never rename/retype).
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, operator: Address) {
        let cfg = load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        if operator != cfg.admin {
            panic_with_error!(&env, PayrollError::NotAdmin);
        }
        operator.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        bump_instance(&env);
    }
}

#[cfg(test)]
mod test;
