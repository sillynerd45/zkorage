# zkorage backend — orchestration + verification REST API

Node/TypeScript service for the zkorage Proof-of-Reserves engine. It is a thin layer over Soroban:
**reads** are read-only `simulateTransaction` calls; **writes** are server-signed for demo convenience.

```bash
cp .env.example .env     # fill in contract IDs + SIGNER_SECRET
npm install
npm run dev              # :8787 (tsx watch)
```

Interactive docs: **`GET /docs`** (Swagger UI) · spec at **`GET /openapi.yaml`**.

## Trust model (read this)
The verification trust does **not** flow through this server:

- **On-chain channel (trustless).** `/count`, `/history`, `/result/:issuer` mirror the policy
  contract's `get_count` / `get_history` / `get_result` — anyone can call those on the public RPC
  (or `stellar contract invoke`) and get the same answer without us.
- **Re-verify channel (trustless).** `/audit/verify` recomputes `sha256(journal)` itself, decodes the
  journal itself, checks the image-id pin, then asks the **public verifier contract** to confirm the
  Groth16 proof and the live supply binding. Every `/audit/*` response embeds a copy-paste
  `stellar contract invoke` recipe so a third party can reproduce it. The frontend `/verify` page runs
  the same checks straight against a public RPC.
- **Writes (convenience, NOT trust).** `/submit`, `/mint`, `/burn` are signed by `SIGNER_SECRET`. They
  let the demo persist/mutate state; they are never how a verifier *trusts* a result.

## REST surface

| Method | Path | Kind | What |
|---|---|---|---|
| GET | `/health` | — | liveness |
| GET | `/info` | read | contract IDs, network, public RPC, decimals |
| GET | `/supply` | read | token `total_supply` |
| GET | `/count` | read | size of the on-chain verified-results log |
| GET | `/history?start=&limit=` | read | a page of the append-only history (limit ≤ 50) |
| GET | `/result` | read | latest persisted result |
| GET | `/result/:issuer` | read | persisted result for a 32-byte-hex issuer |
| GET | `/audit/latest` | read | shareable audit bundle (proof + on-chain result + CLI recipe) |
| GET | `/audit/:issuer` | read | audit bundle for an issuer |
| POST | `/audit/verify` | read | independent re-verify of a posted/cached bundle → checklist + verdict |
| GET | `/badge.svg`, `/badge/:issuer.svg` | read | embeddable on-chain-state badge |
| POST | `/attest-reserves` | mock | custodian PoR attestation (reserves stay private) |
| POST | `/prove-reserves` | proxy | submit a proving job to the self-hosted prover |
| GET | `/prove-status/:id` | proxy | proving job status; caches the bundle on done |
| POST | `/submit` | **write** | verify + supply-bind + persist on the policy contract |
| GET | `/bundle/latest` | read | most recent cached proof bundle |
| POST | `/mint`, `/burn` | **write** | demo-only supply controls (admin) |
| GET | `/openapi.yaml`, `/docs` | — | API spec + Swagger UI |

## curl examples
```bash
curl -s localhost:8787/info | jq
curl -s 'localhost:8787/history?start=0&limit=10' | jq '.count, .results[].index'
curl -s localhost:8787/audit/latest | jq '{result:.onChainResult, recipe:.recipe}'

# Independent re-verify of the cached bundle (no body = use cached proof):
curl -s -X POST localhost:8787/audit/verify | jq '{verdict, checklist}'

# Embeddable badge:
curl -s localhost:8787/badge.svg -o badge.svg
```
