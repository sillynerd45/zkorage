#![cfg(test)]
use super::*;
use risc0_interface::VerifierError;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    vec, Address, Bytes, BytesN, Env,
};

const ISSUER: [u8; 32] = [19u8; 32]; // mock bonded reserve auditor pubkey
const OTHER_ISSUER: [u8; 32] = [7u8; 32]; // a different (PoR) auditor — not allow-listed here
const ESCROW_ID: [u8; 32] = [0xE5u8; 32];
const SUPPLY_TOKEN_ID: [u8; 32] = [0x5Bu8; 32];
const BOND_TOKEN_ID: [u8; 32] = [0xB0u8; 32];
const SOL_IMAGE: [u8; 32] = [0xC0u8; 32];
const CLAIM_TYPE: u32 = 12;
const SUPPLY: u64 = 10_000_000_000_000; // 1,000,000 zUSD @ 7 decimals
const MIN_AMOUNT: u64 = 500;
const LOCK_AMOUNT: i128 = 1000;
const FAR_EXPIRY: u64 = 9_999_999_999;
const FAR_UNLOCK: u64 = 9_000_000_000;

// ---- mock bare verifier ----
#[contract]
pub struct MockVerifier;
#[contractimpl]
impl MockVerifier {
    pub fn set_valid(env: Env, v: bool) {
        env.storage().instance().set(&symbol_short!("valid"), &v);
    }
    pub fn verify(
        env: Env,
        _seal: Bytes,
        _image_id: BytesN<32>,
        _journal: BytesN<32>,
    ) -> Result<(), VerifierError> {
        if env.storage().instance().get(&symbol_short!("valid")).unwrap_or(true) {
            Ok(())
        } else {
            Err(VerifierError::InvalidProof)
        }
    }
}

// ---- mock supply token (just the total_supply read the binding needs) ----
#[contract]
pub struct MockSupplyToken;
#[contractimpl]
impl MockSupplyToken {
    pub fn set_supply(env: Env, s: i128) {
        env.storage().instance().set(&symbol_short!("supply"), &s);
    }
    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().get(&symbol_short!("supply")).unwrap_or(0)
    }
}

// ---- mock escrow (returns a configurable Lock; panics for an unset lock => LockNotFound) ----
#[contract]
pub struct MockEscrow;
#[contractimpl]
impl MockEscrow {
    pub fn set_lock(env: Env, lock: Lock) {
        env.storage().instance().set(&symbol_short!("lock"), &lock);
    }
    pub fn get_lock(env: Env, _lock_id: u64) -> Lock {
        env.storage()
            .instance()
            .get(&symbol_short!("lock"))
            .expect("no lock set")
    }
}

#[allow(clippy::too_many_arguments)]
fn make_journal(
    env: &Env,
    result: u8,
    claim_type: u32,
    issuer: &[u8; 32],
    supply: u64,
    nonce: u64,
    expiry: u64,
    escrow: &[u8; 32],
    lock_id: u64,
    min_amount: u64,
    bond_token: &[u8; 32],
    supply_token: &[u8; 32],
) -> Bytes {
    let mut a = [0u8; 173];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..37].copy_from_slice(issuer);
    a[37..45].copy_from_slice(&supply.to_be_bytes());
    a[45..53].copy_from_slice(&nonce.to_be_bytes());
    a[53..61].copy_from_slice(&expiry.to_be_bytes());
    a[61..93].copy_from_slice(escrow);
    a[93..101].copy_from_slice(&lock_id.to_be_bytes());
    a[101..109].copy_from_slice(&min_amount.to_be_bytes());
    a[109..141].copy_from_slice(bond_token);
    a[141..173].copy_from_slice(supply_token);
    Bytes::from_array(env, &a)
}

struct Fixture<'a> {
    gate: SolvencyGateClient<'a>,
    verifier: MockVerifierClient<'a>,
    supply: MockSupplyTokenClient<'a>,
    escrow: MockEscrowClient<'a>,
    bond_token: Address,
    depositor: Address,
    image: BytesN<32>,
    seal: Bytes,
}

