//! # zkorage solvency-gate contract (BP3 — a solvency proof that dies when you pull your collateral)
//!
//! Binds a RISC Zero proof (`reserves >= supply`, reserves PRIVATE) to **two live on-chain facts**:
//!   1. the proven `supply` equals the real circulating supply of a configured supply token (the PoR
//!      binding, reused), and
//!   2. a specific **bonded escrow lock** is currently live, revocable, in the right token, and holds at
//!      least the proven `min_amount` (read cross-contract from the zkorage escrow).
//!
//! The killer property: `is_granted` is computed **LIVE** with no stored grant expiry, so it cross-reads
//! the escrow on every call. The instant the issuer calls `unbond` (or the lock passes `unlock_time` /
//! is withdrawn), the lock stops being "active" and the solvency grant evaporates in the same breath.
//! That is the demo money-shot: ACTIVE -> VOID the moment you pull your collateral.
//!
//! ## Ownership binding (improves on the locked spec)
//! `submit_solvency_proof` calls `lock.depositor.require_auth()`, so only the party who controls the bond
//! can assert solvency against it (no free-riding on someone else's lock). The grant is keyed by the
//! depositor. The submitter is the lock's depositor (source-account auth covers it; no `signAuthEntry`).
//! `is_granted` is a permissionless read (no auth) so any relying party can re-check live.
//!
//! ## Enforcement order (submit_solvency_proof)
//! 1. **Image pin** — `image_id == Config.image_id` (the bare verifier is image-agnostic, so pinning is
//!    mandatory for soundness).
//! 2. **Digest recomputation** — `sha256(journal)` recomputed on-chain, handed to the verifier (binds the
//!    parsed fields to the proof).
//! 3. **Cross-verify** — the bare Groth16 verifier must accept (seal, image_id, digest).
//! 4. **Journal policy** — `result == 1`, `claim_type == 12`, reserve auditor in the allowlist, `expiry > now`.
//! 5. **Escrow id binding** — `journal.escrow == Config.escrow_id`.
//! 6. **Supply binding** — `journal.supply_token == Config.supply_token_id` AND
//!    `supply_token.total_supply() == journal.supply` (cross-call; the proven liability is the REAL one).
//! 7. **Bond binding** — `journal.bond_token == Config.bond_token_id`; then cross-read `escrow.get_lock`:
//!    the lock is active (`!released && now < unlock_time`), `revocable == true`, `lock.token ==
//!    Config.bond_token`, and `lock.amount >= journal.min_amount`.
//! 8. **Ownership** — `lock.depositor.require_auth()`.
//! 9. **Persist** — store a `SolvencyRecord` keyed by depositor (+ append-only log) and emit.
//!
//! Each token is bound by id-bytes from the journal (compared to a config id) AND by the config Address
//! used for the cross-call, so the proof's claimed token and the live lock's token must both equal the
//! configured token. This avoids any in-contract Address<->bytes conversion. A future multi-token
//! deployment is a pure gate upgrade (the journal already carries the token ids; storage is preserved).
//!
//! **Unaudited — demo only.**

#![no_std]

use risc0_interface::RiscZeroVerifierClient;
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, Address, Bytes, BytesN, Env, Map, Vec,
};

/// Solvency-bonded journal wire layout (173 bytes, big-endian). The first 61 bytes are byte-identical to
/// the PoR journal; the remaining 112 bind the escrow lock + the two token roles. `value` (reserves) is
/// ABSENT/private.
///   [0]        result        u8   (1 = true)
///   [1..5]     claim_type     u32  (= 12, solvency-bonded)
///   [5..37]    issuer_id      [u8;32]  (the bonded reserve auditor's ed25519 pubkey)
///   [37..45]   supply         u64   (the proven liability; bound to supply_token.total_supply())
///   [45..53]   nonce          u64
///   [53..61]   expiry         u64
///   [61..93]   escrow         [u8;32]  (escrow contract id)
///   [93..101]  lock_id        u64
///   [101..109] min_amount     u64
///   [109..141] bond_token     [u8;32]  (bond/collateral token id)
///   [141..173] supply_token   [u8;32]  (supply/liability token id)
const JOURNAL_LEN: u32 = 173;
const CLAIM_TYPE_SOLVENCY: u32 = 12;

