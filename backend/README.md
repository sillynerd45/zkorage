# zkorage backend

Node + TypeScript orchestration API. A thin layer over Soroban: reads are read-only `simulateTransaction`
calls, writes are server-signed for demo convenience. It serves the Data Room, Bonded Proofs, the faucet,
and the earlier proof use cases (Proof-of-Reserves, KYC, compliance), and it proxies proving jobs to the
self-hosted prover.

## Run

Build the SDK first (the backend consumes it via `file:../sdk`):

```bash
cd ../sdk && npm install && npm run build
```

Then, in `backend/`:

```bash
cp .env.example .env     # contract ids + RPC urls are preset to testnet
npm install
npm run dev              # tsx watch, http://localhost:8787
# npm start              # same, without watch
```

`PORT` overrides the port (default 8787). The full HTTP surface is self-documenting: open `GET /docs`
(Swagger UI), spec at `GET /openapi.yaml`.

## Configuration (.env)

The contract ids and RPC urls in `.env.example` already point at the live testnet deployment, so reads and
verification work with no further setup. The values you may need to set:

- `SIGNER_SECRET`: a funded testnet secret (`S...`). Only needed to submit transactions through the server
  relay (the demo writes, mint/burn). Reads and verification do not need it.
- `PROVER_URL`: the prover gateway. Point it at your own `http://localhost:8080` to prove against a local
  prover (see `../prover`).
- `R2_*`: Cloudflare R2 object storage for Data Room files. Leave blank to use the built-in local store at
  `backend/data/blobs`, which is fine for local development.

## Trust model

Verification never flows through this server. Anyone can re-read the on-chain results (`/count`,
`/history`, `/result/:issuer` mirror the policy contract) and independently re-verify a proof against the
public verifier contract (`/audit/verify` recomputes the journal digest, checks the image-id pin, then
asks the verifier contract). The write endpoints (`/submit`, `/mint`, `/burn`) are signed by
`SIGNER_SECRET` for demo convenience, never how a verifier trusts a result.
