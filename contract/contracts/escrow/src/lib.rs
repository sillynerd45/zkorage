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
//! **No admin, no upgrade, no privileged role over locked funds.** Only a lock's `depositor` may
//! `withdraw` / `unbond` it, and only its `claimant` may `claim` it, each gated on `unlock_time`. The
//! contract holds the tokens and returns them; nobody else can move them. Expiry is enforced by the
//! stored `unlock_time`, never by entry TTL. **Unaudited, demo only.**

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient, Address,
    BytesN, Env,
};

// ~5s ledgers -> ~17,280/day. TTL is housekeeping (keeps entries from being archived), NOT a security
// boundary: lock expiry is always enforced by the stored `unlock_time`.
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
    pub amount: i128,
    /// Unix seconds. Funds become movable at/after this time.
    pub unlock_time: u64,
    /// Who may `claim()` after unlock (== depositor for a self-bond).
    pub claimant: Address,
    /// Hiding tag for the BP5 anonymous-tier proof; all-zero when unused.
    pub commitment: BytesN<32>,
    /// `true` => depositor may `unbond()` early (the solvency "pull your collateral" path).
    pub revocable: bool,
    /// `true` once withdrawn / claimed / unbonded.
    pub released: bool,
}

#[contracttype]
pub enum DataKey {
    /// Monotonic lock-id counter (lazy-initialised; first lock is id 1).
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
    /// address authorises the SAC transfer). Returns the new `lock_id`.
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

        // Pull tokens into the contract (SAC/SEP-41 transfer; `from` authorises).
        TokenClient::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);

        let mut id: u64 = env.storage().instance().get(&DataKey::Counter).unwrap_or(0);
        id += 1;
        env.storage().instance().set(&DataKey::Counter, &id);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);

        let lock = Lock {
            id,
            depositor: from.clone(),
            token: token.clone(),
            amount,
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
            amount,
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

    /// Return funds to the depositor once `now >= unlock_time`. Depositor-authorised.
    pub fn withdraw(env: Env, lock_id: u64) -> Result<(), Error> {
        let mut lock = Self::load(&env, lock_id)?;
        lock.depositor.require_auth();
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

    /// Send funds to the designated `claimant` once `now >= unlock_time` (CB-style two-party).
    /// Claimant-authorised.
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

    /// Early exit for **revocable** locks only. Flips `is_locked -> false` immediately and returns the
    /// funds to the depositor. A solvency gate's live `is_locked` read catches this at once, voiding the
    /// proof. Depositor-authorised.
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

    // -------- read-only views (gates call these cross-contract) --------

    /// `true` iff the lock exists, is unreleased, and `now < unlock_time`. Returns `false` for unknown
    /// ids (fail-closed). This is what gates read.
    pub fn is_locked(env: Env, lock_id: u64) -> bool {
        match env
            .storage()
            .persistent()
            .get::<DataKey, Lock>(&DataKey::Lock(lock_id))
        {
            Some(lock) => !lock.released && env.ledger().timestamp() < lock.unlock_time,
            None => false,
        }
    }

    /// Full lock record. Errors with `LockNotFound` for unknown ids.
    pub fn get_lock(env: Env, lock_id: u64) -> Result<Lock, Error> {
        Self::load(&env, lock_id)
    }

    // -------- internals --------

    fn load(env: &Env, lock_id: u64) -> Result<Lock, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Lock(lock_id))
            .ok_or(Error::LockNotFound)
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
