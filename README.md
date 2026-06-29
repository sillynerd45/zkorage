<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/brand/zkorage-mark-light.jpg">
    <img alt="zkorage logo" src="frontend/public/brand/zkorage-mark-dark.jpg" width="96" height="96">
  </picture>
</p>

<h1 align="center">zkorage</h1>

<p align="center">Prove a fact about private data without showing the data, and let anyone check the proof on Stellar.</p>

You hold some private information. It could be a document, a reserve balance, or a KYC record. You want to
prove one fact about it ("reserves are at least the supply", "this person passed KYC", "this file says
revenue is over $X") to someone who should not see the raw data. zkorage runs a zero-knowledge proof on a
machine you control, turns it into a small proof, and a Stellar (Soroban) smart contract verifies it
on-chain. The person checking the proof never sees your data and does not have to trust our server.

> Built for the **Stellar Hacks: Real-World ZK** hackathon. The contracts are **unaudited. This is a demo on
> testnet.**

## Links

- **App (live demo):** https://zkorage.wazowsky.id
- **Source code:** https://github.com/sillynerd45/zkorage
- **API:** https://apizk.wazowsky.id

The app runs on Stellar **testnet**. You can browse and verify everything with no wallet. To create your own
proofs and pay your own gas, connect a wallet (see [Wallet support](#wallet-support)).

## What you can do

The app has two main areas.

### Confidential Data Room

Store an encrypted document and share it only with people who prove they are allowed to open it, without
revealing who they are. The file itself stays encrypted. Only a tamper-evident fingerprint goes on-chain.

A room owner picks one of two access models:

- **Membership.** The owner approves a list of members. An approved member opens a document by proving they
  are on the list, without revealing which member they are, and only once per room (a nullifier blocks reuse).
- **Bonded Access.** The owner sets a requirement: a token, a minimum amount, and a deadline. Anyone who
  locks a qualifying bond can open the room with no approval and no member list. The reader proves they hold a
  qualifying bond without revealing which wallet, which lock, or the exact amount.

When someone is allowed to open a document, the document key is released by a 2-of-3 keeper committee, so no
single server ever holds the key. The reader collects two of the three sealed shares and rebuilds the key in
their own browser.

### Bonded Proofs

Lock tokens in a time-locked escrow contract on Stellar, then build proofs on top of that lock.

- **Bonded Access bond.** The same bond above also works as a standalone, anonymous access gate. Lock a
  qualifying bond once and reuse it to open every room that asks for the same requirement.
- **Earlier proof demos.** A solvency proof that becomes void the moment you withdraw your collateral, and an
  anonymous tier that expires at a chosen deadline. These were earlier demos and stay reachable by URL.

### The public site

Outside the app, the public site has a landing page, **Documentation**, a **Verify** page (paste a link or an
id and re-check it on-chain), an **Explorer** of public rooms, and a **Faucet** that hands out the four test
tokens used by Bonded Access.

## Wallet support

zkorage derives your private keys by having your wallet sign one fixed message, then running that signature
through a key-derivation step (sign-to-derive). Nothing is stored, so you get the same keys on any device. This
needs a wallet that supports deterministic message signing the SEP-53 way (a sha256 over the standard "Stellar
Signed Message" prefix, signed with ed25519, returning the same bytes every time).

- **Freighter (tested).** This is the only wallet wired into the app today, and the one we test against.
  Install the Freighter extension, set it to **Testnet**, and connect from the top right.
- **xBull (not integrated yet).** xBull signs the same SEP-53 way, so it would derive the same identity, but
  it is not wired in yet. Support is planned through the Stellar Wallets Kit.

Other wallets are out for now. Rabet and Albedo sign arbitrary messages in their own non-SEP-53 formats, so
they would produce a different identity, and the rest were not checked.

You only need a wallet to make your own proofs and pay your own gas. Reading and verifying on-chain needs no
wallet.

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/diagrams/zkorage-architecture-dark.png">
    <img alt="How zkorage works" src="frontend/public/diagrams/zkorage-architecture-light.png" width="880">
  </picture>
</p>

Three pieces:

- **Prover (off-chain, self-hosted).** A RISC Zero zkVM guest checks the private input, asserts the fact you
  want to prove, and produces a STARK proof. The host wraps that into a small Groth16 proof over the BN254
  curve. The prover is the only party that ever sees the private data, so we run it ourselves and never send a
  private input to a third-party proving service.
- **Verifier (on-chain).** A bare Groth16 verifier contract on Soroban checks the proof with native BN254
  pairing host functions. A small policy contract then binds the proven fact to on-chain facts (a token's
  supply, a lock's state) and records the result. Anyone can re-read and re-check it.
- **Attestation.** The private data is signed by a trusted party (a custodian, an auditor, a KYC provider).
  The signature is checked inside the zkVM, so a proof is only as good as the signed claim behind it. The demo
  uses a mock signer that can be swapped for a real one.

The whole stack runs on **RISC Zero 5.0.0-rc.1**, with GPU proving on a self-hosted box and a CPU fallback.

## Repository layout

```
contract/   Soroban contracts (Rust): the bare Groth16 verifier, a demo SEP-41 token, and the policy/gate
            contracts (Data Room, escrow, bond gate, and the earlier per-use-case gates).
prover/     RISC Zero zkVM guests + host. Builds and runs on an x86 + Docker box, not on Windows.
backend/    Node/TypeScript API: mock attester, prover proxy, on-chain verify/submit, and the REST surface.
frontend/   Vite + React + TypeScript (Tailwind + shadcn). Public site (/) plus the sidebar app (/app/*).
sdk/        zkorage-sdk: a read-only TypeScript SDK to query and re-verify claims straight from the chain.
mcp/        zkorage-mcp: a read-only MCP server that exposes the SDK as agent tools. No key custody.
keyper/     The 2-of-3 keeper committee that splits and releases each Data Room document key.
deploy/     Dockerfiles and deploy notes for the prover VM.
```

## Run it locally

You need **Node 22**. These steps run the web app against the live testnet contracts. You do not need the
prover or Docker just to browse, read, or verify. Run each server in its own terminal.

```bash
# 1) Build the SDK first. The backend and frontend consume it via file:../sdk.
cd sdk && npm install && npm run build

# 2) Backend API on :8787 (leave it running)
cd backend && cp .env.example .env && npm install && npm run dev

# 3) Frontend on :5173 (leave it running)
cd frontend && npm install && npm run dev
```

The contract ids are already filled in `backend/.env.example`. To submit transactions through the server
relay, set `SIGNER_SECRET` to a funded testnet key. Reads and verification work without it.

**Cloudflare R2 is optional.** The backend stores the encrypted Data Room files in object storage. Leave the
`R2_*` variables blank in `backend/.env` to use the built-in local store at `backend/data/blobs`, which is
fine for local development. To use Cloudflare R2 instead, set `R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in `backend/.env`.

Open http://localhost:5173. Connect Freighter (set to Testnet) to sign your own transactions, or use the app
without a wallet to read and verify.

### Run the prover

The prover turns a private input into a proof. It is self-hosted on purpose, because it is the only part of
the system that sees the private data. You do not need it to browse, read, or verify. You only need it to
create new proofs. It builds and runs on Linux (x86_64), not on Windows.

You need the Rust toolchain, RISC Zero (installed with `rzup`), and Docker (the final Groth16 wrap runs in a
container).

```bash
cd prover
cargo run --release -p host    # proves the bundled demo claim and writes a proof bundle
```

To produce proofs that verify on-chain you need the canonical, reproducible guest build, and there is also a
distributed setup (a public gateway plus a GPU or CPU worker). Both are documented in `prover/README.md`.

### Build the contracts

Building the Soroban contracts needs the Rust toolchain and the `stellar` CLI. This is not required to run the
web app above, since the contracts are already deployed to testnet (see
[Deployed contracts](#deployed-contracts-testnet)).

## Self-test

```bash
cd sdk && npm run smoke              # re-verify the live testnet claims from the chain
cd mcp && npm install && npm run build && npm run selftest   # a client calls every MCP tool

# Frontend end-to-end tests (Chrome runs GPU-disabled, do not change that):
cd frontend && npx playwright install   # first run only: download the test browser
npx playwright test
```

To run the frontend tests against the live site instead of a local server:

```bash
cd frontend && BASE_URL=https://zkorage.wazowsky.id npx playwright test
```

## Deployed contracts (testnet)

These are the contracts the app uses today. The full record, including the earlier per-week gates, is in
`contract/deployment.testnet.json`, and the in-app **Contracts** page reads them live.

| Contract | Id |
|---|---|
| Groth16 verifier (RISC Zero, params 5.0.0-rc.1) | `CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW` |
| Data Room | `CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN` |
| Escrow (time-locked bond) | `CAMQKJKAJTOMT66N5N3E3VIRTN5ACDKV6P3Z2HLYVJHLAVRGJKHZFOXC` |
| Bonded Access gate | `CCKX6B7QIE42YA27Y4KTB6CTXRB3OBGR5EW7N2BLAG4AB3V6CFDKXCZU` |

## Verify a claim yourself, with no zkorage server

Every result lives on the public chain, so you can re-check it directly. The Verify page in the app shows the
exact commands for any given claim. As an example, read a Proof-of-Reserves result and re-verify its proof
against the public verifier:

```bash
# Read the persisted result + history from the chain:
stellar contract invoke --id CDQ2PA27UTJDLPA4XTGG647SNTMUYO2KRFGS3SW5SMNBIWRB7JVCZXQ6 \
  --network testnet --source <any-funded-account> -- get_latest_result

# Re-verify the Groth16 proof against the public verifier (the bundle comes from GET /audit/latest):
stellar contract invoke --id CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW \
  --network testnet --source <any-funded-account> -- verify --seal <hex> --image_id <hex> --journal <hex>
```

Here `journal` is the sha256 digest of the journal bytes. The app's Verify page fills in the exact values for
any claim, so you do not have to assemble them by hand.

## Status

The full build is complete and live on testnet: the use-case proofs (Proof-of-Reserves, KYC, Compliance,
Confidential payroll, Fundraising), the Confidential Data Room, the Bonded Proofs escrow, and Bonded Access.
The app focuses on the Data Room and Bonded Proofs. The earlier per-use-case proofs stay reachable by URL.

This is a hackathon demo. The contracts are unaudited. Do not use them with real funds.
