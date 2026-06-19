#![cfg(test)]
use super::*;
use risc0_interface::VerifierError;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    vec, Address, Bytes, BytesN, Env,
};

const REV_ISSUER: [u8; 32] = [15u8; 32]; // mock revenue auditor pubkey
const ACC_ISSUER: [u8; 32] = [13u8; 32]; // mock accreditation provider pubkey
const ACCESSOR: [u8; 32] = [0xA1u8; 32]; // accredited investor wallet
const ACCESSOR2: [u8; 32] = [0xB2u8; 32]; // NOT accredited
const REV_IMAGE: [u8; 32] = [0xABu8; 32];
const ACC_IMAGE: [u8; 32] = [0xCDu8; 32];
const CLAIM_TYPE_REVENUE: u32 = 6;
const CLAIM_TYPE_ACCREDITED: u32 = 7;
const THRESHOLD_X: u64 = 1_000_000; // demo revenue floor ($1,000,000)
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

// ---- mock accredited gate (the cross-call target for the core fundraise tests) ----
// Mirrors the real `accredited` gate's `is_granted` signature; `set_granted` toggles a flag.
#[contract]
pub struct MockAccreditedGate;
#[contractimpl]
impl MockAccreditedGate {
    pub fn set_granted(env: Env, accessor: BytesN<32>, granted: bool) {
        env.storage().persistent().set(&accessor, &granted);
    }
    pub fn is_granted(env: Env, accessor: BytesN<32>) -> bool {
        env.storage().persistent().get(&accessor).unwrap_or(false)
    }
}

// 61-byte revenue journal (generic claim_predicate guest layout).
fn make_revenue_journal(
    env: &Env,
    result: u8,
    claim_type: u32,
    issuer: &[u8; 32],
    threshold: u64,
    nonce: u64,
    expiry: u64,
) -> Bytes {
    let mut a = [0u8; 61];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..37].copy_from_slice(issuer);
    a[37..45].copy_from_slice(&threshold.to_be_bytes());
    a[45..53].copy_from_slice(&nonce.to_be_bytes());
    a[53..61].copy_from_slice(&expiry.to_be_bytes());
    Bytes::from_array(env, &a)
}

struct Fixture<'a> {
    fundraise: FundraiseClient<'a>,
    verifier: MockVerifierClient<'a>,
    gate: MockAccreditedGateClient<'a>,
    rev_image: BytesN<32>,
    seal: Bytes,
}

fn setup(env: &Env) -> Fixture<'static> {
    let admin = Address::generate(env);
    let verifier_id = env.register(MockVerifier, ());
    let gate_id = env.register(MockAccreditedGate, ());
    let fundraise_id = env.register(Fundraise, ());
    let fundraise = FundraiseClient::new(env, &fundraise_id);
    let verifier = MockVerifierClient::new(env, &verifier_id);
    let gate = MockAccreditedGateClient::new(env, &gate_id);
    let rev_image = BytesN::from_array(env, &REV_IMAGE);
    let rev_issuer = BytesN::from_array(env, &REV_ISSUER);
    fundraise.initialize(
        &admin,
        &verifier_id,
        &gate_id,
        &rev_image,
        &CLAIM_TYPE_REVENUE,
        &THRESHOLD_X,
        &vec![env, rev_issuer],
    );
    Fixture {
        fundraise,
        verifier,
        gate,
        rev_image,
        seal: Bytes::from_array(env, &[0u8; 4]),
    }
}

// submit a valid revenue proof (the financial leg)
fn prove_revenue(env: &Env, f: &Fixture) {
    let j = make_revenue_journal(env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, THRESHOLD_X, 1, FAR_EXPIRY);
    f.fundraise.submit_revenue_proof(&f.seal, &f.rev_image, &j);
}

// ============================ REVENUE LEG ============================

#[test]
fn test_submit_revenue_happy() {
    let env = Env::default();
    let f = setup(&env);
    assert!(!f.fundraise.is_revenue_verified());
    let rec = prove_revenue_ret(&env, &f);
    assert_eq!(rec.threshold, THRESHOLD_X);
    assert_eq!(rec.claim_type, 6);
    assert!(f.fundraise.is_revenue_verified());
    assert_eq!(f.fundraise.get_revenue_record().unwrap().threshold, THRESHOLD_X);
}

fn prove_revenue_ret(env: &Env, f: &Fixture) -> RevenueRecord {
    let j = make_revenue_journal(env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, THRESHOLD_X, 1, FAR_EXPIRY);
    f.fundraise.submit_revenue_proof(&f.seal, &f.rev_image, &j)
}

