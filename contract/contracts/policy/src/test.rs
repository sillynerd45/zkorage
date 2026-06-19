#![cfg(test)]
use super::*;
use risc0_interface::VerifierError;
use soroban_sdk::{
    contract, contractimpl, symbol_short, testutils::Address as _, vec, Address, Bytes, BytesN, Env,
};

const SUPPLY: u64 = 10_000_000_000_000; // 1,000,000 zUSD @ 7 dp
const ISSUER: [u8; 32] = [7u8; 32];
const IMAGE: [u8; 32] = [0xABu8; 32];
const FAR_EXPIRY: u64 = 9_999_999_999;

// ---- mock bare verifier (stands in for the deployed Groth16Verifier) ----
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
        let v: bool = env
            .storage()
            .instance()
            .get(&symbol_short!("valid"))
            .unwrap_or(true);
        if v {
            Ok(())
        } else {
            Err(VerifierError::InvalidProof)
        }
    }
}

// ---- mock SEP-41 token (only total_supply matters for the binding) ----
#[contract]
pub struct MockToken;
#[contractimpl]
impl MockToken {
    pub fn set_supply(env: Env, s: i128) {
        env.storage().instance().set(&symbol_short!("supply"), &s);
    }
    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&symbol_short!("supply"))
            .unwrap_or(0)
    }
}

fn make_journal(
    env: &Env,
    result: u8,
    claim_type: u32,
    issuer: &[u8; 32],
    supply: u64,
    nonce: u64,
    expiry: u64,
) -> Bytes {
    let mut a = [0u8; 61];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..37].copy_from_slice(issuer);
    a[37..45].copy_from_slice(&supply.to_be_bytes());
    a[45..53].copy_from_slice(&nonce.to_be_bytes());
    a[53..61].copy_from_slice(&expiry.to_be_bytes());
    Bytes::from_array(env, &a)
}

struct Fixture<'a> {
    policy: PolicyClient<'a>,
    verifier: MockVerifierClient<'a>,
    token: MockTokenClient<'a>,
    image: BytesN<32>,
    seal: Bytes,
}

fn setup(env: &Env) -> Fixture<'static> {
    let admin = Address::generate(env);
    let verifier_id = env.register(MockVerifier, ());
    let token_id = env.register(MockToken, ());
    let policy_id = env.register(Policy, ());
    let policy = PolicyClient::new(env, &policy_id);
    let verifier = MockVerifierClient::new(env, &verifier_id);
    let token = MockTokenClient::new(env, &token_id);
    token.set_supply(&(SUPPLY as i128));
    let image = BytesN::from_array(env, &IMAGE);
    let issuer = BytesN::from_array(env, &ISSUER);
    policy.initialize(&admin, &verifier_id, &token_id, &image, &2u32, &vec![env, issuer]);
    Fixture {
        policy,
        verifier,
        token,
        image,
        seal: Bytes::from_array(env, &[0u8; 4]),
    }
}

#[test]
fn test_happy_path_persists() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 2, &ISSUER, SUPPLY, 1, FAR_EXPIRY);
    let vr = f.policy.submit_proof_of_reserves(&f.seal, &f.image, &journal);
    assert!(vr.result);
    assert_eq!(vr.supply, SUPPLY);
    assert_eq!(vr.claim_type, 2);
    let latest = f.policy.get_latest_result().unwrap();
    assert_eq!(latest.supply, SUPPLY);
    let issuer = BytesN::from_array(&env, &ISSUER);
    assert_eq!(f.policy.get_result(&issuer).unwrap().supply, SUPPLY);
}

#[test]
fn test_supply_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    f.token.set_supply(&((SUPPLY + 1) as i128)); // supply changed after proving
    let journal = make_journal(&env, 1, 2, &ISSUER, SUPPLY, 1, FAR_EXPIRY);
    let res = f.policy.try_submit_proof_of_reserves(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PolicyError::SupplyMismatch)));
    assert!(f.policy.get_latest_result().is_none()); // nothing persisted on rejection
}

#[test]
fn test_issuer_not_allowed() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 2, &[9u8; 32], SUPPLY, 1, FAR_EXPIRY);
    let res = f.policy.try_submit_proof_of_reserves(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PolicyError::IssuerNotAllowed)));
}

#[test]
fn test_expired() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 2, &ISSUER, SUPPLY, 1, 0); // expiry 0 <= now (0)
    let res = f.policy.try_submit_proof_of_reserves(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PolicyError::Expired)));
}

#[test]
fn test_image_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    let wrong = BytesN::from_array(&env, &[0x00u8; 32]);
    let journal = make_journal(&env, 1, 2, &ISSUER, SUPPLY, 1, FAR_EXPIRY);
    let res = f.policy.try_submit_proof_of_reserves(&f.seal, &wrong, &journal);
    assert_eq!(res, Err(Ok(PolicyError::ImageMismatch)));
}

