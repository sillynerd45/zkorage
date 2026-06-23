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
const TOKEN: [u8; 32] = [0x7Au8; 32];
const NF1: [u8; 32] = [0xD1u8; 32];
const NF2: [u8; 32] = [0xD2u8; 32];
const ACC1: [u8; 32] = [0xE1u8; 32];
const ACC2: [u8; 32] = [0xE2u8; 32];
const IMAGE: [u8; 32] = [0xC0u8; 32];
const CLAIM_TYPE: u32 = 14;
const MIN_AMOUNT: i128 = 1_000_000_000; // 100 tokens @ 7 decimals
const DEADLINE: u64 = 9_000_000_000;

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

/// Compute req_id = sha256(token ‖ min_amount_be(16) ‖ deadline_be(8)) the same way the contract does.
fn req_id_of(env: &Env, token: &[u8; 32], min_amount: i128, deadline: u64) -> [u8; 32] {
    let mut buf = [0u8; 56];
    buf[0..32].copy_from_slice(token);
    buf[32..48].copy_from_slice(&min_amount.to_be_bytes());
    buf[48..56].copy_from_slice(&deadline.to_be_bytes());
    let h: BytesN<32> = env.crypto().sha256(&Bytes::from_array(env, &buf)).into();
    h.to_array()
}

#[allow(clippy::too_many_arguments)]
fn make_journal(
    env: &Env,
    result: u8,
    claim_type: u32,
    member_root: &[u8; 32],
    qual_root: &[u8; 32],
    token: &[u8; 32],
    min_amount: i128,
    deadline: u64,
    context: &[u8; 32],
    nullifier: &[u8; 32],
    accessor: &[u8; 32],
) -> Bytes {
    let mut a = [0u8; 221];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..37].copy_from_slice(member_root);
    a[37..69].copy_from_slice(qual_root);
    a[69..101].copy_from_slice(token);
    a[101..117].copy_from_slice(&min_amount.to_be_bytes());
    a[117..125].copy_from_slice(&deadline.to_be_bytes());
    a[125..157].copy_from_slice(context);
    a[157..189].copy_from_slice(nullifier);
    a[189..221].copy_from_slice(accessor);
    Bytes::from_array(env, &a)
}

struct Fixture<'a> {
    gate: BondGateClient<'a>,
    verifier: MockVerifierClient<'a>,
    image: BytesN<32>,
    seal: Bytes,
    req_id: [u8; 32],
}

/// Set up an initialized gate with one accepted qual root for the demo requirement (TOKEN, MIN_AMOUNT,
/// DEADLINE). The bond-gate does NOT pin a member root (it is generalized), so no set_member_root here.
fn setup(env: &Env) -> Fixture<'static> {
    let admin = Address::generate(env);
    let verifier_id = env.register(MockVerifier, ());
    let gate_id = env.register(BondGate, ());
    let gate = BondGateClient::new(env, &gate_id);
    let verifier = MockVerifierClient::new(env, &verifier_id);
    let image = BytesN::from_array(env, &IMAGE);
    gate.initialize(&admin, &verifier_id, &image, &CLAIM_TYPE);
    let req_id = req_id_of(env, &TOKEN, MIN_AMOUNT, DEADLINE);
    gate.set_qual_root(&BytesN::from_array(env, &req_id), &BytesN::from_array(env, &QUAL_ROOT));
    Fixture {
        gate,
        verifier,
        image,
        seal: Bytes::from_array(env, &[0u8; 4]),
        req_id,
    }
}

/// A well-formed journal for the demo requirement (context == req_id, as the gate enforces).
fn good_journal(env: &Env, f: &Fixture, nullifier: &[u8; 32], accessor: &[u8; 32]) -> Bytes {
    make_journal(
        env, 1, CLAIM_TYPE, &MEMBER_ROOT, &QUAL_ROOT, &TOKEN, MIN_AMOUNT, DEADLINE, &f.req_id,
        nullifier, accessor,
    )
}

fn b(env: &Env, a: &[u8; 32]) -> BytesN<32> {
    BytesN::from_array(env, a)
}

// ============================ HAPPY PATH ============================

