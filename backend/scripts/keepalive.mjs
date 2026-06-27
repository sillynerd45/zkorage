// TTL keep-alive for the Bonded Proofs / Bonded Access contracts.
//
// WHY: Soroban persistent ledger entries (a contract's instance + its wasm code) expire and get "archived"
// when their TTL lapses. The FIRST transaction to touch an archived entry must RESTORE it, and the restore rent
// (proportional to entry size, the wasm is the big one) is bundled into that transaction's resource fee. On the
// escrow that meant a reader's first bond deposit was charged ~31 XLM, while later deposits cost ~0.03 XLM. This
// job periodically bumps the TTL of the escrow + the bond/test token contracts (instance + code) so they never
// archive, so NO user ever lands on the restore bill. Extending an entry's TTL is permissionless (anyone may
// pay to extend any entry), so this only needs a funded source account; it changes no contract state.
//
// Runs as a long-lived service (an internal loop): each cycle extends every target contract, then sleeps. A
// per-contract failure is logged and skipped (the next cycle retries). Env:
//   STELLAR_RPC_URL, NETWORK_PASSPHRASE   - same as the backend
//   SIGNER_SECRET                          - a funded testnet account (the demo deployer; reused from backend/.env)
//   KEEPALIVE_CONTRACTS                    - comma-separated C-addresses (default: escrow + zkUSD + the 4 test SACs)
//   KEEPALIVE_EXTEND_TO                    - ledgers to extend to from now (default 1_000_000 ~ 8 weeks; capped by the network max)
//   KEEPALIVE_INTERVAL_SEC                 - seconds between cycles (default 21600 = 6h)
//   KEEPALIVE_ONCE=1                       - run a single cycle and exit (for a manual/cron-style run)

import {
  rpc,
  TransactionBuilder,
  Operation,
  SorobanDataBuilder,
  BASE_FEE,
  xdr,
  Networks,
  Keypair,
  Address,
} from "@stellar/stellar-sdk";

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const SECRET = process.env.SIGNER_SECRET || "";
const EXTEND_TO = Number(process.env.KEEPALIVE_EXTEND_TO || 1_000_000);
const INTERVAL_SEC = Number(process.env.KEEPALIVE_INTERVAL_SEC || 21_600);
const ONCE = process.env.KEEPALIVE_ONCE === "1";

// The contracts whose archival caused (or would cause) a user-facing restore fee: the escrow + the bond token
// (zkUSD) + the 4 classic test-asset SACs the bond flow accepts (TUSD/TGLD/TBND/TBIL). SACs have no separate
// wasm code entry (the asset contract is built in), so for those only the instance is extended.
const DEFAULT_CONTRACTS = [
  "CAMQKJKAJTOMT66N5N3E3VIRTN5ACDKV6P3Z2HLYVJHLAVRGJKHZFOXC", // Bonded-Proofs escrow (BP1)
  "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5", // zkUSD bond token
  "CALISDUWPL24M3LWLOXIWYNRQ42YYMZJ4ZU6UYIVCCB4NH4DMV767NZX", // TUSD SAC
  "CA3CH2YR5TY4IUYBYLCMFSDT2SDY34Q5GFZEDEZ5LOL7BCYY23XYUG57", // TGLD SAC
  "CAGZZDZ2ZKP7C4PXYTBVEN5Z7RVP3275OMHA7JFZK2X2Y4SMGNRZJZQK", // TBND SAC
  "CDOB2L6FVFOH3GFJDI6DD4VA5GW5MLRXPJFSNA3UF7W7EAOM5CA6C3YE", // TBIL SAC
];
const CONTRACTS = (process.env.KEEPALIVE_CONTRACTS || DEFAULT_CONTRACTS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), "[keepalive]", ...a);

// The persistent contract-instance ledger key for a contract.
function instanceKey(contractId) {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

// The ledger keys to extend for a contract: its instance, plus its wasm code entry when it is a wasm contract
// (SACs are built-in "stellar asset" executables with no separate code entry).
async function ledgerKeysFor(server, contractId) {
  const ik = instanceKey(contractId);
  const keys = [ik];
  const res = await server.getLedgerEntries(ik);
  const entry = res.entries && res.entries[0];
  if (!entry) throw new Error("contract instance not found (already archived or wrong id)");
  const exec = entry.val.contractData().val().instance().executable();
  if (exec.switch().name === "contractExecutableWasm") {
    keys.push(xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: exec.wasmHash() })));
  }
  return keys;
}

// Build + sign + submit a single ExtendFootprintTTL tx that bumps the given contract's entries. The caller
// owns the `account` object and reuses it across contracts, so TransactionBuilder.build() increments the
// sequence locally and stays in sync without a per-contract re-fetch (which lags the RPC's account view and
// causes txBadSeq).
async function extendOne(server, kp, account, contractId) {
  const keys = await ledgerKeysFor(server, contractId);
  const sorobanData = new SorobanDataBuilder().setReadOnly(keys).build();
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.extendFootprintTtl({ extendTo: EXTEND_TO }))
    .setSorobanData(sorobanData)
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error("send failed: " + JSON.stringify(sent.errorResult ?? sent));
  let got = await server.getTransaction(sent.hash);
  for (let i = 0; i < 40 && got.status === rpc.Api.GetTransactionStatus.NOT_FOUND; i++) {
    await sleep(1000);
    got = await server.getTransaction(sent.hash);
  }
  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`tx ${sent.hash} status=${got.status}`);
  }
  return { hash: sent.hash, keys: keys.length };
}

// Extend one contract with a fresh account fetch + retry-with-backoff. Each contract is independent (its own
// sequence), so a slow or dropped tx on one never desyncs the others. Extending TTL is idempotent, so retrying
// after a txBadSeq / NOT_FOUND (the testnet-confirmation races) is safe.
async function extendWithRetry(server, kp, contractId, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const account = await server.getAccount(kp.publicKey());
      return await extendOne(server, kp, account, contractId);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      const transient = /txBadSeq|NOT_FOUND|TRY_AGAIN_LATER|tryAgainLater|429|timeout|ENOTFOUND|ECONNRESET/i.test(msg);
      if (i === attempts - 1 || !transient) throw e;
      log(`  ${contractId} attempt ${i + 1} transient (${msg.slice(0, 60)}), retrying`);
      await sleep(5000 + i * 3000);
    }
  }
}

async function cycle() {
  if (!SECRET) throw new Error("SIGNER_SECRET not set");
  const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });
  const kp = Keypair.fromSecret(SECRET);
  log(`source ${kp.publicKey()} | extendTo ${EXTEND_TO} ledgers | ${CONTRACTS.length} contracts`);
  let ok = 0;
  for (const c of CONTRACTS) {
    try {
      const r = await extendWithRetry(server, kp, c);
      ok++;
      log(`extended ${c} (${r.keys} keys) tx ${r.hash}`);
    } catch (e) {
      log(`FAILED ${c}: ${e && e.message ? e.message : e}`);
    }
  }
  log(`cycle done: ${ok}/${CONTRACTS.length} extended`);
}

async function main() {
  if (ONCE) {
    await cycle();
    return;
  }
  // Long-lived service: extend, sleep, repeat. Errors in a cycle are caught so the loop never dies.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await cycle();
    } catch (e) {
      log("cycle error:", e && e.message ? e.message : e);
    }
    log(`sleeping ${INTERVAL_SEC}s`);
    await sleep(INTERVAL_SEC * 1000);
  }
}

main().catch((e) => {
  log("fatal:", e && e.message ? e.message : e);
  process.exit(1);
});