#[test]
fn test_proof_invalid() {
    let env = Env::default();
    let f = setup(&env);
    f.verifier.set_valid(&false); // bare verifier rejects
    let journal = make_journal(&env, 1, 2, &ISSUER, SUPPLY, 1, FAR_EXPIRY);
    let res = f.policy.try_submit_proof_of_reserves(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PolicyError::ProofInvalid)));
}

#[test]
fn test_result_not_true() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 0, 2, &ISSUER, SUPPLY, 1, FAR_EXPIRY);
    let res = f.policy.try_submit_proof_of_reserves(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PolicyError::ResultNotTrue)));
}

#[test]
fn test_claim_type_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 1, &ISSUER, SUPPLY, 1, FAR_EXPIRY); // claim_type 1 != 2
    let res = f.policy.try_submit_proof_of_reserves(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PolicyError::ClaimTypeMismatch)));
}

#[test]
fn test_malformed_journal() {
    let env = Env::default();
    let f = setup(&env);
    let bad = Bytes::from_array(&env, &[1u8; 60]); // 60 != 61
    let res = f.policy.try_submit_proof_of_reserves(&f.seal, &f.image, &bad);
    assert_eq!(res, Err(Ok(PolicyError::MalformedJournal)));
}

#[test]
fn test_history_appends_and_paginates() {
    let env = Env::default();
    let f = setup(&env);
    // three successful submits (same valid proof; supply unchanged; nonce distinguishes entries).
    let r0 = f
        .policy
        .submit_proof_of_reserves(&f.seal, &f.image, &make_journal(&env, 1, 2, &ISSUER, SUPPLY, 1, FAR_EXPIRY));
    let r1 = f
        .policy
        .submit_proof_of_reserves(&f.seal, &f.image, &make_journal(&env, 1, 2, &ISSUER, SUPPLY, 2, FAR_EXPIRY));
    let r2 = f
        .policy
        .submit_proof_of_reserves(&f.seal, &f.image, &make_journal(&env, 1, 2, &ISSUER, SUPPLY, 3, FAR_EXPIRY));
    assert_eq!((r0.index, r1.index, r2.index), (0, 1, 2));
    assert_eq!(f.policy.get_count(), 3);
    // latest tracks the last append
    assert_eq!(f.policy.get_latest_result().unwrap().nonce, 3);
    // get_by_index: hits + miss
    assert_eq!(f.policy.get_by_index(&0).unwrap().nonce, 1);
    assert_eq!(f.policy.get_by_index(&2).unwrap().nonce, 3);
    assert!(f.policy.get_by_index(&3).is_none());
    // get_history: full page, in order
    let all = f.policy.get_history(&0, &10);
    assert_eq!(all.len(), 3);
    assert_eq!(all.get(0).unwrap().index, 0);
    assert_eq!(all.get(2).unwrap().nonce, 3);
    // sub-page
    let page = f.policy.get_history(&1, &1);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0).unwrap().index, 1);
    // out of range / zero limit / clamp (limit > MAX_PAGE still returns existing)
    assert_eq!(f.policy.get_history(&5, &10).len(), 0);
    assert_eq!(f.policy.get_history(&0, &0).len(), 0);
    assert_eq!(f.policy.get_history(&0, &100).len(), 3);
}

#[test]
fn test_rejection_does_not_append() {
    let env = Env::default();
    let f = setup(&env);
    f.token.set_supply(&((SUPPLY + 1) as i128)); // breaks the supply binding
    let journal = make_journal(&env, 1, 2, &ISSUER, SUPPLY, 1, FAR_EXPIRY);
    let res = f.policy.try_submit_proof_of_reserves(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PolicyError::SupplyMismatch)));
    assert_eq!(f.policy.get_count(), 0);
    assert_eq!(f.policy.get_history(&0, &10).len(), 0);
}

#[test]
fn test_upgrade_rejects_non_admin() {
    let env = Env::default();
    let f = setup(&env);
    let attacker = Address::generate(&env);
    let bogus = BytesN::from_array(&env, &[9u8; 32]);
    // operator != admin → NotAdmin, before any auth is required.
    let res = f.policy.try_upgrade(&bogus, &attacker);
    assert_eq!(res, Err(Ok(PolicyError::NotAdmin.into())));
}

#[test]
fn test_add_issuer_then_verify() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let new_issuer_bytes = [42u8; 32];
    let new_issuer = BytesN::from_array(&env, &new_issuer_bytes);
    assert!(!f.policy.is_issuer_allowed(&new_issuer));
    f.policy.add_issuer(&new_issuer);
    assert!(f.policy.is_issuer_allowed(&new_issuer));
    let journal = make_journal(&env, 1, 2, &new_issuer_bytes, SUPPLY, 1, FAR_EXPIRY);
    let vr = f.policy.submit_proof_of_reserves(&f.seal, &f.image, &journal);
    assert_eq!(vr.issuer_id, new_issuer);
}
