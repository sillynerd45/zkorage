# zkorage proving-systems Q&A

Why zkorage proves with RISC Zero, and how that compares to the main circuit-based alternatives (Noir with
the UltraHonk backend, and Circom). Includes the client-side file question and the trust model. Written for
reuse with users, judges, and reviewers. Accurate as of 2026-06-20.

This is a demo on Stellar testnet with a mocked attester, so read the trust section as the design intent and
its honest limits, not a finished security posture. For where uploaded data goes, see
[data-handling-qa.md](data-handling-qa.md).

## TL;DR

- We prove with **RISC Zero, a zkVM**: write ordinary Rust, prove that it ran, wrap the proof to Groth16 over
  BN254, and verify it on Soroban. Pinned at RISC Zero 5.0.0-rc.1.
- The alternatives are **circuit languages**: **Noir** (default backend UltraHonk) and **Circom** (default
  backend Groth16 via snarkjs). You describe the computation as constraints rather than as a program.
- We chose RISC Zero for four reasons that matter to this project: you write Rust and reuse real crypto
  crates; one **universal** trusted setup lets the predicates change freely; **nothing proving-related ships
  to the user** (the UX win); and a ready Groth16 verifier already exists for Soroban.
- A relying party never has to trust our prover. Trust is **on-chain verification against a pinned program
  hash**, plus the **attester** who signed the underlying claim.

## Q: Are we using RISC Zero?

Yes. Every proof is produced by a RISC Zero zkVM guest written in Rust. The guest verifies an ed25519-signed
claim envelope and asserts a predicate; the host produces a STARK of that execution and wraps it to a Groth16
SNARK over BN254. The Soroban verifier (`NethermindEth/stellar-risc0-verifier`, rebuilt for soroban-sdk
26.1.0) checks it on-chain. There is no other proving system in the stack.

## Q: What are the three options, in one line each?

- **RISC Zero (zkVM):** write Rust, prove execution, wrap to Groth16 over BN254.
- **Noir + UltraHonk:** write a Rust-like circuit (Noir), prove with Aztec's Honk-family backend over BN254.
- **Circom + Groth16:** write low-level R1CS constraints, prove with snarkjs/rapidsnark, usually Groth16 over
  BN254 (the same proof system and curve our on-chain verifier already checks).

## Q: The short comparison

| Dimension | RISC Zero (what we use) | Noir + UltraHonk | Circom + Groth16 |
|---|---|---|---|
| Programming model | Write Rust, reuse crates. No circuit thinking. | Rust-like circuit DSL; the compiler hides much of the constraint work. | Lowest level: wire signals and constraints by hand. |
| Trusted setup | Universal: one setup for the whole zkVM. Change a guest freely. | Universal/updatable SRS; no per-circuit setup. | **Per-circuit**: a new ceremony for each circuit, and again whenever it changes. |
| Soroban verification | Groth16 over BN254. Ready verifier exists. | Honk over BN254. A community verifier exists (`rs-soroban-ultrahonk`): testnet-proven, unaudited, ~24 KB WASM, ~81M instr, ~14.6 KB proof. | Groth16 over BN254. Reuses the same verifier primitive with a per-circuit key. The closest fit. |
| Proof size | ~200 bytes, one pairing check. | A few KB, heavier verification. | ~200 bytes, one pairing check. |
| Prover cost | Heavy: proves a whole RISC-V trace. | Light per circuit. | Light per circuit. |
| Client-side proving | Not feasible (too heavy). | Feasible for modest circuits (Barretenberg WASM). | Feasible for modest circuits (snarkjs WASM). |
| Audit risk | Low: no hand-written constraints. | Moderate. | Higher: under-constrained signals are a classic bug class. |
| Maturity | Younger, growing. | Younger, growing. | The most battle-tested circuit language. |

## Q: What is the trusted-setup difference, and why does it matter here?

This is the decisive one. RISC Zero's Groth16 wrap proves a **fixed** circuit (the STARK verifier), so the
trusted setup is done **once for the whole zkVM**. Changing a guest program does not need a new ceremony; the
specific program is identified by its `image_id`, a hash committed as a public input.

With Circom + Groth16 the setup is **per circuit**. zkorage proves many predicates and they keep evolving
(anonymous membership, bonded access, a solvency proof, an expiring tier, RSA-signed documents). In a Circom
world each one needs its own ceremony, and changing a predicate means another ceremony plus a fresh trust
assumption. A zkVM's one-time universal setup is exactly what lets the predicate set grow without that
burden. (Noir + UltraHonk also avoids per-circuit setup via its universal SRS, and a Soroban verifier for it
does exist as a community reference, see below.)