fn setup(env: &Env) -> Fixture<'static> {
    let admin = Address::generate(env);
    let depositor = Address::generate(env);
    let bond_token = Address::generate(env);
    let verifier_id = env.register(MockVerifier, ());
    let supply_id = env.register(MockSupplyToken, ());
    let escrow_id_addr = env.register(MockEscrow, ());
    let gate_id = env.register(SolvencyGate, ());
    let gate = SolvencyGateClient::new(env, &gate_id);
    let verifier = MockVerifierClient::new(env, &verifier_id);
    let supply = MockSupplyTokenClient::new(env, &supply_id);
    let escrow = MockEscrowClient::new(env, &escrow_id_addr);
    let image = BytesN::from_array(env, &SOL_IMAGE);
    gate.initialize(
        &admin,
        &verifier_id,
        &escrow_id_addr,
        &BytesN::from_array(env, &ESCROW_ID),
        &supply_id,
        &BytesN::from_array(env, &SUPPLY_TOKEN_ID),
        &bond_token,
        &BytesN::from_array(env, &BOND_TOKEN_ID),
        &image,
        &CLAIM_TYPE,
        &vec![env, BytesN::from_array(env, &ISSUER)],
    );
    supply.set_supply(&(SUPPLY as i128));
    Fixture {
        gate,
        verifier,
        supply,
        escrow,
        bond_token,
        depositor,
        image,
        seal: Bytes::from_array(env, &[0u8; 4]),
    }
}

fn good_lock(f: &Fixture, env: &Env) -> Lock {
    Lock {
        id: 1,
        depositor: f.depositor.clone(),
        token: f.bond_token.clone(),
        amount: LOCK_AMOUNT,
        unlock_time: FAR_UNLOCK,
        claimant: f.depositor.clone(),
        commitment: BytesN::from_array(env, &[0u8; 32]),
        revocable: true,
        released: false,
    }
}

fn good_journal(_f: &Fixture, env: &Env) -> Bytes {
    make_journal(
        env, 1, CLAIM_TYPE, &ISSUER, SUPPLY, 1, FAR_EXPIRY, &ESCROW_ID, 1, MIN_AMOUNT, &BOND_TOKEN_ID,
        &SUPPLY_TOKEN_ID,
    )
}

// ============================ HAPPY PATH + SELF-VOID ============================

#[test]
fn test_submit_happy_then_self_void() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    f.escrow.set_lock(&good_lock(&f, &env));

    assert!(!f.gate.is_granted(&f.depositor));
    let rec = f.gate.submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    assert_eq!(rec.depositor, f.depositor);
    assert_eq!(rec.lock_id, 1);
    assert_eq!(rec.supply, SUPPLY);
    assert_eq!(rec.min_amount, MIN_AMOUNT);
    assert_eq!(rec.index, 0);

    // LIVE grant true while the bond is locked
    assert!(f.gate.is_granted(&f.depositor));

    // THE MONEY-SHOT: unbond the lock -> is_granted flips false in the same session
    let mut released = good_lock(&f, &env);
    released.released = true;
    f.escrow.set_lock(&released);
    assert!(!f.gate.is_granted(&f.depositor), "self-void: unbonded lock must revoke the grant");

    // re-bonding (a fresh active lock) restores the LIVE grant without re-proving
    f.escrow.set_lock(&good_lock(&f, &env));
    assert!(f.gate.is_granted(&f.depositor));
}

#[test]
fn test_self_void_on_unlock_passing() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let mut lock = good_lock(&f, &env);
    lock.unlock_time = 2_000;
    f.escrow.set_lock(&lock);
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &ISSUER, SUPPLY, 1, FAR_EXPIRY, &ESCROW_ID, 1, MIN_AMOUNT, &BOND_TOKEN_ID,
        &SUPPLY_TOKEN_ID,
    );
    f.gate.submit_solvency_proof(&f.seal, &f.image, &j);
    assert!(f.gate.is_granted(&f.depositor)); // now (1000) < unlock (2000)
    env.ledger().set_timestamp(2_500); // lock no longer "locked"
    assert!(!f.gate.is_granted(&f.depositor));
}

#[test]
fn test_self_void_on_attestation_expiry() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    f.escrow.set_lock(&good_lock(&f, &env));
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &ISSUER, SUPPLY, 1, 2_000, &ESCROW_ID, 1, MIN_AMOUNT, &BOND_TOKEN_ID,
        &SUPPLY_TOKEN_ID,
    );
    f.gate.submit_solvency_proof(&f.seal, &f.image, &j);
    assert!(f.gate.is_granted(&f.depositor));
    env.ledger().set_timestamp(3_000); // reserve attestation stale
    assert!(!f.gate.is_granted(&f.depositor));
}

