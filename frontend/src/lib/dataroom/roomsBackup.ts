// Encrypted, portable backup of the per-wallet "rooms you can open" list.
//
// The list itself is NOT a secret: it is room ids + your own labels + last-known status. Your actual access is
// re-derived from the wallet on any device (Model B sign-to-derive), so nothing in this file unlocks a room.
// We still encrypt it so a leaked file does not reveal which rooms you are in. The key is HKDF'd from the SAME
// wallet signature that derives your room identity, so ONLY the same wallet can read the file, and our server
// never holds the wallet->rooms mapping (that mapping is exactly the cross-room correlation server-side sync
// would have created). The new device decrypts with its wallet, then re-derives access per room as usual.
//
// Dependency-light by design (no React, no @/ alias, no SDK), so it round-trips both in the browser (Web
// Crypto) and under tsx in Node 22 (globalThis.crypto.subtle), which keeps the selftest runnable offline.
import type { JoinRequest } from "./requests";

const MAGIC = "zkorage-rooms-backup";
const VERSION = 1;
const HKDF_SALT = "zkorage-rooms-backup-salt-v1";
const HKDF_INFO = "zkorage:rooms-backup:v1";

export interface RoomsBackupFile {
  magic: string;
  version: number;
  alg: "AES-256-GCM";
  iv: string; // base64, 12 bytes
  ct: string; // base64 ciphertext + tag of UTF-8 JSON(JoinRequest[])
}

const te = new TextEncoder();
const td = new TextDecoder();

// Defensive bounds on import. A decryptable file is same-wallet, but it could be hand-edited then re-encrypted,
// so cap how many entries we ingest and how long a label can be: a pathological file must not bloat localStorage.
const MAX_IMPORT_ROOMS = 1000;
const MAX_LABEL_LEN = 200;

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const isHex32 = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);

// HKDF-SHA256(wallet signature) -> a 256-bit AES-GCM key, scoped by a backup-only info tag so it is distinct
// from any per-room identity key derived from the same signature.
// Copy a view's bytes into a fresh, plain ArrayBuffer (satisfies WebCrypto's strict BufferSource type, which
// rejects Uint8Array<ArrayBufferLike>). Mirrors the SDK's helper.
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u.byteLength);
  new Uint8Array(ab).set(u);
  return ab;
}

async function deriveBackupKey(sig: Uint8Array): Promise<CryptoKey> {
  if (!sig || sig.length === 0) throw new Error("Missing wallet signature.");
  const ikm = await crypto.subtle.importKey("raw", toArrayBuffer(sig), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(te.encode(HKDF_SALT)),
      info: toArrayBuffer(te.encode(HKDF_INFO)),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A stable, wallet-derived PSEUDONYM that indexes the encrypted vault on the backend. HKDF from the same
 *  signature as the identity + enc key, but a distinct salt+info, so the backend cannot link this handle to
 *  the wallet address or to any per-room id. 32 bytes, hex. */
export async function deriveVaultHandle(sig: Uint8Array): Promise<string> {
  if (!sig || sig.length === 0) throw new Error("Missing wallet signature.");
  const ikm = await crypto.subtle.importKey("raw", toArrayBuffer(sig), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(te.encode("zkorage-rooms-vault-id-salt-v1")),
      info: toArrayBuffer(te.encode("zkorage:rooms-vault-id:v1")),
    },
    ikm,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Encrypt a wallet's room list into a portable file. The file carries no plaintext room ids. */
export async function exportRoomsBackup(sig: Uint8Array, rooms: JoinRequest[]): Promise<RoomsBackupFile> {
  const key = await deriveBackupKey(sig);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = te.encode(JSON.stringify(rooms));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(pt)),
  );
  return { magic: MAGIC, version: VERSION, alg: "AES-256-GCM", iv: b64encode(iv), ct: b64encode(ct) };
}

/** Decrypt a backup file with the same wallet's signature. Throws a clear error on a wrong wallet or a
 *  malformed/foreign file. Returns only structurally-valid entries (hex room id, a known EnrollState, a finite
 *  ts, label truncated), rebuilt clean so extra injected fields are dropped, and capped, so a tampered file
 *  cannot put junk rows, an unknown state, or an oversized payload into the caller's room history. */
export async function importRoomsBackup(sig: Uint8Array, file: unknown): Promise<JoinRequest[]> {
  const f = file as Partial<RoomsBackupFile> | null;
  if (!f || typeof f !== "object" || f.magic !== MAGIC) throw new Error("Not a zkorage rooms backup file.");
  if (f.version !== VERSION) throw new Error(`Unsupported backup version (${String(f.version)}).`);
  if (f.alg !== "AES-256-GCM" || typeof f.iv !== "string" || typeof f.ct !== "string") {
    throw new Error("Malformed backup file.");
  }
  const key = await deriveBackupKey(sig);
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(b64decode(f.iv)) },
      key,
      toArrayBuffer(b64decode(f.ct)),
    );
  } catch {
    throw new Error("Could not decrypt. This file was made with a different wallet.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(td.decode(ptBuf));
  } catch {
    throw new Error("Malformed backup contents.");
  }
  if (!Array.isArray(parsed)) throw new Error("Malformed backup contents.");
  const valid: JoinRequest[] = [];
  for (const r of parsed) {
    if (!r || typeof r !== "object") continue;
    const e = r as JoinRequest;
    if (!isHex32(e.roomId)) continue;
    if (e.state !== "eligible" && e.state !== "pending" && e.state !== "none") continue; // EnrollState
    if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) continue;
    const label = typeof e.label === "string" ? e.label.slice(0, MAX_LABEL_LEN) : undefined;
    valid.push(
      label !== undefined
        ? { roomId: e.roomId, state: e.state, ts: e.ts, label }
        : { roomId: e.roomId, state: e.state, ts: e.ts },
    );
    if (valid.length >= MAX_IMPORT_ROOMS) break;
  }
  return valid;
}

/** Union two histories by lowercased roomId. On conflict keep the newer entry (max ts) but never lose a label.
 *  The merged status is only a hint; the authoritative check is the on-chain Refresh after import. */
export function mergeJoinRequests(existing: JoinRequest[], incoming: JoinRequest[]): JoinRequest[] {
  const byId = new Map<string, JoinRequest>();
  for (const r of [...existing, ...incoming]) {
    const k = r.roomId.toLowerCase();
    const prev = byId.get(k);
    if (!prev) {
      byId.set(k, { ...r });
      continue;
    }
    const newer = r.ts >= prev.ts ? r : prev;
    const older = r.ts >= prev.ts ? prev : r;
    byId.set(k, { ...newer, label: newer.label || older.label });
  }
  return [...byId.values()];
}
