// zkorage Model B — encrypted "rooms you can open" vault (off-chain, opaque).
//
// A member's room list is not a secret (room ids + self-chosen labels + last-known status; access is always
// re-derived from the wallet, per sign-to-derive). But to make it portable across devices WITHOUT us holding a
// {wallet -> rooms} mapping (which would re-create the cross-room correlation Model B avoids), the BROWSER
// encrypts the list under a wallet-derived key (AES-256-GCM, see frontend roomsBackup.ts) and stores the
// CIPHERTEXT here under a wallet-derived PSEUDONYM handle. So the backend holds an opaque blob it cannot
// decrypt, indexed by a handle it cannot link to a wallet address or to any per-room id; the room OWNER (the
// adversary the anonymity protects against) never sees it. Honest residual: the operator can see that a
// pseudonymous handle exists and its update cadence (timestamps, blob-size deltas), never the rooms or the
// wallet. File-backed JSON (demo); atomic write + fail-loud, mirroring escrow-store / enroll-store.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_FILE = process.env.DR_VAULT_FILE ||
  resolve(dirname(fileURLToPath(import.meta.url)), "../data/dr-rooms-vault.json");

// The opaque encrypted blob (the frontend RoomsBackupFile shape; the backend never inspects its meaning).
export interface VaultBlob {
  magic: string;
  version: number;
  alg: string;
  iv: string;
  ct: string;
}

interface VaultRecord {
  blob: VaultBlob;
  updatedAt: number;
}

type Store = Record<string, VaultRecord>; // handleHex (lowercased) -> record

// Backstop on total tracked handles (demo: unauthenticated writes, so cap + evict-oldest keeps it bounded).
const MAX_VAULTS = 20_000;
const norm = (handle: string) => handle.toLowerCase();

function load(): Store {
  if (!existsSync(DATA_FILE)) return {};
  let raw: string;
  try {
    raw = readFileSync(DATA_FILE, "utf8");
  } catch (e) {
    throw new Error(`vault-store: cannot read ${DATA_FILE}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Store;
  } catch {
    throw new Error(`vault-store: ${DATA_FILE} is corrupt (invalid JSON) — refusing to proceed. Restore or remove it.`);
  }
}

function save(s: Store): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, DATA_FILE);
}

export function getVault(handle: string): VaultBlob | null {
  return load()[norm(handle)]?.blob ?? null;
}

export function putVault(handle: string, blob: VaultBlob, nowMs: number): void {
  const s = load();
  const h = norm(handle);
  if (!(h in s) && Object.keys(s).length >= MAX_VAULTS) {
    // Evict the oldest-touched handle to stay bounded. A production deployment would authenticate writes and
    // quota per identity instead; for a resettable demo this is a sufficient backstop.
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of Object.entries(s)) {
      if (v.updatedAt < oldestTs) {
        oldestTs = v.updatedAt;
        oldest = k;
      }
    }
    if (oldest) delete s[oldest];
  }
  s[h] = { blob, updatedAt: nowMs };
  save(s);
}

export function deleteVault(handle: string): boolean {
  const s = load();
  const h = norm(handle);
  if (!(h in s)) return false;
  delete s[h];
  save(s);
  return true;
}