## Q: How does each verify on Soroban?

- **RISC Zero:** Groth16 over BN254. A ready verifier exists and is what zkorage deploys.
- **Circom + Groth16:** also Groth16 over BN254. It reuses the **same** pairing-based verifier primitive,
  configured with the circuit's own verifying key. Of the three alternatives it is the most Soroban-ready,
  because the on-chain check is the same kind we already run.
- **Noir + UltraHonk:** Honk-family proofs over BN254. A Soroban verifier does exist as a community
  reference (see the next question), so a Noir path is feasible. The trade is a much larger proof and a
  heavier verify, against a verifier that is unaudited and covers only the non-ZK, non-recursive path.

(All three use BN254 here, which matches our hard rule: this engine is on BN254, not BLS12-381.)

## Q: Does a Soroban UltraHonk verifier actually exist?

Yes. `rs-soroban-ultrahonk` (the community repo `yugocabrio/rs-soroban-ultrahonk`, MIT) is a Soroban contract
plus a `no_std` Rust crate (`ultrahonk-soroban-verifier`) that verify Noir/UltraHonk proofs on-chain using
Soroban's BN254 host functions (`bn254_g1_msm`, `pairing_check`). It targets the native UltraFlavor path that
Nargo 1.0.0-beta.9 and Barretenberg 0.87.0 produce: a Keccak-256 transcript, a non-ZK sumcheck over 26
subrelations, and Shplemini batch opening (Gemini plus Shplonk plus KZG). It ships example circuits (identity,
tornado, range-heavy, lookup-heavy) and runs the full deploy-and-verify pipeline on Stellar testnet.

Reported numbers from its identity example: contract about **24 KB WASM**, verify about **81M CPU
instructions** on Protocol 26, proof **14,592 bytes**, and roughly **0.014 XLM** per verify on testnet. The
verifying key is set once in the constructor and is immutable, so changing the circuit means redeploying with
a new VK. For comparison, a RISC Zero Groth16 proof is about 200 bytes and verifies more cheaply, and the
~81M-instruction UltraHonk verify sits close to the ~100M instruction budget, which leaves little headroom for
larger circuits.

Caveats worth stating plainly: it is **unaudited** (it does carry a detailed `VERIFIER_PROVENANCE.md` that
maps the Rust code 1:1 to Barretenberg, but that is a self-review, not a third-party audit), and it implements
**only the non-ZK, non-recursive** path (no UltraZKFlavor hiding polynomial, no recursion, no Goblin or Mega,
no IPA or Grumpkin, Keccak transcript only). So it removes the "no verifier" objection to a Noir path and is a
solid reference to build on, but it is not a production-hardened component.

This corrects an earlier version of this doc, which said no Soroban UltraHonk verifier existed.

## Q: I remember Circom needs a file on the client whose size grows with the circuit. What is it?

Two files, both of which grow with circuit complexity:

- **`circuit_final.zkey`**, the Groth16 **proving key**. This is the big one; its size scales with the number
  of constraints. For complex predicates it can be tens to hundreds of MB, even over a GB.
- **`circuit.wasm`**, the **witness generator**, also size-scaling (the `.zkey` usually dominates).

To prove in the browser you call roughly `snarkjs.groth16.fullProve(input, "circuit.wasm",
"circuit_final.zkey")`, so the user's browser has to download and hold both before it can produce a proof.
The size pain is well known: Semaphore-style circuits are tens of MB, Tornado-style ones are hundreds of MB,
and zkEmail (RSA plus email parsing, similar to our RSA document-authenticity proof) had a proving key around
1.6 GB, which was unusable on mobile.

## Q: So why is RISC Zero the better choice on UX?

Three points, the first being the main one:

1. **Nothing proving-related ships to the user.** The browser downloads only the normal web app. It sends a
   request to the self-hosted prover and gets back a ~200-byte proof to show or verify. There is no
   multi-hundred-MB key to fetch.
2. **RISC Zero does have a large key, but it lives once on the prover and is fixed.** RISC Zero's final wrap is
   itself a Circom circuit (the STARK verifier), which is why `circom-witnesscalc` appears in
   `prover/Cargo.lock`. Its proving key (`stark_verify_final.zkey`) is about 5 GB, but it is **universal**:
   the same for every predicate, mounted on the self-hosted prover (`~/.risc0`), and it never touches the
   client. With raw Circom you would have one such key **per circuit**, and if you prove client-side it sits
   in the browser.
3. **Per-circuit setup is an ops and UX cost too.** Each new or changed predicate in a Circom world means a
   new ceremony that produces a new `.zkey` to distribute. With RISC Zero you change the Rust guest and ship
   it. No ceremony, no new key for anyone to download.

