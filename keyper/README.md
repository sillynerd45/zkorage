# zkorage keyper: DR3 threshold key committee

The key-release layer of the Confidential Data Room. A document key `K` is Shamir-split (t=2 of n=3) and
one share handed to each keyper, so no single server ever holds `K`. On a share request, each keyper
independently reads the per-document admission from its own Soroban RPC (`is_doc_admitted`, which resolves
membership or a bond-only grant) and, only if the caller is admitted, ECIES-seals its share to the
proof-bound recipient key that the on-chain admission recorded. Fewer than two keypers cannot rebuild `K`.

## Run the 3-keeper committee (local demo: 3 processes)

```bash
npm install
# one process per member: same contract, each with its own RPC + share store + port
KEYPER_INDEX=1 KEYPER_PORT=8801 DEAL_TOKEN=dr3-demo-deal-token \
  DATAROOM_CONTRACT_ID=CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN \
  SHARE_STORE_PATH=./data/keyper-1.json npx tsx src/keyper.ts
# repeat with KEYPER_INDEX=2 KEYPER_PORT=8802 ... and KEYPER_INDEX=3 KEYPER_PORT=8803
```

In production each keyper runs on a separate machine and points at its own `STELLAR_RPC_URL`, so the
committee does not trust a single RPC. The `deploy/` compose runs the three as VM-internal services.

Self-test (drives the 3 live keypers against the real DataRoom contract):
```bash
npx tsx scripts/dr3-committee-selftest.ts
```

## Environment

| Var | Default | Notes |
|---|---|---|
| `KEYPER_INDEX` | required | 1..255, this keyper's Shamir x-coordinate |
| `KEYPER_PORT` | 8801 | listen port |
| `DATAROOM_CONTRACT_ID` | required | the DataRoom contract this keyper gates against |
| `DEAL_TOKEN` | required | bearer token for `/deal`; fail-closed (every deal returns 503) if unset |
| `SHARE_STORE_PATH` | `./data/keyper-<index>.json` | where this keyper persists its shares |
| `STELLAR_RPC_URL` | testnet SDF | this keyper's own RPC |
| `SIM_SOURCE_PUBKEY` | demo deployer | read-only simulation source (never signs) |
| `SHARE_RATE_PER_MIN` | 0 (off) | per-IP `/share` cap (production hardening) |
| `KEYPER_ALLOWED_ORIGINS` | empty (open) | browser CORS allowlist (production hardening) |

## HTTP API
- `GET /health` -> `{ ok, keyper_index, rpc, contract, shares }`
- `POST /deal` (dealer-only, `Authorization: Bearer $DEAL_TOKEN`) stores this keyper's share.
- `POST /share` (public) returns this keyper's sealed share iff `is_doc_admitted` is true (403 if not).

`/share` is an intentional public oracle: it confirms only what is already public on-chain and reveals no
identity, and a released share decrypts only for the holder of the proof-bound recipient secret. With
t=2/n=3, one keyper can be offline and a document still opens; two down blocks release.
