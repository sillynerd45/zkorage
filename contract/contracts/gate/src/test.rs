#![cfg(test)]
use super::*;
use risc0_interface::VerifierError;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    vec, Address, Bytes, BytesN, Env,
};

const ISSUER: [u8; 32] = [9u8; 32]; // mock KYC provider pubkey
const ACCESSOR: [u8; 32] = [0xA1u8; 32]; // demo "user wallet" key
const ACCESSOR2: [u8; 32] = [0xB2u8; 32];
const IMAGE: [u8; 32] = [0xABu8; 32];
const CLAIM_TYPE_IDENTITY: u32 = 3;
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

fn make_journal(
    env: &Env,
    result: u8,
    claim_type: u32,
    issuer: &[u8; 32],
    accessor: &[u8; 32],
    nonce: u64,
    expiry: u64,
) -> Bytes {
    let mut a = [0u8; 85];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..37].copy_from_slice(issuer);
    a[37..69].copy_from_slice(accessor);
    a[69..77].copy_from_slice(&nonce.to_be_bytes());
    a[77..85].copy_from_slice(&expiry.to_be_bytes());
    Bytes::from_array(env, &a)
}

struct Fixture<'a> {
    gate: GateClient<'a>,
    verifier: MockVerifierClient<'a>,
    image: BytesN<32>,
    seal: Bytes,
}

fn setup(env: &Env) -> Fixture<'static> {
    let admin = Address::generate(env);
    let verifier_id = env.register(MockVerifier, ());
    let gate_id = env.register(Gate, ());
    let gate = GateClient::new(env, &gate_id);
    let verifier = MockVerifierClient::new(env, &verifier_id);
    let image = BytesN::from_array(env, &IMAGE);
    let issuer = BytesN::from_array(env, &ISSUER);
    gate.initialize(&admin, &verifier_id, &image, &CLAIM_TYPE_IDENTITY, &vec![env, issuer]);
    Fixture {
        gate,
        verifier,
        image,
        seal: Bytes::from_array(env, &[0u8; 4]),
    }
}

#[test]
fn test_happy_path_grants() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 1, FAR_EXPIRY);
    let rec = f.gate.request_access(&f.seal, &f.image, &journal);
    assert_eq!(rec.claim_type, 3);
    let accessor = BytesN::from_array(&env, &ACCESSOR);
    assert_eq!(rec.accessor, accessor);
    assert!(f.gate.is_granted(&accessor));
    assert_eq!(f.gate.get_access(&accessor).unwrap().index, 0);
    assert_eq!(f.gate.get_latest_access().unwrap().accessor, accessor);
    // a different accessor is NOT granted
    let other = BytesN::from_array(&env, &ACCESSOR2);
    assert!(!f.gate.is_granted(&other));
    assert!(f.gate.get_access(&other).is_none());
}

#[test]
fn test_image_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    let wrong = BytesN::from_array(&env, &[0x00u8; 32]);
    let journal = make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 1, FAR_EXPIRY);
    let res = f.gate.try_request_access(&f.seal, &wrong, &journal);
    assert_eq!(res, Err(Ok(GateError::ImageMismatch)));
}

#[test]
fn test_malformed_journal() {
    let env = Env::default();
    let f = setup(&env);
    let bad = Bytes::from_array(&env, &[1u8; 84]); // 84 != 85
    let res = f.gate.try_request_access(&f.seal, &f.image, &bad);
    assert_eq!(res, Err(Ok(GateError::MalformedJournal)));
}

#[test]
fn test_proof_invalid() {
    let env = Env::default();
    let f = setup(&env);
    f.verifier.set_valid(&false); // bare verifier rejects
    let journal = make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 1, FAR_EXPIRY);
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(GateError::ProofInvalid)));
}

#[test]
fn test_result_not_true() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 0, 3, &ISSUER, &ACCESSOR, 1, FAR_EXPIRY);
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(GateError::ResultNotTrue)));
}

