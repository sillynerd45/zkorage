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
const DENY_ROOT: [u8; 32] = [0xDDu8; 32]; // authoritative sanctions deny-list root
const CLAIM_TYPE_COMPLIANCE: u32 = 4;
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

#[allow(clippy::too_many_arguments)]
fn make_journal(
    env: &Env,
    result: u8,
    claim_type: u32,
    issuer: &[u8; 32],
    deny_root: &[u8; 32],
    accessor: &[u8; 32],
    nonce: u64,
    expiry: u64,
) -> Bytes {
    let mut a = [0u8; 117];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..37].copy_from_slice(issuer);
    a[37..69].copy_from_slice(deny_root);
    a[69..101].copy_from_slice(accessor);
    a[101..109].copy_from_slice(&nonce.to_be_bytes());
    a[109..117].copy_from_slice(&expiry.to_be_bytes());
    Bytes::from_array(env, &a)
}

struct Fixture<'a> {
    gate: ComplianceClient<'a>,
    verifier: MockVerifierClient<'a>,
    image: BytesN<32>,
    seal: Bytes,
}

fn setup(env: &Env) -> Fixture<'static> {
    let admin = Address::generate(env);
    let verifier_id = env.register(MockVerifier, ());
    let gate_id = env.register(Compliance, ());
    let gate = ComplianceClient::new(env, &gate_id);
    let verifier = MockVerifierClient::new(env, &verifier_id);
    let image = BytesN::from_array(env, &IMAGE);
    let deny_root = BytesN::from_array(env, &DENY_ROOT);
    let issuer = BytesN::from_array(env, &ISSUER);
    gate.initialize(
        &admin,
        &verifier_id,
        &image,
        &CLAIM_TYPE_COMPLIANCE,
        &deny_root,
        &vec![env, issuer],
    );
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
    let journal = make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY);
    let rec = f.gate.request_access(&f.seal, &f.image, &journal);
    assert_eq!(rec.claim_type, 4);
    let accessor = BytesN::from_array(&env, &ACCESSOR);
    assert_eq!(rec.accessor, accessor);
    assert_eq!(rec.deny_root, BytesN::from_array(&env, &DENY_ROOT));
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
    let journal = make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY);
    let res = f.gate.try_request_access(&f.seal, &wrong, &journal);
    assert_eq!(res, Err(Ok(ComplianceError::ImageMismatch)));
}

#[test]
fn test_malformed_journal() {
    let env = Env::default();
    let f = setup(&env);
    let bad = Bytes::from_array(&env, &[1u8; 116]); // 116 != 117
    let res = f.gate.try_request_access(&f.seal, &f.image, &bad);
    assert_eq!(res, Err(Ok(ComplianceError::MalformedJournal)));
}

#[test]
fn test_proof_invalid() {
    let env = Env::default();
    let f = setup(&env);
    f.verifier.set_valid(&false); // bare verifier rejects
    let journal = make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY);
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(ComplianceError::ProofInvalid)));
}

#[test]
fn test_result_not_true() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 0, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY);
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(ComplianceError::ResultNotTrue)));
}

#[test]
fn test_claim_type_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 3, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY); // 3 != 4
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(ComplianceError::ClaimTypeMismatch)));
}

// A valid proof checked against a STALE deny-list root is rejected (#11).
#[test]
fn test_deny_root_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    let stale_root = [0xEEu8; 32]; // != DENY_ROOT
    let journal = make_journal(&env, 1, 4, &ISSUER, &stale_root, &ACCESSOR, 1, FAR_EXPIRY);
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(ComplianceError::DenyRootMismatch)));
}

#[test]
fn test_issuer_not_allowed() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 4, &[7u8; 32], &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY);
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(ComplianceError::IssuerNotAllowed)));
}

#[test]
fn test_expired() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, 0); // expiry 0 <= now (0)
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(ComplianceError::Expired)));
}

#[test]
fn test_history_appends_and_paginates() {
    let env = Env::default();
    let f = setup(&env);
    let r0 = f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY));
    let r1 = f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR2, 2, FAR_EXPIRY));
    let r2 = f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &[0xC3u8; 32], 3, FAR_EXPIRY));
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
    let journal = make_journal(&env, 1, 4, &[7u8; 32], &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY); // issuer not allowed
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(ComplianceError::IssuerNotAllowed)));
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
    assert_eq!(res, Err(Ok(ComplianceError::NotAdmin.into())));
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
    let journal = make_journal(&env, 1, 4, &new_issuer_bytes, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY);
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
    let a = BytesN::from_array(&env, &ACCESSOR);
    f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY));
    assert!(f.gate.is_granted(&a));
    f.gate.remove_issuer(&issuer);
    assert!(!f.gate.is_issuer_allowed(&issuer));
    assert!(f.gate.is_granted(&a)); // prior grant untouched
    let journal = make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR2, 2, FAR_EXPIRY);
    let res = f.gate.try_request_access(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(ComplianceError::IssuerNotAllowed)));
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
    assert_eq!(f.gate.get_deny_root(), BytesN::from_array(&env, &DENY_ROOT));
}