#[test]
fn test_submit_happy_then_is_granted_for() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let req = b(&env, &f.req_id);

    assert!(!f.gate.is_granted_for(&b(&env, &ACC1), &req, &b(&env, &MEMBER_ROOT)));
    let g = f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF1, &ACC1));
    assert_eq!(g.accessor, b(&env, &ACC1));
    assert_eq!(g.req_id, req);
    assert_eq!(g.member_root, b(&env, &MEMBER_ROOT));
    assert_eq!(g.min_amount, MIN_AMOUNT);
    assert_eq!(g.deadline, DEADLINE);
    assert_eq!(g.index, 0);

    // bound to the right member_root -> granted; member-root-agnostic read also true
    assert!(f.gate.is_granted_for(&b(&env, &ACC1), &req, &b(&env, &MEMBER_ROOT)));
    assert!(f.gate.is_granted(&b(&env, &ACC1), &req));
    assert!(f.gate.is_nullifier_used(&b(&env, &NF1)));
    assert_eq!(f.gate.get_count(), 1);
}

#[test]
fn test_is_granted_for_wrong_member_root_rejected() {
    // The Option-A soundness property: a grant proven against MEMBER_ROOT does NOT admit when the relying
    // party (the DataRoom) supplies a DIFFERENT room eligible_root. The bond implies membership of THIS room
    // only, and re-pinning the room's root drops the grant.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let req = b(&env, &f.req_id);
    f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF1, &ACC1));
    assert!(f.gate.is_granted_for(&b(&env, &ACC1), &req, &b(&env, &MEMBER_ROOT)));
    // a different (rotated / foreign) member root -> not admitted
    assert!(!f.gate.is_granted_for(&b(&env, &ACC1), &req, &b(&env, &[0x99u8; 32])));
}

#[test]
fn test_three_anonymous_grants_unlinkable() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let req = b(&env, &f.req_id);
    let acc3 = [0xE3u8; 32];
    let nf3 = [0xD3u8; 32];
    f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF1, &ACC1));
    f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF2, &ACC2));
    f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &nf3, &acc3));
    assert!(f.gate.is_granted_for(&b(&env, &ACC1), &req, &b(&env, &MEMBER_ROOT)));
    assert!(f.gate.is_granted_for(&b(&env, &ACC2), &req, &b(&env, &MEMBER_ROOT)));
    assert!(f.gate.is_granted_for(&b(&env, &acc3), &req, &b(&env, &MEMBER_ROOT)));
    assert_eq!(f.gate.get_count(), 3);
}

#[test]
fn test_permissionless_submit() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    env.mock_auths(&[]); // no auths available
    let g = f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF1, &ACC1));
    assert_eq!(g.index, 0);
    assert!(f.gate.is_granted_for(&b(&env, &ACC1), &b(&env, &f.req_id), &b(&env, &MEMBER_ROOT)));
}

// ============================ PER-REQUIREMENT KEYING ============================

#[test]
fn test_different_requirement_distinct_grant() {
    // The SAME accessor proving TWO different requirements (different req_id) gets TWO independent grants;
    // a grant for one requirement does not satisfy the other.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);

    // a second requirement: higher min_amount -> a different req_id, with its own published qual root.
    let min2: i128 = MIN_AMOUNT * 5;
    let req2 = req_id_of(&env, &TOKEN, min2, DEADLINE);
    let qual2 = [0x5Bu8; 32];
    f.gate.set_qual_root(&b(&env, &req2), &b(&env, &qual2));

    f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF1, &ACC1));
    let j2 = make_journal(
        &env, 1, CLAIM_TYPE, &MEMBER_ROOT, &qual2, &TOKEN, min2, DEADLINE, &req2, &NF2, &ACC1,
    );
    f.gate.submit_bond_proof(&f.seal, &f.image, &j2);

    let mr = b(&env, &MEMBER_ROOT);
    assert!(f.gate.is_granted_for(&b(&env, &ACC1), &b(&env, &f.req_id), &mr));
    assert!(f.gate.is_granted_for(&b(&env, &ACC1), &b(&env, &req2), &mr));
    // the req1 grant does not satisfy req2's id and vice versa (distinct keys); a fresh accessor has neither.
    assert!(!f.gate.is_granted_for(&b(&env, &ACC2), &b(&env, &f.req_id), &mr));
    assert_eq!(f.gate.get_count(), 2);
}

// ============================ NULLIFIER (one grant per identity per requirement) ============================

#[test]
fn test_nullifier_reuse_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF1, &ACC1));
    let res = f
        .gate
        .try_submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF1, &ACC2));
    assert_eq!(res, Err(Ok(BondError::NullifierUsed)));
    assert_eq!(f.gate.get_count(), 1);
}

// ============================ CONTEXT BINDING ============================

#[test]
fn test_context_must_equal_req_id() {
    // A journal whose context is NOT the req_id is rejected (the nullifier must be bound to this requirement).
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let bad_ctx = [0x33u8; 32];
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &MEMBER_ROOT, &QUAL_ROOT, &TOKEN, MIN_AMOUNT, DEADLINE, &bad_ctx, &NF1, &ACC1,
    );
    let res = f.gate.try_submit_bond_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(BondError::ContextMismatch)));
}