#[test]
fn test_revenue_image_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    let wrong = BytesN::from_array(&env, &[0x00u8; 32]);
    let j = make_revenue_journal(&env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, THRESHOLD_X, 1, FAR_EXPIRY);
    let res = f.fundraise.try_submit_revenue_proof(&f.seal, &wrong, &j);
    assert_eq!(res, Err(Ok(FundraiseError::ImageMismatch)));
}

#[test]
fn test_revenue_malformed_journal() {
    let env = Env::default();
    let f = setup(&env);
    let bad = Bytes::from_array(&env, &[1u8; 60]); // 60 != 61
    let res = f.fundraise.try_submit_revenue_proof(&f.seal, &f.rev_image, &bad);
    assert_eq!(res, Err(Ok(FundraiseError::MalformedJournal)));
}

#[test]
fn test_revenue_proof_invalid() {
    let env = Env::default();
    let f = setup(&env);
    f.verifier.set_valid(&false);
    let j = make_revenue_journal(&env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, THRESHOLD_X, 1, FAR_EXPIRY);
    let res = f.fundraise.try_submit_revenue_proof(&f.seal, &f.rev_image, &j);
    assert_eq!(res, Err(Ok(FundraiseError::ProofInvalid)));
}

#[test]
fn test_revenue_result_not_true() {
    let env = Env::default();
    let f = setup(&env);
    let j = make_revenue_journal(&env, 0, CLAIM_TYPE_REVENUE, &REV_ISSUER, THRESHOLD_X, 1, FAR_EXPIRY);
    let res = f.fundraise.try_submit_revenue_proof(&f.seal, &f.rev_image, &j);
    assert_eq!(res, Err(Ok(FundraiseError::ResultNotTrue)));
}

#[test]
fn test_revenue_claim_type_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    let j = make_revenue_journal(&env, 1, 2, &REV_ISSUER, THRESHOLD_X, 1, FAR_EXPIRY); // 2 (PoR) != 6
    let res = f.fundraise.try_submit_revenue_proof(&f.seal, &f.rev_image, &j);
    assert_eq!(res, Err(Ok(FundraiseError::ClaimTypeMismatch)));
}

#[test]
fn test_revenue_issuer_not_allowed() {
    let env = Env::default();
    let f = setup(&env);
    let j = make_revenue_journal(&env, 1, CLAIM_TYPE_REVENUE, &[9u8; 32], THRESHOLD_X, 1, FAR_EXPIRY);
    let res = f.fundraise.try_submit_revenue_proof(&f.seal, &f.rev_image, &j);
    assert_eq!(res, Err(Ok(FundraiseError::IssuerNotAllowed)));
}

#[test]
fn test_revenue_threshold_mismatch() {
    let env = Env::default();
    let f = setup(&env);
    // proven threshold 999_999 != pinned X (1_000_000) -> rejected (prover can't lower the bar)
    let j = make_revenue_journal(&env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, 999_999, 1, FAR_EXPIRY);
    let res = f.fundraise.try_submit_revenue_proof(&f.seal, &f.rev_image, &j);
    assert_eq!(res, Err(Ok(FundraiseError::ThresholdMismatch)));
}

#[test]
fn test_revenue_expired() {
    let env = Env::default();
    let f = setup(&env);
    env.ledger().set_timestamp(5_000);
    let j = make_revenue_journal(&env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, THRESHOLD_X, 1, 4_000);
    let res = f.fundraise.try_submit_revenue_proof(&f.seal, &f.rev_image, &j);
    assert_eq!(res, Err(Ok(FundraiseError::Expired)));
}

#[test]
fn test_revenue_freshness_expires() {
    let env = Env::default();
    let f = setup(&env);
    env.ledger().set_timestamp(1_000);
    let j = make_revenue_journal(&env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, THRESHOLD_X, 1, 2_000);
    f.fundraise.submit_revenue_proof(&f.seal, &f.rev_image, &j);
    assert!(f.fundraise.is_revenue_verified()); // now (1000) < expiry (2000)
    env.ledger().set_timestamp(3_000); // past revenue expiry
    assert!(!f.fundraise.is_revenue_verified()); // stale revenue stops gating
}

// ====================== THE COMPOSITION (AND) ======================

