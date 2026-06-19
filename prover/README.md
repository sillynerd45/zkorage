# zkorage prover

RISC Zero zkVM guest + host, plus a **distributed prover** (gateway + GPU/CPU worker). Builds and runs
on Linux (x86_64). Two deployment shapes:

1. **Standalone** — run the host directly to prove the demo claim (or a job file).
2. **Distributed** — a public **gateway** on an always-on box (behind a Cloudflare tunnel) hands proving
   jobs to a **worker** on a beefier machine; if no worker is connected, the gateway proves on its own CPU.

## Crates
- `methods/guest` — the zkVM guest: verifies an ed25519 claim envelope, asserts `value ≥ threshold`,
  commits the public journal (`value` stays private). Uses the RISC0 curve25519/crypto-bigint precompile
  patches (`[patch.crates-io]`) — ~3.8× fewer cycles (3.39M/4 segments → 0.90M/1 segment).
- `methods/guest-identity` — KYC identity guest (W5): ed25519 KYC credential → "kyc = passed" by an
  allow-listed provider, `subject_id` private, bound to a public `accessor`.
- `methods/guest-compliance` — compliance guest (W6): KYC **∧ not-sanctioned**. Same ed25519 KYC check
  **plus** a SHA-256 Indexed-Merkle-Tree non-membership proof of the (private) `subject_id` against a
  sanctions deny-list, committing the deny-list root. **SHA-256, not Poseidon**: RISC0 has a sha256
  precompile, so depth-20 non-membership stays at ~1 segment (combined proof ≈ 2 segments / ~1.18M
  cycles); Poseidon-BN254 measured at ~28 segments (no BN254 field precompile). The gate only compares
  the committed root to its pinned root (no on-chain hashing), so the in-guest hash is a free choice.
- `host` — proves (STARK) + wraps (Groth16) + `encode_seal` → `{seal, image_id, journal_digest, journal}`.
  - Demo mode (default): self-signs a demo claim.
  - **Job mode**: `ZKORAGE_JOB=<4-line file: envelope_hex/signature_hex/issuer_pubkey_hex/threshold>`
    `ZKORAGE_OUT=<bundle.json>`.
  - Exec-only (fast, no proving): `ZKORAGE_EXEC_ONLY=1 [ZKORAGE_VALUE=.. ZKORAGE_THRESHOLD=..]`.
  - `--features cuda` builds a GPU prover. **⚠️ Blackwell sm_120 (RTX 5070 Ti) under WSL2 is BLOCKED:**
    proving crashes in `sppark 0.1.15` (illegal memory access). Tested 4 driver branches (576.57 / 581.42 /
    596.49 / 610.47) — all fail identically, so it's NOT the driver; cause is WSL2's `/dev/dxg` paravirt
    path and/or sppark-on-sm_120. **Decision: CPU hold** (GPU is marginal for a 1-segment proof anyway).
    Re-entry: native Linux (not WSL2), or an upstream sppark/risc0 Blackwell fix — worth it at the
    multi-segment Week-5+ predicates. See `../development/Research/claude-web-gpu-blackwell-research-{brief,report}.md`.
- `gateway/gateway.py` — VM job-queue gateway (stdlib Python). Public: `POST /prove`, `GET /prove/<id>`,
  `GET /health`. Worker (token-gated): `GET /jobs/next`, `POST /jobs/<id>/result`. Falls back to local
  CPU proving if no worker claims within `FALLBACK_SECS`.
- `worker/` — Dockerized pull-worker: claims jobs from the gateway (outbound only), proves, posts back.

## Topology (as deployed)
```
 submit ─▶ gateway (VM, behind Cloudflare tunnel prover.wazowsky.id → localhost:8080)
           │  queue + VM-CPU fallback (no GPU on the VM)
           ▼ GET /jobs/next (worker dials OUT over the tunnel; no inbound/tunnel on the worker box)
        worker (WSL2 + RTX 5070 Ti box, several cores) ── proves ── POST /jobs/<id>/result
```
The worker never accepts inbound connections; it only makes outbound HTTPS to the gateway's tunnel URL.

## Run — gateway (on the VM)
```bash
# run once (foreground): PORT=8080 WORKER_TOKEN=<token> FALLBACK_SECS=30 python3 gateway/gateway.py
# ~/start_gateway.sh sets those env vars + exec python3 gateway.py.
# PERMANENT (self-healing; survives crash/reboot; no sudo) — user crontab on the VM:
#   * * * * * pgrep -f "[p]ython3 gateway.py" >/dev/null || setsid bash ~/start_gateway.sh </dev/null >~/gateway.log 2>&1
#   NOTE the [p] bracket: a plain "python3 gateway.py" pattern self-matches the cron job's own
#   command line, so the check would never restart. [p]ython3 avoids the self-match.
# expose it: add a Cloudflare tunnel public hostname  prover.wazowsky.id → http://localhost:8080
```