// ~5s ledgers. Keep config + records comfortably alive for the demo window.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP: u32 = 30 * DAY_IN_LEDGERS;
const THRESHOLD: u32 = BUMP - DAY_IN_LEDGERS;

// Max page size for `get_history` — bounds a single read's storage footprint.
const MAX_PAGE: u32 = 50;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum SolvencyError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    ImageMismatch = 3,
    MalformedJournal = 4,
    ProofInvalid = 5,
    ResultNotTrue = 6,
    ClaimTypeMismatch = 7,
    IssuerNotAllowed = 8,
    Expired = 9,
    /// `journal.escrow` != the configured escrow id.
    EscrowMismatch = 10,
    /// `journal.supply_token` != the configured supply-token id.
    SupplyTokenMismatch = 11,
    /// `journal.supply` != the supply token's live `total_supply()`.
    SupplyMismatch = 12,
    /// `total_supply()` outside the u64 range the journal commits.
    SupplyOutOfRange = 13,
    /// The bonded lock does not exist (or the escrow read failed).
    LockNotFound = 14,
    /// The lock is released or already past `unlock_time` (not currently bonding anything).
    LockNotActive = 15,
    /// The lock is not revocable (a bond you cannot pull is not skin in the game).
    NotRevocable = 16,
    /// `journal.bond_token` != the configured bond-token id, or the lock holds a different token.
    BondTokenMismatch = 17,
    /// `lock.amount` < `journal.min_amount`.
    InsufficientBond = 18,
    NotAdmin = 19,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    /// Bonded reserve-auditor allowlist.
    Issuers,
    /// Latest solvency record (persistent).
    Latest,
    /// Per-depositor solvency record (persistent). Presence == was admitted; validity is LIVE.
    Record(Address),
    /// Total number of records appended to the log (instance).
    Count,
    /// The i-th record in the append-only history (persistent).
    Log(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub verifier: Address,
    /// The zkorage escrow this gate reads cross-contract.
    pub escrow: Address,
    /// The escrow's 32-byte contract id (== `journal.escrow`).
    pub escrow_id: BytesN<32>,
    /// The supply/liability token whose `total_supply()` the proven `supply` must equal.
    pub supply_token: Address,
    /// The supply token's 32-byte contract id (== `journal.supply_token`).
    pub supply_token_id: BytesN<32>,
    /// The bond/collateral token the lock must hold.
    pub bond_token: Address,
    /// The bond token's 32-byte contract id (== `journal.bond_token`).
    pub bond_token_id: BytesN<32>,
    pub image_id: BytesN<32>,
    pub claim_type: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SolvencyRecord {
    /// Position in the append-only history (0-based).
    pub index: u32,
    /// The bond owner this grant is keyed to (== the lock's depositor; authenticated at submit).
    pub depositor: Address,
    /// The reserve auditor that signed the (private) reserve figure.
    pub issuer_id: BytesN<32>,
    /// The proven liability (== supply_token.total_supply() at submit time).
    pub supply: u64,
    /// The escrow lock backing this proof.
    pub lock_id: u64,
    /// The bonded amount the proof asserted (lock.amount >= this).
    pub min_amount: u64,
    /// Soft staleness bound on the reserve attestation (NOT the bond's expiry).
    pub expiry: u64,
    pub nonce: u64,
    pub ledger: u32,
    pub timestamp: u64,
}

#[contractevent]
pub struct SolvencyProven {
    #[topic]
    pub depositor: Address,
    pub index: u32,
    pub lock_id: u64,
    pub supply: u64,
    pub min_amount: u64,
    pub ledger: u32,
}

/// Minimal client for the supply token — we only need the live supply read for the binding.
#[contractclient(name = "SupplyTokenClient")]
pub trait SupplyTokenInterface {
    fn total_supply(env: Env) -> i128;
}

/// One escrowed deposit — MUST mirror the zkorage escrow's `Lock` contracttype byte-for-byte (the escrow
/// is immutable, so this never drifts). Re-declared here (rather than depending on the escrow contract
/// crate) so the gate's wasm does not link the escrow's contract logic; only the type + cross-call stub.
#[contracttype]
#[derive(Clone)]
pub struct Lock {
    pub id: u64,
    pub depositor: Address,
    pub token: Address,
    pub amount: i128,
    pub unlock_time: u64,
    pub claimant: Address,
    pub commitment: BytesN<32>,
    pub revocable: bool,
    pub released: bool,
}

/// Minimal client for the escrow — we read the full lock and derive liveness ourselves (atomic
/// read-and-act in this same transaction, per the escrow's gate-author note).
#[contractclient(name = "EscrowClient")]
pub trait EscrowInterface {
    fn get_lock(env: Env, lock_id: u64) -> Lock;
}

fn load_config(env: &Env) -> Result<Config, SolvencyError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(SolvencyError::NotInitialized)
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(THRESHOLD, BUMP);
}