#[test]
fn test_claim_type_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 2, &ISSUER, &ACCESSOR, 1, FAR_EXPIRY); // 2 != 3
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(GateError::ClaimTypeMismatch)));
}

#[test]
fn test_issuer_not_allowed() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 3, &[7u8; 32], &ACCESSOR, 1, FAR_EXPIRY); // wrong issuer
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(GateError::IssuerNotAllowed)));
}

#[test]
fn test_expired() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 1, 0); // expiry 0 <= now (0)
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(GateError::Expired)));
}

#[test]
fn test_history_appends_and_paginates() {
    let env = Env::default();
    let f = setup(&env);
    // three grants to distinct accessors (nonce distinguishes entries).
    let r0 = f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 1, FAR_EXPIRY));
    let r1 = f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 3, &ISSUER, &ACCESSOR2, 2, FAR_EXPIRY));
    let r2 = f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 3, &ISSUER, &[0xC3u8; 32], 3, FAR_EXPIRY));
    assert_eq!((r0.index, r1.index, r2.index), (0, 1, 2));
    assert_eq!(f.gate.get_count(), 3);
    assert_eq!(f.gate.get_latest_access().unwrap().nonce, 3);
    assert_eq!(f.gate.get_by_index(&0).unwrap().nonce, 1);
    assert_eq!(f.gate.get_by_index(&2).unwrap().nonce, 3);
    assert!(f.gate.get_by_index(&3).is_none());
    let all = f.gate.get_history(&0, &10);
    assert_eq!(all.len(), 3);
    assert_eq!(all.get(0).unwrap().index, 0);
    assert_eq!(all.get(2).unwrap().nonce, 3);
    let page = f.gate.get_history(&1, &1);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0).unwrap().index, 1);
    assert_eq!(f.gate.get_history(&5, &10).len(), 0);
    assert_eq!(f.gate.get_history(&0, &0).len(), 0);
    assert_eq!(f.gate.get_history(&0, &100).len(), 3);
}

#[test]
fn test_rejection_does_not_append() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 3, &[7u8; 32], &ACCESSOR, 1, FAR_EXPIRY); // issuer not allowed
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(GateError::IssuerNotAllowed)));
    assert_eq!(f.gate.get_count(), 0);
    assert_eq!(f.gate.get_history(&0, &10).len(), 0);
    let accessor = BytesN::from_array(&env, &ACCESSOR);
    assert!(!f.gate.is_granted(&accessor));
}

#[test]
fn test_upgrade_rejects_non_admin() {
    let env = Env::default();
    let f = setup(&env);
    let attacker = Address::generate(&env);
    let bogus = BytesN::from_array(&env, &[9u8; 32]);
    let res = f.gate.try_upgrade(&bogus, &attacker);
    assert_eq!(res, Err(Ok(GateError::NotAdmin.into())));
}

#[test]
fn test_add_issuer_then_grant() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let new_issuer_bytes = [42u8; 32];
    let new_issuer = BytesN::from_array(&env, &new_issuer_bytes);
    assert!(!f.gate.is_issuer_allowed(&new_issuer));
    f.gate.add_issuer(&new_issuer);
    assert!(f.gate.is_issuer_allowed(&new_issuer));
    let journal = make_journal(&env, 1, 3, &new_issuer_bytes, &ACCESSOR, 1, FAR_EXPIRY);
    let rec = f.gate.request_access(&f.seal, &f.image, &journal);
    assert_eq!(rec.issuer_id, new_issuer);
}

#[test]
fn test_remove_issuer_then_reject() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let issuer = BytesN::from_array(&env, &ISSUER);
    assert!(f.gate.is_issuer_allowed(&issuer));
    // a grant made BEFORE removal stays valid (history is append-only / immutable)
    let a = BytesN::from_array(&env, &ACCESSOR);
    f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 1, FAR_EXPIRY));
    assert!(f.gate.is_granted(&a));
    f.gate.remove_issuer(&issuer);
    assert!(!f.gate.is_issuer_allowed(&issuer));
    assert!(f.gate.is_granted(&a)); // prior grant untouched
    // but a NEW submission from the now-removed issuer is rejected
    let journal = make_journal(&env, 1, 3, &ISSUER, &ACCESSOR2, 2, FAR_EXPIRY);
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(GateError::IssuerNotAllowed)));
}