// ============================ AMOUNT FLOOR ============================

#[test]
fn test_bad_min_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    // min_amount = 0 -> req_id differs, context set to match it, qual root published -> still rejected by floor.
    let req0 = req_id_of(&env, &TOKEN, 0, DEADLINE);
    f.gate.set_qual_root(&b(&env, &req0), &b(&env, &QUAL_ROOT));
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &MEMBER_ROOT, &QUAL_ROOT, &TOKEN, 0, DEADLINE, &req0, &NF1, &ACC1,
    );
    let res = f.gate.try_submit_bond_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(BondError::BadMinAmount)));
}

// ============================ FRESHNESS (deadline-encoded) ============================

#[test]
fn test_deadline_passed_rejected_on_submit() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(DEADLINE + 1); // now >= deadline
    let f = setup(&env);
    let res = f
        .gate
        .try_submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF1, &ACC1));
    assert_eq!(res, Err(Ok(BondError::DeadlinePassed)));
}

#[test]
fn test_is_granted_expires_at_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let dl = 2_000u64;
    let req = req_id_of(&env, &TOKEN, MIN_AMOUNT, dl);
    f.gate.set_qual_root(&b(&env, &req), &b(&env, &QUAL_ROOT));
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &MEMBER_ROOT, &QUAL_ROOT, &TOKEN, MIN_AMOUNT, dl, &req, &NF1, &ACC1,
    );
    f.gate.submit_bond_proof(&f.seal, &f.image, &j);
    let mr = b(&env, &MEMBER_ROOT);
    assert!(f.gate.is_granted_for(&b(&env, &ACC1), &b(&env, &req), &mr)); // 1000 < 2000
    env.ledger().set_timestamp(2_500); // past the deadline
    assert!(!f.gate.is_granted_for(&b(&env, &ACC1), &b(&env, &req), &mr));
}

// ============================ QUAL-ROOT BINDING / RING ============================

#[test]
fn test_qual_root_unknown() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &MEMBER_ROOT, &[0x77u8; 32], &TOKEN, MIN_AMOUNT, DEADLINE, &f.req_id, &NF1, &ACC1,
    );
    let res = f.gate.try_submit_bond_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(BondError::QualRootUnknown)));
}

#[test]
fn test_qual_root_wrong_requirement_rejected() {
    // The right root, but the journal describes a DIFFERENT requirement (min_amount) than the root was
    // published under. The recomputed req_id selects an empty ring -> unknown.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let min2 = MIN_AMOUNT + 1;
    let req2 = req_id_of(&env, &TOKEN, min2, DEADLINE);
    let j = make_journal(
        &env, 1, CLAIM_TYPE, &MEMBER_ROOT, &QUAL_ROOT, &TOKEN, min2, DEADLINE, &req2, &NF1, &ACC1,
    );
    let res = f.gate.try_submit_bond_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(BondError::QualRootUnknown)));
}

#[test]
fn test_qual_ring_accepts_recent_after_rotation() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env); // QUAL_ROOT (R1) already published for f.req_id
    let req = b(&env, &f.req_id);
    let r2 = [0x55u8; 32];
    f.gate.set_qual_root(&req, &b(&env, &r2));
    assert_eq!(f.gate.get_qual_ring(&req).len(), 2);
    // proof against R1 (older root) still verifies
    f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF1, &ACC1));
    // proof against R2 (new root) also verifies
    let j2 = make_journal(
        &env, 1, CLAIM_TYPE, &MEMBER_ROOT, &r2, &TOKEN, MIN_AMOUNT, DEADLINE, &f.req_id, &NF2, &ACC2,
    );
    f.gate.submit_bond_proof(&f.seal, &f.image, &j2);
}

#[test]
fn test_qual_ring_drops_oldest_beyond_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env); // ring already has 1 (QUAL_ROOT)
    let req = b(&env, &f.req_id);
    for i in 0..RING_CAP {
        let r = [0x10u8 + i as u8; 32];
        f.gate.set_qual_root(&req, &b(&env, &r));
    }
    assert_eq!(f.gate.get_qual_ring(&req).len(), RING_CAP);
    assert!(!f.gate.is_qual_root_accepted(&req, &b(&env, &QUAL_ROOT)));
    assert!(f.gate.is_qual_root_accepted(&req, &b(&env, &[0x10u8; 32])));
}

#[test]
fn test_set_qual_root_idempotent_head() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let req = b(&env, &f.req_id);
    f.gate.set_qual_root(&req, &b(&env, &QUAL_ROOT));
    f.gate.set_qual_root(&req, &b(&env, &QUAL_ROOT));
    assert_eq!(f.gate.get_qual_ring(&req).len(), 1);
}