#[test]
fn test_self_void_on_supply_change() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    f.escrow.set_lock(&good_lock(&f, &env));
    f.gate.submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    assert!(f.gate.is_granted(&f.depositor));
    f.supply.set_supply(&((SUPPLY + 1) as i128)); // mint -> reserves no longer proven >= supply
    assert!(!f.gate.is_granted(&f.depositor), "supply change must drop the grant until re-proof");
}

// ============================ JOURNAL / BINDING NEGATIVES ============================

#[test]
fn test_image_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    f.escrow.set_lock(&good_lock(&f, &env));
    let wrong = BytesN::from_array(&env, &[0u8; 32]);
    let res = f.gate.try_submit_solvency_proof(&f.seal, &wrong, &good_journal(&f, &env));
    assert_eq!(res, Err(Ok(SolvencyError::ImageMismatch)));
}

#[test]
fn test_malformed_journal() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let bad = Bytes::from_array(&env, &[1u8; 172]); // 172 != 173
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &bad);
    assert_eq!(res, Err(Ok(SolvencyError::MalformedJournal)));
}

#[test]
fn test_proof_invalid() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    f.verifier.set_valid(&false);
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    assert_eq!(res, Err(Ok(SolvencyError::ProofInvalid)));
}

#[test]
fn test_result_not_true() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let j = make_journal(
        &env, 0, CLAIM_TYPE, &ISSUER, SUPPLY, 1, FAR_EXPIRY, &ESCROW_ID, 1, MIN_AMOUNT, &BOND_TOKEN_ID,
        &SUPPLY_TOKEN_ID,
    );
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(SolvencyError::ResultNotTrue)));
}

#[test]
fn test_claim_type_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let j = make_journal(
        &env, 1, 2, &ISSUER, SUPPLY, 1, FAR_EXPIRY, &ESCROW_ID, 1, MIN_AMOUNT, &BOND_TOKEN_ID,
        &SUPPLY_TOKEN_ID,
    );
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(SolvencyError::ClaimTypeMismatch)));
}

#[test]
fn test_issuer_not_allowed() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &OTHER_ISSUER, SUPPLY, 1, FAR_EXPIRY, &ESCROW_ID, 1, MIN_AMOUNT,
        &BOND_TOKEN_ID, &SUPPLY_TOKEN_ID,
    );
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(SolvencyError::IssuerNotAllowed)));
}

#[test]
fn test_expired() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(5_000);
    let f = setup(&env);
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &ISSUER, SUPPLY, 1, 4_000, &ESCROW_ID, 1, MIN_AMOUNT, &BOND_TOKEN_ID,
        &SUPPLY_TOKEN_ID,
    );
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(SolvencyError::Expired)));
}

#[test]
fn test_escrow_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &ISSUER, SUPPLY, 1, FAR_EXPIRY, &[0xAAu8; 32], 1, MIN_AMOUNT,
        &BOND_TOKEN_ID, &SUPPLY_TOKEN_ID,
    );
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(SolvencyError::EscrowMismatch)));
}

#[test]
fn test_supply_token_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &ISSUER, SUPPLY, 1, FAR_EXPIRY, &ESCROW_ID, 1, MIN_AMOUNT, &BOND_TOKEN_ID,
        &[0xAAu8; 32],
    );
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(SolvencyError::SupplyTokenMismatch)));
}

#[test]
fn test_supply_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    f.supply.set_supply(&((SUPPLY + 7) as i128)); // live supply != proven supply
    f.escrow.set_lock(&good_lock(&f, &env));
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    assert_eq!(res, Err(Ok(SolvencyError::SupplyMismatch)));
}

#[test]
fn test_bond_token_mismatch_journal() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    f.escrow.set_lock(&good_lock(&f, &env));
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &ISSUER, SUPPLY, 1, FAR_EXPIRY, &ESCROW_ID, 1, MIN_AMOUNT, &[0xAAu8; 32],
        &SUPPLY_TOKEN_ID,
    );
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(SolvencyError::BondTokenMismatch)));
}

#[test]
fn test_bond_token_mismatch_lock() {
    // journal bond_token matches config, but the LIVE lock holds a different token
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let mut lock = good_lock(&f, &env);
    lock.token = Address::generate(&env); // not the configured bond token
    f.escrow.set_lock(&lock);
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    assert_eq!(res, Err(Ok(SolvencyError::BondTokenMismatch)));
}