#[test]
fn test_compose_both_true_grants() {
    let env = Env::default();
    let f = setup(&env);
    let a = BytesN::from_array(&env, &ACCESSOR);
    // both legs true
    prove_revenue(&env, &f);
    f.gate.set_granted(&a, &true);
    assert!(f.fundraise.can_access(&a));
    let rec = f.fundraise.request_investor_access(&a);
    assert_eq!(rec.accessor, a);
    assert_eq!(rec.revenue_threshold, THRESHOLD_X);
    assert_eq!(rec.index, 0);
    assert_eq!(f.fundraise.get_investor_access(&a).unwrap().index, 0);
    assert_eq!(f.fundraise.get_latest_access().unwrap().accessor, a);
    assert_eq!(f.fundraise.get_count(), 1);
}

#[test]
fn test_compose_accredited_but_no_revenue_denied() {
    let env = Env::default();
    let f = setup(&env);
    let a = BytesN::from_array(&env, &ACCESSOR);
    f.gate.set_granted(&a, &true); // accredited...
    // ...but no revenue proof submitted
    assert!(!f.fundraise.can_access(&a));
    let res = f.fundraise.try_request_investor_access(&a);
    assert_eq!(res, Err(Ok(FundraiseError::RevenueNotVerified)));
    assert_eq!(f.fundraise.get_count(), 0); // rejection does not append
}

#[test]
fn test_compose_revenue_but_not_accredited_denied() {
    let env = Env::default();
    let f = setup(&env);
    let a = BytesN::from_array(&env, &ACCESSOR2);
    prove_revenue(&env, &f); // revenue...
    // ...but accessor not accredited (gate default false)
    assert!(!f.fundraise.can_access(&a));
    let res = f.fundraise.try_request_investor_access(&a);
    assert_eq!(res, Err(Ok(FundraiseError::NotAccredited)));
    assert_eq!(f.fundraise.get_count(), 0);
}

#[test]
fn test_compose_neither_denied() {
    let env = Env::default();
    let f = setup(&env);
    let a = BytesN::from_array(&env, &ACCESSOR);
    assert!(!f.fundraise.can_access(&a));
    let res = f.fundraise.try_request_investor_access(&a);
    // revenue is checked first -> RevenueNotVerified
    assert_eq!(res, Err(Ok(FundraiseError::RevenueNotVerified)));
}

#[test]
fn test_compose_access_drops_when_revenue_expires() {
    let env = Env::default();
    let f = setup(&env);
    let a = BytesN::from_array(&env, &ACCESSOR);
    env.ledger().set_timestamp(1_000);
    let j = make_revenue_journal(&env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, THRESHOLD_X, 1, 2_000);
    f.fundraise.submit_revenue_proof(&f.seal, &f.rev_image, &j);
    f.gate.set_granted(&a, &true);
    assert!(f.fundraise.can_access(&a)); // both fresh
    env.ledger().set_timestamp(3_000); // revenue expired
    assert!(!f.fundraise.can_access(&a)); // composed decision drops
    let res = f.fundraise.try_request_investor_access(&a);
    assert_eq!(res, Err(Ok(FundraiseError::RevenueNotVerified)));
}

#[test]
fn test_compose_access_drops_when_accreditation_revoked() {
    let env = Env::default();
    let f = setup(&env);
    let a = BytesN::from_array(&env, &ACCESSOR);
    prove_revenue(&env, &f);
    f.gate.set_granted(&a, &true);
    assert!(f.fundraise.can_access(&a));
    f.gate.set_granted(&a, &false); // accreditation revoked / expired at the gate
    assert!(!f.fundraise.can_access(&a)); // composed decision drops
    let res = f.fundraise.try_request_investor_access(&a);
    assert_eq!(res, Err(Ok(FundraiseError::NotAccredited)));
}

#[test]
fn test_admission_history_paginates() {
    let env = Env::default();
    let f = setup(&env);
    prove_revenue(&env, &f);
    let a = BytesN::from_array(&env, &ACCESSOR);
    let b = BytesN::from_array(&env, &ACCESSOR2);
    let c = BytesN::from_array(&env, &[0xC3u8; 32]);
    f.gate.set_granted(&a, &true);
    f.gate.set_granted(&b, &true);
    f.gate.set_granted(&c, &true);
    let r0 = f.fundraise.request_investor_access(&a);
    let r1 = f.fundraise.request_investor_access(&b);
    let r2 = f.fundraise.request_investor_access(&c);
    assert_eq!((r0.index, r1.index, r2.index), (0, 1, 2));
    assert_eq!(f.fundraise.get_count(), 3);
    assert_eq!(f.fundraise.get_by_index(&0).unwrap().accessor, a);
    assert_eq!(f.fundraise.get_by_index(&2).unwrap().accessor, c);
    assert!(f.fundraise.get_by_index(&3).is_none());
    assert_eq!(f.fundraise.get_history(&0, &10).len(), 3);
    assert_eq!(f.fundraise.get_history(&1, &1).len(), 1);
    assert_eq!(f.fundraise.get_history(&1, &1).get(0).unwrap().index, 1);
    assert_eq!(f.fundraise.get_history(&5, &10).len(), 0);
    assert_eq!(f.fundraise.get_history(&0, &0).len(), 0);
}

