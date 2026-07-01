# zkorage data-handling Q&A

What happens to the data you put into zkorage: where it goes, what is stored, and what is not. Written for
the question "does the prover save my uploaded document, or only hold it in memory?". Every claim points at
the code so you can check it yourself. Accurate as of 2026-06-21.

This is a demo on testnet with a mocked attester, so read the residual risks at the end as honest limits,
not as a finished security posture. For why we prove with RISC Zero and how it compares to Noir and Circom,
see [proving-systems-qa.md](proving-systems-qa.md).

## Two senses of "the prover"

- **The backend** (`backend/`): the orchestration server. It encrypts your document, stores the encrypted
  blob, and talks to the zkVM.
- **The zkVM prover** (`prover/`): the RISC Zero gateway on the VM plus the GPU worker. It generates the
  proof. It does not store documents.

The landing copy "the data never leaves the prover you run" is about plaintext. Only ciphertext ever leaves
this boundary, and the key that would open it does not travel with it.

## TL;DR

- Your **document plaintext is never written to disk in the clear**, anywhere. The backend keeps it in a
  memory buffer only, encrypts it, and persists only the encrypted blob.
- The **zkVM prover never receives the document bytes** for a Data Room upload. It is handed the document
  key, the recipient key, and the content hash, not the file.
- The prover's **job queue is in memory** and is lost on restart. Two on-disk exceptions exist for the proof
  inputs, and both are described honestly below.
- What **is** persisted by design is the **encrypted blob** (so the recipient can fetch it later) and the
  public on-chain record (a fingerprint and the sealed key, never the plaintext or the key in the clear).

## The Store data flow, step by step

1. You submit a document to `POST /dataroom/prove-seal` (`backend/src/server.ts:1655`).
2. The backend reads it into a memory buffer (`plaintext`), generates a fresh random key `K`, and encrypts
   with AES-256-GCM: `aeadSeal(plaintext, K)` (`server.ts:1688-1689`).
3. It sends the zkVM prover only `K`, the recipient's x25519 key, the content hash, and the room/doc ids
   (`server.ts:1691-1702`, fields listed at `prover/gateway/gateway.py:59`). The plaintext is not sent.
4. It persists **only the ciphertext** to the blob store: `getBlobStore().put(blob)` (`server.ts:1706`). The
   store is content-addressed by `sha256(ciphertext)`.
5. The plaintext buffer goes out of scope and is garbage-collected. `K` is dropped after the proof request;
   it is not persisted by the backend and never goes on-chain in the clear.
6. The proof and a fingerprint get anchored on-chain by `put_document`; the document contents do not.

## Questions and answers

### Q1. When I upload a document, does the prover store it?
No. The backend stores only the **encrypted** blob, and the zkVM prover stores nothing about the document.
The plaintext is held in memory just long enough to encrypt it.

### Q2. Is the document plaintext ever written to disk?
No, not in the clear. The only thing written for the document is the AES-256-GCM ciphertext blob
(`server.ts:1706`). The blob store backend is either local files under `backend/data/blobs` or Cloudflare R2,
both ciphertext only.

### Q3. So what is persisted, exactly?
Three things, none of them your plaintext:
- the **encrypted blob** (so the recipient can fetch and decrypt it later),
- the **on-chain record**: a content fingerprint, the recipient, and the key sealed to that recipient (the
  key is never on-chain in the clear, see `Anchor.tsx` journal rows),
- proof **bundles** the demo seeds (public journals and seals), which contain no document content.

### Q4. Does the zkVM prover even see my document?
For a Data Room upload, no. It is handed `doc_key_hex`, `recipient_pubkey_hex`, `content_hash_hex`, and the
ids (`gateway.py:59`). It proves that the key was sealed to the recipient and bound to the content hash. It
is not given the document bytes, and it does not hold the ciphertext, so it cannot reconstruct the file.

### Q5. Where does the prover keep its work, memory or disk?
The gateway keeps jobs in an **in-memory dict** (`gateway.py:73`); a restart drops them. There are two
on-disk exceptions for the proof inputs, both honest:
- **VM-CPU fallback** (`gateway.py:114-130`): writes a temporary job file plus an output file, then deletes
  **both** in a `finally` block, even if proving errors. Transient.
- **GPU worker** (`prover/worker/worker.sh:44,67`): writes `/tmp/zk.job` (the inputs) and `/tmp/zk.out.json`.
  These are **overwritten** at the start of each job but are **not explicitly deleted**, so the most recent
  job's inputs sit in `/tmp` until the next job overwrites them. For a Data Room upload those inputs are the
  document key and hashes, not the document. Hardening this (delete or shred after each job) is listed below.