#[test]
fn test_lock_not_found() {
    // no lock set in the mock escrow -> get_lock panics -> try_get_lock fails -> LockNotFound
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    assert_eq!(res, Err(Ok(SolvencyError::LockNotFound)));
}

#[test]
fn test_lock_not_active_released() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let mut lock = good_lock(&f, &env);
    lock.released = true;
    f.escrow.set_lock(&lock);
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    assert_eq!(res, Err(Ok(SolvencyError::LockNotActive)));
}

#[test]
fn test_not_revocable() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let mut lock = good_lock(&f, &env);
    lock.revocable = false;
    f.escrow.set_lock(&lock);
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    assert_eq!(res, Err(Ok(SolvencyError::NotRevocable)));
}

#[test]
fn test_insufficient_bond() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let mut lock = good_lock(&f, &env);
    lock.amount = i128::from(MIN_AMOUNT) - 1; // below the proven floor
    f.escrow.set_lock(&lock);
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    assert_eq!(res, Err(Ok(SolvencyError::InsufficientBond)));
}

// ============================ OWNERSHIP BINDING ============================

#[test]
fn test_ownership_requires_depositor_auth() {
    // NO mock_all_auths: submit must trap on lock.depositor.require_auth() (the ownership binding).
    let env = Env::default();
    let f = setup(&env);
    f.escrow.set_lock(&good_lock(&f, &env));
    let res = f.gate.try_submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    assert!(res.is_err(), "submit must require the lock depositor's auth");
    assert_eq!(f.gate.get_count(), 0); // nothing recorded
}

// ============================ READS / HISTORY / ADMIN ============================

#[test]
fn test_is_granted_no_record() {
    let env = Env::default();
    let f = setup(&env);
    assert!(!f.gate.is_granted(&f.depositor));
    assert!(f.gate.get_record(&f.depositor).is_none());
    assert!(f.gate.get_latest().is_none());
    assert_eq!(f.gate.get_count(), 0);
}

#[test]
fn test_history_paginates() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let d2 = Address::generate(&env);
    let d3 = Address::generate(&env);
    // depositor 1
    f.escrow.set_lock(&good_lock(&f, &env));
    f.gate.submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    // depositor 2 (different lock owner)
    let mut l2 = good_lock(&f, &env);
    l2.depositor = d2.clone();
    f.escrow.set_lock(&l2);
    f.gate.submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    // depositor 3
    let mut l3 = good_lock(&f, &env);
    l3.depositor = d3.clone();
    f.escrow.set_lock(&l3);
    f.gate.submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));

    assert_eq!(f.gate.get_count(), 3);
    assert_eq!(f.gate.get_by_index(&0).unwrap().depositor, f.depositor);
    assert_eq!(f.gate.get_by_index(&2).unwrap().depositor, d3);
    assert!(f.gate.get_by_index(&3).is_none());
    assert_eq!(f.gate.get_history(&0, &10).len(), 3);
    assert_eq!(f.gate.get_history(&1, &1).len(), 1);
    assert_eq!(f.gate.get_history(&1, &1).get(0).unwrap().index, 1);
    assert_eq!(f.gate.get_history(&5, &10).len(), 0);
    assert_eq!(f.gate.get_history(&0, &0).len(), 0);
}

#[test]
fn test_resubmit_overwrites_same_depositor() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    f.escrow.set_lock(&good_lock(&f, &env));
    // first proof: lock_id 1
    f.gate.submit_solvency_proof(&f.seal, &f.image, &good_journal(&f, &env));
    // second proof from the SAME depositor binding lock_id 2 (a fresh bond) overwrites the record
    let mut l2 = good_lock(&f, &env);
    l2.id = 2;
    f.escrow.set_lock(&l2);
    let j2 = make_journal(
        &env, 1, CLAIM_TYPE, &ISSUER, SUPPLY, 2, FAR_EXPIRY, &ESCROW_ID, 2, MIN_AMOUNT, &BOND_TOKEN_ID,
        &SUPPLY_TOKEN_ID,
    );
    f.gate.submit_solvency_proof(&f.seal, &f.image, &j2);
    assert_eq!(f.gate.get_record(&f.depositor).unwrap().lock_id, 2);
    assert_eq!(f.gate.get_count(), 2); // both appended to the history log
}

