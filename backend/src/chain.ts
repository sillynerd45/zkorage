// Soroban chain helpers: read-only simulation + server-signed writes.
// Reads simulate (no signing). Writes are signed by SIGNER_SECRET (the demo deployer/admin key)
// and submitted — the Week-2 MVP persists results with a server key (Freighter lands in Week 3).
import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Networks,
  Keypair,
  Address,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const SIM_SOURCE =
  process.env.SIM_SOURCE_PUBKEY || "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const SIGNER_SECRET = process.env.SIGNER_SECRET || "";

export interface Cost {
  cpuInsns?: number;
  memBytes?: number;
  minResourceFee?: string;
}

export const scBytes = (hex: string): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
export const scAddress = (g: string): xdr.ScVal => new Address(g).toScVal();
/** Soroban `Option<Address>`: Some(addr) -> the address scVal; None -> void. */
export const scOptAddress = (g?: string | null): xdr.ScVal =>
  g ? new Address(g).toScVal() : xdr.ScVal.scvVoid();
export const scI128 = (v: bigint | string | number): xdr.ScVal =>
  nativeToScVal(BigInt(v), { type: "i128" });
export const scU32 = (v: number): xdr.ScVal => nativeToScVal(v >>> 0, { type: "u32" });
export const scBool = (b: boolean): xdr.ScVal => xdr.ScVal.scvBool(b);

function server(): rpc.Server {
  return new rpc.Server(RPC_URL);
}

function costOf(sim: unknown): Cost {
  const s = sim as { cost?: { cpuInsns?: string; memBytes?: string }; minResourceFee?: string };
  return {
    cpuInsns: s.cost?.cpuInsns ? Number(s.cost.cpuInsns) : undefined,
    memBytes: s.cost?.memBytes ? Number(s.cost.memBytes) : undefined,
    minResourceFee: s.minResourceFee,
  };
}

/** Read-only: simulate a contract call and decode the return value to native JS. */
export async function readContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<{ value: unknown; cost: Cost }> {
  const srv = server();
  const src = await srv.getAccount(SIM_SOURCE);
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await srv.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return { value: retval ? scValToNative(retval) : null, cost: costOf(sim) };
}

export interface InvokeResult {
  hash: string;
  returnValue: unknown;
  cost: Cost;
}

/** Server-signed write: simulate (for cost) → assemble → sign → send → poll until SUCCESS. */
export async function invokeContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<InvokeResult> {
  if (!SIGNER_SECRET) throw new Error("SIGNER_SECRET not configured");
  const srv = server();
  const kp = Keypair.fromSecret(SIGNER_SECRET);
  const src = await srv.getAccount(kp.publicKey());
  const built = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();

  const sim = await srv.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const cost = costOf(sim);

  const prepared = rpc.assembleTransaction(built, sim).build();
  prepared.sign(kp);

  const sent = await srv.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error("send failed: " + JSON.stringify(sent.errorResult ?? sent));
  }

  let got = await srv.getTransaction(sent.hash);
  for (let i = 0; i < 30 && got.status === rpc.Api.GetTransactionStatus.NOT_FOUND; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    got = await srv.getTransaction(sent.hash);
  }
  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`tx ${sent.hash} status=${got.status}`);
  }
  const returnValue =
    got.returnValue && got.returnValue.switch().name !== "scvVoid"
      ? scValToNative(got.returnValue)
      : null;
  return { hash: sent.hash, returnValue, cost };
}

/** Build an UNSIGNED, simulated + assembled tx XDR with `source` as the fee-payer/source account,
 *  for client-side (Freighter) signing. We only expose this for the PERMISSIONLESS proof entrypoints,
 *  where the source merely pays fees and the proof is the authorization — so simulating with any
 *  funded source yields the same footprint, and the contract logic is identical to the relay path.
 *  Contracts are unchanged; this just lets the user submit + pay for their own proof. */
export async function buildUnsignedXdr(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  source: string,
): Promise<{ xdr: string; cost: Cost }> {
  const srv = server();
  let src;
  try {
    src = await srv.getAccount(source);
  } catch {
    const net = PASSPHRASE === Networks.TESTNET ? "testnet" : "this network";
    throw new Error(
      `source account ${source} not found on ${net} — fund it first (friendbot), then retry`,
    );
  }
  const built = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(300) // give the user time to sign in the wallet before the tx expires
    .build();
  const sim = await srv.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const cost = costOf(sim);
  const prepared = rpc.assembleTransaction(built, sim).build();
  return { xdr: prepared.toXDR(), cost };
}

/** Submit a client-signed tx XDR (from Freighter): send → poll until SUCCESS → decode return value. */
export async function submitSignedXdr(signedXdr: string): Promise<InvokeResult> {
  const srv = server();
  const tx = TransactionBuilder.fromXDR(signedXdr, PASSPHRASE);
  const sent = await srv.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error("send failed: " + JSON.stringify(sent.errorResult ?? sent));
  }
  let got = await srv.getTransaction(sent.hash);
  for (let i = 0; i < 30 && got.status === rpc.Api.GetTransactionStatus.NOT_FOUND; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    got = await srv.getTransaction(sent.hash);
  }
  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`tx ${sent.hash} status=${got.status}`);
  }
  const returnValue =
    got.returnValue && got.returnValue.switch().name !== "scvVoid"
      ? scValToNative(got.returnValue)
      : null;
  return { hash: sent.hash, returnValue, cost: {} };
}

/** JSON-safe deep stringify (bigint -> string, Buffer/bytes -> hex). */
export function jsonSafe<T>(v: T): unknown {
  return JSON.parse(
    JSON.stringify(v, (_k, val) => {
      if (typeof val === "bigint") return val.toString();
      if (val && typeof val === "object" && (val as { type?: string }).type === "Buffer" && Array.isArray((val as { data?: unknown }).data)) {
        return Buffer.from((val as { data: number[] }).data).toString("hex");
      }
      return val;
    }),
  );
}
