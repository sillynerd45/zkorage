# zkorage-sdk

Read-only, **trust-minimized** TypeScript SDK for the zkorage Proof-of-Reserves engine on Soroban.
Query and **re-verify** claims straight against the **public chain** — no backend in the trust path,
**no private keys**. Works in Node and the browser (needs a `Buffer` polyfill in the browser).

```bash
npm install   # then `npm run build` (dist/) or import the source directly
npm run smoke # runs against the live testnet contracts
```

## Quick start
```ts
import { ZkorageClient, DEMO_ISSUER_ID } from "zkorage-sdk";

// Testnet contract IDs are baked in; override any field as needed.
const z = new ZkorageClient({ apiBaseUrl: "http://localhost:8787" /* only for getAuditBundle */ });

// The headline question — on-chain-verified answer + live freshness check:
const a = await z.isReservesGteSupply();
// { answer: true, boundSupply: "10000000000000", liveSupply: "10000000000000", fresh: true, result: {...} }

// Trustless on-chain reads:
await z.getLatestResult();
await z.getHistory(0, 10);
await z.getCount();
await z.getResult(DEMO_ISSUER_ID);

// Full independent Groth16 re-verification of a proof bundle (recompute digest → image pin →
// verifier.verify on the public contract → supply binding):
const audit = await z.getAuditBundle();          // proof bundle isn't on-chain; fetched via REST
const v = await z.verifyBundle(audit.proof!);     // { verdict: true, checklist: {...9 checks}, ... }
```

## API
| Method | Trust | Returns |
|---|---|---|
| `getConfig()` | on-chain | policy config (pinned image_id, claim_type, …) |
| `getSupply()` | on-chain | token `total_supply` (string) |
| `getCount()` | on-chain | size of the verified-results log |
| `getLatestResult()` / `getResult(issuer)` / `getByIndex(i)` | on-chain | a `VerifiedResult` |
| `getHistory(start, limit≤50)` | on-chain | `VerifiedResult[]` |
| `isIssuerAllowed(issuer)` | on-chain | boolean |
| `isReservesGteSupply(issuer?)` | on-chain | `{ answer, boundSupply, liveSupply, fresh, result }` |
| `verifyBundle(bundle)` | on-chain | `{ verdict, checklist, recomputedDigest, liveSupply, notes }` |
| `getAuditBundle(issuer?)` | REST | shareable bundle (proof + result + CLI recipe) |
| `getBadgeUrl(issuer?)` | REST | embeddable SVG badge URL |

Config: `{ rpcUrl, networkPassphrase, contracts:{verifier,token,policy}, readSource, apiBaseUrl?, decimals }`
— defaults to live **testnet** (`TESTNET`). `readSource` is any funded account used only as the
read-only simulation source; it never signs. The SDK never takes a secret key.
