#![cfg(test)]
use super::*;
use risc0_interface::VerifierError;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, BytesN, Env,
};

const MEMBER_ROOT: [u8; 32] = [0xAAu8; 32];
const QUAL_ROOT: [u8; 32] = [0xBBu8; 32];
const CONTEXT: [u8; 32] = [0xCCu8; 32];
const NF1: [u8; 32] = [0xD1u8; 32];
const NF2: [u8; 32] = [0xD2u8; 32];
const ACC1: [u8; 32] = [0xE1u8; 32];
const ACC2: [u8; 32] = [0xE2u8; 32];
const IMAGE: [u8; 32] = [0xC0u8; 32];
const CLAIM_TYPE: u32 = 13;
const THRESH: u64 = 1_000;
const FAR_X: u64 = 9_000_000_000;

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

#[allow(clippy::too_many_arguments)]
fn make_journal(
    env: &Env,
    result: u8,
    claim_type: u32,
    member_root: &[u8; 32],
    qual_root: &[u8; 32],
    threshold: u64,
    unlock_after: u64,
    context: &[u8; 32],
    nullifier: &[u8; 32],
    accessor: &[u8; 32],
) -> Bytes {
    let mut a = [0u8; 181];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..37].copy_from_slice(member_root);
    a[37..69].copy_from_slice(qual_root);
    a[69..77].copy_from_slice(&threshold.to_be_bytes());
    a[77..85].copy_from_slice(&unlock_after.to_be_bytes());
    a[85..117].copy_from_slice(context);
    a[117..149].copy_from_slice(nullifier);
    a[149..181].copy_from_slice(accessor);
    Bytes::from_array(env, &a)
}

struct Fixture<'a> {
    gate: TierGateClient<'a>,
    verifier: MockVerifierClient<'a>,
    image: BytesN<32>,
    seal: Bytes,
}

/// Set up an initialized gate with the demo member root + one accepted qual root for (THRESH, FAR_X).
fn setup(env: &Env) -> Fixture<'static> {
    let admin = Address::generate(env);
    let verifier_id = env.register(MockVerifier, ());
    let gate_id = env.register(TierGate, ());
    let gate = TierGateClient::new(env, &gate_id);
    let verifier = MockVerifierClient::new(env, &verifier_id);
    let image = BytesN::from_array(env, &IMAGE);
    gate.initialize(&admin, &verifier_id, &image, &CLAIM_TYPE);
    gate.set_member_root(&BytesN::from_array(env, &MEMBER_ROOT));
    gate.set_qual_root(&THRESH, &FAR_X, &BytesN::from_array(env, &QUAL_ROOT));
    Fixture {
        gate,
        verifier,
        image,
        seal: Bytes::from_array(env, &[0u8; 4]),
    }
}

fn good_journal(env: &Env, nullifier: &[u8; 32], accessor: &[u8; 32]) -> Bytes {
    make_journal(
        env, 1, CLAIM_TYPE, &MEMBER_ROOT, &QUAL_ROOT, THRESH, FAR_X, &CONTEXT, nullifier, accessor,
    )
}

fn acc(env: &Env, a: &[u8; 32]) -> BytesN<32> {
    BytesN::from_array(env, a)
}

// ============================ HAPPY PATH ============================

#[test]
fn test_submit_happy_then_is_granted() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);

    assert!(!f.gate.is_granted(&acc(&env, &ACC1)));
    let g = f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF1, &ACC1));
    assert_eq!(g.accessor, acc(&env, &ACC1));
    assert_eq!(g.threshold, THRESH);
    assert_eq!(g.unlock_after, FAR_X);
    assert_eq!(g.index, 0);

    assert!(f.gate.is_granted(&acc(&env, &ACC1)));
    assert!(f.gate.is_nullifier_used(&acc(&env, &NF1)));
    assert_eq!(f.gate.get_count(), 1);
    assert_eq!(f.gate.get_grant(&acc(&env, &ACC1)).unwrap().nullifier, acc(&env, &NF1));
}

