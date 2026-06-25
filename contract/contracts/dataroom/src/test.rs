#![cfg(test)]
use super::*;
use risc0_interface::VerifierError;
use soroban_sdk::{
    contract, contractimpl, symbol_short, testutils::Address as _, Address, Bytes, BytesN, Env,
};

const IMAGE: [u8; 32] = [0xABu8; 32];
const CLAIM_TYPE_DATAROOM: u32 = 8;
const ROOM: [u8; 32] = [0x01u8; 32];
const DOC: [u8; 32] = [0x09u8; 32];
const RECIPIENT: [u8; 32] = [0xADu8; 32];
const CONTENT: [u8; 32] = [0xC0u8; 32];

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

/// Build the 229-byte seal journal (matches the guest layout byte-for-byte).
fn make_journal(
    env: &Env,
    result: u8,
    claim_type: u32,
    room: &[u8; 32],
    doc: &[u8; 32],
) -> Bytes {
    let mut a = [0u8; 229];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..37].copy_from_slice(room);
    a[37..69].copy_from_slice(doc);
    a[69..101].copy_from_slice(&RECIPIENT);
    a[101..133].copy_from_slice(&CONTENT);
    a[133..165].copy_from_slice(&[0xE1u8; 32]); // eph_pub
    a[165..197].copy_from_slice(&[0xC2u8; 32]); // ct
    a[197..229].copy_from_slice(&[0x76u8; 32]); // tag
    Bytes::from_array(env, &a)
}

struct Fixture<'a> {
    dr: DataRoomClient<'a>,
    verifier: MockVerifierClient<'a>,
    image: BytesN<32>,
    seal: Bytes,
    admin: Address,
}

fn setup(env: &Env) -> Fixture<'static> {
    let admin = Address::generate(env);
    let verifier_id = env.register(MockVerifier, ());
    let dr_id = env.register(DataRoom, ());
    let dr = DataRoomClient::new(env, &dr_id);
    let verifier = MockVerifierClient::new(env, &verifier_id);
    let image = BytesN::from_array(env, &IMAGE);
    dr.initialize(&admin, &verifier_id, &image, &CLAIM_TYPE_DATAROOM);
    Fixture {
        dr,
        verifier,
        image,
        seal: Bytes::from_array(env, &[0u8; 4]),
        admin,
    }
}

#[test]
fn test_empty_state() {
    let env = Env::default();
    let f = setup(&env);
    assert_eq!(f.dr.get_room_count(), 0);
    let cfg = f.dr.get_config();
    assert_eq!(cfg.admin, f.admin);
    assert_eq!(cfg.claim_type, CLAIM_TYPE_DATAROOM);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // AlreadyInitialized
fn test_double_initialize() {
    let env = Env::default();
    let f = setup(&env);
    let other = Address::generate(&env);
    let verifier_id = Address::generate(&env);
    f.dr.initialize(&other, &verifier_id, &f.image, &CLAIM_TYPE_DATAROOM);
}

#[test]
fn test_create_room_and_read() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    let room_id = BytesN::from_array(&env, &ROOM);
    let room = f.dr.create_room(&owner, &room_id);
    assert_eq!(room.index, 0);
    assert_eq!(room.owner, owner);
    assert_eq!(f.dr.get_room_count(), 1);
    let got = f.dr.get_room(&room_id).unwrap();
    assert_eq!(got.owner, owner);
    assert_eq!(f.dr.get_doc_count(&room_id), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")] // RoomExists
fn test_duplicate_room_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    let room_id = BytesN::from_array(&env, &ROOM);
    f.dr.create_room(&owner, &room_id);
    f.dr.create_room(&owner, &room_id);
}

#[test]
fn test_two_rooms_increment_count() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    f.dr.create_room(&owner, &BytesN::from_array(&env, &ROOM));
    f.dr.create_room(&owner, &BytesN::from_array(&env, &[0x02u8; 32]));
    assert_eq!(f.dr.get_room_count(), 2);
}

#[test]
fn test_admin_set_verifier_and_image() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let new_verifier = Address::generate(&env);
    let new_image = BytesN::from_array(&env, &[0xCDu8; 32]);
    f.dr.set_verifier(&new_verifier);
    f.dr.set_image_id(&new_image);
    let cfg = f.dr.get_config();
    assert_eq!(cfg.verifier, new_verifier);
    assert_eq!(cfg.seal_image_id, new_image);
}

// ---- put_document ----

fn create_default_room(env: &Env, f: &Fixture) {
    let owner = Address::generate(env);
    f.dr.create_room(&owner, &BytesN::from_array(env, &ROOM));
}

#[test]
fn test_put_document_happy() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let journal = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    let doc = f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"r2://k1"));
    assert_eq!(doc.index, 0);
    assert_eq!(doc.recipient_pub, BytesN::from_array(&env, &RECIPIENT));
    assert_eq!(doc.content_hash, BytesN::from_array(&env, &CONTENT));

    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    assert_eq!(f.dr.get_doc_count(&room_id), 1);
    let got = f.dr.get_document(&room_id, &doc_id).unwrap();
    assert_eq!(got.content_hash, BytesN::from_array(&env, &CONTENT));
    assert_eq!(got.blob_pointer, Bytes::from_slice(&env, b"r2://k1"));
    let by_idx = f.dr.get_doc_by_index(&room_id, &0).unwrap();
    assert_eq!(by_idx.doc_id, doc_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // ImageMismatch
fn test_put_document_image_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let journal = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    let wrong = BytesN::from_array(&env, &[0xFFu8; 32]);
    f.dr.put_document(&f.seal, &wrong, &journal, &Bytes::from_slice(&env, b"x"));
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // MalformedJournal
fn test_put_document_malformed_journal() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let bad = Bytes::from_array(&env, &[1u8; 100]);
    f.dr.put_document(&f.seal, &f.image, &bad, &Bytes::from_slice(&env, b"x"));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // ProofInvalid
fn test_put_document_proof_invalid() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    f.verifier.set_valid(&false);
    create_default_room(&env, &f);
    let journal = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"x"));
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // ResultNotTrue
fn test_put_document_result_not_true() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let journal = make_journal(&env, 0, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"x"));
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")] // ClaimTypeMismatch
fn test_put_document_claim_type_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let journal = make_journal(&env, 1, 99, &ROOM, &DOC);
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"x"));
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // RoomNotFound
fn test_put_document_room_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    // no room created
    let journal = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"x"));
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")] // DocExists
fn test_put_document_duplicate_doc() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let journal = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"k1"));
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"k2"));
}

#[test]
fn test_two_documents_increment_and_enumerate() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let j0 = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &[0x09u8; 32]);
    let j1 = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &[0x0Au8; 32]);
    f.dr.put_document(&f.seal, &f.image, &j0, &Bytes::from_slice(&env, b"k0"));
    f.dr.put_document(&f.seal, &f.image, &j1, &Bytes::from_slice(&env, b"k1"));
    let room_id = BytesN::from_array(&env, &ROOM);
    assert_eq!(f.dr.get_doc_count(&room_id), 2);
    assert_eq!(f.dr.get_doc_by_index(&room_id, &1).unwrap().index, 1);
}

/// The single most security-critical check in `put_document`: only the ROOM OWNER may anchor a document
/// (`room.owner.require_auth()`). `mock_all_auths` auto-approves every auth, so the other put_document
/// tests can't catch a regression that dropped or misplaced that binding — here we assert (via
/// `env.auths()`) that anchoring actually REQUIRED the room owner's authorization. A binding that was
/// dropped (no auth) or misplaced (a different address) would make this assertion fail.
#[test]
fn test_put_document_requires_room_owner_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    f.dr.create_room(&owner, &BytesN::from_array(&env, &ROOM));
    let journal = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"k"));
    let auths = env.auths();
    assert!(
        auths.iter().any(|entry| entry.0 == owner),
        "put_document must require the room owner's auth; got {:?}",
        auths,
    );
}

// ---- DR2: anonymous eligibility (membership + nullifier) ----

const MEMBERSHIP_IMAGE: [u8; 32] = [0xB2u8; 32];
const CLAIM_TYPE_MEMBERSHIP_T: u32 = 9;
const ELIG_ROOT: [u8; 32] = [0x7Eu8; 32];
const NULL1: [u8; 32] = [0x4Eu8; 32];
const ACCESSOR1: [u8; 32] = [0xA1u8; 32];
const ACCESSOR2: [u8; 32] = [0xA2u8; 32];

/// Build the 165-byte membership journal (matches the guest layout byte-for-byte).
fn make_membership_journal(
    env: &Env,
    result: u8,
    claim_type: u32,
    room: &[u8; 32],
    root: &[u8; 32],
    nullifier: &[u8; 32],
    accessor: &[u8; 32],
) -> Bytes {
    let mut a = [0u8; 165];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..37].copy_from_slice(room);
    a[37..69].copy_from_slice(root);
    a[69..101].copy_from_slice(nullifier);
    a[101..133].copy_from_slice(accessor);
    a[133..165].copy_from_slice(&RECIPIENT);
    Bytes::from_array(env, &a)
}

/// Membership image (BytesN). Set it + create a room owned by a fresh owner + pin the eligible root.
fn setup_membership(env: &Env, f: &Fixture) -> (BytesN<32>, Address) {
    let mem_image = BytesN::from_array(env, &MEMBERSHIP_IMAGE);
    f.dr.set_membership_image_id(&mem_image);
    let owner = Address::generate(env);
    f.dr.create_room(&owner, &BytesN::from_array(env, &ROOM));
    f.dr
        .set_eligible_root(&BytesN::from_array(env, &ROOM), &BytesN::from_array(env, &ELIG_ROOT));
    (mem_image, owner)
}

#[test]
fn test_membership_happy_grant() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (mem_image, _) = setup_membership(&env, &f);
    let j = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    let grant = f.dr.request_access(&f.seal, &mem_image, &j);
    assert_eq!(grant.index, 0);
    assert_eq!(grant.accessor, BytesN::from_array(&env, &ACCESSOR1));
    assert_eq!(grant.recipient_pub, BytesN::from_array(&env, &RECIPIENT));
    assert_eq!(grant.eligible_root, BytesN::from_array(&env, &ELIG_ROOT));
    assert_eq!(grant.nullifier, BytesN::from_array(&env, &NULL1));

    let room_id = BytesN::from_array(&env, &ROOM);
    assert!(f.dr.is_granted(&room_id, &BytesN::from_array(&env, &ACCESSOR1)));
    assert!(f.dr.is_nullifier_used(&room_id, &BytesN::from_array(&env, &NULL1)));
    assert_eq!(f.dr.get_grant_count(&room_id), 1);
    assert_eq!(
        f.dr.get_grant_by_index(&room_id, &0).unwrap().accessor,
        BytesN::from_array(&env, &ACCESSOR1)
    );
}

