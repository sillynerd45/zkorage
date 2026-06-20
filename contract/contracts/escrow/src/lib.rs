//! # zkorage Bonded-Proofs escrow (BP1)
//!
//! A **Soroban-native escrow** that locks any SEP-41 / SAC token until a stored `unlock_time`. It is the
//! shared primitive behind two upcoming ZK products (per `development/Build-Plan/claimable/PLAN.md`):
//!   1. a **solvency proof that dies when you pull your collateral** (revocable locks; a gate reads
//!      `is_locked` live and the grant evaporates the instant `unbond` is called), and
//!   2. an **anonymous tier / membership expiring at X** (non-revocable locks; `now < unlock_time`
//!      provably means "still funded", so no per-lock read is needed and anonymity is preserved).
//!
//! ## Why not a classic Claimable Balance
//! A Soroban contract cannot read a classic Claimable Balance, and a CB is fully public, so a proof
//! "about" a CB is theater. This escrow exposes `is_locked()` / `get_lock()` for a gate to read
//! cross-contract, which is the property the whole design needs.
//!
//! ## Trust model (BP1)
//! **No admin, no upgrade, no privileged role over locked funds.** Funds move only via the lock's own
//! parties:
//!   * a **self-bond** (`claimant == depositor`, the roadmap default) is released by the depositor via
//!     `withdraw` (after unlock) or `unbond` (early, revocable locks only);
//!   * a **distinct-claimant** lock (`claimant != depositor`) is a one-way time-locked send: it MUST be
//!     non-revocable, and it is releasable only by the claimant via `claim` after unlock. The depositor
//!     cannot reclaim it. This removes the withdraw-vs-claim race (a depositor cannot front-run and take
//!     funds advertised to a claimant).
//!
//! Lock expiry is enforced by the stored `unlock_time`, never by entry TTL. **Unaudited, demo only.**
//!
//! ## Notes for the gate authors (BP3/BP5)
//! * `is_locked` is only trustworthy under an **atomic read-and-act in the same transaction**. A gate
//!   that caches `is_locked == true` and grants something redeemable in a *later* transaction is wrong:
//!   the depositor can `unbond` in between. Read-and-decide in one cross-contract call.
//! * `get_lock` returns the full record (depositor, claimant, amount, commitment) to ANY caller, so it
//!   is **not** anonymity-preserving. The BP5 anonymous tier must rely on the ZK proof (and at most the
//!   boolean `is_locked`), and must never reveal a specific `lock_id` to the verifier.
//! * Restrict bonded products to fixed-supply, non-clawback, non-`AUTH_REQUIRED` tokens (enforce in the
//!   gate/UI, not here): a clawback/de-auth by the issuer can move funds the escrow cannot observe.

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient, Address,
    BytesN, Env,
};

// ~5s ledgers -> ~17,280/day. TTL is housekeeping (keeps entries from being archived), NOT a security
// boundary: lock expiry is always enforced by the stored `unlock_time`. We bump on read as well as on
// write so a long-dormant lock a gate watches stays warm (an archived entry makes a read ABORT the
// transaction, never silently return "unlocked").
const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = DAY_IN_LEDGERS; // ~1 day
const TTL_EXTEND: u32 = 60 * DAY_IN_LEDGERS; // ~60 days

/// One escrowed deposit.
#[contracttype]
#[derive(Clone)]
pub struct Lock {
    pub id: u64,
    pub depositor: Address,
    pub token: Address,
    /// The ACTUAL amount received by the contract at deposit time (measured, not the requested figure).
    pub amount: i128,
    /// Unix seconds. Funds become movable at/after this time.
    pub unlock_time: u64,
    /// Who may `claim()` after unlock. `== depositor` for a self-bond; a distinct claimant makes this a
    /// non-revocable one-way send releasable only by the claimant.
    pub claimant: Address,
    /// Hiding tag for the BP5 anonymous-tier proof; all-zero when unused. NOT validated in BP1 (it is an
    /// attacker-controlled blob today); the BP5 guest/gate must verify it against the proof.
    pub commitment: BytesN<32>,
    /// `true` => depositor may `unbond()` early (the solvency "pull your collateral" path). Enforced at
    /// deposit time to imply a self-bond.
    pub revocable: bool,
    /// `true` once withdrawn / claimed / unbonded.
    pub released: bool,
}