#[test]
fn test_three_anonymous_grants_unlinkable() {
    // The marquee: three DISTINCT identities (distinct nullifiers) each get a grant under three distinct
    // accessors. The on-chain record reveals neither identity nor which qualifying lock backs each grant.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let acc3 = [0xE3u8; 32];
    let nf3 = [0xD3u8; 32];
    f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF1, &ACC1));
    f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF2, &ACC2));
    f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &nf3, &acc3));
    assert!(f.gate.is_granted(&acc(&env, &ACC1)));
    assert!(f.gate.is_granted(&acc(&env, &ACC2)));
    assert!(f.gate.is_granted(&acc(&env, &acc3)));
    assert_eq!(f.gate.get_count(), 3);
}

#[test]
fn test_permissionless_submit() {
    // submit_tier_proof has NO require_auth (the in-guest holder sig is the consent). After admin setup,
    // clearing auths must NOT block a submit (a relayer can pay).
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    env.mock_auths(&[]); // no auths available
    let g = f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF1, &ACC1));
    assert_eq!(g.index, 0);
    assert!(f.gate.is_granted(&acc(&env, &ACC1)));
}

// ============================ NULLIFIER (one grant per identity per context) ============================

#[test]
fn test_nullifier_reuse_rejected() {
    // Same identity (same nullifier) under a DIFFERENT accessor -> the second submit is rejected. This is
    // the "two accessors from one credential" anonymity property, mirroring DR2.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF1, &ACC1));
    let res = f
        .gate
        .try_submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF1, &ACC2));
    assert_eq!(res, Err(Ok(TierError::NullifierUsed)));
    assert!(!f.gate.is_granted(&acc(&env, &ACC2)));
    assert_eq!(f.gate.get_count(), 1);
}

#[test]
fn test_different_context_different_grant() {
    // Same accessor, DIFFERENT nullifier (different context) -> a second grant is allowed (one per context).
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF1, &ACC1));
    // a different nullifier (a different context for the same identity) re-grants the same accessor
    f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF2, &ACC1));
    assert_eq!(f.gate.get_count(), 2);
}

// ============================ FRESHNESS (deadline-encoded) ============================

#[test]
fn test_deadline_passed_rejected_on_submit() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(FAR_X + 1); // now >= X
    let f = setup(&env);
    let res = f
        .gate
        .try_submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF1, &ACC1));
    assert_eq!(res, Err(Ok(TierError::DeadlinePassed)));
}

#[test]
fn test_is_granted_expires_at_x() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let x = 2_000u64;
    f.gate.set_qual_root(&THRESH, &x, &BytesN::from_array(&env, &QUAL_ROOT));
    let j = make_journal(&env, 1, CLAIM_TYPE, &MEMBER_ROOT, &QUAL_ROOT, THRESH, x, &CONTEXT, &NF1, &ACC1);
    f.gate.submit_tier_proof(&f.seal, &f.image, &j);
    assert!(f.gate.is_granted(&acc(&env, &ACC1))); // now (1000) < X (2000)
    env.ledger().set_timestamp(2_500); // past X
    assert!(!f.gate.is_granted(&acc(&env, &ACC1)));
}

// ============================ MEMBER / QUAL BINDINGS ============================

#[test]
fn test_member_root_not_set() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    // initialize WITHOUT set_member_root
    let admin = Address::generate(&env);
    let verifier_id = env.register(MockVerifier, ());
    let gate_id = env.register(TierGate, ());
    let gate = TierGateClient::new(&env, &gate_id);
    let image = BytesN::from_array(&env, &IMAGE);
    gate.initialize(&admin, &verifier_id, &image, &CLAIM_TYPE);
    gate.set_qual_root(&THRESH, &FAR_X, &BytesN::from_array(&env, &QUAL_ROOT));
    let seal = Bytes::from_array(&env, &[0u8; 4]);
    let res = gate.try_submit_tier_proof(&seal, &image, &good_journal(&env, &NF1, &ACC1));
    assert_eq!(res, Err(Ok(TierError::MemberRootNotSet)));
}

#[test]
fn test_member_root_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &[0x99u8; 32], &QUAL_ROOT, THRESH, FAR_X, &CONTEXT, &NF1, &ACC1,
    );
    let res = f.gate.try_submit_tier_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(TierError::MemberRootMismatch)));
}