/// THE marquee DR2 acceptance: two accessors from ONE credential (same nullifier) → first granted,
/// second `#NullifierUsed`. (Same NULL1, different accessor — exactly what a sybil attempt looks like.)
#[test]
#[should_panic(expected = "Error(Contract, #15)")] // NullifierUsed
fn test_membership_nullifier_reuse_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (mem_image, _) = setup_membership(&env, &f);
    let j1 = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &mem_image, &j1);
    // Same nullifier, DIFFERENT accessor → must be rejected.
    let j2 = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR2);
    f.dr.request_access(&f.seal, &mem_image, &j2);
}

/// A different identity (different nullifier) in the same room is granted independently.
#[test]
fn test_membership_different_nullifier_grants() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (mem_image, _) = setup_membership(&env, &f);
    let j1 = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &mem_image, &j1);
    let null2 = [0x4Fu8; 32];
    let j2 = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &null2, &ACCESSOR2);
    f.dr.request_access(&f.seal, &mem_image, &j2);
    let room_id = BytesN::from_array(&env, &ROOM);
    assert_eq!(f.dr.get_grant_count(&room_id), 2);
    assert!(f.dr.is_granted(&room_id, &BytesN::from_array(&env, &ACCESSOR2)));
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // ImageMismatch (wrong image)
fn test_membership_image_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    setup_membership(&env, &f);
    let wrong = BytesN::from_array(&env, &[0xFFu8; 32]);
    let j = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &wrong, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // ImageMismatch (membership image never pinned → fail-closed)
fn test_membership_not_enabled_rejects() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    // create room + eligible root but do NOT set_membership_image_id.
    let owner = Address::generate(&env);
    f.dr.create_room(&owner, &BytesN::from_array(&env, &ROOM));
    f.dr.set_eligible_root(&BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &ELIG_ROOT));
    let mem_image = BytesN::from_array(&env, &MEMBERSHIP_IMAGE);
    let j = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &mem_image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // MalformedJournal
fn test_membership_malformed_journal() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (mem_image, _) = setup_membership(&env, &f);
    let bad = Bytes::from_array(&env, &[1u8; 100]);
    f.dr.request_access(&f.seal, &mem_image, &bad);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // ProofInvalid
fn test_membership_proof_invalid() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    f.verifier.set_valid(&false);
    let (mem_image, _) = setup_membership(&env, &f);
    let j = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &mem_image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // ResultNotTrue
fn test_membership_result_not_true() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (mem_image, _) = setup_membership(&env, &f);
    let j = make_membership_journal(&env, 0, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &mem_image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")] // ClaimTypeMismatch
fn test_membership_claim_type_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (mem_image, _) = setup_membership(&env, &f);
    let j = make_membership_journal(&env, 1, 8, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1); // claim_type 8 (seal), not 9
    f.dr.request_access(&f.seal, &mem_image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // RoomNotFound
fn test_membership_room_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let mem_image = BytesN::from_array(&env, &MEMBERSHIP_IMAGE);
    f.dr.set_membership_image_id(&mem_image);
    // no room created
    let j = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &mem_image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")] // EligibleRootNotSet
fn test_membership_root_not_set() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let mem_image = BytesN::from_array(&env, &MEMBERSHIP_IMAGE);
    f.dr.set_membership_image_id(&mem_image);
    let owner = Address::generate(&env);
    f.dr.create_room(&owner, &BytesN::from_array(&env, &ROOM)); // room exists but no eligible root pinned
    let j = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &mem_image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #16)")] // EligibleRootMismatch
fn test_membership_root_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (mem_image, _) = setup_membership(&env, &f);
    let stale_root = [0x99u8; 32]; // proof checked a different root than the one pinned
    let j = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &stale_root, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &mem_image, &j);
}

/// Re-pinning the eligible root revokes a stale grant: `is_granted` flips to false because the grant was
/// proven against a now-stale root (the membership-revocation story). NOTE: re-granting requires a NEW
/// proof against the NEW root — and since `nullifier = sha256(0x02 ‖ id_secret ‖ room_id)` does NOT depend
/// on the root, a member who already spent their nullifier in this room CANNOT be re-granted here (they'd
/// hit `#NullifierUsed`); only a DIFFERENT identity, or a future epoch'd `external_nullifier`, re-grants.
#[test]
fn test_membership_root_rotation_revokes() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (mem_image, _) = setup_membership(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let j = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &mem_image, &j);
    assert!(f.dr.is_granted(&room_id, &BytesN::from_array(&env, &ACCESSOR1)));
    // rotate the eligible set → the old grant is revoked (proven against a now-stale root).
    let new_root = [0x7Fu8; 32];
    f.dr.set_eligible_root(&room_id, &BytesN::from_array(&env, &new_root));
    assert!(!f.dr.is_granted(&room_id, &BytesN::from_array(&env, &ACCESSOR1)));
    // the raw grant is still stored (audit), but is_granted is the live decision.
    assert!(f.dr.get_grant(&room_id, &BytesN::from_array(&env, &ACCESSOR1)).is_some());
}

/// `set_eligible_root` must require the ROOM OWNER's auth (mock_all_auths masks it in the happy path).
#[test]
fn test_set_eligible_root_requires_owner_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let mem_image = BytesN::from_array(&env, &MEMBERSHIP_IMAGE);
    f.dr.set_membership_image_id(&mem_image);
    let owner = Address::generate(&env);
    let room_id = BytesN::from_array(&env, &ROOM);
    f.dr.create_room(&owner, &room_id);
    f.dr.set_eligible_root(&room_id, &BytesN::from_array(&env, &ELIG_ROOT));
    let auths = env.auths();
    assert!(
        auths.iter().any(|entry| entry.0 == owner),
        "set_eligible_root must require the room owner's auth; got {:?}",
        auths,
    );
}

/// `set_membership_image_id` must require the ADMIN's auth.
#[test]
fn test_set_membership_image_requires_admin_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let mem_image = BytesN::from_array(&env, &MEMBERSHIP_IMAGE);
    f.dr.set_membership_image_id(&mem_image);
    // Capture auths from the set call BEFORE any read (a read would reset env.auths()).
    let auths = env.auths();
    assert!(
        auths.iter().any(|entry| entry.0 == f.admin),
        "set_membership_image_id must require the admin's auth; got {:?}",
        auths,
    );
    assert_eq!(f.dr.get_membership_image_id().unwrap(), mem_image);
}

// ---- DR3: threshold-ECIES committee documents ----

const KCOMMIT: [u8; 32] = [0x4Bu8; 32];

#[test]
fn test_committee_doc_happy() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let doc = f.dr.put_committee_document(
        &room_id,
        &doc_id,
        &BytesN::from_array(&env, &CONTENT),
        &BytesN::from_array(&env, &KCOMMIT),
        &Bytes::from_slice(&env, b"r2://committee-blob"),
    );
    assert_eq!(doc.index, 0);
    assert_eq!(doc.content_hash, BytesN::from_array(&env, &CONTENT));
    assert_eq!(doc.k_commitment, BytesN::from_array(&env, &KCOMMIT));

    assert_eq!(f.dr.get_committee_doc_count(&room_id), 1);
    let got = f.dr.get_committee_document(&room_id, &doc_id).unwrap();
    assert_eq!(got.k_commitment, BytesN::from_array(&env, &KCOMMIT));
    assert_eq!(got.blob_pointer, Bytes::from_slice(&env, b"r2://committee-blob"));
    let by_idx = f.dr.get_committee_doc_by_index(&room_id, &0).unwrap();
    assert_eq!(by_idx.doc_id, doc_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // RoomNotFound
fn test_committee_doc_room_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    // no room created
    f.dr.put_committee_document(
        &BytesN::from_array(&env, &ROOM),
        &BytesN::from_array(&env, &DOC),
        &BytesN::from_array(&env, &CONTENT),
        &BytesN::from_array(&env, &KCOMMIT),
        &Bytes::from_slice(&env, b"x"),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")] // DocExists
fn test_committee_doc_duplicate_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    f.dr.put_committee_document(&room_id, &doc_id, &BytesN::from_array(&env, &CONTENT), &BytesN::from_array(&env, &KCOMMIT), &Bytes::from_slice(&env, b"k1"));
    f.dr.put_committee_document(&room_id, &doc_id, &BytesN::from_array(&env, &CONTENT), &BytesN::from_array(&env, &KCOMMIT), &Bytes::from_slice(&env, b"k2"));
}

#[test]
fn test_two_committee_docs_increment_and_enumerate() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    f.dr.put_committee_document(&room_id, &BytesN::from_array(&env, &[0x09u8; 32]), &BytesN::from_array(&env, &CONTENT), &BytesN::from_array(&env, &KCOMMIT), &Bytes::from_slice(&env, b"k0"));
    f.dr.put_committee_document(&room_id, &BytesN::from_array(&env, &[0x0Au8; 32]), &BytesN::from_array(&env, &CONTENT), &BytesN::from_array(&env, &KCOMMIT), &Bytes::from_slice(&env, b"k1"));
    assert_eq!(f.dr.get_committee_doc_count(&room_id), 2);
    assert_eq!(f.dr.get_committee_doc_by_index(&room_id, &1).unwrap().index, 1);
}

/// A committee doc and a DR1 (single-recipient) doc may share a doc_id in the same room — separate keyspaces.
#[test]
fn test_committee_doc_coexists_with_dr1_doc() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    // DR1 doc with this doc_id…
    let journal = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"dr1"));
    // …and a committee doc with the SAME doc_id — both must exist independently.
    f.dr.put_committee_document(&room_id, &doc_id, &BytesN::from_array(&env, &CONTENT), &BytesN::from_array(&env, &KCOMMIT), &Bytes::from_slice(&env, b"committee"));
    assert!(f.dr.get_document(&room_id, &doc_id).is_some());
    assert!(f.dr.get_committee_document(&room_id, &doc_id).is_some());
    assert_eq!(f.dr.get_doc_count(&room_id), 1);
    assert_eq!(f.dr.get_committee_doc_count(&room_id), 1);
}

