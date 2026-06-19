// Independent, trust-minimized re-verification of a Proof-of-Reserves bundle.
//
// Verification logic lives in ONE place — the `zkorage-sdk` package (also used by the frontend and the
// MCP server). The backend simply delegates to it, so the server, the SDK, the browser and any agent
// all run byte-for-byte the same checks against the public chain. This module keeps the server-side
// glue: a `ZkorageClient` built from the backend's env, and the copy-paste CLI recipe.
import { ZkorageClient, type VerifyResult } from "zkorage-sdk";
import type { Bundle } from "./verify.js";

export interface AuditContext {
  verifierId: string;
  tokenId: string;
  policyId: string;
}

function clientFor(ctx: AuditContext): ZkorageClient {
  return new ZkorageClient({
    rpcUrl: process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
    contracts: { verifier: ctx.verifierId, token: ctx.tokenId, policy: ctx.policyId },
    readSource: process.env.SIM_SOURCE_PUBKEY || "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6",
  });
}

/** Re-verify a bundle against the public chain via the SDK → checklist + verdict. */
export async function verifyBundle(ctx: AuditContext, b: Bundle): Promise<VerifyResult> {
  if (!b?.seal || !b?.image_id || !b?.journal) {
    throw new Error("seal, image_id, journal (raw hex) required");
  }
  return clientFor(ctx).verifyBundle({
    seal: b.seal,
    image_id: b.image_id,
    journal: b.journal,
    journal_digest: b.journal_digest,
  });
}

/** A copy-paste recipe a third party can run to reproduce the checks with the stellar CLI. */
export function cliRecipe(ctx: AuditContext, b: Bundle | null, recomputedDigest?: string) {
  const net = "--network testnet --source <any-funded-account>";
  return {
    readLatestOnChain: `stellar contract invoke --id ${ctx.policyId} ${net} -- get_latest_result`,
    readHistoryOnChain: `stellar contract invoke --id ${ctx.policyId} ${net} -- get_history --start 0 --limit 10`,
    reVerifyProof: b
      ? `stellar contract invoke --id ${ctx.verifierId} ${net} -- verify --seal ${b.seal} --image_id ${b.image_id} --journal ${recomputedDigest ?? b.journal_digest ?? "<sha256(journal)>"}`
      : `stellar contract invoke --id ${ctx.verifierId} ${net} -- verify --seal <hex> --image_id <hex> --journal <sha256(journal)>`,
  };
}