#[test]
fn test_qual_root_unknown() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    // a qual root never published for this tier
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &MEMBER_ROOT, &[0x77u8; 32], THRESH, FAR_X, &CONTEXT, &NF1, &ACC1,
    );
    let res = f.gate.try_submit_tier_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(TierError::QualRootUnknown)));
}

#[test]
fn test_qual_root_wrong_tier_rejected() {
    // The right root, but for a DIFFERENT (threshold, X) than it was published under -> unknown.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &MEMBER_ROOT, &QUAL_ROOT, THRESH + 1, FAR_X, &CONTEXT, &NF1, &ACC1,
    );
    let res = f.gate.try_submit_tier_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(TierError::QualRootUnknown)));
}

// ============================ QUAL-ROOT RING ============================

#[test]
fn test_qual_ring_accepts_recent_after_rotation() {
    // Publish R1 then R2; a proof against the still-recent R1 is still accepted (kills the publish/prove race).
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env); // QUAL_ROOT (call it R1) already published
    let r2 = [0x55u8; 32];
    f.gate.set_qual_root(&THRESH, &FAR_X, &BytesN::from_array(&env, &r2));
    assert_eq!(f.gate.get_qual_ring(&THRESH, &FAR_X).len(), 2);
    // proof against R1 (the older root) still verifies
    f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF1, &ACC1));
    // proof against R2 (the new root) also verifies
    let j2 = make_journal(&env, 1, CLAIM_TYPE, &MEMBER_ROOT, &r2, THRESH, FAR_X, &CONTEXT, &NF2, &ACC2);
    f.gate.submit_tier_proof(&f.seal, &f.image, &j2);
}

#[test]
fn test_qual_ring_drops_oldest_beyond_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env); // ring already has 1 (QUAL_ROOT)
    // publish RING_CAP more distinct roots -> the original QUAL_ROOT (oldest) should fall off.
    for i in 0..RING_CAP {
        let r = [0x10u8 + i as u8; 32];
        f.gate.set_qual_root(&THRESH, &FAR_X, &BytesN::from_array(&env, &r));
    }
    assert_eq!(f.gate.get_qual_ring(&THRESH, &FAR_X).len(), RING_CAP);
    assert!(!f.gate.is_qual_root_accepted(&THRESH, &FAR_X, &BytesN::from_array(&env, &QUAL_ROOT)));
    assert!(f.gate.is_qual_root_accepted(&THRESH, &FAR_X, &BytesN::from_array(&env, &[0x10u8; 32])));
}

#[test]
fn test_set_qual_root_idempotent_head() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    // re-publishing the same head root is a no-op (no duplicate ring entry)
    f.gate.set_qual_root(&THRESH, &FAR_X, &BytesN::from_array(&env, &QUAL_ROOT));
    f.gate.set_qual_root(&THRESH, &FAR_X, &BytesN::from_array(&env, &QUAL_ROOT));
    assert_eq!(f.gate.get_qual_ring(&THRESH, &FAR_X).len(), 1);
}

// ============================ JOURNAL / PROOF NEGATIVES ============================

#[test]
fn test_image_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let wrong = BytesN::from_array(&env, &[0u8; 32]);
    let res = f.gate.try_submit_tier_proof(&f.seal, &wrong, &good_journal(&env, &NF1, &ACC1));
    assert_eq!(res, Err(Ok(TierError::ImageMismatch)));
}

#[test]
fn test_malformed_journal() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let bad = Bytes::from_array(&env, &[1u8; 180]); // 180 != 181
    let res = f.gate.try_submit_tier_proof(&f.seal, &f.image, &bad);
    assert_eq!(res, Err(Ok(TierError::MalformedJournal)));
}

#[test]
fn test_proof_invalid() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    f.verifier.set_valid(&false);
    let res = f.gate.try_submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF1, &ACC1));
    assert_eq!(res, Err(Ok(TierError::ProofInvalid)));
}