/// `put_committee_document` must require the ROOM OWNER's auth (mock_all_auths masks it in the happy path).
#[test]
fn test_committee_doc_requires_room_owner_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    let room_id = BytesN::from_array(&env, &ROOM);
    f.dr.create_room(&owner, &room_id);
    f.dr.put_committee_document(
        &room_id,
        &BytesN::from_array(&env, &DOC),
        &BytesN::from_array(&env, &CONTENT),
        &BytesN::from_array(&env, &KCOMMIT),
        &Bytes::from_slice(&env, b"k"),
    );
    let auths = env.auths();
    assert!(
        auths.iter().any(|entry| entry.0 == owner),
        "put_committee_document must require the room owner's auth; got {:?}",
        auths,
    );
}

// ---- DR4: document-authenticity (signed-PDF / zkPDF fact) ----

const DOCAUTH_IMAGE: [u8; 32] = [0xD4u8; 32];
const CLAIM_TYPE_DOCAUTH_T: u32 = 10;
const FIELD_TAG_BALANCE: u32 = 1;
const THRESHOLD_X: u64 = 1_000_000;
const ISSUER_HASH: [u8; 32] = [0x1Bu8; 32];
const MSG_DIGEST: [u8; 32] = [0x3Du8; 32];

/// Build the 113-byte docauth journal (matches the guest layout byte-for-byte).
#[allow(clippy::too_many_arguments)]
fn make_docauth_journal(
    env: &Env,
    result: u8,
    claim_type: u32,
    field_tag: u32,
    threshold: u64,
    issuer_hash: &[u8; 32],
    room: &[u8; 32],
    msg_digest: &[u8; 32],
) -> Bytes {
    let mut a = [0u8; 113];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..9].copy_from_slice(&field_tag.to_be_bytes());
    a[9..17].copy_from_slice(&threshold.to_be_bytes());
    a[17..49].copy_from_slice(issuer_hash);
    a[49..81].copy_from_slice(room);
    a[81..113].copy_from_slice(msg_digest);
    Bytes::from_array(env, &a)
}

/// Pin the docauth image, create a room owned by a fresh owner, and allowlist the demo issuer key hash.
fn setup_docauth(env: &Env, f: &Fixture) -> (BytesN<32>, Address) {
    let image = BytesN::from_array(env, &DOCAUTH_IMAGE);
    f.dr.set_docauth_image_id(&image);
    let owner = Address::generate(env);
    f.dr.create_room(&owner, &BytesN::from_array(env, &ROOM));
    f.dr
        .set_docauth_issuer(&BytesN::from_array(env, &ISSUER_HASH), &true);
    (image, owner)
}

#[test]
fn test_docauth_happy() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_docauth(&env, &f);
    let j = make_docauth_journal(
        &env, 1, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &MSG_DIGEST,
    );
    let fact = f.dr.attest_document_fact(&f.seal, &image, &j);
    assert_eq!(fact.index, 0);
    assert_eq!(fact.field_tag, FIELD_TAG_BALANCE);
    assert_eq!(fact.threshold, THRESHOLD_X);
    assert_eq!(fact.issuer_key_hash, BytesN::from_array(&env, &ISSUER_HASH));
    assert_eq!(fact.msg_digest, BytesN::from_array(&env, &MSG_DIGEST));

    let room_id = BytesN::from_array(&env, &ROOM);
    let md = BytesN::from_array(&env, &MSG_DIGEST);
    assert_eq!(f.dr.get_doc_fact_count(&room_id), 1);
    let got = f.dr.get_document_fact(&room_id, &md).unwrap();
    assert_eq!(got.threshold, THRESHOLD_X);
    assert_eq!(f.dr.get_doc_fact_by_index(&room_id, &0).unwrap().msg_digest, md);
    assert!(f.dr.is_docauth_issuer_allowed(&BytesN::from_array(&env, &ISSUER_HASH)));
}

/// THE marquee DR4 soundness check: a fact signed by a NON-allowlisted issuer (a self-minted RSA key) is
/// rejected — this is what makes it "third-party truth" rather than the uploader's word.
#[test]
#[should_panic(expected = "Error(Contract, #8)")] // IssuerNotAllowed
fn test_docauth_issuer_not_allowed() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let image = BytesN::from_array(&env, &DOCAUTH_IMAGE);
    f.dr.set_docauth_image_id(&image);
    let owner = Address::generate(&env);
    f.dr.create_room(&owner, &BytesN::from_array(&env, &ROOM));
    // NOTE: issuer NOT allowlisted.
    let j = make_docauth_journal(
        &env, 1, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &MSG_DIGEST,
    );
    f.dr.attest_document_fact(&f.seal, &image, &j);
}

/// Removing an allowlisted issuer revokes FUTURE attestations from it.
#[test]
#[should_panic(expected = "Error(Contract, #8)")] // IssuerNotAllowed after removal
fn test_docauth_issuer_removal_revokes() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_docauth(&env, &f);
    let issuer = BytesN::from_array(&env, &ISSUER_HASH);
    f.dr.set_docauth_issuer(&issuer, &false); // remove
    assert!(!f.dr.is_docauth_issuer_allowed(&issuer));
    let j = make_docauth_journal(
        &env, 1, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &MSG_DIGEST,
    );
    f.dr.attest_document_fact(&f.seal, &image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #18)")] // DocFactExists
fn test_docauth_duplicate_fact_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_docauth(&env, &f);
    let j = make_docauth_journal(
        &env, 1, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &MSG_DIGEST,
    );
    f.dr.attest_document_fact(&f.seal, &image, &j);
    // same (room, msg_digest) → one canonical fact per doc.
    f.dr.attest_document_fact(&f.seal, &image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // ImageMismatch (wrong image)
fn test_docauth_image_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    setup_docauth(&env, &f);
    let wrong = BytesN::from_array(&env, &[0xFFu8; 32]);
    let j = make_docauth_journal(
        &env, 1, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &MSG_DIGEST,
    );
    f.dr.attest_document_fact(&f.seal, &wrong, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // ImageMismatch (docauth image never pinned → fail-closed)
fn test_docauth_not_enabled_rejects() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    f.dr.create_room(&owner, &BytesN::from_array(&env, &ROOM));
    f.dr.set_docauth_issuer(&BytesN::from_array(&env, &ISSUER_HASH), &true);
    let image = BytesN::from_array(&env, &DOCAUTH_IMAGE); // never pinned via set_docauth_image_id
    let j = make_docauth_journal(
        &env, 1, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &MSG_DIGEST,
    );
    f.dr.attest_document_fact(&f.seal, &image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // MalformedJournal
fn test_docauth_malformed_journal() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_docauth(&env, &f);
    let bad = Bytes::from_array(&env, &[1u8; 100]);
    f.dr.attest_document_fact(&f.seal, &image, &bad);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // ProofInvalid
fn test_docauth_proof_invalid() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    f.verifier.set_valid(&false);
    let (image, _) = setup_docauth(&env, &f);
    let j = make_docauth_journal(
        &env, 1, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &MSG_DIGEST,
    );
    f.dr.attest_document_fact(&f.seal, &image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // ResultNotTrue
fn test_docauth_result_not_true() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_docauth(&env, &f);
    let j = make_docauth_journal(
        &env, 0, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &MSG_DIGEST,
    );
    f.dr.attest_document_fact(&f.seal, &image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")] // ClaimTypeMismatch
fn test_docauth_claim_type_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_docauth(&env, &f);
    let j = make_docauth_journal(
        &env, 1, 9, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &MSG_DIGEST, // claim_type 9 (membership), not 10
    );
    f.dr.attest_document_fact(&f.seal, &image, &j);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // RoomNotFound
fn test_docauth_room_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let image = BytesN::from_array(&env, &DOCAUTH_IMAGE);
    f.dr.set_docauth_image_id(&image);
    // no room created
    let j = make_docauth_journal(
        &env, 1, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &MSG_DIGEST,
    );
    f.dr.attest_document_fact(&f.seal, &image, &j);
}

#[test]
fn test_two_docauth_facts_increment_and_enumerate() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_docauth(&env, &f);
    let j0 = make_docauth_journal(
        &env, 1, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &[0x3Du8; 32],
    );
    let j1 = make_docauth_journal(
        &env, 1, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, 2_000_000, &ISSUER_HASH, &ROOM, &[0x3Eu8; 32],
    );
    f.dr.attest_document_fact(&f.seal, &image, &j0);
    f.dr.attest_document_fact(&f.seal, &image, &j1);
    let room_id = BytesN::from_array(&env, &ROOM);
    assert_eq!(f.dr.get_doc_fact_count(&room_id), 2);
    assert_eq!(f.dr.get_doc_fact_by_index(&room_id, &1).unwrap().threshold, 2_000_000);
}

/// `attest_document_fact` must require the ROOM OWNER's auth (mock_all_auths masks it in the happy path).
#[test]
fn test_docauth_requires_room_owner_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let image = BytesN::from_array(&env, &DOCAUTH_IMAGE);
    f.dr.set_docauth_image_id(&image);
    f.dr.set_docauth_issuer(&BytesN::from_array(&env, &ISSUER_HASH), &true);
    let owner = Address::generate(&env);
    f.dr.create_room(&owner, &BytesN::from_array(&env, &ROOM));
    let j = make_docauth_journal(
        &env, 1, CLAIM_TYPE_DOCAUTH_T, FIELD_TAG_BALANCE, THRESHOLD_X, &ISSUER_HASH, &ROOM, &MSG_DIGEST,
    );
    f.dr.attest_document_fact(&f.seal, &image, &j);
    let auths = env.auths();
    assert!(
        auths.iter().any(|entry| entry.0 == owner),
        "attest_document_fact must require the room owner's auth; got {:?}",
        auths,
    );
}

/// `set_docauth_image_id` and `set_docauth_issuer` must require the ADMIN's auth.
#[test]
fn test_set_docauth_admin_methods_require_admin_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let image = BytesN::from_array(&env, &DOCAUTH_IMAGE);
    f.dr.set_docauth_image_id(&image);
    let auths1 = env.auths();
    assert!(
        auths1.iter().any(|entry| entry.0 == f.admin),
        "set_docauth_image_id must require the admin's auth; got {:?}",
        auths1,
    );
    f.dr.set_docauth_issuer(&BytesN::from_array(&env, &ISSUER_HASH), &true);
    let auths2 = env.auths();
    assert!(
        auths2.iter().any(|entry| entry.0 == f.admin),
        "set_docauth_issuer must require the admin's auth; got {:?}",
        auths2,
    );
    assert_eq!(f.dr.get_docauth_image_id().unwrap(), image);
}

// ---- DR5: faithful disclosure / data-side teaser ----

const TEASER_IMAGE: [u8; 32] = [0x55u8; 32];
const CLAIM_TYPE_TEASER_T: u32 = 11;
const TEASER_ATTESTER: [u8; 32] = [0xA9u8; 32];
const FIELD_TAG_REVENUE: u32 = 1;
const TEASER_THRESHOLD: u64 = 1_000_000;
const TEASER_EXPIRY: u64 = 4_000_000_000; // far future (env.ledger().timestamp() defaults to 0 in tests)

/// Build the 61-byte teaser journal (== the generic value≥threshold guest layout, byte-for-byte). The
/// attester signs `nonce = field_tag` (low 32 bits), so the field semantics are attester-vouched.
fn make_teaser_journal(
    env: &Env,
    result: u8,
    claim_type: u32,
    attester: &[u8; 32],
    threshold: u64,
    field_tag: u32,
    expiry: u64,
) -> Bytes {
    let mut a = [0u8; 61];
    a[0] = result;
    a[1..5].copy_from_slice(&claim_type.to_be_bytes());
    a[5..37].copy_from_slice(attester);
    a[37..45].copy_from_slice(&threshold.to_be_bytes());
    let nonce: u64 = field_tag as u64;
    a[45..53].copy_from_slice(&nonce.to_be_bytes());
    a[53..61].copy_from_slice(&expiry.to_be_bytes());
    Bytes::from_array(env, &a)
}

/// Pin the teaser image, create a room (fresh owner), anchor the sealed DR1 document the teaser is about,
/// and allowlist the appraiser attester. Returns (teaser_image, owner).
fn setup_teaser(env: &Env, f: &Fixture) -> (BytesN<32>, Address) {
    let image = BytesN::from_array(env, &TEASER_IMAGE);
    f.dr.set_teaser_image_id(&image);
    let owner = Address::generate(env);
    f.dr.create_room(&owner, &BytesN::from_array(env, &ROOM));
    // anchor the sealed document the teaser advertises (its content_hash is bound into the teaser).
    let journal = make_journal(env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(env, b"r2://full"));
    f.dr.set_teaser_attester(&BytesN::from_array(env, &TEASER_ATTESTER), &true);
    (image, owner)
}

#[test]
fn test_teaser_happy() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_teaser(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    let t = f.dr.attest_teaser(&f.seal, &image, &j, &room_id, &doc_id);
    assert_eq!(t.index, 0);
    assert_eq!(t.field_tag, FIELD_TAG_REVENUE);
    assert_eq!(t.threshold, TEASER_THRESHOLD);
    assert_eq!(t.attester, BytesN::from_array(&env, &TEASER_ATTESTER));
    assert_eq!(t.expiry, TEASER_EXPIRY);
    // the teaser is bound to the anchored document's content_hash (the "released blob hash").
    assert_eq!(t.content_hash, BytesN::from_array(&env, &CONTENT));

    assert_eq!(f.dr.get_teaser_count(&room_id), 1);
    let got = f.dr.get_teaser(&room_id, &doc_id).unwrap();
    assert_eq!(got.threshold, TEASER_THRESHOLD);
    assert_eq!(f.dr.get_teaser_by_index(&room_id, &0).unwrap().doc_id, doc_id);
    assert!(f.dr.is_teaser_valid(&room_id, &doc_id));
    assert!(f.dr.is_teaser_attester_allowed(&BytesN::from_array(&env, &TEASER_ATTESTER)));
}

/// THE marquee DR5 soundness check: a teaser vouched by a NON-allowlisted attester (a self-minted key) is
/// rejected — this is what makes the public fact "appraiser truth" rather than the owner's word.
#[test]
#[should_panic(expected = "Error(Contract, #8)")] // IssuerNotAllowed
fn test_teaser_attester_not_allowed() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let image = BytesN::from_array(&env, &TEASER_IMAGE);
    f.dr.set_teaser_image_id(&image);
    let owner = Address::generate(&env);
    f.dr.create_room(&owner, &BytesN::from_array(&env, &ROOM));
    let journal = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"r2://full"));
    // NOTE: attester NOT allowlisted.
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    f.dr.attest_teaser(&f.seal, &image, &j, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
}

