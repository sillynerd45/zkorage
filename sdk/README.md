# zkorage-sdk

Read-only, trust-minimized TypeScript SDK for zkorage on Soroban. Query and re-verify claims straight
against the public chain: no backend in the trust path, no private keys. Works in Node and the browser
(needs a `Buffer` polyfill in the browser).

## Build

The backend and the MCP server consume the SDK via `file:../sdk`, so build it before you `npm install`
them.

```bash
npm install
npm run build      # tsc -> dist/
npm run smoke      # re-verify the live testnet claims straight from the chain
```

## Quick start
```ts
import { ZkorageClient, DEMO_ISSUER_ID } from "zkorage-sdk";

// Testnet contract ids are baked in; override any field as needed.
const z = new ZkorageClient({ apiBaseUrl: "http://localhost:8787" /* only for getAuditBundle */ });

// On-chain-verified answer plus a live freshness check:
const a = await z.isReservesGteSupply();

// Trustless on-chain reads:
await z.getLatestResult();
await z.getHistory(0, 10);
await z.getResult(DEMO_ISSUER_ID);

// Full independent Groth16 re-verification of a proof bundle
// (recompute digest -> image-id pin -> verifier.verify on the public contract -> supply binding):
const audit = await z.getAuditBundle();        // the proof bundle is not on-chain; fetched via REST
const v = await z.verifyBundle(audit.proof!);   // { verdict, checklist, ... }
```

## API
| Method | Trust | Returns |
|---|---|---|
| `getConfig()` | on-chain | policy config (pinned image_id, claim_type) |
| `getSupply()` | on-chain | token `total_supply` |
| `getCount()` | on-chain | size of the verified-results log |
| `getLatestResult()` / `getResult(issuer)` / `getByIndex(i)` | on-chain | a `VerifiedResult` |
| `getHistory(start, limit<=50)` | on-chain | `VerifiedResult[]` |
| `isIssuerAllowed(issuer)` | on-chain | boolean |
| `isReservesGteSupply(issuer?)` | on-chain | `{ answer, boundSupply, liveSupply, fresh, result }` |
| `verifyBundle(bundle)` | on-chain | `{ verdict, checklist, recomputedDigest, liveSupply, notes }` |
| `getAuditBundle(issuer?)` | REST | shareable bundle (proof + result + CLI recipe) |
| `getBadgeUrl(issuer?)` | REST | embeddable SVG badge url |

Config: `{ rpcUrl, networkPassphrase, contracts, readSource, apiBaseUrl?, decimals }`, defaults to the live
testnet. `readSource` is any funded account used only as the read-only simulation source; it never signs.
The SDK never takes a secret key.