// ====================== ADMIN ======================

#[test]
fn test_set_threshold_then_new_proof_must_match() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    f.fundraise.set_threshold(&2_000_000);
    assert_eq!(f.fundraise.get_config().revenue_threshold, 2_000_000);
    // old X no longer accepted
    let old = make_revenue_journal(&env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, THRESHOLD_X, 1, FAR_EXPIRY);
    assert_eq!(
        f.fundraise.try_submit_revenue_proof(&f.seal, &f.rev_image, &old),
        Err(Ok(FundraiseError::ThresholdMismatch))
    );
    // new X accepted
    let new = make_revenue_journal(&env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, 2_000_000, 1, FAR_EXPIRY);
    f.fundraise.submit_revenue_proof(&f.seal, &f.rev_image, &new);
    assert!(f.fundraise.is_revenue_verified());
}

#[test]
fn test_set_threshold_revokes_stale_revenue() {
    // After set_threshold(new X), a revenue record that cleared the OLD floor must stop gating access
    // (is_revenue_verified requires the proven floor to equal the CURRENT pinned X), until a fresh
    // proof matching the new X is submitted.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    prove_revenue(&env, &f); // proves the floor X = THRESHOLD_X (1_000_000)
    assert!(f.fundraise.is_revenue_verified());
    f.fundraise.set_threshold(&2_000_000); // repoint X — the stale proof no longer matches
    assert!(!f.fundraise.is_revenue_verified(), "stale revenue (old X) must stop gating after set_threshold");
    // a composed access check now denies (revenue leg false), even for an accredited investor
    let a = BytesN::from_array(&env, &ACCESSOR);
    f.gate.set_granted(&a, &true);
    assert!(!f.fundraise.can_access(&a));
    // a fresh proof matching the new X restores it
    let new = make_revenue_journal(&env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, 2_000_000, 1, FAR_EXPIRY);
    f.fundraise.submit_revenue_proof(&f.seal, &f.rev_image, &new);
    assert!(f.fundraise.is_revenue_verified());
    assert!(f.fundraise.can_access(&a));
}

#[test]
fn test_can_access_total_on_broken_gate() {
    // MEDIUM-1 hardening: can_access must be TOTAL — a misconfigured accredited_gate (here a contract
    // with no `is_granted`) yields `false` (denied) via try_is_granted, NOT a trap.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    prove_revenue(&env, &f);
    let a = BytesN::from_array(&env, &ACCESSOR);
    // point the gate at the verifier-shaped mock (which has no `is_granted` method)
    let broken = env.register(MockVerifier, ());
    f.fundraise.set_accredited_gate(&broken);
    assert!(!f.fundraise.can_access(&a), "broken gate -> can_access returns false, not a trap");
    assert_eq!(
        f.fundraise.try_request_investor_access(&a),
        Err(Ok(FundraiseError::NotAccredited))
    );
}

#[test]
fn test_set_accredited_gate_repoint() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    prove_revenue(&env, &f);
    let a = BytesN::from_array(&env, &ACCESSOR);
    // a second gate that grants `a`
    let gate2_id = env.register(MockAccreditedGate, ());
    let gate2 = MockAccreditedGateClient::new(&env, &gate2_id);
    gate2.set_granted(&a, &true);
    assert!(!f.fundraise.can_access(&a)); // original gate doesn't grant a
    f.fundraise.set_accredited_gate(&gate2_id);
    assert!(f.fundraise.can_access(&a)); // now AND'd against gate2
}

#[test]
fn test_upgrade_rejects_non_admin() {
    let env = Env::default();
    let f = setup(&env);
    let attacker = Address::generate(&env);
    let bogus = BytesN::from_array(&env, &[9u8; 32]);
    let res = f.fundraise.try_upgrade(&bogus, &attacker);
    assert_eq!(res, Err(Ok(FundraiseError::NotAdmin.into())));
}

