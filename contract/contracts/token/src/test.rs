#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, String};

fn setup(env: &Env) -> (TokenClient<'static>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(Token, ());
    let client = TokenClient::new(env, &contract_id);
    client.initialize(
        &admin,
        &7u32,
        &String::from_str(env, "zkorage USD"),
        &String::from_str(env, "zUSD"),
    );
    (client, admin)
}

#[test]
fn test_initialize_and_metadata() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    assert_eq!(client.decimals(), 7);
    assert_eq!(client.symbol(), String::from_str(&env, "zUSD"));
    assert_eq!(client.name(), String::from_str(&env, "zkorage USD"));
    assert_eq!(client.total_supply(), 0);
    assert_eq!(client.admin(), admin);
}

#[test]
fn test_mint_increases_supply() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);
    let user = Address::generate(&env);
    client.mint(&user, &1_000i128);
    assert_eq!(client.balance(&user), 1_000);
    assert_eq!(client.total_supply(), 1_000);
    client.mint(&user, &500i128);
    assert_eq!(client.total_supply(), 1_500);
    assert_eq!(client.balance(&user), 1_500);
}

#[test]
fn test_burn_decreases_supply() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);
    let user = Address::generate(&env);
    client.mint(&user, &1_000i128);
    client.burn(&user, &400i128);
    assert_eq!(client.balance(&user), 600);
    assert_eq!(client.total_supply(), 600);
}

#[test]
fn test_transfer_preserves_supply() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.mint(&a, &1_000i128);
    client.transfer(&a, &b, &250i128);
    assert_eq!(client.balance(&a), 750);
    assert_eq!(client.balance(&b), 250);
    assert_eq!(client.total_supply(), 1_000); // supply invariant under transfer
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn test_transfer_overdraw_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.mint(&a, &100i128);
    client.transfer(&a, &b, &101i128);
}

#[test]
#[should_panic]
fn test_mint_requires_admin_auth() {
    // No mock_all_auths(): mint's `admin.require_auth()` must reject. initialize() has no auth gate.
    let env = Env::default();
    let (client, _admin) = setup(&env);
    let user = Address::generate(&env);
    client.mint(&user, &1_000i128);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialize_panics() {
    let env = Env::default();
    let (client, _admin) = setup(&env);
    let other = Address::generate(&env);
    client.initialize(
        &other,
        &7u32,
        &String::from_str(&env, "x"),
        &String::from_str(&env, "x"),
    );
}
