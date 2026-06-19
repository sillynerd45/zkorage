#![cfg(test)]
use super::*;
use risc0_interface::VerifierError;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    vec, Address, Bytes, BytesN, Env,
};

const ISSUER: [u8; 32] = [9u8; 32]; // mock payroll attester pubkey
const ACCESSOR: [u8; 32] = [0xA1u8; 32]; // demo "employee wallet" key
const ACCESSOR2: [u8; 32] = [0xB2u8; 32];
const IMAGE: [u8; 32] = [0xABu8; 32];
const AUDITOR: [u8; 32] = [0xADu8; 32]; // allow-listed auditor x25519 pubkey
const AUDITOR2: [u8; 32] = [0xAEu8; 32]; // NOT allow-listed
const EPH: [u8; 32] = [0x0Eu8; 32]; // disclosure: ephemeral pubkey (gate stores, doesn't validate)
const CT: [u8; 40] = [0x0Cu8; 40]; // disclosure: ciphertext
const TAG: [u8; 32] = [0x07u8; 32]; // disclosure: integrity tag
const CLAIM_TYPE_PAYROLL: u32 = 5;
const THRESHOLD: u64 = 5_000;
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
    threshold: u64,
    accessor: &[u8; 32],
    auditor: &[u8; 32],
    nonce: u64,
    expiry: u64,
) -> Bytes {
    let mut a = [0u8; 229];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..37].copy_from_slice(issuer);
    a[37..45].copy_from_slice(&threshold.to_be_bytes());
    a[45..77].copy_from_slice(accessor);
    a[77..109].copy_from_slice(auditor);
    a[109..141].copy_from_slice(&EPH);
    a[141..181].copy_from_slice(&CT);
    a[181..213].copy_from_slice(&TAG);
    a[213..221].copy_from_slice(&nonce.to_be_bytes());
    a[221..229].copy_from_slice(&expiry.to_be_bytes());
    Bytes::from_array(env, &a)
}

struct Fixture<'a> {
    gate: PayrollClient<'a>,
    verifier: MockVerifierClient<'a>,
    image: BytesN<32>,
    seal: Bytes,
}

fn setup(env: &Env) -> Fixture<'static> {
    let admin = Address::generate(env);
    let verifier_id = env.register(MockVerifier, ());
    let gate_id = env.register(Payroll, ());
    let gate = PayrollClient::new(env, &gate_id);
    let verifier = MockVerifierClient::new(env, &verifier_id);
    let image = BytesN::from_array(env, &IMAGE);
    let issuer = BytesN::from_array(env, &ISSUER);
    let auditor = BytesN::from_array(env, &AUDITOR);
    gate.initialize(
        &admin,
        &verifier_id,
        &image,
        &CLAIM_TYPE_PAYROLL,
        &vec![env, issuer],
        &vec![env, auditor],
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
    let journal = make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY);
    let rec = f.gate.submit_payroll_proof(&f.seal, &f.image, &journal);
    assert_eq!(rec.claim_type, 5);
    assert_eq!(rec.threshold, THRESHOLD);
    let accessor = BytesN::from_array(&env, &ACCESSOR);
    assert_eq!(rec.accessor, accessor);
    assert_eq!(rec.auditor_pub, BytesN::from_array(&env, &AUDITOR));
    assert!(f.gate.is_granted(&accessor));
    assert_eq!(f.gate.get_access(&accessor).unwrap().index, 0);
    assert_eq!(f.gate.get_latest_access().unwrap().accessor, accessor);
    // the disclosure blob is stored verbatim for the auditor
    let disc = f.gate.get_disclosure(&accessor).unwrap();
    assert_eq!(disc.auditor_pub, BytesN::from_array(&env, &AUDITOR));
    assert_eq!(disc.eph_pub, BytesN::from_array(&env, &EPH));
    assert_eq!(disc.ct, BytesN::from_array(&env, &CT));
    assert_eq!(disc.tag, BytesN::from_array(&env, &TAG));
    // a different accessor is NOT granted
    let other = BytesN::from_array(&env, &ACCESSOR2);
    assert!(!f.gate.is_granted(&other));
    assert!(f.gate.get_access(&other).is_none());
    assert!(f.gate.get_disclosure(&other).is_none());
}

#[test]
fn test_image_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    let wrong = BytesN::from_array(&env, &[0x00u8; 32]);
    let journal = make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY);
    let res = f.gate.try_submit_payroll_proof(&f.seal, &wrong, &journal);
    assert_eq!(res, Err(Ok(PayrollError::ImageMismatch)));
}

#[test]
fn test_malformed_journal() {
    let env = Env::default();
    let f = setup(&env);
    let bad = Bytes::from_array(&env, &[1u8; 228]); // 228 != 229
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &bad);
    assert_eq!(res, Err(Ok(PayrollError::MalformedJournal)));
}

#[test]
fn test_proof_invalid() {
    let env = Env::default();
    let f = setup(&env);
    f.verifier.set_valid(&false); // bare verifier rejects
    let journal = make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY);
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PayrollError::ProofInvalid)));
}

#[test]
fn test_result_not_true() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 0, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY);
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PayrollError::ResultNotTrue)));
}

