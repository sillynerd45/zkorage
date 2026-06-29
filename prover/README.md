# zkorage prover

RISC Zero zkVM guests + host, plus a distributed gateway and worker. It builds and runs on Linux (x86_64);
WSL2 works, native Windows does not. It is self-hosted on purpose: the prover is the only part of the
system that sees the private witness, so a private input is never sent to a third-party proving service.

Two shapes:

1. **Standalone**: run the host directly to prove the demo claim (or a job file).
2. **Distributed**: a public **gateway** on an always-on box (behind a Cloudflare tunnel) hands jobs to a
   **worker** on a GPU box; if no worker is connected, the gateway proves on its own CPU.

## Prerequisites

- Rust toolchain (the version pinned in `rust-toolchain.toml`).
- RISC Zero 5.0.0-rc.1, installed with `rzup` (it provides `r0vm` and `cargo-risczero`):
  ```bash
  curl -L https://risczero.com/install | bash
  rzup install
  ```
- Docker. The reproducible guest build (`cargo risczero build`) and the final Groth16 wrap
  (`stark_to_snark`) both run in containers.

## Quick start (standalone, demo claim)

```bash
cargo run --release -p host             # proves the bundled demo claim -> bundle.json + proof.txt
ZKORAGE_EXEC_ONLY=1 cargo run -p host   # fast: run the guest without proving
```

A real job is read from a file: `ZKORAGE_JOB=<job-file> ZKORAGE_OUT=<out.json> cargo run --release -p host`
(get a signed `{envelope, signature, issuer_pubkey}` from the backend `POST /attest`).

## Crates

- `methods/` embeds the guest ELFs, one zkVM program per predicate. The 12 guests: `guest`
  (Proof-of-Reserves / revenue), `guest-identity` (KYC), `guest-compliance` (KYC and not-sanctioned),
  `guest-payroll`, `guest-accredited`, `guest-dataroom-seal` (DR1), `guest-membership` (DR2 anonymous
  eligibility), `guest-docauth` (DR4), `guest-solvency` (bonded solvency), `guest-tier` (anonymous tier),
  `guest-bond` (Bonded Access), `guest-bond-open` (bond-only room open).
- `host/` builds one binary per guest (`host`, `host_identity`, ... `host_bond_open`): prove (STARK), then
  wrap (Groth16), then `encode_seal` -> `{ seal, image_id, journal_digest, journal }`.
- `gateway/gateway.py` (stdlib Python) is the job queue. Public: `POST /prove`, `GET /prove/<id>`,
  `GET /health`. Worker (token-gated): `GET /jobs/next`, `POST /jobs/<id>/result`. Falls back to local CPU
  proving if no worker claims a job within `FALLBACK_SECS`.
- `worker/` is a Dockerized pull-worker that claims jobs from the gateway (outbound only), proves, and
  posts the bundle back.

## Canonical (reproducible) build

A default `cargo build` is not byte-identical across machines, so the `image_id` differs per box. The gate
contracts pin an exact `image_id`, so every prover must emit the same one. The canonical build runs each
guest in Docker, then builds the host with all 12 guest ELFs embedded. Use the scripts:

```bash
./build_guests.sh              # cargo risczero build for all 12 guests; prints each ImageID
./build_canonical_host.sh      # canonical host bins with GPU (--features cuda) for the worker box
./build_canonical_host_cpu.sh  # canonical host bins, CPU-only, for the gateway VM
```

Adding a new predicate adds a guest crate, a `host_<kind>` bin, a `build.rs` ELF env var, and a
gateway/worker route.

## GPU vs CPU

RISC Zero 5 supports the worker's GPU (Blackwell sm_120), so the GPU box proves a claim in seconds. Build
its host bins with `--features cuda` (`build_canonical_host.sh`). The gateway VM has no GPU and uses the
CPU-only bins (`build_canonical_host_cpu.sh`) as the fallback when the worker is offline.

## Run the gateway (always-on box)

```bash
PORT=8080 WORKER_TOKEN=<token> FALLBACK_SECS=30 python3 gateway/gateway.py
```
Expose it with a Cloudflare tunnel public hostname (`prover.wazowsky.id` -> `http://localhost:8080`), then
point the backend's `PROVER_URL` at it.

## Run the worker (GPU box)

The worker runs every canonical host bin and routes by job `kind`. Build its image from the canonical host
bins + `r0vm`, then run it dialing out to the gateway (it makes outbound HTTPS only, no inbound):

```bash
docker build -t zkorage-worker worker
docker run -d --restart unless-stopped --name zkorage-worker --dns 1.1.1.1 \
  -v /var/run/docker.sock:/var/run/docker.sock -v /tmp:/tmp \
  -e VM_URL=https://prover.wazowsky.id -e WORKER_TOKEN=<token> \
  zkorage-worker
```
The mounted docker socket + shared `/tmp` let the Groth16 wrap run the `risczero/risc0-groth16-prover`
image as a sibling container. The worker's bins must be the canonical ones, or its proofs carry a
mismatched `image_id` and the contracts reject them.

## Submit a job (end to end)

```bash
curl -s -X POST https://prover.wazowsky.id/prove -H 'content-type: application/json' \
  -d '{"kind":"reserves","envelope_hex":"…","signature_hex":"…","issuer_pubkey_hex":"…","threshold":500000}'
# -> {"job_id":"…"}; poll GET /prove/<job_id> until {"status":"done","bundle":{…}}
```