fn be_u32(a: &[u8; 173], o: usize) -> u32 {
    u32::from_be_bytes([a[o], a[o + 1], a[o + 2], a[o + 3]])
}

fn be_u64(a: &[u8; 173], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&a[o..o + 8]);
    u64::from_be_bytes(b)
}

fn bytes32(env: &Env, a: &[u8; 173], o: usize) -> BytesN<32> {
    let mut b = [0u8; 32];
    b.copy_from_slice(&a[o..o + 32]);
    BytesN::from_array(env, &b)
}

/// Live liveness of a fetched lock against the bond bindings. Returns the specific error so submit can
/// surface it; `is_granted` just maps any error to `false`.
fn check_lock_bonded(
    env: &Env,
    cfg: &Config,
    lock: &Lock,
    min_amount: u64,
    now: u64,
) -> Result<(), SolvencyError> {
    if lock.released || now >= lock.unlock_time {
        return Err(SolvencyError::LockNotActive);
    }
    if !lock.revocable {
        return Err(SolvencyError::NotRevocable);
    }
    if lock.token != cfg.bond_token {
        return Err(SolvencyError::BondTokenMismatch);
    }
    if lock.amount < i128::from(min_amount) {
        return Err(SolvencyError::InsufficientBond);
    }
    let _ = env;
    Ok(())
}

#[contract]
pub struct SolvencyGate;