#[test]
fn test_claim_type_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 4, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY); // 4 != 5
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PayrollError::ClaimTypeMismatch)));
}

#[test]
fn test_issuer_not_allowed() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 5, &[7u8; 32], THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY);
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PayrollError::IssuerNotAllowed)));
}

#[test]
fn test_expired() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, 0); // expiry 0 <= now (0)
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PayrollError::Expired)));
}

// A proof whose disclosure targets a non-allow-listed auditor is rejected (#11).
#[test]
fn test_auditor_not_allowed() {
    let env = Env::default();
    let f = setup(&env);
    let journal = make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR2, 1, FAR_EXPIRY);
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PayrollError::AuditorNotAllowed)));
}

#[test]
fn test_history_appends_and_paginates() {
    let env = Env::default();
    let f = setup(&env);
    let r0 = f.gate.submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY));
    let r1 = f.gate.submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR2, &AUDITOR, 2, FAR_EXPIRY));
    let r2 = f.gate.submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &[0xC3u8; 32], &AUDITOR, 3, FAR_EXPIRY));
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
    let journal = make_journal(&env, 1, 5, &[7u8; 32], THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY); // issuer not allowed
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PayrollError::IssuerNotAllowed)));
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
    assert_eq!(res, Err(Ok(PayrollError::NotAdmin.into())));
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
    let journal = make_journal(&env, 1, 5, &new_issuer_bytes, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY);
    let rec = f.gate.submit_payroll_proof(&f.seal, &f.image, &journal);
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
    f.gate.submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY));
    assert!(f.gate.is_granted(&a));
    f.gate.remove_issuer(&issuer);
    assert!(!f.gate.is_issuer_allowed(&issuer));
    assert!(f.gate.is_granted(&a)); // prior grant untouched
    let journal = make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR2, &AUDITOR, 2, FAR_EXPIRY);
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &journal);
    assert_eq!(res, Err(Ok(PayrollError::IssuerNotAllowed)));
}

#[test]
fn test_add_auditor_then_grant() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let new_auditor = BytesN::from_array(&env, &AUDITOR2);
    assert!(!f.gate.is_auditor_allowed(&new_auditor));
    // a proof to AUDITOR2 is rejected before it's allow-listed
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR2, 1, FAR_EXPIRY));
    assert_eq!(res, Err(Ok(PayrollError::AuditorNotAllowed)));
    f.gate.add_auditor(&new_auditor);
    assert!(f.gate.is_auditor_allowed(&new_auditor));
    let rec = f.gate.submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR2, 1, FAR_EXPIRY));
    assert_eq!(rec.auditor_pub, new_auditor);
}

#[test]
fn test_remove_auditor_then_reject() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let auditor = BytesN::from_array(&env, &AUDITOR);
    assert!(f.gate.is_auditor_allowed(&auditor));
    f.gate.submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY));
    f.gate.remove_auditor(&auditor);
    assert!(!f.gate.is_auditor_allowed(&auditor));
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR2, &AUDITOR, 2, FAR_EXPIRY));
    assert_eq!(res, Err(Ok(PayrollError::AuditorNotAllowed)));
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
    assert!(f.gate.get_disclosure(&a).is_none());
    assert_eq!(f.gate.get_history(&0, &10).len(), 0);
    assert!(f.gate.is_issuer_allowed(&BytesN::from_array(&env, &ISSUER)));
    assert!(f.gate.is_auditor_allowed(&BytesN::from_array(&env, &AUDITOR)));
}

#[test]
fn test_is_granted_expires() {
    let env = Env::default();
    let f = setup(&env);
    env.ledger().set_timestamp(1_000);
    let a = BytesN::from_array(&env, &ACCESSOR);
    f.gate.submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, 2_000));
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
    f.gate.submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY));
    f.gate.submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, 6_000, &ACCESSOR, &AUDITOR, 2, FAR_EXPIRY));
    assert_eq!(f.gate.get_count(), 2);
    assert_eq!(f.gate.get_access(&a).unwrap().nonce, 2);
    assert_eq!(f.gate.get_access(&a).unwrap().threshold, 6_000);
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
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY));
    assert_eq!(res, Err(Ok(PayrollError::ImageMismatch)));
    let rec = f.gate.submit_payroll_proof(&f.seal, &new_image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY));
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
    let res = f.gate.try_submit_payroll_proof(&f.seal, &f.image, &make_journal(&env, 1, 5, &ISSUER, THRESHOLD, &ACCESSOR, &AUDITOR, 1, FAR_EXPIRY));
    assert_eq!(res, Err(Ok(PayrollError::ProofInvalid)));
}

#[test]
fn test_set_image_id_requires_auth() {
    let env = Env::default();
    let f = setup(&env); // NO mock_all_auths
    let res = f.gate.try_set_image_id(&BytesN::from_array(&env, &[0xCDu8; 32]));
    assert!(res.is_err());
}

#[test]
fn test_add_auditor_requires_auth() {
    let env = Env::default();
    let f = setup(&env); // NO mock_all_auths
    let res = f.gate.try_add_auditor(&BytesN::from_array(&env, &AUDITOR2));
    assert!(res.is_err());
}
