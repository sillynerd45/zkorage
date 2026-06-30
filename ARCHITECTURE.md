# zkorage architecture

This is the deeper companion to the [README](README.md). It covers the proving pipeline, the on-chain
verifier and gate pattern, the full contract set on testnet, the Data Room and Bonded Proofs internals, and
the build and deploy paths. Read the README first for what zkorage does and why the zero-knowledge is
load-bearing.

## The engine in one pass

zkorage has three moving parts and one anchor.

1. A **prover** turns a private witness into a small proof of one fact, off-chain, on hardware we control.
2. A **verifier** contract on Soroban checks that proof on-chain with native BN254 host functions.
3. A **policy / gate** contract binds the proven fact to on-chain facts (a token supply, a lock state) and
   records the result so anyone can re-read and re-check it.
4. The **anchor** is what makes a proof mean something: an attester signature checked inside the zkVM, or an
   on-chain fact the gate enforces. Without an anchor, a proof of "I computed correctly over my inputs" says
   nothing about whether the inputs were real.

## Prover (off-chain, self-hosted)

A RISC Zero zkVM guest reads the private input, checks it, asserts the predicate, and commits a small public
journal. The host proves the guest execution as a STARK and then wraps that STARK into a Groth16 proof over the
BN254 curve, which is what the Soroban verifier checks.

We self-host proving on purpose. The prover is the one party that sees the plaintext witness, so sending a
private witness to a shared proving market would hand the secret away. zkorage never does that.

The prover runs as two cooperating machines behind a Cloudflare tunnel (`prover.wazowsky.id`):

- a **gateway** that accepts proving jobs and hands them out, and
- a **worker** that does the proving. A GPU worker on RISC Zero 5.0.0-rc.1 is primary, with a CPU worker as
  fallback. Workers pull jobs, so the gateway never needs to reach into a worker.

Each predicate is a separate guest. Guests are built as reproducible Docker builds, and every prover box must
emit the same `image_id` for a given guest, because the gate contracts pin the expected `image_id`. The bare
verifier is image-agnostic, so pinning the image in the gate is what ties a proof to a specific, audited
program. Adding a new predicate kind means adding its host binary to the worker image.

### Guests and what they prove

Image ids and journal layouts are recorded in
[`contract/deployment.testnet.json`](contract/deployment.testnet.json). Summary:

| Guest | Claim type | Proves | Image id (prefix) |
|---|---|---|---|
| Proof-of-Reserves / revenue | 2, 6 | A signed value is at least a threshold | `973c9831…` |
| Identity / KYC | 3 | A subject passed KYC, subject hidden | `a5198a5a…` |
| Compliance | 4 | KYC and not-sanctioned (Merkle non-membership) | `54d5921c…` |
| Payroll | 5 | Income at least a threshold, salary sealed to an auditor view key | `2c9cc61b…` |
| Accredited investor | 7 | Accreditation by an allow-listed provider | `26d74373…` |
| Data Room seal | 8 | A document key is sealed (ECIES) to a recipient and bound to the blob | `8f24842d…` |
| Membership (Data Room DR2) | 9 | Membership in a set plus a nullifier, member hidden | `9550a12e…` |
| Document authenticity (DR4) | 10 | A real RSA-2048 bank-statement signature, re-verified in-zkVM | `e4f4a356…` |
| Solvency (Bonded Proofs) | 12 | Reserves at least supply, bound to a live escrow lock | `d0a2f137…` |
| Anonymous tier (Bonded Proofs) | 13 | Membership in a qualifying set, expiring at a deadline | `2671938b…` |
| Bonded Access | 14 | The holder locked a qualifying bond, wallet and amount hidden | `dc4da02d…` |

The membership and tier guests use ed25519 plus sha256 only, so their image ids reproduce across machines. The
seal guest adds x25519, and the document-authenticity guest runs an RSA-2048 modular exponentiation in-zkVM
(about 22 segments), which is the heaviest predicate.

## Verifier and the gate pattern (on-chain)

The verifier is the bare `Groth16Verifier` from Nethermind's `stellar-risc0-verifier`, rebuilt against
soroban-sdk 26.1.0, checking proofs with native BN254 host functions (Protocol 26). It is unaudited and for
the demo only.

