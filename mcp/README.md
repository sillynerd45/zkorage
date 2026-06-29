# zkorage-mcp

A read-only MCP server for zkorage. It lets an AI agent (Claude Desktop / Claude Code) query and re-verify
claims on-chain. No key custody: every tool is a read against a public Soroban RPC and the public contracts
(via `zkorage-sdk`), so it can never sign or mutate anything.

## Build + self-test

Build the SDK first (consumed via `file:../sdk`), then build and self-test the server:

```bash
cd ../sdk && npm install && npm run build
cd ../mcp && npm install
npm run build       # -> dist/server.js
npm run selftest    # spawns the server, lists + calls every tool (backend on :8787 for the audit tools)
```

Run it directly with `npm start` (tsx) or `node dist/server.js` after a build. The server speaks MCP over
stdio, so it has no HTTP port.

## Tools
| Tool | Args | What |
|---|---|---|
| `is_reserves_ge_supply` | `{ issuer? }` | On-chain-verified answer to "reserves >= supply?" plus freshness |
| `get_latest_result` | (none) | Latest persisted verified result |
| `get_result_by_issuer` | `{ issuer }` | Result for a 32-byte-hex issuer |
| `get_count` | (none) | Size of the on-chain history log |
| `get_history` | `{ start?, limit? }` | A page of the verified-results history |
| `verify_proof_bundle` | `{ issuer? }` or `{ seal, image_id, journal }` | Full Groth16 re-verify -> checklist + verdict |
| `get_audit_bundle` | `{ issuer? }` | Shareable bundle (proof + result + CLI recipe) |

`verify_proof_bundle` (by issuer) and `get_audit_bundle` fetch the proof bundle over REST (it is not
on-chain), so they need `ZKORAGE_API_BASE`. Everything else is pure on-chain and needs no config.

## Wire it into Claude (stdio)

Add to Claude Desktop's `claude_desktop_config.json`, or this project's `.mcp.json` for Claude Code:

```json
{
  "mcpServers": {
    "zkorage": {
      "command": "node",
      "args": ["D:/Project/Stellar/Real-World-ZK/zkorage/mcp/dist/server.js"],
      "env": { "ZKORAGE_API_BASE": "http://localhost:8787" }
    }
  }
}
```

Then ask: *"Using zkorage, is the latest issuer's reserves >= supply?"* and the agent calls
`is_reserves_ge_supply` and reports the on-chain-verified answer.

All env vars are optional and default to the live testnet. Set `ZKORAGE_API_BASE` to enable the audit
tools. Other overrides: `ZKORAGE_RPC_URL`, and the contract ids `ZKORAGE_VERIFIER`, `ZKORAGE_TOKEN`,
`ZKORAGE_POLICY`, `ZKORAGE_GATE`, `ZKORAGE_COMPLIANCE`, `ZKORAGE_PAYROLL`, `ZKORAGE_ACCREDITED`,
`ZKORAGE_FUNDRAISE`, `ZKORAGE_DATAROOM`, `ZKORAGE_ESCROW`, `ZKORAGE_SOLVENCY_GATE`, `ZKORAGE_TIER_GATE`,
`ZKORAGE_BOND_TOKEN`.