#[contractimpl]
impl SolvencyGate {
    /// One-time setup. `escrow`/`supply_token`/`bond_token` are the deployed contracts; their `*_id`
    /// args are the matching 32-byte contract ids (== what the guest commits in the journal). `image_id`
    /// is the canonical solvency guest image; `claim_type` is 12; `issuers` is the bonded reserve-auditor
    /// ed25519-pubkey allowlist.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier: Address,
        escrow: Address,
        escrow_id: BytesN<32>,
        supply_token: Address,
        supply_token_id: BytesN<32>,
        bond_token: Address,
        bond_token_id: BytesN<32>,
        image_id: BytesN<32>,
        claim_type: u32,
        issuers: Vec<BytesN<32>>,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, SolvencyError::AlreadyInitialized);
        }
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                verifier,
                escrow,
                escrow_id,
                supply_token,
                supply_token_id,
                bond_token,
                bond_token_id,
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

    /// Verify a solvency-bonded proof, bind it to the live supply + the bonded escrow lock, require the
    /// lock owner's auth, and persist. See the module docs for the full enforcement order. The lock
    /// owner authorizes; otherwise permissionless (the proof + bindings are the rest of the authorization).
    pub fn submit_solvency_proof(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal: Bytes,
    ) -> Result<SolvencyRecord, SolvencyError> {
        let cfg = load_config(&env)?;

        // (1) image pin.
        if image_id != cfg.image_id {
            return Err(SolvencyError::ImageMismatch);
        }

        // (2) recompute the journal digest on-chain (binds parsed fields to the proof).
        if journal.len() != JOURNAL_LEN {
            return Err(SolvencyError::MalformedJournal);
        }
        let digest: BytesN<32> = env.crypto().sha256(&journal).into();

        // (3) cross-verify against the bare Groth16 verifier.
        let verifier = RiscZeroVerifierClient::new(&env, &cfg.verifier);
        match verifier.try_verify(&seal, &image_id, &digest) {
            Ok(Ok(())) => {}
            _ => return Err(SolvencyError::ProofInvalid),
        }

        // (4) parse + policy-check the journal.
        let mut jb = [0u8; 173];
        journal.copy_into_slice(&mut jb);
        if jb[0] != 1 {
            return Err(SolvencyError::ResultNotTrue);
        }
        let claim_type = be_u32(&jb, 1);
        if claim_type != cfg.claim_type || claim_type != CLAIM_TYPE_SOLVENCY {
            return Err(SolvencyError::ClaimTypeMismatch);
        }
        let issuer_id = bytes32(&env, &jb, 5);
        let supply = be_u64(&jb, 37);
        let nonce = be_u64(&jb, 45);
        let expiry = be_u64(&jb, 53);
        let escrow_id = bytes32(&env, &jb, 61);
        let lock_id = be_u64(&jb, 93);
        let min_amount = be_u64(&jb, 101);
        let bond_token_id = bytes32(&env, &jb, 109);
        let supply_token_id = bytes32(&env, &jb, 141);

        let issuers: Map<BytesN<32>, bool> = env.storage().instance().get(&DataKey::Issuers).unwrap();
        if !issuers.get(issuer_id.clone()).unwrap_or(false) {
            return Err(SolvencyError::IssuerNotAllowed);
        }
        let now = env.ledger().timestamp();
        if expiry <= now {
            return Err(SolvencyError::Expired);
        }

        // (5) escrow id binding.
        if escrow_id != cfg.escrow_id {
            return Err(SolvencyError::EscrowMismatch);
        }

        // (6) supply binding — proven liability must equal the REAL on-chain circulating supply.
        if supply_token_id != cfg.supply_token_id {
            return Err(SolvencyError::SupplyTokenMismatch);
        }
        let ts: i128 = SupplyTokenClient::new(&env, &cfg.supply_token).total_supply();
        if ts < 0 || ts > i128::from(u64::MAX) {
            return Err(SolvencyError::SupplyOutOfRange);
        }
        if ts as u64 != supply {
            return Err(SolvencyError::SupplyMismatch);
        }

        // (7) bond binding — proven token must match config, then read the live lock and check it.
        if bond_token_id != cfg.bond_token_id {
            return Err(SolvencyError::BondTokenMismatch);
        }
        let lock = match EscrowClient::new(&env, &cfg.escrow).try_get_lock(&lock_id) {
            Ok(Ok(l)) => l,
            _ => return Err(SolvencyError::LockNotFound),
        };
        check_lock_bonded(&env, &cfg, &lock, min_amount, now)?;

        // (8) ownership — only the bond owner may assert solvency against their own lock.
        lock.depositor.require_auth();

        // (9) persist (append-only log + latest + per-depositor) and emit.
        let index: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let rec = SolvencyRecord {
            index,
            depositor: lock.depositor.clone(),
            issuer_id,
            supply,
            lock_id,
            min_amount,
            expiry,
            nonce,
            ledger: env.ledger().sequence(),
            timestamp: now,
        };
        let pstore = env.storage().persistent();
        pstore.set(&DataKey::Log(index), &rec);
        pstore.extend_ttl(&DataKey::Log(index), THRESHOLD, BUMP);
        pstore.set(&DataKey::Latest, &rec);
        pstore.extend_ttl(&DataKey::Latest, THRESHOLD, BUMP);
        pstore.set(&DataKey::Record(lock.depositor.clone()), &rec);
        pstore.extend_ttl(&DataKey::Record(lock.depositor.clone()), THRESHOLD, BUMP);
        env.storage()
            .instance()
            .set(&DataKey::Count, &index.saturating_add(1));
        bump_instance(&env);

        SolvencyProven {
            depositor: lock.depositor,
            index,
            lock_id,
            supply,
            min_amount,
            ledger: rec.ledger,
        }
        .publish(&env);

        Ok(rec)
    }

    // ---- reads ----

    /// **The live solvency decision.** True iff `depositor` has a recorded solvency proof whose reserve
    /// attestation is still fresh, whose proven supply still equals the supply token's CURRENT
    /// `total_supply()`, AND whose backing lock is STILL active + revocable + in the bond token + >=
    /// min_amount. Re-evaluated on every read by cross-reading the escrow + supply token, so it flips to
    /// `false` the instant the issuer `unbond`s, the lock unlocks, or the supply changes. Permissionless.
    pub fn is_granted(env: Env, depositor: Address) -> bool {
        let rec: SolvencyRecord = match env.storage().persistent().get(&DataKey::Record(depositor)) {
            Some(r) => r,
            None => return false,
        };
        let cfg = match load_config(&env) {
            Ok(c) => c,
            Err(_) => return false,
        };
        let now = env.ledger().timestamp();
        // reserve attestation still fresh
        if rec.expiry <= now {
            return false;
        }
        // proven supply still equals the live circulating supply (any mint/burn drops it until re-proof)
        let ts: i128 = match SupplyTokenClient::new(&env, &cfg.supply_token).try_total_supply() {
            Ok(Ok(v)) => v,
            _ => return false,
        };
        if ts < 0 || ts > i128::from(u64::MAX) || ts as u64 != rec.supply {
            return false;
        }
        // the bond is STILL live (the self-void) — total read: a missing/broken lock denies, never traps.
        let lock = match EscrowClient::new(&env, &cfg.escrow).try_get_lock(&rec.lock_id) {
            Ok(Ok(l)) => l,
            _ => return false,
        };
        check_lock_bonded(&env, &cfg, &lock, rec.min_amount, now).is_ok()
    }

    /// The raw stored record for a depositor (regardless of current validity — use `is_granted` for the
    /// live decision). The real reserve figure is never stored (only that it cleared `supply`).
    pub fn get_record(env: Env, depositor: Address) -> Option<SolvencyRecord> {
        env.storage().persistent().get(&DataKey::Record(depositor))
    }

    pub fn get_latest(env: Env) -> Option<SolvencyRecord> {
        env.storage().persistent().get(&DataKey::Latest)
    }

    pub fn get_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    pub fn get_by_index(env: Env, index: u32) -> Option<SolvencyRecord> {
        env.storage().persistent().get(&DataKey::Log(index))
    }

    /// A page of the append-only history, in order, from `start` (0-based). `limit` clamped to `MAX_PAGE`.
    pub fn get_history(env: Env, start: u32, limit: u32) -> Vec<SolvencyRecord> {
        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let lim = if limit > MAX_PAGE { MAX_PAGE } else { limit };
        let mut out: Vec<SolvencyRecord> = Vec::new(&env);
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

    /// Repoint the escrow this gate reads. Both the Address (for the cross-call) and its id (for the
    /// journal binding) move together.
    pub fn set_escrow(env: Env, escrow: Address, escrow_id: BytesN<32>) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.escrow = escrow;
        cfg.escrow_id = escrow_id;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Repoint the supply/liability token (Address + id together).
    pub fn set_supply_token(env: Env, supply_token: Address, supply_token_id: BytesN<32>) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.supply_token = supply_token;
        cfg.supply_token_id = supply_token_id;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Repoint the bond/collateral token (Address + id together).
    pub fn set_bond_token(env: Env, bond_token: Address, bond_token_id: BytesN<32>) {
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();
        cfg.bond_token = bond_token;
        cfg.bond_token_id = bond_token_id;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Admin-gated, in-place WASM upgrade (same native `update_current_contract_wasm` mechanism as the
    /// other zkorage contracts). Storage preserved — new code MUST keep existing `DataKey`/struct shapes
    /// (add keys; never rename or retype). A future multi-token deployment upgrades here.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, operator: Address) {
        let cfg = load_config(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        if operator != cfg.admin {
            panic_with_error!(&env, SolvencyError::NotAdmin);
        }
        operator.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        bump_instance(&env);
    }
}

#[cfg(test)]
mod test;