Each gate contract follows the same shape:

1. Recompute `sha256(journal)` on-chain from the submitted journal bytes.
2. Cross-call the bare verifier with `verify(seal, image_id, journal_digest)`.
3. Check the pinned `image_id` and the claim type, so only the intended program counts.
4. Bind the proven fact to on-chain facts: compare `journal.supply` to `token.total_supply()`, read
   `escrow.get_lock(lock_id)` for liveness, check a nullifier has not been used, and so on.
5. Record the result and emit an event.

The decisive design choice is that `is_granted` recomputes the live conditions on each read rather than trusting
a stored flag. That is why a solvency grant flips to void the instant the collateral is unbonded.

## Deployed contracts (testnet)

Deployer `GDLECNXD…GXZY6`. The four the live app leans on are in the README; the full set:

| Contract | Id |
|---|---|
| Groth16 verifier | `CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW` |
| Demo SEP-41 supply token (zUSD) | `CC3JKNC4EKALMT7WALUMCTVBSH73ZZSP3AC4B7IQUAZ7UYYZCEIISQLA` |
| Data Room (DR1-DR6) | `CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN` |
| Escrow (time-locked bond) | `CAMQKJKAJTOMT66N5N3E3VIRTN5ACDKV6P3Z2HLYVJHLAVRGJKHZFOXC` |
| Bond token (zkUSD) | `CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5` |
| Bonded Access gate | `CCKX6B7QIE42YA27Y4KTB6CTXRB3OBGR5EW7N2BLAG4AB3V6CFDKXCZU` |
| Solvency gate | `CDHUG4NFTDIO4HX2MZH3PR77EKYUAU47HVKH4UO2WG7GSKDEF4ABWMLA` |
| Tier gate | `CASSJSBMFDS3BCUBYKXG52SUS7GIHBCHDUM5FGQO4LY5VOWPUPPUFKZP` |
| Proof-of-Reserves policy (set aside) | `CDQ2PA27UTJDLPA4XTGG647SNTMUYO2KRFGS3SW5SMNBIWRB7JVCZXQ6` |
| KYC gate (set aside) | `CCTHDSEQFMAOPJXI5GVSUTMXO5DHZUJS7YQYAEIGKFMOAMTNDKSL4FWT` |
| Compliance gate (set aside) | `CDSA3PUL7OZ5HKLIT73ZTG64TLYK4QTO5ZHZKHA3JBS76R5L5Q2EO4FV` |
| Payroll gate (set aside) | `CA6XYNHYR3GS3TQ24Z2Y45SXRNQDA5Z4L2PU54YM2WUKSMPVWVMYZCDA` |
| Accredited gate (set aside) | `CCLSXZBOPCAJQS6L54EAGZQHTD5QUES2OSYCFX5XJT6ZXSICRPS4QKQZ` |
| Fundraise access (set aside) | `CDEV4METH74Z42DFV6HC3VLF3PWACXVIIS7C3PLK6CZT2B6L5I3YBC2L` |

## Confidential Data Room internals

The Data Room contract was built in place over DR1 to DR6, so all of it lives at one contract id with storage
preserved across upgrades.

- **DR1, data plane.** `create_room` then `put_document`. The seal guest seals the AES-256-GCM document key to
  a recipient x25519 key and binds it to the content hash, room id, and document id. The ciphertext is stored
  off-chain (Cloudflare R2, or a local store for development), content-addressed by its hash. Only the
  fingerprint goes on-chain.
- **DR2, anonymous eligibility.** A member proves a leaf in a depth-20 sha256 Merkle tree of approved members,
  plus a nullifier `sha256(0x02 ‖ id_secret ‖ room_id)`. The grant is keyed to the public accessor the holder
  signs for, the member identity and tree index stay private, and the nullifier blocks a second open. Rotating
  the eligible root revokes stale grants.
- **DR3, key release.** A self-built 2-of-3 threshold committee (`keyper/`). The document key is Shamir-split
  over GF(256), and each keeper seals its share (ECIES) only to the proof-bound recipient on the on-chain
  grant, reading `is_granted` from its own RPC. The reader collects two shares and reconstructs the key in the
  browser. No key material is ever on-chain.