#[contracttype]
pub enum DataKey {
    /// Monotonic lock-id counter (lazy-initialised; first lock is id 1). Lives in instance storage and
    /// survives archival/restore (restore preserves the value), so `unwrap_or(0)` never re-mints id 1.
    Counter,
    Lock(u64),
}

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error {
    LockNotFound = 1,
    AlreadyReleased = 2,
    StillLocked = 3,
    NotRevocable = 4,
    BadUnlockTime = 5,
    BadAmount = 6,
    /// `withdraw` on a lock with a distinct claimant; only the claimant may release it (via `claim`).
    ClaimantOnly = 7,
    /// `deposit` with `revocable = true` requires `claimant == from` (revocable locks are self-bonds).
    RevocableMustBeSelfBond = 8,
}

// -------- events (consumed by the BP2 indexer to build "My Balances") --------

#[contractevent]
pub struct Deposited {
    #[topic]
    pub depositor: Address,
    #[topic]
    pub claimant: Address,
    pub id: u64,
    pub token: Address,
    pub amount: i128,
    pub unlock_time: u64,
    pub revocable: bool,
}

#[contractevent]
pub struct Relocked {
    #[topic]
    pub depositor: Address,
    pub id: u64,
    pub new_unlock_time: u64,
}

#[contractevent]
pub struct Withdrawn {
    #[topic]
    pub depositor: Address,
    pub id: u64,
    pub amount: i128,
}

#[contractevent]
pub struct Claimed {
    #[topic]
    pub claimant: Address,
    pub id: u64,
    pub amount: i128,
}

#[contractevent]
pub struct Unbonded {
    #[topic]
    pub depositor: Address,
    pub id: u64,
    pub amount: i128,
}

#[contract]
pub struct Escrow;

#[contractimpl]
impl Escrow {
    /// Lock `amount` of `token` until `unlock_time`. Pulls the tokens into the contract (the `from`
    /// address authorises the SAC transfer) and records the ACTUAL received amount. Returns the new
    /// `lock_id`. A revocable lock must be a self-bond (`claimant == from`).
    pub fn deposit(
        env: Env,
        from: Address,
        token: Address,
        amount: i128,
        unlock_time: u64,
        claimant: Address,
        commitment: BytesN<32>,
        revocable: bool,
    ) -> Result<u64, Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        if unlock_time <= env.ledger().timestamp() {
            return Err(Error::BadUnlockTime);
        }
        // A revocable lock must be a self-bond: otherwise the depositor could `unbond` early and rug a
        // distinct claimant.
        if revocable && claimant != from {
            return Err(Error::RevocableMustBeSelfBond);
        }

        // Pull tokens in, measuring the ACTUAL delta so a fee-on-transfer / rebasing token cannot make
        // the stored amount exceed the held balance (which would let one lock drain another's funds).
        let tc = TokenClient::new(&env, &token);
        let contract = env.current_contract_address();
        let before = tc.balance(&contract);
        tc.transfer(&from, &contract, &amount);
        let received = tc.balance(&contract) - before;
        if received <= 0 {
            return Err(Error::BadAmount);
        }