/// Removing an allowlisted appraiser revokes FUTURE teasers from it.
#[test]
#[should_panic(expected = "Error(Contract, #8)")] // IssuerNotAllowed after removal
fn test_teaser_attester_removal_revokes() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_teaser(&env, &f);
    let attester = BytesN::from_array(&env, &TEASER_ATTESTER);
    f.dr.set_teaser_attester(&attester, &false); // remove
    assert!(!f.dr.is_teaser_attester_allowed(&attester));
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    f.dr.attest_teaser(&f.seal, &image, &j, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
}

#[test]
#[should_panic(expected = "Error(Contract, #19)")] // TeaserExists
fn test_teaser_duplicate_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_teaser(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    f.dr.attest_teaser(&f.seal, &image, &j, &room_id, &doc_id);
    // same (room, doc) → one teaser per document.
    f.dr.attest_teaser(&f.seal, &image, &j, &room_id, &doc_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #20)")] // DocNotFound (teaser references a non-anchored doc)
fn test_teaser_doc_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let image = BytesN::from_array(&env, &TEASER_IMAGE);
    f.dr.set_teaser_image_id(&image);
    let owner = Address::generate(&env);
    f.dr.create_room(&owner, &BytesN::from_array(&env, &ROOM));
    f.dr.set_teaser_attester(&BytesN::from_array(&env, &TEASER_ATTESTER), &true);
    // room exists + attester allowlisted, but NO document anchored under DOC.
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    f.dr.attest_teaser(&f.seal, &image, &j, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")] // Expired
fn test_teaser_expired_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_teaser(&env, &f);
    // expiry 0 ≤ ledger timestamp (0) → rejected as expired.
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, 0,
    );
    f.dr.attest_teaser(&f.seal, &image, &j, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // ImageMismatch (wrong image)
fn test_teaser_image_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    setup_teaser(&env, &f);
    let wrong = BytesN::from_array(&env, &[0xFFu8; 32]);
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    f.dr.attest_teaser(&f.seal, &wrong, &j, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // ImageMismatch (teaser image never pinned → fail-closed)
fn test_teaser_not_enabled_rejects() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    f.dr.create_room(&owner, &BytesN::from_array(&env, &ROOM));
    let journal = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"r2://full"));
    f.dr.set_teaser_attester(&BytesN::from_array(&env, &TEASER_ATTESTER), &true);
    let image = BytesN::from_array(&env, &TEASER_IMAGE); // never pinned via set_teaser_image_id
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    f.dr.attest_teaser(&f.seal, &image, &j, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // MalformedJournal
fn test_teaser_malformed_journal() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_teaser(&env, &f);
    let bad = Bytes::from_array(&env, &[1u8; 100]);
    f.dr.attest_teaser(&f.seal, &image, &bad, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // ProofInvalid
fn test_teaser_proof_invalid() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_teaser(&env, &f);
    f.verifier.set_valid(&false);
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    f.dr.attest_teaser(&f.seal, &image, &j, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // ResultNotTrue
fn test_teaser_result_not_true() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_teaser(&env, &f);
    let j = make_teaser_journal(
        &env, 0, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    f.dr.attest_teaser(&f.seal, &image, &j, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
}

/// A fundraise revenue proof (claim_type 6) over the SAME generic guest must NOT be ingestible as a teaser.
#[test]
#[should_panic(expected = "Error(Contract, #7)")] // ClaimTypeMismatch
fn test_teaser_claim_type_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_teaser(&env, &f);
    let j = make_teaser_journal(
        &env, 1, 6, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY, // claim_type 6 (revenue), not 11
    );
    f.dr.attest_teaser(&f.seal, &image, &j, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // RoomNotFound
fn test_teaser_room_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let image = BytesN::from_array(&env, &TEASER_IMAGE);
    f.dr.set_teaser_image_id(&image);
    // no room created
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    f.dr.attest_teaser(&f.seal, &image, &j, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
}

#[test]
fn test_two_teasers_increment_and_enumerate() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_teaser(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    // a second sealed document in the same room.
    let doc2 = [0x0Au8; 32];
    let j_doc2 = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &doc2);
    f.dr.put_document(&f.seal, &f.image, &j_doc2, &Bytes::from_slice(&env, b"r2://full2"));
    let t0 = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    let t1 = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, 2_000_000, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    f.dr.attest_teaser(&f.seal, &image, &t0, &room_id, &BytesN::from_array(&env, &DOC));
    f.dr.attest_teaser(&f.seal, &image, &t1, &room_id, &BytesN::from_array(&env, &doc2));
    assert_eq!(f.dr.get_teaser_count(&room_id), 2);
    assert_eq!(f.dr.get_teaser_by_index(&room_id, &1).unwrap().threshold, 2_000_000);
}

/// `attest_teaser` must require the ROOM OWNER's auth (mock_all_auths masks it in the happy path).
#[test]
fn test_teaser_requires_room_owner_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let image = BytesN::from_array(&env, &TEASER_IMAGE);
    f.dr.set_teaser_image_id(&image);
    let owner = Address::generate(&env);
    f.dr.create_room(&owner, &BytesN::from_array(&env, &ROOM));
    let journal = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &DOC);
    f.dr.put_document(&f.seal, &f.image, &journal, &Bytes::from_slice(&env, b"r2://full"));
    f.dr.set_teaser_attester(&BytesN::from_array(&env, &TEASER_ATTESTER), &true);
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    f.dr.attest_teaser(&f.seal, &image, &j, &BytesN::from_array(&env, &ROOM), &BytesN::from_array(&env, &DOC));
    let auths = env.auths();
    assert!(
        auths.iter().any(|entry| entry.0 == owner),
        "attest_teaser must require the room owner's auth; got {:?}",
        auths,
    );
}

/// BY DESIGN (the owner-asserted linkage): the SAME teaser proof can be bound to a DIFFERENT document in a
/// room the owner controls — the proof commits to the figure, not to which document. (A different room
/// owner could not, since `attest_teaser` requires the target room's owner auth.) This pins that the
/// figure↔document binding is the owner's assertion, not cryptographic — see the `Teaser` soundness note.
#[test]
fn test_teaser_same_proof_rebindable_to_another_doc() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_teaser(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    // a second sealed document in the same room.
    let doc2 = [0x0Au8; 32];
    let j_doc2 = make_journal(&env, 1, CLAIM_TYPE_DATAROOM, &ROOM, &doc2);
    f.dr.put_document(&f.seal, &f.image, &j_doc2, &Bytes::from_slice(&env, b"r2://full2"));
    // ONE teaser journal, bound first to DOC then to doc2 — both accepted (the proof carries no doc id).
    let j = make_teaser_journal(
        &env, 1, CLAIM_TYPE_TEASER_T, &TEASER_ATTESTER, TEASER_THRESHOLD, FIELD_TAG_REVENUE, TEASER_EXPIRY,
    );
    let t0 = f.dr.attest_teaser(&f.seal, &image, &j, &room_id, &BytesN::from_array(&env, &DOC));
    let t1 = f.dr.attest_teaser(&f.seal, &image, &j, &room_id, &BytesN::from_array(&env, &doc2));
    // Same appraiser + threshold, DIFFERENT doc + the doc's own content_hash bound.
    assert_eq!(t0.attester, t1.attester);
    assert_eq!(t0.threshold, t1.threshold);
    assert_eq!(t1.doc_id, BytesN::from_array(&env, &doc2));
    assert_eq!(f.dr.get_teaser_count(&room_id), 2);
}

/// `field_tag` is the LOW 32 bits of the attester-signed u64 nonce (offset 49 of the journal). A nonce with
/// non-zero HIGH bits parses to the low word — deterministic, and the honest host caps field_tag to u32.
#[test]
fn test_teaser_field_tag_is_low_word_of_nonce() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (image, _) = setup_teaser(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    // nonce = 0xFFFFFFFF_00000007 → high word 0xFFFFFFFF (ignored), low word 7 == field_tag.
    let mut a = [0u8; 61];
    a[0] = 1;
    a[1..5].copy_from_slice(&CLAIM_TYPE_TEASER_T.to_be_bytes());
    a[5..37].copy_from_slice(&TEASER_ATTESTER);
    a[37..45].copy_from_slice(&TEASER_THRESHOLD.to_be_bytes());
    a[45..53].copy_from_slice(&0xFFFFFFFF_00000007u64.to_be_bytes());
    a[53..61].copy_from_slice(&TEASER_EXPIRY.to_be_bytes());
    let j = Bytes::from_array(&env, &a);
    let t = f.dr.attest_teaser(&f.seal, &image, &j, &room_id, &doc_id);
    assert_eq!(t.field_tag, 7);
}

/// `set_teaser_image_id` and `set_teaser_attester` must require the ADMIN's auth.
#[test]
fn test_set_teaser_admin_methods_require_admin_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let image = BytesN::from_array(&env, &TEASER_IMAGE);
    f.dr.set_teaser_image_id(&image);
    let auths1 = env.auths();
    assert!(
        auths1.iter().any(|entry| entry.0 == f.admin),
        "set_teaser_image_id must require the admin's auth; got {:?}",
        auths1,
    );
    f.dr.set_teaser_attester(&BytesN::from_array(&env, &TEASER_ATTESTER), &true);
    let auths2 = env.auths();
    assert!(
        auths2.iter().any(|entry| entry.0 == f.admin),
        "set_teaser_attester must require the admin's auth; got {:?}",
        auths2,
    );
    assert_eq!(f.dr.get_teaser_image_id().unwrap(), image);
}

// ---- DR6: private-policy composition + revocation/rotation ----

// Mock zkorage access gate (compliance / accredited cross-call target). Mirrors the real gates'
// `is_granted(accessor) -> bool` signature; `set_granted` toggles a per-accessor flag.
#[contract]
pub struct MockGate;
#[contractimpl]
impl MockGate {
    pub fn set_granted(env: Env, accessor: BytesN<32>, granted: bool) {
        env.storage().persistent().set(&accessor, &granted);
    }
    pub fn is_granted(env: Env, accessor: BytesN<32>) -> bool {
        env.storage().persistent().get(&accessor).unwrap_or(false)
    }
}

/// Set up: membership-enabled room (owner) + a granted membership for ACCESSOR1 + two mock gates.
/// Returns (owner, compliance_gate_id, compliance_client, accredited_gate_id, accredited_client).
fn setup_composite<'a>(
    env: &'a Env,
    f: &Fixture<'a>,
) -> (Address, Address, MockGateClient<'a>, Address, MockGateClient<'a>) {
    let (mem_image, owner) = setup_membership(env, f);
    let j = make_membership_journal(env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &mem_image, &j);
    let comp_id = env.register(MockGate, ());
    let comp = MockGateClient::new(env, &comp_id);
    let acc_id = env.register(MockGate, ());
    let acc = MockGateClient::new(env, &acc_id);
    (owner, comp_id, comp, acc_id, acc)
}

#[test]
fn test_room_admission_full_composite() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_owner, comp_id, comp, acc_id, acc) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    f.dr.set_room_policy(&room_id, &true, &Some(comp_id.clone()), &Some(acc_id.clone()));
    // Both legs granted for the SAME accessor.
    comp.set_granted(&accessor, &true);
    acc.set_granted(&accessor, &true);

    let admission = f.dr.request_room_admission(&room_id, &accessor);
    assert_eq!(admission.index, 0);
    assert_eq!(admission.accessor, accessor);
    assert!(admission.required_compliance);
    assert!(admission.required_accredited);

    assert!(f.dr.is_admitted(&room_id, &accessor));
    assert_eq!(f.dr.get_admission_count(&room_id), 1);
    assert_eq!(f.dr.get_admission_by_index(&room_id, &0).unwrap().accessor, accessor);
    let policy = f.dr.get_room_policy(&room_id).unwrap();
    assert!(policy.require_membership);
    assert_eq!(policy.compliance_gate, Some(comp_id));
    assert_eq!(policy.accredited_gate, Some(acc_id));
}