### Q6. Is my data written to logs?
The gateway suppresses its HTTP request log (`gateway.py:281`) and routes the host process output to
`/dev/null` on the fallback path (`gateway.py:123-124`). The worker writes host output to `/tmp/zk.log`
(`worker.sh:67`); that is proving output, not a dump of the witness. The backend was not built to log witness
values, but it has not been audited line by line for incidental logging, so treat "no logging" as a design
intent, not a proven guarantee.

### Q7. What about a proof over private attested data, not a Data Room upload? Does the prover see that data?
Yes, by design. A proof over private attested data proves a fact about that data, so the **private witness
reaches the prover** in memory (and through the same temporary files in Q5). This is expected: a
zero-knowledge proof hides the data from the **verifier**, not from the **prover**. That is exactly why the
prover is self-hosted and why a private witness is never sent to a third-party proving marketplace.

### Q8. What are the honest residual risks?
- **Process memory.** While encrypting or proving, the plaintext or the witness is in RAM. A memory dump or
  swap-to-disk on a compromised host could expose it. This demo is not hardened against that.
- **The GPU worker's `/tmp/zk.job`** lingers until the next job overwrites it (Q5).
- **The encrypted blob may live in Cloudflare R2**, a third party. That is acceptable because it is
  ciphertext and the key is sealed only to the recipient, but it does mean the encrypted bytes leave the box.
- **The demo prover is project-hosted.** The architecture supports the data owner running their own prover,
  which is the point of "self-hosted", but the public demo runs a shared prover that the project operates.
- **The attester is mocked.** The proof is only as meaningful as the signer of the underlying claim. Real
  use needs a real signer, zkTLS, or an on-chain source.

### Q9. How is this different from a normal server that just promises not to store my data?
Two ways. First, the property here is structural, not a promise: the code encrypts before it persists and
sends the prover a key and a hash rather than the file, so you can read the flow and check it
(`server.ts:1688-1706`, `gateway.py:59`). Second, the part a relying party actually trusts does not depend on
this promise at all. The proof is verified **on-chain** against a pinned program hash, so a verifier never
has to believe anything about how our server handled the data.

### Q10. What is the keeper committee, and who can actually decrypt a Data Room document?
A document is encrypted under one key `K`, and after `K` is created it is never held whole by any single party.
It is split with **Shamir secret sharing** into 3 shares (2-of-3 threshold, `backend/src/shamir.ts`), one share
dealt to each of three independent **keepers** (the `keyper/` package, run as the VM-internal services
`keyper1/keyper2/keyper3`). One share reveals nothing about `K`; any two rebuild it.

To open a document, the requester first proves eligibility on-chain (the anonymous membership proof, recorded
as a grant bound to their public key). Then, on a share request, each keeper does two things **independently**
(`keyper/src/keyper.ts`):
- **Re-checks the access decision on its own Soroban RPC**: `is_doc_admitted` for a per-document policy,
  falling back to `is_granted` (`keyper/src/chain.ts:46-55`). A non-admitted requester is refused. Because each
  keeper reads its own RPC, no single RPC provider can push the threshold of keepers into releasing, which is
  why the committee runs over three distinct RPC providers.
- **Seals its share to the requester, not to the server**: it ECIES-encrypts its share to the `recipient_pub`
  committed inside the requester's proof (`keyper/src/share-ecies.ts`, byte-exact with
  `backend/src/committee.ts`). So even though shares pass back through the backend aggregator
  (`/dataroom/committee/collect`, `backend/src/server.ts:2284`), only the proof-bound recipient can open them.

The recipient then collects 2 of the 3 sealed shares, opens them with their own secret, reconstructs `K`, and
AES-256-GCM-decrypts the document. This runs **client-side in the browser** through the zkorage SDK
(`openCommitteeDocument` in `sdk/src/client.ts`, built on `sdk/src/committee.ts`); the recipient secret and the
reconstructed `K` never leave the browser, and the SDK custodies no keys.

So "who can decrypt" is not "trust one server". It is: be admitted on-chain, and get any two of three
independent keepers to release. No single keeper can release `K`, the aggregator never sees a share in the
clear, and the access decision lives on-chain.

Two honest caveats: the demo uses a **trusted dealer** at split time (whoever splits `K` sees it once, before
dealing the shares; distributed key generation would remove this), and opening needs **2 of 3 keepers live**
(if two are down, documents are temporarily unopenable, but never leaked).

### Q11. What would harden this further (future work)?
- Replace the trusted dealer at `K`-split with distributed key generation, so no party ever holds `K` whole.
- Delete or shred `/tmp/zk.job` and `/tmp/zk.out.json` after each worker job (a `trap` on exit), matching the
  fallback path's `finally`.
- Run the prover in a memory-locked process or a confidential-computing enclave to limit RAM exposure.
- Let the data owner run their own prover box for production, so plaintext never reaches the project at all.
- Move from a mocked attester to a real signature, zkTLS, or on-chain data source.
