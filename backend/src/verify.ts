// On-chain verification against the deployed bare Groth16Verifier (Soroban testnet).
// Read-only: builds the verify() invocation and simulates it. Success == proof valid.
import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Networks,
} from "@stellar/stellar-sdk";

export interface Bundle {
  seal: string; // hex
  image_id: string; // hex (32 bytes)
  journal_digest: string; // hex (32 bytes)
  journal?: string; // hex (raw journal bytes, optional)
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  cpuInsns?: number;
  memBytes?: number;
  minResourceFee?: string;
}

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
// Funded account used only as the read-only simulation source (never signs).
const SIM_SOURCE =
  process.env.SIM_SOURCE_PUBKEY || "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";

const scBytes = (hex: string): xdr.ScVal =>
  xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));

export async function verifyOnChain(contractId: string, b: Bundle): Promise<VerifyResult> {
  const server = new rpc.Server(RPC_URL);
  const source = await server.getAccount(SIM_SOURCE);
  const contract = new Contract(contractId);
  const op = contract.call(
    "verify",
    scBytes(b.seal),
    scBytes(b.image_id),
    scBytes(b.journal_digest),
  );
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    return { ok: false, error: sim.error };
  }
  const cost = (sim as { cost?: { cpuInsns?: string; memBytes?: string } }).cost;
  return {
    ok: true,
    cpuInsns: cost?.cpuInsns ? Number(cost.cpuInsns) : undefined,
    memBytes: cost?.memBytes ? Number(cost.memBytes) : undefined,
    minResourceFee: (sim as { minResourceFee?: string }).minResourceFee,
  };
}
