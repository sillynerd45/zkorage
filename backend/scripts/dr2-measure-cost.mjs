// Measure the DR2 request_access verify cost via simulateTransaction (no signing/submission).
// Usage: node dr2-measure-cost.mjs <job_id>   (the job must be a finished membership proof for a room
// whose eligible_root is already pinned and whose nullifier is NOT yet spent).
import { rpc, TransactionBuilder, Networks, Contract, Account, xdr, nativeToScVal } from "@stellar/stellar-sdk";

const GATEWAY = process.env.GATEWAY || "https://prover.wazowsky.id";
const RPC = process.env.RPC || "https://soroban-testnet.stellar.org";
const DR = process.env.DR || "CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN";
const SOURCE = process.env.SOURCE || "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const jobId = process.argv[2];

const bytes = (hex) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));

const jr = await (await fetch(`${GATEWAY}/prove/${jobId}`)).json();
if (jr.status !== "done" || !jr.bundle) throw new Error(`job ${jobId} not done: ${jr.status} ${jr.error || ""}`);
const b = jr.bundle;

const srv = new rpc.Server(RPC);
const acct = await srv.getAccount(SOURCE);
const tx = new TransactionBuilder(new Account(SOURCE, acct.sequenceNumber()), {
  fee: "100000",
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(new Contract(DR).call("request_access", bytes(b.seal), bytes(b.image_id), bytes(b.journal)))
  .setTimeout(60)
  .build();

const sim = await srv.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) throw new Error("simulation failed: " + sim.error);

const res = sim.transactionData.build().resources();
const rd = res.diskReadBytes ? res.diskReadBytes() : (res.readBytes ? res.readBytes() : "?");
const wr = res.writeBytes ? res.writeBytes() : "?";
console.log("=== DR2 request_access cost (simulateTransaction, testnet) ===");
console.log("CPU instructions :", res.instructions().toLocaleString(), "(" + ((res.instructions() / 100_000_000) * 100).toFixed(1) + "% of the 100M budget)");
console.log("read bytes       :", rd.toLocaleString ? rd.toLocaleString() : rd);
console.log("write bytes      :", wr.toLocaleString ? wr.toLocaleString() : wr);
console.log("min resource fee :", sim.minResourceFee, "stroops (", (Number(sim.minResourceFee) / 1e7).toFixed(7), "XLM )");
