#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env,
};

const NOW: u64 = 1_000;
const UNLOCK: u64 = 2_000;

struct Fix {
    env: Env,
    escrow: EscrowClient<'static>,
    escrow_id: Address,
    token: Address,
    alice: Address,
    bob: Address,
}

fn zero(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

fn setup() -> Fix {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let escrow_id = env.register(Escrow, ());
    let escrow = EscrowClient::new(&env, &escrow_id);

    // A real SAC test token; the escrow holds any SEP-41/SAC asset.
    let issuer = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(issuer).address();

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&alice, &1_000i128);

    Fix { env, escrow, escrow_id, token, alice, bob }
}

fn bal(f: &Fix, who: &Address) -> i128 {
    TokenClient::new(&f.env, &f.token).balance(who)
}

#[test]
fn deposit_locks_funds() {
    let f = setup();
    let z = zero(&f.env);
    let id = f
        .escrow
        .deposit(&f.alice, &f.token, &100i128, &UNLOCK, &f.alice, &z, &true);
    assert_eq!(id, 1);
    assert!(f.escrow.is_locked(&1));
    assert_eq!(bal(&f, &f.alice), 900); // 100 pulled into escrow
    assert_eq!(bal(&f, &f.escrow_id), 100);

    let lk = f.escrow.get_lock(&1);
    assert_eq!(lk.amount, 100);
    assert_eq!(lk.unlock_time, UNLOCK);
    assert_eq!(lk.depositor, f.alice);
    assert!(lk.revocable);
    assert!(!lk.released);
}

#[test]
fn unbond_revocable_refunds_and_voids() {
    let f = setup();
    let z = zero(&f.env);
    f.escrow
        .deposit(&f.alice, &f.token, &100i128, &UNLOCK, &f.alice, &z, &true);
    f.escrow.unbond(&1); // early exit, lock still in its time window
    assert_eq!(bal(&f, &f.alice), 1_000); // fully refunded
    assert_eq!(bal(&f, &f.escrow_id), 0);
    assert!(!f.escrow.is_locked(&1)); // the gate's live read would see this and void the proof
    assert!(f.escrow.get_lock(&1).released);
}

#[test]
fn unbond_nonrevocable_rejected() {
    let f = setup();
    let z = zero(&f.env);
    f.escrow
        .deposit(&f.alice, &f.token, &100i128, &UNLOCK, &f.alice, &z, &false);
    assert_eq!(f.escrow.try_unbond(&1), Err(Ok(Error::NotRevocable)));
    assert!(f.escrow.is_locked(&1)); // unchanged
}

#[test]
fn withdraw_before_unlock_rejected() {
    let f = setup();
    let z = zero(&f.env);
    f.escrow
        .deposit(&f.alice, &f.token, &100i128, &UNLOCK, &f.alice, &z, &false);
    assert_eq!(f.escrow.try_withdraw(&1), Err(Ok(Error::StillLocked)));
}

#[test]
fn withdraw_after_unlock_refunds() {
    let f = setup();
    let z = zero(&f.env);
    f.escrow
        .deposit(&f.alice, &f.token, &100i128, &UNLOCK, &f.alice, &z, &false);
    f.env.ledger().set_timestamp(UNLOCK); // now == unlock_time => claimable
    f.escrow.withdraw(&1);
    assert_eq!(bal(&f, &f.alice), 1_000);
    assert!(!f.escrow.is_locked(&1));
}

#[test]
fn claim_pays_designated_claimant() {
    let f = setup();
    let z = zero(&f.env);
    f.escrow
        .deposit(&f.alice, &f.token, &100i128, &UNLOCK, &f.bob, &z, &false);
    f.env.ledger().set_timestamp(UNLOCK);
    f.escrow.claim(&1);
    assert_eq!(bal(&f, &f.bob), 100);
    assert_eq!(bal(&f, &f.alice), 900);
}

#[test]
fn set_timelock_extends_only() {
    let f = setup();
    let z = zero(&f.env);
    f.escrow
        .deposit(&f.alice, &f.token, &100i128, &UNLOCK, &f.alice, &z, &true);
    f.escrow.set_timelock(&1, &3_000);
    assert_eq!(f.escrow.get_lock(&1).unlock_time, 3_000);
    // cannot shorten or no-op
    assert_eq!(
        f.escrow.try_set_timelock(&1, &2_500),
        Err(Ok(Error::BadUnlockTime))
    );
    assert_eq!(
        f.escrow.try_set_timelock(&1, &3_000),
        Err(Ok(Error::BadUnlockTime))
    );
}

#[test]
fn is_locked_unknown_is_false() {
    let f = setup();
    assert!(!f.escrow.is_locked(&999)); // fail-closed
}

#[test]
fn get_lock_unknown_panics() {
    let f = setup();
    assert_eq!(f.escrow.try_get_lock(&999).err(), Some(Ok(Error::LockNotFound)));
}

#[test]
fn deposit_zero_amount_rejected() {
    let f = setup();
    let z = zero(&f.env);
    assert_eq!(
        f.escrow
            .try_deposit(&f.alice, &f.token, &0i128, &UNLOCK, &f.alice, &z, &true),
        Err(Ok(Error::BadAmount))
    );
}

#[test]
fn deposit_past_unlock_rejected() {
    let f = setup();
    let z = zero(&f.env);
    assert_eq!(
        f.escrow
            .try_deposit(&f.alice, &f.token, &100i128, &NOW, &f.alice, &z, &true),
        Err(Ok(Error::BadUnlockTime))
    );
}

#[test]
fn double_release_rejected() {
    let f = setup();
    let z = zero(&f.env);
    f.escrow
        .deposit(&f.alice, &f.token, &100i128, &UNLOCK, &f.alice, &z, &true);
    f.escrow.unbond(&1);
    assert_eq!(f.escrow.try_unbond(&1), Err(Ok(Error::AlreadyReleased)));
    f.env.ledger().set_timestamp(UNLOCK);
    assert_eq!(f.escrow.try_withdraw(&1), Err(Ok(Error::AlreadyReleased)));
}

#[test]
fn counter_increments_per_lock() {
    let f = setup();
    let z = zero(&f.env);
    let id1 = f
        .escrow
        .deposit(&f.alice, &f.token, &100i128, &UNLOCK, &f.alice, &z, &true);
    let id2 = f
        .escrow
        .deposit(&f.alice, &f.token, &100i128, &UNLOCK, &f.alice, &z, &true);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(bal(&f, &f.escrow_id), 200);
}