#[test]
fn test_empty_state() {
    let env = Env::default();
    let f = setup(&env);
    assert!(f.gate.get_latest_access().is_none());
    assert_eq!(f.gate.get_count(), 0);
    let a = BytesN::from_array(&env, &ACCESSOR);
    assert!(!f.gate.is_granted(&a));
    assert!(f.gate.get_access(&a).is_none());
    assert_eq!(f.gate.get_history(&0, &10).len(), 0);
}

// is_granted re-checks the credential expiry against ledger time on every read — a grant from a
// credential that has since expired reads as NOT granted, while get_access still returns the record.
#[test]
fn test_is_granted_expires() {
    let env = Env::default();
    let f = setup(&env);
    env.ledger().set_timestamp(1_000);
    let a = BytesN::from_array(&env, &ACCESSOR);
    f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 1, 2_000));
    assert!(f.gate.is_granted(&a)); // now (1000) < expiry (2000)
    assert!(f.gate.get_access(&a).is_some());
    env.ledger().set_timestamp(3_000); // past the credential's expiry
    assert!(!f.gate.is_granted(&a)); // live decision: expired
    assert!(f.gate.get_access(&a).is_some()); // raw record still readable (audit)
}

// Re-granting the same accessor overwrites the keyed record with the latest grant AND appends a new
// history entry (count grows; the log keeps every grant).
#[test]
fn test_regrant_same_accessor() {
    let env = Env::default();
    let f = setup(&env);
    let a = BytesN::from_array(&env, &ACCESSOR);
    f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 1, FAR_EXPIRY));
    f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 2, FAR_EXPIRY));
    assert_eq!(f.gate.get_count(), 2); // two log entries
    assert_eq!(f.gate.get_access(&a).unwrap().nonce, 2); // keyed view = latest
    assert_eq!(f.gate.get_access(&a).unwrap().index, 1);
    assert_eq!(f.gate.get_by_index(&0).unwrap().nonce, 1); // old entry preserved
    assert!(f.gate.is_granted(&a));
}

#[test]
fn test_set_image_id_changes_pin() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let new_image = BytesN::from_array(&env, &[0xCDu8; 32]);
    f.gate.set_image_id(&new_image);
    assert_eq!(f.gate.get_config().image_id, new_image);
    // the old image now mismatches
    let res = f.gate.try_request_access(&f.seal, &f.image, &make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 1, FAR_EXPIRY));
    assert_eq!(res, Err(Ok(GateError::ImageMismatch)));
    // the new image is accepted
    let rec = f.gate.request_access(&f.seal, &new_image, &make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 1, FAR_EXPIRY));
    assert!(f.gate.is_granted(&rec.accessor));
}

#[test]
fn test_set_verifier_repoint() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    // repoint to a second verifier that rejects → request_access now fails ProofInvalid
    let v2 = env.register(MockVerifier, ());
    MockVerifierClient::new(&env, &v2).set_valid(&false);
    f.gate.set_verifier(&v2);
    let res = f.gate.try_request_access(&f.seal, &f.image, &make_journal(&env, 1, 3, &ISSUER, &ACCESSOR, 1, FAR_EXPIRY));
    assert_eq!(res, Err(Ok(GateError::ProofInvalid)));
}

// Admin functions require the admin's auth — without it, the call fails (not a contract error).
#[test]
fn test_set_image_id_requires_auth() {
    let env = Env::default();
    let f = setup(&env); // NO mock_all_auths
    let res = f.gate.try_set_image_id(&BytesN::from_array(&env, &[0xCDu8; 32]));
    assert!(res.is_err());
}