#[test]
#[should_panic(expected = "Error(Contract, #23)")] // NotCompliant
fn test_admission_denied_missing_compliance() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, _comp, acc_id, acc) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    f.dr.set_room_policy(&room_id, &true, &Some(comp_id), &Some(acc_id));
    // accredited granted, compliance NOT granted.
    acc.set_granted(&accessor, &true);
    f.dr.request_room_admission(&room_id, &accessor);
}

#[test]
#[should_panic(expected = "Error(Contract, #24)")] // NotAccredited
fn test_admission_denied_missing_accredited() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, acc_id, _acc) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    f.dr.set_room_policy(&room_id, &true, &Some(comp_id), &Some(acc_id));
    comp.set_granted(&accessor, &true); // accredited NOT granted
    f.dr.request_room_admission(&room_id, &accessor);
}

#[test]
#[should_panic(expected = "Error(Contract, #22)")] // MembershipRequired
fn test_admission_denied_no_membership() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, acc_id, acc) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    // ACCESSOR2 has NO membership grant (only ACCESSOR1 does).
    let accessor = BytesN::from_array(&env, &ACCESSOR2);
    f.dr.set_room_policy(&room_id, &true, &Some(comp_id), &Some(acc_id));
    comp.set_granted(&accessor, &true);
    acc.set_granted(&accessor, &true);
    f.dr.request_room_admission(&room_id, &accessor);
}

#[test]
#[should_panic(expected = "Error(Contract, #21)")] // RoomPolicyNotSet
fn test_admission_denied_no_policy() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let _ = setup_composite(&env, &f); // membership granted but NO policy set
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    f.dr.request_room_admission(&room_id, &accessor);
}

/// A policy with no gate legs (both None) -> membership alone admits (the anonymity-only room).
#[test]
fn test_admission_membership_only_policy() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let _ = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    let none: Option<Address> = None;
    f.dr.set_room_policy(&room_id, &true, &none, &none);
    let admission = f.dr.request_room_admission(&room_id, &accessor);
    assert!(!admission.required_compliance);
    assert!(!admission.required_accredited);
    assert!(f.dr.is_admitted(&room_id, &accessor));
}

/// A misconfigured/broken gate (an address with no `is_granted`) -> fail-closed (denied), not a trap.
#[test]
#[should_panic(expected = "Error(Contract, #23)")] // NotCompliant (try_is_granted => denied)
fn test_admission_broken_gate_fail_closed() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, _comp_id, _comp, acc_id, acc) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    // Point the compliance leg at the verifier-shaped mock (no is_granted method).
    let broken = env.register(MockVerifier, ());
    f.dr.set_room_policy(&room_id, &true, &Some(broken), &Some(acc_id));
    acc.set_granted(&accessor, &true);
    f.dr.request_room_admission(&room_id, &accessor);
}

#[test]
fn test_revoke_then_denied_and_unrevoke_restores() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, acc_id, acc) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    f.dr.set_room_policy(&room_id, &true, &Some(comp_id), &Some(acc_id));
    comp.set_granted(&accessor, &true);
    acc.set_granted(&accessor, &true);
    f.dr.request_room_admission(&room_id, &accessor);
    assert!(f.dr.is_admitted(&room_id, &accessor));
    assert!(f.dr.is_granted(&room_id, &accessor)); // DR3 keypers gate on this

    // Revoke -> both is_granted (keypers) and is_admitted drop.
    f.dr.revoke_access(&room_id, &accessor, &true);
    assert!(f.dr.is_access_revoked(&room_id, &accessor));
    assert!(!f.dr.is_granted(&room_id, &accessor));
    assert!(!f.dr.is_admitted(&room_id, &accessor));

    // Unrevoke -> restored (the grant + gates are still valid).
    f.dr.revoke_access(&room_id, &accessor, &false);
    assert!(!f.dr.is_access_revoked(&room_id, &accessor));
    assert!(f.dr.is_granted(&room_id, &accessor));
    assert!(f.dr.is_admitted(&room_id, &accessor));
}

#[test]
#[should_panic(expected = "Error(Contract, #25)")] // AccessRevoked
fn test_request_admission_revoked_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, acc_id, acc) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    f.dr.set_room_policy(&room_id, &true, &Some(comp_id), &Some(acc_id));
    comp.set_granted(&accessor, &true);
    acc.set_granted(&accessor, &true);
    f.dr.revoke_access(&room_id, &accessor, &true);
    f.dr.request_room_admission(&room_id, &accessor);
}

/// revoke_access must require the ROOM owner's auth.
#[test]
fn test_revoke_requires_room_owner_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (owner, _c, _cc, _a, _ac) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    f.dr.revoke_access(&room_id, &accessor, &true);
    let auths = env.auths();
    assert!(
        auths.iter().any(|entry| entry.0 == owner),
        "revoke_access must require the room owner's auth; got {:?}",
        auths,
    );
}