#[test]
fn test_admin_set_supply_token_and_image() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let new_img = BytesN::from_array(&env, &[0x11u8; 32]);
    f.gate.set_image_id(&new_img);
    assert_eq!(f.gate.get_config().image_id, new_img);
    let new_tok = Address::generate(&env);
    let new_id = BytesN::from_array(&env, &[0x22u8; 32]);
    f.gate.set_supply_token(&new_tok, &new_id);
    assert_eq!(f.gate.get_config().supply_token, new_tok);
    assert_eq!(f.gate.get_config().supply_token_id, new_id);
}

#[test]
fn test_admin_requires_auth() {
    let env = Env::default();
    let f = setup(&env); // NO mock_all_auths
    let img = BytesN::from_array(&env, &[0x11u8; 32]);
    assert!(f.gate.try_set_image_id(&img).is_err());
}

#[test]
fn test_upgrade_rejects_non_admin() {
    let env = Env::default();
    let f = setup(&env);
    let attacker = Address::generate(&env);
    let bogus = BytesN::from_array(&env, &[9u8; 32]);
    let res = f.gate.try_upgrade(&bogus, &attacker);
    assert_eq!(res, Err(Ok(SolvencyError::NotAdmin.into())));
}

// ============ DE-RISK: real escrow cross-call (self-void end-to-end) ============
// Registers the ACTUAL `escrow` contract + a real SEP-41 token, deposits a revocable lock, proves
// solvency against it, asserts is_granted true, then `unbond`s through the REAL escrow and asserts the
// grant evaporates — the on-chain self-void, across the two real contracts.
#[test]
fn test_real_escrow_self_void() {
    use escrow::{Escrow, EscrowClient as RealEscrowClient};
    use token::{Token, TokenClient};

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);

    // real SEP-41 bond token, mint to the depositor
    let token_id = env.register(Token, ());
    let bond = TokenClient::new(&env, &token_id);
    bond.initialize(&admin, &7u32, &soroban_sdk::String::from_str(&env, "zkUSD"), &soroban_sdk::String::from_str(&env, "zkUSD"));
    bond.mint(&depositor, &1_000_000);

    // real escrow
    let escrow_addr = env.register(Escrow, ());
    let escrow = RealEscrowClient::new(&env, &escrow_addr);
    // deposit a revocable self-bond lock (claimant == depositor)
    env.ledger().set_timestamp(1_000);
    let commitment = BytesN::from_array(&env, &[0u8; 32]);
    let lock_id = escrow.deposit(
        &depositor,
        &token_id,
        &100_000i128,
        &9_000_000u64,
        &depositor,
        &commitment,
        &true,
    );

    // real supply token (separate role) + verifier mock
    let verifier_id = env.register(MockVerifier, ());
    let supply_id = env.register(MockSupplyToken, ());
    let supply = MockSupplyTokenClient::new(&env, &supply_id);
    supply.set_supply(&(SUPPLY as i128));

    // the gate, pointed at the REAL escrow + the real bond token Address
    let gate_id = env.register(SolvencyGate, ());
    let gate = SolvencyGateClient::new(&env, &gate_id);
    let image = BytesN::from_array(&env, &SOL_IMAGE);
    gate.initialize(
        &admin,
        &verifier_id,
        &escrow_addr,
        &BytesN::from_array(&env, &ESCROW_ID),
        &supply_id,
        &BytesN::from_array(&env, &SUPPLY_TOKEN_ID),
        &token_id,
        &BytesN::from_array(&env, &BOND_TOKEN_ID),
        &image,
        &CLAIM_TYPE,
        &vec![&env, BytesN::from_array(&env, &ISSUER)],
    );

    let seal = Bytes::from_array(&env, &[0u8; 4]);
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &ISSUER, SUPPLY, 1, FAR_EXPIRY, &ESCROW_ID, lock_id, MIN_AMOUNT,
        &BOND_TOKEN_ID, &SUPPLY_TOKEN_ID,
    );
    gate.submit_solvency_proof(&seal, &image, &j);
    assert!(gate.is_granted(&depositor), "solvent + bonded -> granted");

    // pull the collateral through the REAL escrow -> the gate's live read catches it
    escrow.unbond(&lock_id);
    assert!(!gate.is_granted(&depositor), "self-void: unbond revokes the grant on-chain");
}