- **DR4, document authenticity.** Re-verifies a real RSA-2048 signature over a bank statement inside the zkVM
  and asserts a field is at least a threshold, statement and exact value hidden.
- **Bonded Access (claim type 14) and Room Management.** A room is Membership or Bonded Access, not both. A
  bonded room needs no approval and no member list: a reader locks a non-revocable qualifying bond and proves
  it anonymously to open.

The SDK reproduces the key-free open byte-for-byte, so the open runs entirely in the browser and the recipient
secret never leaves it. The MCP server exposes read-only tools only, with no open or key tool.

## Bonded Proofs internals

- **Escrow.** A Soroban-native, time-locked bond over a SEP-41 token. It stores the time the lock expires and a
  revocable flag, and exposes `is_locked` / `get_lock` for cross-contract reads. Self-deposit auth is
  source-account only.
- **Solvency gate.** Verifies a solvency proof, then binds it to the live escrow lock and the token supply.
  Because `is_granted` recomputes liveness on each read, the grant voids the moment the bond is pulled.
- **Tier gate.** An anonymous tier that expires at a deadline, extending the membership guest with a second
  Merkle path that proves the holder is in a qualifying set, with a one-time nullifier per accessor.
- **Bond gate.** The multi-token gate behind both standalone Bonded Access and the Data Room bonded rooms. The
  owner sets any wallet token, a minimum amount, and a deadline, and the anonymity set is enforced per
  requirement.

## Attestation

For the signature-anchored use-case proofs, the private data is signed as an ed25519 envelope
`{claim_type, value(s), issuer_id, nonce, expiry}`. The guest verifies the signature and asserts the committed
`issuer_id` equals the key that signed, so a prover cannot verify under their own key while claiming an
allow-listed issuer. Trust is anchored by an issuer-key allowlist held in the contract. The demo uses mock
signers, swappable for real issuers.

## Build, test, deploy

- **Build order.** Build the SDK first (`cd sdk && npm install && npm run build`); the backend and frontend
  consume it via `file:../sdk`.
- **Contracts.** Build with the `stellar` CLI to WASM and deploy to testnet. Always `simulateTransaction` to
  measure verify cost (the budget is about 100M instructions, and the verify WASM stays under 64 KiB). Deploy
  scripts are in `contract/scripts/`, and ids land in `contract/deployment.testnet.json`.
- **Prover.** Install RISC Zero 5.0.0-rc.1 via `rzup` (which provides `r0vm` and `cargo-risczero`) plus Docker
  for the reproducible guest build and the final Groth16 wrap. Details in [`prover/README.md`](prover/README.md).
- **Frontend and backend.** Run with vite and the Node API as in the README. Frontend end-to-end tests run on
  real Chromium with the GPU disabled, which must stay that way.
- **Deploy.** The frontend and backend run as Docker containers on the prover VM, exposed by a Cloudflare
  tunnel (`zkorage.wazowsky.id`, `apizk.wazowsky.id`, `prover.wazowsky.id`). The flow is in
  [`deploy/README.md`](deploy/README.md).

## Pinned stack

- `soroban-sdk = 26.1.0` (Protocol 26, BN254 host functions).
- RISC Zero `5.0.0-rc.1`. Changing the version means regenerating verifier params, redeploying the bare
  verifier, rebuilding all guests, and re-pinning the contracts.
- `ark-bn254 0.5.0`, Rust edition 2024 on stable (1.85 or newer).
- In-guest signatures use RISC0-patched ed25519-dalek.
- Frontend and SDK use `@stellar/stellar-sdk`; the MCP server uses the Model Context Protocol TypeScript SDK.

## Trust model, recap

The verifier learns one fact and nothing else. The prover sees the plaintext, so proving is self-hosted and
never sent to a shared market. The result is on-chain, so anyone re-reads and re-verifies it without a zkorage
server. Every claim is anchored to an attester signature checked in the zkVM or to an on-chain fact the gate
enforces. The contracts are unaudited and for the testnet demo only.