The trade we accept for this UX is heavier proving on the prover box (RISC Zero proves a whole RISC-V trace),
which is why proving is self-hosted on a GPU or a strong CPU rather than in the browser.

## Q: Could we offer Noir or Circom as a user-selectable alternative?

Not as a toggle. It would be a **parallel engine**, for three reasons:

1. The verifier and its maturity. A Soroban UltraHonk verifier does exist (`rs-soroban-ultrahonk`), so Noir is
   no longer blocked on verification, but that verifier is unaudited and covers only the non-ZK, non-recursive
   path, and its verify cost (~81M instructions) sits close to the budget. Circom would reuse our Groth16
   verifier with a per-circuit verifying key. Either way each circuit becomes its own deployed verifier with
   its VK pinned at deploy.
2. Every predicate would be rewritten as a circuit, including RSA-2048 and ed25519, which are large and
   awkward in a circuit DSL but a few lines of Rust with a crate in RISC Zero.
3. It does not improve the trust or privacy story (see the next two questions).

The one genuine upside of a circuit path is **client-side proving**: Barretenberg (Noir) and snarkjs (Circom)
run in WASM, so for modest circuits the data owner could prove on their own device and the data would never
leave it. For our heavy predicates that is a real project rather than a switch, and the client-file sizes
above are the cost. So the recommendation is to keep RISC Zero as the single engine, and treat client-side
proving as a future research direction if a Soroban Honk verifier ever lands or a Circom path is built out.

## Q: Why should a relying party trust our self-hosted zkVM?

They do not have to, and that is the point of using ZK here.

- **Trust is math plus the chain, not our server.** The proof is checked on-chain by the Soroban Groth16
  verifier, and the policy contract checks it against a **pinned `image_id`** (a hash of the exact guest
  program). A prover cannot forge a valid proof for a false statement, because it does not hold a valid
  witness or signature.
- **"Self-hosted" is about privacy, not about trusting us.** The prover sees the plaintext, so the data owner
  runs the prover to keep their data off third-party machines. The verifier never sees the data and never has
  to trust how the prover handled it.
- **The program is checkable.** Because the `image_id` is a commitment to the guest, anyone can rebuild the
  guest deterministically (`cargo risczero build`, the Docker build) and confirm the hash matches what the
  contract pins. So "trust our zkVM" reduces to "verify the published program hash," which is public.

Two honest caveats:

1. **The real trust dependency is the attester.** The proof shows "a trusted attester signed claim X and the
   predicate holds." It does not prove the real-world fact on its own, so the verifier trusts the math plus
   the issuer key allowlisted on-chain. In this demo the attester is mocked, so that link is only as strong
   as the mock. Production needs a real signer, zkTLS, or an on-chain source.
2. **The demo prover is project-hosted.** The architecture supports the data owner running their own prover,
   which is the intent of self-hosting, but the public demo runs a shared prover that the project operates.
   The verifier's trust is unchanged either way, because verification is on-chain.

## Q: How is the self-hosted prover different from Boundless?

Same RISC Zero technology, same proofs, same on-chain verification. The difference is **who runs the prover
and whether the secret input is exposed**:

- **Boundless** is RISC Zero's decentralized proving marketplace. You outsource proof generation to
  third-party provers who get paid, and those provers **see the witness**.
- **Self-hosted** keeps the plaintext witness local.

Because the prover sees plaintext, sending a private witness to a marketplace would leak the private data to
whoever generates the proof. So zkorage self-hosts proving for private witnesses (a hard rule), and never
sends them to Boundless. Boundless is a fine fit for proofs whose inputs are public, but it is the wrong tool
for private-data proofs.

## Bottom line

For an engine that proves many evolving predicates over real cryptography and verifies cheaply on Soroban,
RISC Zero wins on developer reach (write Rust), on setup (one universal ceremony), on UX (no proving key for
the user to download), and on a ready on-chain verifier with small, cheap-to-verify proofs. Circom is the most
Soroban-compatible alternative because it shares the Groth16 and BN254 path, and it can prove client-side, but
per-circuit trusted setups, the large client-side `.zkey`, hand-written circuits, and the under-constraint
audit burden make it a parallel engine rather than a switch. Noir + UltraHonk is more viable on Soroban than a
first look suggests, because a community verifier (`rs-soroban-ultrahonk`) already runs it on testnet; the
trade is a ~14.6 KB proof and a ~81M-instruction verify against an unaudited, non-ZK-only verifier, plus
rewriting each predicate as a circuit. Client-side proving stays the genuine upside of either circuit path.