/// set_room_policy must require the ROOM owner's auth.
#[test]
fn test_set_room_policy_requires_room_owner_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (owner, comp_id, _cc, acc_id, _ac) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    f.dr.set_room_policy(&room_id, &true, &Some(comp_id), &Some(acc_id));
    let auths = env.auths();
    assert!(
        auths.iter().any(|entry| entry.0 == owner),
        "set_room_policy must require the room owner's auth; got {:?}",
        auths,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // RoomNotFound
fn test_set_room_policy_room_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let room_id = BytesN::from_array(&env, &ROOM); // never created
    let none: Option<Address> = None;
    f.dr.set_room_policy(&room_id, &true, &none, &none);
}

#[test]
fn test_rotate_committee_document_happy() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    f.dr.put_committee_document(
        &room_id,
        &doc_id,
        &BytesN::from_array(&env, &CONTENT),
        &BytesN::from_array(&env, &KCOMMIT),
        &Bytes::from_slice(&env, b"r2://v0"),
    );
    assert_eq!(f.dr.get_committee_key_epoch(&room_id, &doc_id), 0);

    let new_content = BytesN::from_array(&env, &[0xCEu8; 32]);
    let new_kcommit = BytesN::from_array(&env, &[0x4Cu8; 32]);
    let rotated = f.dr.rotate_committee_document(
        &room_id,
        &doc_id,
        &new_content,
        &new_kcommit,
        &Bytes::from_slice(&env, b"r2://v1"),
    );
    assert_eq!(rotated.index, 0); // index preserved
    assert_eq!(rotated.content_hash, new_content);
    assert_eq!(rotated.k_commitment, new_kcommit);
    assert_eq!(f.dr.get_committee_key_epoch(&room_id, &doc_id), 1);
    let got = f.dr.get_committee_document(&room_id, &doc_id).unwrap();
    assert_eq!(got.content_hash, new_content);
    assert_eq!(got.k_commitment, new_kcommit);
    assert_eq!(got.blob_pointer, Bytes::from_slice(&env, b"r2://v1"));
    assert_eq!(f.dr.get_committee_doc_count(&room_id), 1); // not duplicated

    // A second rotation bumps the epoch again.
    f.dr.rotate_committee_document(
        &room_id,
        &doc_id,
        &BytesN::from_array(&env, &[0xCFu8; 32]),
        &BytesN::from_array(&env, &[0x4Du8; 32]),
        &Bytes::from_slice(&env, b"r2://v2"),
    );
    assert_eq!(f.dr.get_committee_key_epoch(&room_id, &doc_id), 2);
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")] // CommitteeDocNotFound
fn test_rotate_committee_nonexistent() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    create_default_room(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC); // no committee doc put
    f.dr.rotate_committee_document(
        &room_id,
        &doc_id,
        &BytesN::from_array(&env, &CONTENT),
        &BytesN::from_array(&env, &KCOMMIT),
        &Bytes::from_slice(&env, b"r2://x"),
    );
}

#[test]
fn test_rotate_committee_requires_room_owner_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    let room_id = BytesN::from_array(&env, &ROOM);
    f.dr.create_room(&owner, &room_id);
    let doc_id = BytesN::from_array(&env, &DOC);
    f.dr.put_committee_document(
        &room_id, &doc_id,
        &BytesN::from_array(&env, &CONTENT),
        &BytesN::from_array(&env, &KCOMMIT),
        &Bytes::from_slice(&env, b"r2://v0"),
    );
    f.dr.rotate_committee_document(
        &room_id, &doc_id,
        &BytesN::from_array(&env, &[0xCEu8; 32]),
        &BytesN::from_array(&env, &[0x4Cu8; 32]),
        &Bytes::from_slice(&env, b"r2://v1"),
    );
    let auths = env.auths();
    assert!(
        auths.iter().any(|entry| entry.0 == owner),
        "rotate_committee_document must require the room owner's auth; got {:?}",
        auths,
    );
}

/// is_admitted is false for an unknown room / no policy (totality, no trap).
#[test]
fn test_is_admitted_false_without_policy() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    assert!(!f.dr.is_admitted(&room_id, &accessor));
    assert!(f.dr.get_room_policy(&room_id).is_none());
    assert_eq!(f.dr.get_admission_count(&room_id), 0);
}

/// LOW-1 fix: re-calling the PERMISSIONLESS request_room_admission for an already-admitted accessor must NOT
/// inflate the room's admission log/count — it refreshes the per-accessor record at its original index.
#[test]
fn test_request_admission_is_idempotent_in_the_log() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, acc_id, acc) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    f.dr.set_room_policy(&room_id, &true, &Some(comp_id), &Some(acc_id));
    comp.set_granted(&accessor, &true);
    acc.set_granted(&accessor, &true);

    let a1 = f.dr.request_room_admission(&room_id, &accessor);
    assert_eq!(a1.index, 0);
    assert_eq!(f.dr.get_admission_count(&room_id), 1);
    // re-call (anyone can, permissionlessly) — count stays 1, index preserved, no log inflation.
    let a2 = f.dr.request_room_admission(&room_id, &accessor);
    assert_eq!(a2.index, 0);
    assert_eq!(f.dr.get_admission_count(&room_id), 1);
    let a3 = f.dr.request_room_admission(&room_id, &accessor);
    assert_eq!(a3.index, 0);
    assert_eq!(f.dr.get_admission_count(&room_id), 1);
    assert_eq!(f.dr.get_admission_by_index(&room_id, &0).unwrap().accessor, accessor);
}

/// Code-review #1 fix: revocation must drop `is_admitted` even for a membership-OPTIONAL room (where the
/// membership leg — which carries the revoke check via is_granted — is skipped). Both paths must deny.
#[test]
fn test_revocation_drops_is_admitted_when_membership_not_required() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, _a, _ac) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    // require_membership = FALSE; only the compliance leg required.
    let none: Option<Address> = None;
    f.dr.set_room_policy(&room_id, &false, &Some(comp_id), &none);
    comp.set_granted(&accessor, &true);
    assert!(f.dr.is_admitted(&room_id, &accessor)); // admitted (no membership needed)

    // Revoke → is_admitted MUST drop even though the membership leg is skipped.
    f.dr.revoke_access(&room_id, &accessor, &true);
    assert!(!f.dr.is_admitted(&room_id, &accessor));
}

#[test]
#[should_panic(expected = "Error(Contract, #25)")] // AccessRevoked
fn test_request_admission_revoked_rejected_when_membership_not_required() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, _a, _ac) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    let none: Option<Address> = None;
    f.dr.set_room_policy(&room_id, &false, &Some(comp_id), &none);
    comp.set_granted(&accessor, &true);
    f.dr.revoke_access(&room_id, &accessor, &true);
    f.dr.request_room_admission(&room_id, &accessor);
}

// ---- Pattern 2: prove-a-policy self-serve, PER-DOCUMENT access policy (set_doc_policy / is_doc_admitted) ----

/// setup_composite (membership grant for ACCESSOR1 + two mock gates) PLUS a committee document anchored in
/// the room, so a per-document policy can be set on it. Returns the composite tuple.
fn setup_doc<'a>(
    env: &'a Env,
    f: &Fixture<'a>,
) -> (Address, Address, MockGateClient<'a>, Address, MockGateClient<'a>) {
    let composite = setup_composite(env, f);
    f.dr.put_committee_document(
        &BytesN::from_array(env, &ROOM),
        &BytesN::from_array(env, &DOC),
        &BytesN::from_array(env, &CONTENT),
        &BytesN::from_array(env, &KCOMMIT),
        &Bytes::from_slice(env, b"r2://doc"),
    );
    composite
}

/// Full per-document composite: a doc policy of member AND compliance AND accredited; all granted for the
/// SAME accessor -> is_doc_admitted true. get_doc_policy round-trips.
#[test]
fn test_doc_policy_full_composite() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, acc_id, acc) = setup_doc(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    f.dr.set_doc_policy(&room_id, &doc_id, &true, &Some(comp_id.clone()), &Some(acc_id.clone()));
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor)); // gates not granted yet
    comp.set_granted(&accessor, &true);
    acc.set_granted(&accessor, &true);
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    let p = f.dr.get_doc_policy(&room_id, &doc_id).unwrap();
    assert!(p.require_membership);
    assert_eq!(p.compliance_gate, Some(comp_id));
    assert_eq!(p.accredited_gate, Some(acc_id));
}

/// A per-document policy is used OVER the room policy. Room policy = membership-only (accessor passes); doc
/// policy = member AND compliance (accessor lacks compliance) -> is_admitted(room) true, is_doc_admitted false.
#[test]
fn test_doc_policy_overrides_room_policy() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, _a, _ac) = setup_doc(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    let none: Option<Address> = None;
    f.dr.set_room_policy(&room_id, &true, &none, &none); // room: membership-only
    f.dr.set_doc_policy(&room_id, &doc_id, &true, &Some(comp_id.clone()), &none); // doc: stricter
    assert!(f.dr.is_admitted(&room_id, &accessor)); // passes the room policy (membership only)
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor)); // but NOT the stricter doc policy
    comp.set_granted(&accessor, &true);
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor)); // now passes the doc policy
}

/// No per-document policy -> is_doc_admitted falls back to the ROOM policy.
#[test]
fn test_doc_admitted_falls_back_to_room_policy() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, _a, _ac) = setup_doc(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    let none: Option<Address> = None;
    f.dr.set_room_policy(&room_id, &true, &Some(comp_id), &none); // room: member AND compliance
    assert!(f.dr.get_doc_policy(&room_id, &doc_id).is_none()); // no doc policy
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor)); // compliance not granted
    comp.set_granted(&accessor, &true);
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor)); // room policy satisfied
}

/// No doc policy AND no room policy -> is_doc_admitted falls back to the bare DR2 membership grant
/// (backward-compatible with pre-policy committee documents). ACCESSOR1 is granted; ACCESSOR2 is not.
#[test]
fn test_doc_admitted_falls_back_to_membership() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let _ = setup_doc(&env, &f); // ACCESSOR1 has a membership grant; NO room/doc policy set
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &BytesN::from_array(&env, &ACCESSOR1)));
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &BytesN::from_array(&env, &ACCESSOR2)));
}

/// Revocation drops is_doc_admitted (the keypers refuse), then unrevoke restores it.
#[test]
fn test_doc_admitted_revocation_drops_then_restores() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, acc_id, acc) = setup_doc(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    f.dr.set_doc_policy(&room_id, &doc_id, &true, &Some(comp_id), &Some(acc_id));
    comp.set_granted(&accessor, &true);
    acc.set_granted(&accessor, &true);
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    f.dr.revoke_access(&room_id, &accessor, &true);
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    f.dr.revoke_access(&room_id, &accessor, &false);
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
}

