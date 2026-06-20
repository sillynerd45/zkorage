use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use risc0_zkvm::guest::env;

/// # solvency_predicate (BP3) — a proof-of-reserves predicate bound to a bonded escrow lock
///
/// This guest reuses the Proof-of-Reserves predicate (`reserves >= supply`, the reserve figure stays
/// PRIVATE) and additionally **binds the proof to a specific escrow lock** so the on-chain solvency gate
/// can read that lock LIVE and let the grant evaporate the instant the issuer un-bonds.
///
/// The reserve claim is authenticated by an allow-listed "bonded reserve auditor" (a mock ed25519 issuer
/// for the demo). The escrow-binding fields (`escrow`, `lock_id`, `min_amount`, `bond_token`,
/// `supply_token`) are PUBLIC values the prover commits; the guest binds them into the journal but does
/// NOT (and cannot) check them — the GATE checks them against on-chain reality (the escrow's real lock
/// state and the supply token's real `total_supply`).
///
/// ClaimEnvelope wire layout (60 bytes, big-endian), signed by the reserve auditor over `DOMAIN || env`:
///   [0..4]   claim_type : u32    (= 12, solvency-bonded)
///   [4..12]  value      : u64    (the PRIVATE reserve figure — never committed to the journal)
///   [12..44] issuer_id  : [u8;32]
///   [44..52] nonce      : u64
///   [52..60] expiry     : u64
const ENVELOPE_LEN: usize = 60;
const CLAIM_TYPE_SOLVENCY: u32 = 12;

/// Domain separation (mirrors the W8 accredited guest's NEW-2): the auditor signs `DOMAIN || envelope`,
/// not the bare envelope, so a reserve attestation for THIS use-case can never be reinterpreted as the
/// byte-identical Proof-of-Reserves envelope (or any other), even if an auditor key were ever shared.
/// The backend attester and `host_solvency` MUST sign over the same `DOMAIN || envelope` bytes.
const DOMAIN: &[u8] = b"zkorage-solvency-v1\x00";

fn main() {
    // Inputs (written by the host in this exact order). The first four are the reserve attestation; the
    // last five are the public escrow-binding values the gate enforces.
    let envelope: Vec<u8> = env::read();
    let sig_bytes: Vec<u8> = env::read();
    let pk_bytes: Vec<u8> = env::read();
    let threshold: u64 = env::read(); // = the supply the gate binds to supply_token.total_supply()
    let escrow: Vec<u8> = env::read(); // escrow contract id (32 bytes)
    let lock_id: u64 = env::read();
    let min_amount: u64 = env::read();
    let bond_token: Vec<u8> = env::read(); // bond/collateral token id (32 bytes)
    let supply_token: Vec<u8> = env::read(); // supply/liability token id (32 bytes)

    assert_eq!(envelope.len(), ENVELOPE_LEN, "bad envelope length");
    let escrow_arr: [u8; 32] = escrow.as_slice().try_into().expect("escrow must be 32 bytes");
    let bond_token_arr: [u8; 32] = bond_token
        .as_slice()
        .try_into()
        .expect("bond_token must be 32 bytes");
    let supply_token_arr: [u8; 32] = supply_token
        .as_slice()
        .try_into()
        .expect("supply_token must be 32 bytes");

    // 1) Authenticate the reserve claim: ed25519 over `DOMAIN || envelope`. Panics (=> no receipt) if bad.
    let pk_arr: [u8; 32] = pk_bytes.as_slice().try_into().expect("pubkey must be 32 bytes");
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().expect("signature must be 64 bytes");
    let vk = VerifyingKey::from_bytes(&pk_arr).expect("invalid issuer public key");
    let sig = Signature::from_bytes(&sig_arr);
    let mut signed = Vec::with_capacity(DOMAIN.len() + envelope.len());
    signed.extend_from_slice(DOMAIN);
    signed.extend_from_slice(&envelope);
    vk.verify(&signed, &sig).expect("signature verification failed");

    // 2) Parse the envelope. `value` (reserves) is read but DELIBERATELY never committed (the ZK property).
    let claim_type = u32::from_be_bytes(envelope[0..4].try_into().unwrap());
    let value = u64::from_be_bytes(envelope[4..12].try_into().unwrap());
    let issuer_id: [u8; 32] = envelope[12..44].try_into().unwrap();
    let nonce = u64::from_be_bytes(envelope[44..52].try_into().unwrap());
    let expiry = u64::from_be_bytes(envelope[52..60].try_into().unwrap());

    // 2a) SOUNDNESS: the committed issuer_id MUST equal the key that verified the signature (same
    //     rationale as the PoR/identity/accredited guests — binds the proof to the real auditor).
    assert_eq!(pk_arr, issuer_id, "issuer_id must equal the signing public key");

    // 3) The predicate: a solvency-bonded reserve claim with `reserves >= supply`. Panics (=> no receipt)
    //    when false — a valid receipt's EXISTENCE is the proof.
    assert_eq!(claim_type, CLAIM_TYPE_SOLVENCY, "not a solvency-bonded claim");
    assert!(value >= threshold, "predicate false: reserves < supply");

    // 4) Commit the 173-byte PUBLIC journal. The first 61 bytes are byte-identical to the PoR journal
    //    (result | claim_type | issuer_id | supply | nonce | expiry); the remaining 112 bytes bind the
    //    escrow lock + the two token roles. `value` (reserves) is ABSENT (stays private).
    //    Layout (173 bytes, big-endian):
    //      [0]        result        u8  (=1)
    //      [1..5]     claim_type     u32 (=12)
    //      [5..37]    issuer_id      [u8;32]
    //      [37..45]   supply         u64
    //      [45..53]   nonce          u64
    //      [53..61]   expiry         u64
    //      [61..93]   escrow         [u8;32]
    //      [93..101]  lock_id        u64
    //      [101..109] min_amount     u64
    //      [109..141] bond_token     [u8;32]
    //      [141..173] supply_token   [u8;32]
    let mut journal = Vec::with_capacity(173);
    journal.push(1u8); // result = true
    journal.extend_from_slice(&claim_type.to_be_bytes());
    journal.extend_from_slice(&issuer_id);
    journal.extend_from_slice(&threshold.to_be_bytes());
    journal.extend_from_slice(&nonce.to_be_bytes());
    journal.extend_from_slice(&expiry.to_be_bytes());
    journal.extend_from_slice(&escrow_arr);
    journal.extend_from_slice(&lock_id.to_be_bytes());
    journal.extend_from_slice(&min_amount.to_be_bytes());
    journal.extend_from_slice(&bond_token_arr);
    journal.extend_from_slice(&supply_token_arr);
    env::commit_slice(&journal);
}
