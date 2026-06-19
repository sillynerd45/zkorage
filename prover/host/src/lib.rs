// Shared host helpers for the zkorage prover bins.
//
// Local `encode_seal` — risc0-ethereum-contracts has no risc0-5.x release, so we reimplement the
// (tiny, stable) Groth16 seal encoding the Stellar verifier expects: the 4-byte selector
// (= the receipt's verifier_parameters digest, first 4 bytes) followed by the Groth16 proof bytes.
// This is byte-identical to risc0_ethereum_contracts::encode_seal for a Groth16 receipt.
use risc0_zkvm::Receipt;

/// Encode a Groth16 receipt into the on-chain seal: `selector(4) || groth16_seal(256)` = 260 bytes.
pub fn encode_seal(receipt: &Receipt) -> Vec<u8> {
    let g = receipt
        .inner
        .groth16()
        .expect("receipt is not a Groth16 receipt (prove with ProverOpts::groth16())");
    let mut out = Vec::with_capacity(4 + g.seal.len());
    out.extend_from_slice(&g.verifier_parameters.as_bytes()[..4]);
    out.extend_from_slice(&g.seal);
    out
}