// ============================ JOURNAL / PROOF NEGATIVES ============================

#[test]
fn test_image_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let wrong = BytesN::from_array(&env, &[0u8; 32]);
    let res = f.gate.try_submit_bond_proof(&f.seal, &wrong, &good_journal(&env, &f, &NF1, &ACC1));
    assert_eq!(res, Err(Ok(BondError::ImageMismatch)));
}

#[test]
fn test_malformed_journal() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let bad = Bytes::from_array(&env, &[1u8; 220]); // 220 != 221
    let res = f.gate.try_submit_bond_proof(&f.seal, &f.image, &bad);
    assert_eq!(res, Err(Ok(BondError::MalformedJournal)));
}

#[test]
fn test_proof_invalid() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    f.verifier.set_valid(&false);
    let res = f.gate.try_submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF1, &ACC1));
    assert_eq!(res, Err(Ok(BondError::ProofInvalid)));
}

#[test]
fn test_result_not_true() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let j = make_journal(
        &env, 0, CLAIM_TYPE, &MEMBER_ROOT, &QUAL_ROOT, &TOKEN, MIN_AMOUNT, DEADLINE, &f.req_id, &NF1, &ACC1,
    );
    let res = f.gate.try_submit_bond_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(BondError::ResultNotTrue)));
}

#[test]
fn test_claim_type_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    let j = make_journal(
        &env, 1, 13, &MEMBER_ROOT, &QUAL_ROOT, &TOKEN, MIN_AMOUNT, DEADLINE, &f.req_id, &NF1, &ACC1,
    );
    let res = f.gate.try_submit_bond_proof(&f.seal, &f.image, &j);
    assert_eq!(res, Err(Ok(BondError::ClaimTypeMismatch)));
}

// ============================ READS / HISTORY / ADMIN ============================

#[test]
fn test_reads_empty() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let req = b(&env, &f.req_id);
    assert!(!f.gate.is_granted_for(&b(&env, &ACC1), &req, &b(&env, &MEMBER_ROOT)));
    assert!(!f.gate.is_granted(&b(&env, &ACC1), &req));
    assert!(f.gate.get_grant(&b(&env, &ACC1), &req).is_none());
    assert!(f.gate.get_latest().is_none());
    assert_eq!(f.gate.get_count(), 0);
}

#[test]
fn test_history_paginates() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let f = setup(&env);
    f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF1, &ACC1));
    f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &NF2, &ACC2));
    let nf3 = [0xD3u8; 32];
    let acc3 = [0xE3u8; 32];
    f.gate.submit_bond_proof(&f.seal, &f.image, &good_journal(&env, &f, &nf3, &acc3));

    assert_eq!(f.gate.get_count(), 3);
    assert_eq!(f.gate.get_by_index(&0).unwrap().accessor, b(&env, &ACC1));
    assert_eq!(f.gate.get_by_index(&2).unwrap().accessor, b(&env, &acc3));
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
    let req = b(&env, &f.req_id);
    let root = b(&env, &QUAL_ROOT);
    assert!(f.gate.try_set_qual_root(&req, &root).is_err());
    assert!(f.gate.try_set_image_id(&b(&env, &[0x11u8; 32])).is_err());
    assert!(f.gate.try_set_verifier(&Address::generate(&env)).is_err());
}

#[test]
fn test_admin_set_image_and_verifier() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let new_img = b(&env, &[0x11u8; 32]);
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
    let bogus = b(&env, &[9u8; 32]);
    let res = f.gate.try_upgrade(&bogus, &attacker);
    assert_eq!(res, Err(Ok(BondError::NotAdmin.into())));
}

#[test]
fn test_double_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let verifier_id = env.register(MockVerifier, ());
    let gate_id = env.register(BondGate, ());
    let gate = BondGateClient::new(&env, &gate_id);
    let image = b(&env, &IMAGE);
    gate.initialize(&admin, &verifier_id, &image, &CLAIM_TYPE);
    let res = gate.try_initialize(&admin, &verifier_id, &image, &CLAIM_TYPE);
    assert_eq!(res, Err(Ok(BondError::AlreadyInitialized.into())));
}

/// A gate initialized + a qual root published but WITHOUT mock_all_auths active (for the admin-auth negative
/// test). We register/initialize under a temporary mock so setup succeeds, then the caller tests with no auths.
fn setup_no_auth(env: &Env) -> Fixture<'static> {
    env.mock_all_auths();
    let f = setup(env);
    env.mock_auths(&[]);
    f
}