        let mut id: u64 = env.storage().instance().get(&DataKey::Counter).unwrap_or(0);
        id += 1;
        env.storage().instance().set(&DataKey::Counter, &id);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);

        let lock = Lock {
            id,
            depositor: from.clone(),
            token: token.clone(),
            amount: received,
            unlock_time,
            claimant: claimant.clone(),
            commitment,
            revocable,
            released: false,
        };
        Self::save(&env, &lock);

        Deposited {
            depositor: from,
            claimant,
            id,
            token,
            amount: received,
            unlock_time,
            revocable,
        }
        .publish(&env);
        Ok(id)
    }

    /// Lengthen a lock's `unlock_time`. **Extend only** — never shortens — so a party who saw
    /// `unlock_time = X` can rely on ">= X" forever. Depositor-authorised.
    pub fn set_timelock(env: Env, lock_id: u64, new_unlock_time: u64) -> Result<(), Error> {
        let mut lock = Self::load(&env, lock_id)?;
        lock.depositor.require_auth();
        if lock.released {
            return Err(Error::AlreadyReleased);
        }
        if new_unlock_time <= lock.unlock_time {
            return Err(Error::BadUnlockTime); // extend-only; never shorten
        }
        lock.unlock_time = new_unlock_time;
        Self::save(&env, &lock);
        Relocked {
            depositor: lock.depositor.clone(),
            id: lock_id,
            new_unlock_time,
        }
        .publish(&env);
        Ok(())
    }

    /// Return funds to the depositor once `now >= unlock_time`. **Self-bond only** — a lock with a
    /// distinct claimant is released solely by `claim`. Depositor-authorised.
    pub fn withdraw(env: Env, lock_id: u64) -> Result<(), Error> {
        let mut lock = Self::load(&env, lock_id)?;
        lock.depositor.require_auth();
        if lock.claimant != lock.depositor {
            return Err(Error::ClaimantOnly);
        }
        Self::ensure_unlocked(&env, &lock)?;
        lock.released = true;
        Self::save(&env, &lock);
        TokenClient::new(&env, &lock.token).transfer(
            &env.current_contract_address(),
            &lock.depositor,
            &lock.amount,
        );
        Withdrawn {
            depositor: lock.depositor.clone(),
            id: lock_id,
            amount: lock.amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Send funds to the designated `claimant` once `now >= unlock_time` (the one-way send path).
    /// Claimant-authorised. For a self-bond this is equivalent to `withdraw`.
    pub fn claim(env: Env, lock_id: u64) -> Result<(), Error> {
        let mut lock = Self::load(&env, lock_id)?;
        lock.claimant.require_auth();
        Self::ensure_unlocked(&env, &lock)?;
        lock.released = true;
        Self::save(&env, &lock);
        TokenClient::new(&env, &lock.token).transfer(
            &env.current_contract_address(),
            &lock.claimant,
            &lock.amount,
        );
        Claimed {
            claimant: lock.claimant.clone(),
            id: lock_id,
            amount: lock.amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Early exit for **revocable** locks only (which are always self-bonds). Flips `is_locked -> false`
    /// immediately and returns the funds to the depositor. A solvency gate's live `is_locked` read
    /// catches this at once, voiding the proof. Depositor-authorised.
    pub fn unbond(env: Env, lock_id: u64) -> Result<(), Error> {
        let mut lock = Self::load(&env, lock_id)?;
        lock.depositor.require_auth();
        if lock.released {
            return Err(Error::AlreadyReleased);
        }
        if !lock.revocable {
            return Err(Error::NotRevocable);
        }
        lock.released = true;
        Self::save(&env, &lock);
        TokenClient::new(&env, &lock.token).transfer(
            &env.current_contract_address(),
            &lock.depositor,
            &lock.amount,
        );
        Unbonded {
            depositor: lock.depositor.clone(),
            id: lock_id,
            amount: lock.amount,
        }
        .publish(&env);
        Ok(())
    }

    // -------- read-only views (gates call these cross-contract; see the header note on atomicity) --------

    /// `true` iff the lock exists, is unreleased, and `now < unlock_time`. Returns `false` for unknown
    /// ids (fail-closed). Bumps the entry's TTL so a watched lock stays warm. This is what gates read.
    pub fn is_locked(env: Env, lock_id: u64) -> bool {
        let key = DataKey::Lock(lock_id);
        match env.storage().persistent().get::<DataKey, Lock>(&key) {
            Some(lock) => {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
                !lock.released && env.ledger().timestamp() < lock.unlock_time
            }
            None => false,
        }
    }

    /// Full lock record. Errors with `LockNotFound` for unknown ids. NOT anonymity-preserving (returns
    /// depositor/claimant/commitment) — see the header note for BP5.
    pub fn get_lock(env: Env, lock_id: u64) -> Result<Lock, Error> {
        Self::load(&env, lock_id)
    }

    // -------- internals --------

    fn load(env: &Env, lock_id: u64) -> Result<Lock, Error> {
        let key = DataKey::Lock(lock_id);
        let lock: Lock = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::LockNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        Ok(lock)
    }

    fn save(env: &Env, lock: &Lock) {
        let key = DataKey::Lock(lock.id);
        env.storage().persistent().set(&key, lock);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
    }

    fn ensure_unlocked(env: &Env, lock: &Lock) -> Result<(), Error> {
        if lock.released {
            return Err(Error::AlreadyReleased);
        }
        if env.ledger().timestamp() < lock.unlock_time {
            return Err(Error::StillLocked);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;
