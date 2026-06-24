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

const HERE = dirname(fileURLToPath(import.meta.url));
// Two opaque-blob stores keyed by an unguessable wallet-derived pseudonym handle: the Data Room "rooms you can
// open" list, and the standalone Bonded Access handle secret. Same shape + invariants, separate files so the
// two namespaces never share a file even though their handles are derived from different HKDF info anyway.
const DATA_FILE = process.env.DR_VAULT_FILE || resolve(HERE, "../data/dr-rooms-vault.json");
const BOND_FILE = process.env.BOND_HANDLE_VAULT_FILE || resolve(HERE, "../data/bonded-handle-vault.json");

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

function load(file: string): Store {
  if (!existsSync(file)) return {};
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`vault-store: cannot read ${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Store;
  } catch {
    throw new Error(`vault-store: ${file} is corrupt (invalid JSON) — refusing to proceed. Restore or remove it.`);
  }
}

function save(file: string, s: Store): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
}

function getBlob(file: string, handle: string): VaultBlob | null {
  return load(file)[norm(handle)]?.blob ?? null;
}

function putBlob(file: string, handle: string, blob: VaultBlob, nowMs: number): void {
  const s = load(file);
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
  save(file, s);
}

function delBlob(file: string, handle: string): boolean {
  const s = load(file);
  const h = norm(handle);
  if (!(h in s)) return false;
  delete s[h];
  save(file, s);
  return true;
}

// Data Room "rooms you can open" vault.
export const getVault = (handle: string): VaultBlob | null => getBlob(DATA_FILE, handle);
export const putVault = (handle: string, blob: VaultBlob, nowMs: number): void => putBlob(DATA_FILE, handle, blob, nowMs);
export const deleteVault = (handle: string): boolean => delBlob(DATA_FILE, handle);

// Standalone Bonded Access handle vault (its own file; the encrypted handle secret follows the wallet).
export const getBondHandleVault = (handle: string): VaultBlob | null => getBlob(BOND_FILE, handle);
export const putBondHandleVault = (handle: string, blob: VaultBlob, nowMs: number): void => putBlob(BOND_FILE, handle, blob, nowMs);
export const deleteBondHandleVault = (handle: string): boolean => delBlob(BOND_FILE, handle);