#[test]
fn test_is_granted_expires() {
    let env = Env::default();
    let f = setup(&env);
    env.ledger().set_timestamp(1_000);
    let a = BytesN::from_array(&env, &ACCESSOR);
    f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, 2_000));
    assert!(f.gate.is_granted(&a)); // now (1000) < expiry (2000)
    assert!(f.gate.get_access(&a).is_some());
    env.ledger().set_timestamp(3_000); // past the credential's expiry
    assert!(!f.gate.is_granted(&a)); // live decision: expired
    assert!(f.gate.get_access(&a).is_some()); // raw record still readable (audit)
}

#[test]
fn test_regrant_same_accessor() {
    let env = Env::default();
    let f = setup(&env);
    let a = BytesN::from_array(&env, &ACCESSOR);
    f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY));
    f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 2, FAR_EXPIRY));
    assert_eq!(f.gate.get_count(), 2);
    assert_eq!(f.gate.get_access(&a).unwrap().nonce, 2);
    assert_eq!(f.gate.get_access(&a).unwrap().index, 1);
    assert_eq!(f.gate.get_by_index(&0).unwrap().nonce, 1);
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
    let res = f.gate.try_request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY));
    assert_eq!(res, Err(Ok(ComplianceError::ImageMismatch)));
    let rec = f.gate.request_access(&f.seal, &new_image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY));
    assert!(f.gate.is_granted(&rec.accessor));
}

#[test]
fn test_set_verifier_repoint() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let v2 = env.register(MockVerifier, ());
    MockVerifierClient::new(&env, &v2).set_valid(&false);
    f.gate.set_verifier(&v2);
    let res = f.gate.try_request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY));
    assert_eq!(res, Err(Ok(ComplianceError::ProofInvalid)));
}

#[test]
fn test_set_image_id_requires_auth() {
    let env = Env::default();
    let f = setup(&env); // NO mock_all_auths
    let res = f.gate.try_set_image_id(&BytesN::from_array(&env, &[0xCDu8; 32]));
    assert!(res.is_err());
}

// Updating the deny-list root re-pins it: the OLD root now mismatches (#11); the NEW root is accepted.
#[test]
fn test_set_deny_root_changes_pin() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let new_root_bytes = [0x11u8; 32];
    let new_root = BytesN::from_array(&env, &new_root_bytes);
    f.gate.set_deny_root(&new_root);
    assert_eq!(f.gate.get_deny_root(), new_root);
    // a proof against the OLD root is now rejected
    let res = f.gate.try_request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY));
    assert_eq!(res, Err(Ok(ComplianceError::DenyRootMismatch)));
    // a proof against the NEW root is accepted
    let rec = f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &new_root_bytes, &ACCESSOR, 1, FAR_EXPIRY));
    assert_eq!(rec.deny_root, new_root);
    assert!(f.gate.is_granted(&rec.accessor));
}

#[test]
fn test_set_deny_root_requires_auth() {
    let env = Env::default();
    let f = setup(&env); // NO mock_all_auths
    let res = f.gate.try_set_deny_root(&BytesN::from_array(&env, &[0x11u8; 32]));
    assert!(res.is_err());
}

// Re-pinning the deny-list root (a new sanction) immediately revokes a prior grant that was verified
// against the OLD root: is_granted goes false, while get_access still returns the raw record (audit).
#[test]
fn test_is_granted_revoked_by_set_deny_root() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let a = BytesN::from_array(&env, &ACCESSOR);
    f.gate.request_access(&f.seal, &f.image, &make_journal(&env, 1, 4, &ISSUER, &DENY_ROOT, &ACCESSOR, 1, FAR_EXPIRY));
    assert!(f.gate.is_granted(&a)); // granted against the current root
    // admin re-pins the deny-list → the prior grant (verified against the old root) is no longer live
    f.gate.set_deny_root(&BytesN::from_array(&env, &[0x11u8; 32]));
    assert!(!f.gate.is_granted(&a)); // revoked: record.deny_root != cfg.deny_root
    assert!(f.gate.get_access(&a).is_some()); // raw record still readable (audit)
}
