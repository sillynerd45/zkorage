// zkorage DR3 keyper — READ-ONLY Soroban access. Each keyper independently simulates against its OWN RPC
// (no shared oracle hop): it reads the DR2 grant the same way any verifier would, then decides — alone —
// whether to release its share. A keyper NEVER signs or writes; it only ever simulates these two reads.
import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Networks,
  scValToNative,
} from "@stellar/stellar-sdk";

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
// Any funded account works as the simulation source (reads are never submitted/charged). Defaults to the
// demo deployer, overridable per keyper to make "each keyper reads its own RPC, independently" literal.
const SIM_SOURCE =
  process.env.SIM_SOURCE_PUBKEY || "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";

const scBytes = (hex: string): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));

function server(): rpc.Server {
  return new rpc.Server(RPC_URL);
}

/** Read-only simulate → native JS return value. Throws on simulation error. */
async function readContract(contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
  const srv = server();
  const src = await srv.getAccount(SIM_SOURCE);
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await srv.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return retval ? scValToNative(retval) : null;
}

/**
 * The LIVE access decision (root-revocation aware): true iff `accessor` holds a currently-valid DR2 grant
 * in `roomId`. This is exactly what the contract's `is_granted` enforces (grant exists AND was proven
 * against the room's CURRENT eligible root) — re-pinning the root revokes stale grants automatically.
 */
export async function isGranted(contractId: string, roomIdHex: string, accessorHex: string): Promise<boolean> {
  const v = await readContract(contractId, "is_granted", [scBytes(roomIdHex), scBytes(accessorHex)]);
  return v === true;
}

/**
 * The proof-bound x25519 recipient key (hex) NEW-5 committed in the DR2 grant, or null if there is no grant.
 * The keyper seals its share ONLY to this key — never to a client-supplied key — so a released share is
 * decryptable by no one but the holder of the recipient secret the eligibility proof bound.
 */
export async function getGrantRecipientPub(
  contractId: string,
  roomIdHex: string,
  accessorHex: string,
): Promise<string | null> {
  const grant = (await readContract(contractId, "get_grant", [scBytes(roomIdHex), scBytes(accessorHex)])) as
    | { recipient_pub?: unknown }
    | null;
  if (!grant || grant.recipient_pub == null) return null;
  const rp = grant.recipient_pub;
  const buf = Buffer.isBuffer(rp) ? rp : Buffer.from(rp as Uint8Array);
  if (buf.length !== 32) throw new Error(`grant.recipient_pub is ${buf.length} bytes, expected 32`);
  return buf.toString("hex");
}

export function rpcUrl(): string {
  return RPC_URL;
}
