// Persistent faucet claim ledger: G-address -> last claim timestamp (ms). Enforces "once per 24h per wallet".
// Atomic write (tmp + rename), mirrors the other small JSON stores (enroll-store, eligible-store).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_FILE =
  process.env.FAUCET_STORE_FILE ||
  resolve(dirname(fileURLToPath(import.meta.url)), "../data/faucet-claims.json");

type Store = Record<string, number>;

function load(): Store {
  if (!existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(readFileSync(DATA_FILE, "utf8")) as Store;
  } catch {
    return {};
  }
}

function save(s: Store): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, DATA_FILE);
}

export function lastClaim(address: string): number {
  return load()[address] ?? 0;
}

export function recordClaim(address: string, ts: number): void {
  const s = load();
  s[address] = ts;
  save(s);
}
