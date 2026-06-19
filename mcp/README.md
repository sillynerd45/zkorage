# zkorage-mcp

A **read-only** MCP server for the zkorage Proof-of-Reserves engine. It lets an AI agent (Claude
Desktop / Claude Code) **query and re-verify** claims on-chain. **No key custody** — every tool is a
read against a public Soroban RPC + the public contracts (via `zkorage-sdk`); it can never sign or
mutate anything.

## Tools
| Tool | Args | What |
|---|---|---|
| `is_reserves_ge_supply` | `{ issuer? }` | **Headline.** On-chain-verified answer to "reserves ≥ supply?" + freshness |
| `get_latest_result` | — | Latest persisted verified result |
| `get_result_by_issuer` | `{ issuer }` | Result for a 32-byte-hex issuer |
| `get_count` | — | Size of the on-chain history log |
| `get_history` | `{ start?, limit? }` | A page of the verified-results history |
| `verify_proof_bundle` | `{ issuer? }` or `{ seal, image_id, journal }` | Full Groth16 re-verify → checklist + verdict |
| `get_audit_bundle` | `{ issuer? }` | Shareable bundle (proof + result + CLI recipe) |

`verify_proof_bundle` (by issuer) and `get_audit_bundle` fetch the proof bundle over REST (it isn't
on-chain), so they need `ZKORAGE_API_BASE`. Everything else is pure on-chain — zero config.

## Build + self-test
```bash
npm install
npm run build           # -> dist/server.js
npm run selftest        # spawns the server, lists + calls every tool (backend on :8787 for audit tools)
```

## Wire it into Claude (stdio)
Add to Claude Desktop's `claude_desktop_config.json`, or this project's `.mcp.json` for Claude Code.
All env vars are optional (default to live testnet); set `ZKORAGE_API_BASE` to enable the audit tools.

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

Then ask: *"Using zkorage, is the latest issuer's reserves ≥ supply?"* → the agent calls
`is_reserves_ge_supply` and reports the on-chain-verified answer. No keys are ever involved.

### Config (env, all optional)
`ZKORAGE_RPC_URL` · `ZKORAGE_VERIFIER` · `ZKORAGE_TOKEN` · `ZKORAGE_POLICY` · `ZKORAGE_API_BASE`