/// A gate-only doc policy (require_membership = false) still drops on revocation (the top-level revoke
/// check, regardless of which legs the policy has).
#[test]
fn test_doc_admitted_gate_only_revocation_drops() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, comp, _a, _ac) = setup_doc(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    let none: Option<Address> = None;
    f.dr.set_doc_policy(&room_id, &doc_id, &false, &Some(comp_id), &none);
    comp.set_granted(&accessor, &true);
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    f.dr.revoke_access(&room_id, &accessor, &true);
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
}

/// set_doc_policy must require the ROOM owner's auth.
#[test]
fn test_set_doc_policy_requires_room_owner_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (owner, comp_id, _cc, acc_id, _ac) = setup_doc(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    f.dr.set_doc_policy(&room_id, &doc_id, &true, &Some(comp_id), &Some(acc_id));
    let auths = env.auths();
    assert!(
        auths.iter().any(|entry| entry.0 == owner),
        "set_doc_policy must require the room owner's auth; got {:?}",
        auths,
    );
}

/// set_doc_policy on a (room, doc) with no committee document -> CommitteeDocNotFound.
#[test]
#[should_panic(expected = "Error(Contract, #26)")] // CommitteeDocNotFound
fn test_set_doc_policy_requires_committee_doc() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, _cc, _a, _ac) = setup_composite(&env, &f); // room exists, but NO committee doc
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    f.dr.set_doc_policy(&room_id, &doc_id, &true, &Some(comp_id), &None);
}

/// An empty doc policy (no membership, no gates) is rejected (it would admit everyone).
#[test]
#[should_panic(expected = "Error(Contract, #27)")] // EmptyPolicy
fn test_set_doc_policy_empty_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let _ = setup_doc(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let none: Option<Address> = None;
    f.dr.set_doc_policy(&room_id, &doc_id, &false, &none, &none);
}

/// Totality: is_doc_admitted on an unknown room/doc with no grant -> false (fallback to is_granted), no trap.
#[test]
fn test_is_doc_admitted_false_unknown() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let accessor = BytesN::from_array(&env, &ACCESSOR1);
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    assert!(f.dr.get_doc_policy(&room_id, &doc_id).is_none());
}

/// INFO-1 fix: a policy with NO membership spine AND NO gates would admit everyone — rejected (#27 EmptyPolicy).
#[test]
#[should_panic(expected = "Error(Contract, #27)")] // EmptyPolicy
fn test_set_room_policy_rejects_open_room() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    setup_membership(&env, &f); // creates the room (owner)
    let room_id = BytesN::from_array(&env, &ROOM);
    let none: Option<Address> = None;
    f.dr.set_room_policy(&room_id, &false, &none, &none); // require_membership=false + no gates -> #27
}

/// A gate-only policy (no membership spine, but a gate present) is still allowed — only the FULLY-empty
/// policy is rejected.
#[test]
fn test_set_room_policy_allows_gate_only() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, comp_id, _comp, _a, _ac) = setup_composite(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let none: Option<Address> = None;
    f.dr.set_room_policy(&room_id, &false, &Some(comp_id), &none); // OK (one leg present)
    assert!(f.dr.get_room_policy(&room_id).is_some());
}

// ---- BA1: anonymous Bonded Access (per-requirement bond leg in is_doc_admitted / is_admitted) ----

const REQ: [u8; 32] = [0x5Au8; 32];
const REQ2: [u8; 32] = [0x5Bu8; 32];
const WRONG_ROOT: [u8; 32] = [0x99u8; 32];

// Mock bond gate: mirrors the real gate's 3-arg `is_granted_for(accessor, req_id, member_root) -> bool`.
// `set_grant` records ONE expected triple; is_granted_for returns true ONLY for that exact triple — so a
// test can prove the DataRoom passes the room's eligible_root (and that a wrong/rotated root denies).
#[contract]
pub struct MockBondGate;
#[contractimpl]
impl MockBondGate {
    pub fn set_grant(env: Env, accessor: BytesN<32>, req_id: BytesN<32>, member_root: BytesN<32>) {
        env.storage().instance().set(&symbol_short!("a"), &accessor);
        env.storage().instance().set(&symbol_short!("r"), &req_id);
        env.storage().instance().set(&symbol_short!("m"), &member_root);
    }
    pub fn is_granted_for(
        env: Env,
        accessor: BytesN<32>,
        req_id: BytesN<32>,
        member_root: BytesN<32>,
    ) -> bool {
        let a: Option<BytesN<32>> = env.storage().instance().get(&symbol_short!("a"));
        let r: Option<BytesN<32>> = env.storage().instance().get(&symbol_short!("r"));
        let m: Option<BytesN<32>> = env.storage().instance().get(&symbol_short!("m"));
        a == Some(accessor) && r == Some(req_id) && m == Some(member_root)
    }
    // ---- bond-OPEN (no-approval) path: records (accessor, req_id) -> recipient_pub, no member_root ----
    pub fn set_open_grant(env: Env, accessor: BytesN<32>, req_id: BytesN<32>, recipient_pub: BytesN<32>) {
        env.storage().instance().set(&symbol_short!("oa"), &accessor);
        env.storage().instance().set(&symbol_short!("orq"), &req_id);
        env.storage().instance().set(&symbol_short!("orp"), &recipient_pub);
    }
    pub fn is_open_granted(env: Env, accessor: BytesN<32>, req_id: BytesN<32>) -> bool {
        let a: Option<BytesN<32>> = env.storage().instance().get(&symbol_short!("oa"));
        let r: Option<BytesN<32>> = env.storage().instance().get(&symbol_short!("orq"));
        a == Some(accessor) && r == Some(req_id)
    }
    pub fn get_open_recipient_pub(
        env: Env,
        accessor: BytesN<32>,
        req_id: BytesN<32>,
    ) -> Option<BytesN<32>> {
        if Self::is_open_granted(env.clone(), accessor, req_id) {
            env.storage().instance().get(&symbol_short!("orp"))
        } else {
            None
        }
    }
}

/// Membership-enabled room (eligible_root pinned to ELIG_ROOT) + a registered mock bond gate + a token addr.
/// Returns (owner, bond_gate_id, bond_client, token).
fn setup_bond<'a>(
    env: &'a Env,
    f: &Fixture<'a>,
) -> (Address, Address, MockBondGateClient<'a>, Address) {
    let (_mem_image, owner) = setup_membership(env, f);
    let bond_id = env.register(MockBondGate, ());
    let bond = MockBondGateClient::new(env, &bond_id);
    let token = Address::generate(env);
    (owner, bond_id, bond, token)
}

