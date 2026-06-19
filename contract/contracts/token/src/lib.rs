//! # zkorage demo SEP-41 supply-tracking token (`zUSD`)
//!
//! A **minimal, demo-only** fungible token whose sole reason to exist in zkorage is to provide an
//! **on-chain circulating-supply anchor** for the Proof-of-Reserves policy. Classic Stellar-asset
//! SACs expose **no** `total_supply`, so the PoR policy could not bind a proven figure to a real
//! liability. This token tracks `total_supply` explicitly (bumped on `mint`, reduced on `burn`) and
//! exposes it as a read, so the policy contract can assert `journal.supply == token.total_supply()`.
//!
//! Implements the core SEP-41 surface (`balance`/`transfer`/`burn`/`decimals`/`name`/`symbol`) plus
//! `mint` (admin) and the zkorage-specific `total_supply`. Allowance/`transfer_from` are intentionally
//! omitted — not needed for the PoR demo. **Unaudited — demo only.**

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String};

// ~5s ledgers → ~17,280 per day. Keep instance + balances alive for a comfortable demo window.
const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;
const BALANCE_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const BALANCE_THRESHOLD: u32 = BALANCE_BUMP - DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Metadata,
    TotalSupply,
    Balance(Address),
}

#[contracttype]
#[derive(Clone)]
pub struct Metadata {
    pub decimals: u32,
    pub name: String,
    pub symbol: String,
}

fn read_balance(env: &Env, id: &Address) -> i128 {
    let key = DataKey::Balance(id.clone());
    if let Some(b) = env.storage().persistent().get::<DataKey, i128>(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, BALANCE_THRESHOLD, BALANCE_BUMP);
        b
    } else {
        0
    }
}

fn write_balance(env: &Env, id: &Address, amount: i128) {
    let key = DataKey::Balance(id.clone());
    env.storage().persistent().set(&key, &amount);
    env.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_THRESHOLD, BALANCE_BUMP);
}

fn read_total_supply(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalSupply)
        .unwrap_or(0)
}

fn write_total_supply(env: &Env, amount: i128) {
    env.storage().instance().set(&DataKey::TotalSupply, &amount);
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

fn require_init(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic!("not initialized"))
}

#[contract]
pub struct Token;

#[contractimpl]
impl Token {
    /// One-time setup. `admin` controls `mint`. Panics if already initialized.
    pub fn initialize(env: Env, admin: Address, decimals: u32, name: String, symbol: String) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(
            &DataKey::Metadata,
            &Metadata {
                decimals,
                name,
                symbol,
            },
        );
        write_total_supply(&env, 0);
        bump_instance(&env);
    }

    /// Mint `amount` to `to`. Admin-only. Increases `total_supply`.
    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin = require_init(&env);
        admin.require_auth();
        assert!(amount >= 0, "amount must be non-negative");
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        write_total_supply(&env, read_total_supply(&env) + amount);
        bump_instance(&env);
        env.events().publish((symbol_short!("mint"), to), amount);
    }

    /// Burn `amount` from `from`. Reduces `total_supply`. Requires `from`'s auth.
    pub fn burn(env: Env, from: Address, amount: i128) {
        require_init(&env);
        from.require_auth();
        assert!(amount >= 0, "amount must be non-negative");
        let bal = read_balance(&env, &from);
        assert!(bal >= amount, "insufficient balance");
        write_balance(&env, &from, bal - amount);
        write_total_supply(&env, read_total_supply(&env) - amount);
        bump_instance(&env);
        env.events().publish((symbol_short!("burn"), from), amount);
    }

    /// Move `amount` from `from` to `to`. Requires `from`'s auth. `total_supply` unchanged.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        require_init(&env);
        from.require_auth();
        assert!(amount >= 0, "amount must be non-negative");
        let fb = read_balance(&env, &from);
        assert!(fb >= amount, "insufficient balance");
        write_balance(&env, &from, fb - amount);
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        bump_instance(&env);
        env.events()
            .publish((symbol_short!("transfer"), from, to), amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        read_balance(&env, &id)
    }

    /// The zkorage-specific read: current circulating supply. The PoR policy binds to this.
    pub fn total_supply(env: Env) -> i128 {
        read_total_supply(&env)
    }

    pub fn decimals(env: Env) -> u32 {
        let m: Metadata = env.storage().instance().get(&DataKey::Metadata).unwrap();
        m.decimals
    }

    pub fn name(env: Env) -> String {
        let m: Metadata = env.storage().instance().get(&DataKey::Metadata).unwrap();
        m.name
    }

    pub fn symbol(env: Env) -> String {
        let m: Metadata = env.storage().instance().get(&DataKey::Metadata).unwrap();
        m.symbol
    }

    pub fn admin(env: Env) -> Address {
        require_init(&env)
    }
}

#[cfg(test)]
mod test;