#[test]
fn test_result_not_true() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let j = make_journal(
        &env, 0, CLAIM_TYPE, &MEMBER_ROOT, &QUAL_ROOT, THRESH, FAR_X, &CONTEXT, &NF1, &ACC1,
    );
    let res = f.gate.try_submit_tier_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(TierError::ResultNotTrue)));
}

#[test]
fn test_claim_type_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let j = make_journal(
        &env, 1, 9, &MEMBER_ROOT, &QUAL_ROOT, THRESH, FAR_X, &CONTEXT, &NF1, &ACC1,
    );
    let res = f.gate.try_submit_tier_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(TierError::ClaimTypeMismatch)));
}

// ============================ READS / HISTORY / ADMIN ============================

#[test]
fn test_is_granted_no_record() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    assert!(!f.gate.is_granted(&acc(&env, &ACC1)));
    assert!(f.gate.get_grant(&acc(&env, &ACC1)).is_none());
    assert!(f.gate.get_latest().is_none());
    assert_eq!(f.gate.get_count(), 0);
}

#[test]
fn test_history_paginates() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF1, &ACC1));
    f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &NF2, &ACC2));
    let nf3 = [0xD3u8; 32];
    let acc3 = [0xE3u8; 32];
    f.gate.submit_tier_proof(&f.seal, &f.image, &good_journal(&env, &nf3, &acc3));

    assert_eq!(f.gate.get_count(), 3);
    assert_eq!(f.gate.get_by_index(&0).unwrap().accessor, acc(&env, &ACC1));
    assert_eq!(f.gate.get_by_index(&2).unwrap().accessor, acc(&env, &acc3));
    assert!(f.gate.get_by_index(&3).is_none());
    assert_eq!(f.gate.get_history(&0, &10).len(), 3);
    assert_eq!(f.gate.get_history(&1, &1).len(), 1);
    assert_eq!(f.gate.get_history(&1, &1).get(0).unwrap().index, 1);
    assert_eq!(f.gate.get_history(&5, &10).len(), 0);
    assert_eq!(f.gate.get_history(&0, &0).len(), 0);
}

#[test]
fn test_admin_requires_auth() {
    let env = Env::default();
    let f = setup_no_auth(&env);
    let root = BytesN::from_array(&env, &MEMBER_ROOT);
    assert!(f.gate.try_set_member_root(&root).is_err());
    assert!(f.gate.try_set_qual_root(&THRESH, &FAR_X, &root).is_err());
    assert!(f.gate.try_set_image_id(&BytesN::from_array(&env, &[0x11u8; 32])).is_err());
}

#[test]
fn test_admin_set_image_and_verifier() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let new_img = BytesN::from_array(&env, &[0x11u8; 32]);
    f.gate.set_image_id(&new_img);
    assert_eq!(f.gate.get_config().image_id, new_img);
    let new_verifier = Address::generate(&env);
    f.gate.set_verifier(&new_verifier);
    assert_eq!(f.gate.get_config().verifier, new_verifier);
}

#[test]
fn test_upgrade_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let attacker = Address::generate(&env);
    let bogus = BytesN::from_array(&env, &[9u8; 32]);
    let res = f.gate.try_upgrade(&bogus, &attacker);
    assert_eq!(res, Err(Ok(TierError::NotAdmin.into())));
}

#[test]
fn test_double_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let verifier_id = env.register(MockVerifier, ());
    let gate_id = env.register(TierGate, ());
    let gate = TierGateClient::new(&env, &gate_id);
    let image = BytesN::from_array(&env, &IMAGE);
    gate.initialize(&admin, &verifier_id, &image, &CLAIM_TYPE);
    let res = gate.try_initialize(&admin, &verifier_id, &image, &CLAIM_TYPE);
    assert_eq!(res, Err(Ok(TierError::AlreadyInitialized.into())));
}

/// A gate initialized + enrolled but WITHOUT mock_all_auths active (for the admin-auth negative test). We
/// register and initialize under a temporary mock so setup succeeds, then the caller tests with no auths.
fn setup_no_auth(env: &Env) -> Fixture<'static> {
    env.mock_all_auths();
    let f = setup(env);
    env.mock_auths(&[]);
    f
}