#[test]
fn test_bond_leg_admits_without_dr2_grant() {
    // Option A: a satisfied bond leg admits an accessor that has NO DR2 membership grant (the bond proof's
    // member_root == the room's eligible_root proves membership). ACCESSOR2 never called request_access.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, bond_id, bond, token) = setup_bond(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let req_id = BytesN::from_array(&env, &REQ);
    let accessor = BytesN::from_array(&env, &ACCESSOR2);
    let doc_id = BytesN::from_array(&env, &DOC);
    f.dr.set_bond_requirement(&room_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
    // not granted yet -> denied
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    // gate grants for (accessor, req, ELIG_ROOT) = the room's eligible_root the DataRoom passes
    bond.set_grant(&accessor, &req_id, &BytesN::from_array(&env, &ELIG_ROOT));
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    assert!(f.dr.is_admitted(&room_id, &accessor));
    let req = f.dr.get_bond_requirement(&room_id).unwrap();
    assert_eq!(req.req_id, req_id);
    assert_eq!(req.min_amount, 1_000_000_000i128);
    assert_eq!(req.deadline, 9_000_000_000u64);
}

#[test]
fn test_bond_leg_denies_wrong_member_root() {
    // The gate grant is bound to WRONG_ROOT, but the DataRoom passes the room's ELIG_ROOT -> the binding
    // fails -> denied. This is the Option-A soundness: a bond proven vs a foreign member set admits nobody.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, bond_id, bond, token) = setup_bond(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let req_id = BytesN::from_array(&env, &REQ);
    let accessor = BytesN::from_array(&env, &ACCESSOR2);
    let doc_id = BytesN::from_array(&env, &DOC);
    f.dr.set_bond_requirement(&room_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
    bond.set_grant(&accessor, &req_id, &BytesN::from_array(&env, &WRONG_ROOT));
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
}

#[test]
fn test_bond_leg_fail_closed_without_eligible_root() {
    // A room with a bond requirement but NO pinned eligible_root -> the bond leg fails closed (the DataRoom
    // cannot bind membership), even if the gate would grant.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    let fresh_room = [0x33u8; 32];
    let room_id = BytesN::from_array(&env, &fresh_room);
    f.dr.create_room(&owner, &room_id); // NO set_eligible_root
    let bond_id = env.register(MockBondGate, ());
    let bond = MockBondGateClient::new(&env, &bond_id);
    let token = Address::generate(&env);
    let req_id = BytesN::from_array(&env, &REQ);
    let accessor = BytesN::from_array(&env, &ACCESSOR2);
    f.dr.set_bond_requirement(&room_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
    bond.set_grant(&accessor, &req_id, &BytesN::from_array(&env, &ELIG_ROOT));
    assert!(!f.dr.is_doc_admitted(&room_id, &BytesN::from_array(&env, &DOC), &accessor));
}

#[test]
fn test_bond_root_rotation_drops_access() {
    // Granting bound to ELIG_ROOT admits; re-pinning the room's eligible_root to a NEW value drops access
    // (the DataRoom now passes NEW, which the gate grant does not match) — mirrors the DR2 grant rotation.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, bond_id, bond, token) = setup_bond(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let req_id = BytesN::from_array(&env, &REQ);
    let accessor = BytesN::from_array(&env, &ACCESSOR2);
    let doc_id = BytesN::from_array(&env, &DOC);
    f.dr.set_bond_requirement(&room_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
    bond.set_grant(&accessor, &req_id, &BytesN::from_array(&env, &ELIG_ROOT));
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    f.dr.set_eligible_root(&room_id, &BytesN::from_array(&env, &WRONG_ROOT)); // rotate
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
}

#[test]
fn test_doc_bond_requirement_overrides_room() {
    // A per-document bond requirement (gate B / REQ2) overrides the room-level one (gate A / REQ) for that doc.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_owner, bond_a_id, _bond_a, token) = setup_bond(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    // the committee doc must exist for a per-document requirement
    f.dr.put_committee_document(
        &room_id, &doc_id, &BytesN::from_array(&env, &CONTENT), &BytesN::from_array(&env, &KCOMMIT),
        &Bytes::from_slice(&env, b"bond"),
    );
    let bond_b_id = env.register(MockBondGate, ());
    let bond_b = MockBondGateClient::new(&env, &bond_b_id);
    let req_a = BytesN::from_array(&env, &REQ);
    let req_b = BytesN::from_array(&env, &REQ2);
    let accessor = BytesN::from_array(&env, &ACCESSOR2);
    f.dr.set_bond_requirement(&room_id, &bond_a_id, &req_a, &token, &1_000_000_000i128, &9_000_000_000u64);
    f.dr.set_doc_bond_requirement(&room_id, &doc_id, &bond_b_id, &req_b, &token, &2_000_000_000i128, &9_000_000_000u64);
    // gate B grants for REQ2 against ELIG_ROOT -> admitted via the DOC requirement (gate A never granted)
    bond_b.set_grant(&accessor, &req_b, &BytesN::from_array(&env, &ELIG_ROOT));
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    assert_eq!(f.dr.get_doc_bond_requirement(&room_id, &doc_id).unwrap().req_id, req_b);
}

#[test]
fn test_bond_plus_compliance_anded() {
    // Bond requirement AND a compliance gate (require_membership=false): both must pass.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, bond_id, bond, token) = setup_bond(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let req_id = BytesN::from_array(&env, &REQ);
    let accessor = BytesN::from_array(&env, &ACCESSOR2);
    let comp_id = env.register(MockGate, ());
    let comp = MockGateClient::new(&env, &comp_id);
    let none: Option<Address> = None;
    f.dr.set_bond_requirement(&room_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
    f.dr.set_room_policy(&room_id, &false, &Some(comp_id), &none); // bond implies membership; compliance ANDed
    bond.set_grant(&accessor, &req_id, &BytesN::from_array(&env, &ELIG_ROOT));
    // compliance NOT granted -> denied
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    // grant compliance -> admitted
    comp.set_granted(&accessor, &true);
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
}

#[test]
fn test_bond_revoked_denied() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, bond_id, bond, token) = setup_bond(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let req_id = BytesN::from_array(&env, &REQ);
    let accessor = BytesN::from_array(&env, &ACCESSOR2);
    f.dr.set_bond_requirement(&room_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
    bond.set_grant(&accessor, &req_id, &BytesN::from_array(&env, &ELIG_ROOT));
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    f.dr.revoke_access(&room_id, &accessor, &true);
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
}

#[test]
fn test_clear_bond_requirement_falls_back() {
    // After clearing the room bond requirement (and with no policy), access falls back to bare DR2 membership:
    // ACCESSOR2 (no grant) is then denied.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, bond_id, bond, token) = setup_bond(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let doc_id = BytesN::from_array(&env, &DOC);
    let req_id = BytesN::from_array(&env, &REQ);
    let accessor = BytesN::from_array(&env, &ACCESSOR2);
    f.dr.set_bond_requirement(&room_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
    bond.set_grant(&accessor, &req_id, &BytesN::from_array(&env, &ELIG_ROOT));
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    f.dr.clear_bond_requirement(&room_id);
    assert!(f.dr.get_bond_requirement(&room_id).is_none());
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor)); // back to bare membership; ACCESSOR2 has none
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")] // BadBondRequirement
fn test_set_bond_requirement_rejects_zero_min_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, bond_id, _bond, token) = setup_bond(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    f.dr.set_bond_requirement(&room_id, &bond_id, &BytesN::from_array(&env, &REQ), &token, &0i128, &9_000_000_000u64);
}

#[test]
fn test_set_bond_requirement_requires_room_owner_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (_o, bond_id, _bond, token) = setup_bond(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    env.mock_auths(&[]); // drop auths
    let res = f.dr.try_set_bond_requirement(
        &room_id, &bond_id, &BytesN::from_array(&env, &REQ), &token, &1_000_000_000i128, &9_000_000_000u64,
    );
    assert!(res.is_err(), "set_bond_requirement must require the room owner's auth; got {:?}", res);
}

// ============================ TRUE bond-only (no-approval) mode ============================

const BOND_RECIP: [u8; 32] = [0x55u8; 32];

#[test]
fn test_bond_open_admits_non_member_without_eligible_root() {
    // The whole point: a reader who is NOT an approved member, in a room with NO pinned eligible_root, is
    // admitted purely by a qualifying bond proven anonymously (the bond-OPEN leg). No approval, no membership.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    let fresh = [0x44u8; 32];
    let room_id = BytesN::from_array(&env, &fresh);
    f.dr.create_room(&owner, &room_id); // NO set_eligible_root, NO approvals
    let bond_id = env.register(MockBondGate, ());
    let bond = MockBondGateClient::new(&env, &bond_id);
    let token = Address::generate(&env);
    let req_id = BytesN::from_array(&env, &REQ);
    let accessor = BytesN::from_array(&env, &ACCESSOR2);
    let doc_id = BytesN::from_array(&env, &DOC);

    f.dr.set_bond_open_requirement(&room_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
    assert!(f.dr.is_bond_open(&room_id));
    // no grant yet -> denied
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    // a bond-open grant (NO member_root) -> admitted, with no eligible_root pinned
    bond.set_open_grant(&accessor, &req_id, &BytesN::from_array(&env, &BOND_RECIP));
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    assert!(f.dr.is_admitted(&room_id, &accessor));
    // the keeper's unified recipient_pub read returns the proof-bound key from the bond-open grant
    assert_eq!(
        f.dr.admission_recipient_pub(&room_id, &accessor),
        Some(BytesN::from_array(&env, &BOND_RECIP))
    );
}

#[test]
fn test_bond_open_revocation_drops_access() {
    // Revoking the accessor drops a bond-only admission too (revocation is checked first).
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    let fresh = [0x45u8; 32];
    let room_id = BytesN::from_array(&env, &fresh);
    f.dr.create_room(&owner, &room_id);
    let bond_id = env.register(MockBondGate, ());
    let bond = MockBondGateClient::new(&env, &bond_id);
    let token = Address::generate(&env);
    let req_id = BytesN::from_array(&env, &REQ);
    let accessor = BytesN::from_array(&env, &ACCESSOR2);
    let doc_id = BytesN::from_array(&env, &DOC);
    f.dr.set_bond_open_requirement(&room_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
    bond.set_open_grant(&accessor, &req_id, &BytesN::from_array(&env, &BOND_RECIP));
    assert!(f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
    f.dr.revoke_access(&room_id, &accessor, &true);
    assert!(!f.dr.is_doc_admitted(&room_id, &doc_id, &accessor));
}

#[test]
fn test_admission_recipient_pub_membership_fallback() {
    // For a non-bond-only (membership) room, the keeper read returns the DR2 grant's recipient_pub, and None
    // for an accessor with no grant.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let (mem_image, _owner) = setup_membership(&env, &f);
    let room_id = BytesN::from_array(&env, &ROOM);
    let j = make_membership_journal(&env, 1, CLAIM_TYPE_MEMBERSHIP_T, &ROOM, &ELIG_ROOT, &NULL1, &ACCESSOR1);
    f.dr.request_access(&f.seal, &mem_image, &j);
    assert!(!f.dr.is_bond_open(&room_id));
    assert_eq!(
        f.dr.admission_recipient_pub(&room_id, &BytesN::from_array(&env, &ACCESSOR1)),
        Some(BytesN::from_array(&env, &RECIPIENT))
    );
    assert_eq!(f.dr.admission_recipient_pub(&room_id, &BytesN::from_array(&env, &ACCESSOR2)), None);
}

#[test]
fn test_clear_bond_requirement_clears_open_mode() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    let fresh = [0x46u8; 32];
    let room_id = BytesN::from_array(&env, &fresh);
    f.dr.create_room(&owner, &room_id);
    let bond_id = env.register(MockBondGate, ());
    let token = Address::generate(&env);
    let req_id = BytesN::from_array(&env, &REQ);
    f.dr.set_bond_open_requirement(&room_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
    assert!(f.dr.is_bond_open(&room_id));
    assert!(f.dr.get_bond_requirement(&room_id).is_some());
    f.dr.clear_bond_requirement(&room_id);
    assert!(!f.dr.is_bond_open(&room_id));
    assert!(f.dr.get_bond_requirement(&room_id).is_none());
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")] // BadBondRequirement
fn test_set_bond_open_requirement_rejects_zero_min_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    let fresh = [0x47u8; 32];
    let room_id = BytesN::from_array(&env, &fresh);
    f.dr.create_room(&owner, &room_id);
    let bond_id = env.register(MockBondGate, ());
    let token = Address::generate(&env);
    f.dr.set_bond_open_requirement(&room_id, &bond_id, &BytesN::from_array(&env, &REQ), &token, &0i128, &9_000_000_000u64);
}

#[test]
fn test_set_bond_open_requirement_requires_room_owner_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    let fresh = [0x48u8; 32];
    let room_id = BytesN::from_array(&env, &fresh);
    f.dr.create_room(&owner, &room_id);
    let bond_id = env.register(MockBondGate, ());
    let token = Address::generate(&env);
    env.mock_auths(&[]); // drop auths
    let res = f.dr.try_set_bond_open_requirement(
        &room_id, &bond_id, &BytesN::from_array(&env, &REQ), &token, &1_000_000_000i128, &9_000_000_000u64,
    );
    assert!(res.is_err(), "set_bond_open_requirement must require the room owner's auth; got {:?}", res);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")] // BadBondRequirement
fn test_set_doc_bond_requirement_rejected_on_bond_only_room() {
    // A bond-only room is room-uniform: a per-document bond requirement (which admission_recipient_pub does
    // NOT resolve) must be rejected, so a bonded doc can never become admittable-but-unopenable.
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env);
    let owner = Address::generate(&env);
    let fresh = [0x49u8; 32];
    let room_id = BytesN::from_array(&env, &fresh);
    f.dr.create_room(&owner, &room_id);
    let bond_id = env.register(MockBondGate, ());
    let token = Address::generate(&env);
    let req_id = BytesN::from_array(&env, &REQ);
    f.dr.set_bond_open_requirement(&room_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
    let doc_id = BytesN::from_array(&env, &DOC);
    f.dr.set_doc_bond_requirement(&room_id, &doc_id, &bond_id, &req_id, &token, &1_000_000_000i128, &9_000_000_000u64);
}