## Run — worker (on the GPU/CPU box; here WSL2)
The worker runs ALL THREE **canonical** host bins and routes by job `kind`, so the gateway offers it every
kind (worker-first; the VM falls back when the worker is offline). The bins MUST be the canonical
(Docker-built-ELF) ones — copy them from the box that did the canonical host build, or the worker emits a
non-canonical image_id and its proofs are rejected on-chain (ImageMismatch).
```bash
# build the image (copies the 3 canonical host bins + r0vm into the build context):
cp target/release/host           worker/host
cp target/release/host_identity  worker/host_identity
cp target/release/host_compliance worker/host_compliance
cp -L ~/.cargo/bin/r0vm          worker/r0vm
docker build -t zkorage-worker worker

# run it (keep alive). --dns 1.1.1.1 bypasses a router that won't resolve the tunnel host.
docker run -d --restart unless-stopped --name zkorage-worker \
  --dns 1.1.1.1 \
  -v /var/run/docker.sock:/var/run/docker.sock -v /tmp:/tmp \
  -e VM_URL=https://prover.wazowsky.id -e WORKER_TOKEN=<token> \
  zkorage-worker
docker logs -f zkorage-worker
```
The mounted docker socket + shared `/tmp` let the Groth16 wrap (`stark_to_snark`) run the
`risczero/risc0-groth16-prover` image as a sibling container with matching temp paths.

## Submit a job (end to end)
```bash
curl -s -X POST https://prover.wazowsky.id/prove -H 'content-type: application/json' \
  -d '{"envelope_hex":"…","signature_hex":"…","issuer_pubkey_hex":"…","threshold":500000}'
# -> {"job_id":"…"}; poll GET /prove/<job_id> until {"status":"done","bundle":{…}}
# then verify the bundle on testnet (contract/scripts/measure.sh or the backend /verify).
```
(Get a signed `{envelope,signature,issuer_pubkey}` from the backend `POST /attest`.)

## ⚠️ Guest reproducibility — canonical deterministic build (Week 2)
The default (non-Docker) guest build is **not** byte-identical across machines, so a native build on the
worker box vs the VM yields **different `image_id`s**. The bare verifier is image-agnostic (both verify),
but the **Week-2 PoR policy pins `expected_image_id`** (mandatory for soundness), so every prover box
must emit the **same** id.

**Canonical build (Week 6: THREE guests — `claim_predicate` (PoR) + `identity_predicate` (KYC) +
`compliance_predicate` (KYC ∧ not-sanctioned)).** `methods/build.rs` embeds ALL THREE guests; the
canonical path requires ALL of `ZKORAGE_GUEST_ELF`, `ZKORAGE_IDENTITY_ELF`, `ZKORAGE_COMPLIANCE_ELF` to
be set together (the single `host` crate compiles `host` + `host_identity` + `host_compliance`, so all
three image_ids must exist). Each guest needs its own `ruint=1.17.2` pin.
```bash
# 1) deterministic guest ELFs (Docker / reproducible). Pin ruint in EACH guest dir:
(cd methods/guest            && cargo update -p ruint --precise 1.17.2)  # 1.18 needs rustc 1.90 > docker 1.88
(cd methods/guest-identity   && cargo update -p ruint --precise 1.17.2)
(cd methods/guest-compliance && cargo update -p ruint --precise 1.17.2)
(cd methods/guest            && cargo risczero build)   # -> .../docker/claim_predicate.bin
#    prints: ImageID: 82bbf7ee…1c6f3d54  (CANONICAL PoR — W5 re-pin after the pk==issuer_id fix)
(cd methods/guest-identity   && cargo risczero build)   # -> .../docker/identity_predicate.bin
#    prints: ImageID: 99e3fdb8…2d810ac2  (CANONICAL identity)
(cd methods/guest-compliance && cargo risczero build)   # -> .../docker/compliance_predicate.bin
#    prints: ImageID: <compliance image_id>  (CANONICAL compliance — pinned by the compliance gate)
# 2) build ALL THREE host bins so they EMBED those exact ELFs (build.rs reads all three env vars):
POR=$PWD/methods/guest/target/riscv32im-risc0-zkvm-elf/docker/claim_predicate.bin
ID=$PWD/methods/guest-identity/target/riscv32im-risc0-zkvm-elf/docker/identity_predicate.bin
COMP=$PWD/methods/guest-compliance/target/riscv32im-risc0-zkvm-elf/docker/compliance_predicate.bin
ZKORAGE_GUEST_ELF=$POR ZKORAGE_IDENTITY_ELF=$ID ZKORAGE_COMPLIANCE_ELF=$COMP cargo build --release -p host
#    -> target/release/host (PoR) + host_identity (KYC) + host_compliance (compliance)
```
Both the VM host bins AND the worker's host bins are built this way (canonical). The gateway routes jobs
by `kind` ("reserves"→`host`, "identity"→`host_identity`, "compliance"→`host_compliance`) and offers
**every kind** to the worker (it now embeds all three canonical ELFs and routes by `kind`). So a job goes
to the **multi-core worker when it's online** (~2.5× the multi-core VM) and **falls back to the VM CPU** when no
worker claims it within `FALLBACK_SECS` — worker-first, VM-fallback, for all kinds.
**The worker MUST stay canonical:** its `host*` bins must embed the same canonical ELFs the contracts pin
(copy them from the canonical-host-build box — see "Run — worker"), or its proofs carry a mismatched
image_id and the contracts reject them with `ImageMismatch (#3)`. Adding a NEW predicate kind requires
adding its canonical host bin to the worker image too, else the gateway would offer the worker a kind it
can't prove canonically.
