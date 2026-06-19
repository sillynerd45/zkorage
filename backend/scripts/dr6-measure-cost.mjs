// Measure DR6 on-chain op costs via simulateTransaction (no signing/submission). The demo room
// (db16742c) is owned by SOURCE (the deployer) and its demo accessor (ed4928c6) is admitted, so these
// simulate cleanly. Usage: node scripts/dr6-measure-cost.mjs
import { rpc, TransactionBuilder, Networks, Contract, Account, xdr, Address } from "@stellar/stellar-sdk";

const RPC = process.env.RPC || "https://soroban-testnet.stellar.org";
const DR = process.env.DR || "CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN";
const COMP = "CDSA3PUL7OZ5HKLIT73ZTG64TLYK4QTO5ZHZKHA3JBS76R5L5Q2EO4FV";
const ACC = "CCLSXZBOPCAJQS6L54EAGZQHTD5QUES2OSYCFX5XJT6ZXSICRPS4QKQZ";
const SOURCE = process.env.SOURCE || "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const ROOM = "db16742cf50b4443db1336b65ece5a532515487d7d4f7b6feab87bbb87396489";
const ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";
const DOC = "8b041fe3998194a15fab4bf9d32db0cc528ef12eec9a6b521ec5124ad66508a6";

const bytes = (hex) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
const bool = (b) => xdr.ScVal.scvBool(b);
const optAddr = (g) => (g ? new Address(g).toScVal() : xdr.ScVal.scvVoid());

const srv = new rpc.Server(RPC);
const acct = await srv.getAccount(SOURCE);

async function measure(label, method, args) {
  const tx = new TransactionBuilder(new Account(SOURCE, acct.sequenceNumber()), { fee: "200000", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(DR).call(method, ...args)).setTimeout(60).build();
  const sim = await srv.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) { console.log(`✗ ${label}: ${sim.error.split("\n")[0]}`); return; }
  const res = sim.transactionData.build().resources();
  const cpu = res.instructions();
  console.log(`• ${label}`);
  console.log(`    CPU instr : ${cpu.toLocaleString()} (${((cpu / 100_000_000) * 100).toFixed(2)}% of 100M)`);
  console.log(`    fee       : ${sim.minResourceFee} stroops (${(Number(sim.minResourceFee) / 1e7).toFixed(7)} XLM)`);
}

console.log("=== DR6 on-chain op costs (simulateTransaction, testnet) ===");
await measure("request_room_admission (composite AND: membership ∧ compliance ∧ accredited)", "request_room_admission", [bytes(ROOM), bytes(ACCESSOR)]);
await measure("is_admitted (live composed read)", "is_admitted", [bytes(ROOM), bytes(ACCESSOR)]);
await measure("set_room_policy (member ∧ compliance ∧ accredited)", "set_room_policy", [bytes(ROOM), bool(true), optAddr(COMP), optAddr(ACC)]);
await measure("revoke_access (surgical)", "revoke_access", [bytes(ROOM), bytes(ACCESSOR), bool(true)]);
await measure("get_room_policy (read)", "get_room_policy", [bytes(ROOM)]);
console.log(`\n(doc for rotation context: ${DOC.slice(0, 12)}…)`);