#[test]
fn test_admin_requires_auth() {
    let env = Env::default();
    let f = setup(&env); // NO mock_all_auths
    assert!(f.fundraise.try_set_threshold(&2_000_000).is_err());
}

#[test]
fn test_empty_state() {
    let env = Env::default();
    let f = setup(&env);
    assert!(!f.fundraise.is_revenue_verified());
    assert!(f.fundraise.get_revenue_record().is_none());
    assert!(f.fundraise.get_latest_access().is_none());
    assert_eq!(f.fundraise.get_count(), 0);
    let a = BytesN::from_array(&env, &ACCESSOR);
    assert!(!f.fundraise.can_access(&a));
    assert!(f.fundraise.get_investor_access(&a).is_none());
}

// ============ DE-RISK GATE: real cross-contract composition ============
// Registers the ACTUAL `accredited` gate (not a mock) + the real verifier-shaped mock, grants an
// accessor through the gate's real `request_access`, submits revenue, and asserts the composed
// can_access / request_investor_access across the two real contracts. This is the Chunk-0 de-risk:
// proves the `#[contractclient]` cross-call to the real gate's `is_granted` composes end-to-end.
#[test]
fn test_real_accredited_gate_composition() {
    use accredited::{Accredited, AccreditedClient};

    let env = Env::default();
    let admin = Address::generate(&env);
    let verifier_id = env.register(MockVerifier, ());

    // real accredited gate, pinned to claim_type 7 + the accreditation issuer
    let acc_gate_id = env.register(Accredited, ());
    let acc_gate = AccreditedClient::new(&env, &acc_gate_id);
    let acc_image = BytesN::from_array(&env, &ACC_IMAGE);
    let acc_issuer = BytesN::from_array(&env, &ACC_ISSUER);
    acc_gate.initialize(&admin, &verifier_id, &acc_image, &CLAIM_TYPE_ACCREDITED, &vec![&env, acc_issuer]);

    // fundraise pointed at the REAL accredited gate
    let fundraise_id = env.register(Fundraise, ());
    let fundraise = FundraiseClient::new(&env, &fundraise_id);
    let rev_image = BytesN::from_array(&env, &REV_IMAGE);
    let rev_issuer = BytesN::from_array(&env, &REV_ISSUER);
    fundraise.initialize(
        &admin,
        &verifier_id,
        &acc_gate_id,
        &rev_image,
        &CLAIM_TYPE_REVENUE,
        &THRESHOLD_X,
        &vec![&env, rev_issuer],
    );

    let seal = Bytes::from_array(&env, &[0u8; 4]);
    let a = BytesN::from_array(&env, &ACCESSOR);

    // before anything: denied
    assert!(!fundraise.can_access(&a));

    // grant accreditation through the REAL gate's request_access (85-byte identity-style journal)
    let mut aj = [0u8; 85];
    aj[0] = 1;
    aj[1..5].copy_from_slice(&CLAIM_TYPE_ACCREDITED.to_be_bytes());
    aj[5..37].copy_from_slice(&ACC_ISSUER);
    aj[37..69].copy_from_slice(&ACCESSOR);
    aj[69..77].copy_from_slice(&1u64.to_be_bytes());
    aj[77..85].copy_from_slice(&FAR_EXPIRY.to_be_bytes());
    acc_gate.request_access(&seal, &acc_image, &Bytes::from_array(&env, &aj));
    assert!(acc_gate.is_granted(&a));

    // accredited but still no revenue -> composed denied
    assert!(!fundraise.can_access(&a));
    assert_eq!(
        fundraise.try_request_investor_access(&a),
        Err(Ok(FundraiseError::RevenueNotVerified))
    );

    // submit revenue -> now BOTH legs hold across the two real contracts
    let rj = make_revenue_journal(&env, 1, CLAIM_TYPE_REVENUE, &REV_ISSUER, THRESHOLD_X, 1, FAR_EXPIRY);
    fundraise.submit_revenue_proof(&seal, &rev_image, &rj);
    assert!(fundraise.can_access(&a));
    let rec = fundraise.request_investor_access(&a);
    assert_eq!(rec.accessor, a);

    // a different, non-accredited accessor is still denied via the real gate
    let b = BytesN::from_array(&env, &ACCESSOR2);
    assert!(!fundraise.can_access(&b));
    assert_eq!(
        fundraise.try_request_investor_access(&b),
        Err(Ok(FundraiseError::NotAccredited))
    );
}
