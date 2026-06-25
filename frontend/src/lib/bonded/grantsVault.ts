// Wallet-derived sync for the standalone Bonded Access "Your access" list.
//
// The handle's grant records (token + amount + deadline per requirement the handle proved) normally live only
// in this browser's localStorage. This module encrypts that list under a key HKDF'd from the SAME wallet
// signature the handle vault uses (so it costs no extra prompt), but with a DISTINCT HKDF salt/info, so the
// enc key and the vault id are different domains from the handle vault. The ciphertext is stored on the backend
// under a wallet-derived pseudonym; the backend holds an opaque blob it cannot read, and only the same wallet
// can decrypt it. The list then follows the wallet to other devices, alongside the handle.
//
// The records carry NO secret (they are the public requirement values the user picked), but encrypting them
// under the wallet keeps them private to the wallet, consistent with the handle vault. Web Crypto only (no
// React / no @/ alias / no SDK), so it round-trips in the browser AND under tsx in Node 22.

import type { BondGrantRecord } from "./grants";

const MAGIC = "zkorage-bond-grants";
const VERSION = 1;
const HKDF_SALT_KEY = "zkorage-bond-grants-key-salt-v1";
const HKDF_INFO_KEY = "zkorage:bond-grants-key:v1";
const HKDF_SALT_ID = "zkorage-bond-grants-vault-id-salt-v1";
const HKDF_INFO_ID = "zkorage:bond-grants-vault-id:v1";

export interface BondGrantsBlob {
  magic: string;
  version: number;
  alg: "AES-256-GCM";
  iv: string; // base64, 12 bytes
  ct: string; // base64 ciphertext + tag of UTF-8 JSON(BondGrantRecord[])
}

const te = new TextEncoder();
const td = new TextDecoder();

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
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u.byteLength);
  new Uint8Array(ab).set(u);
  return ab;
}

async function deriveKey(sig: Uint8Array): Promise<CryptoKey> {
  if (!sig || sig.length === 0) throw new Error("Missing wallet signature.");
  const ikm = await crypto.subtle.importKey("raw", toArrayBuffer(sig), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(te.encode(HKDF_SALT_KEY)), info: toArrayBuffer(te.encode(HKDF_INFO_KEY)) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A stable, wallet-derived PSEUDONYM that indexes the grants vault. Distinct salt+info from the enc key AND
 *  from the handle vault id, so the backend cannot link this list to the wallet or to the handle vault. 32-byte hex. */
export async function deriveBondGrantsVaultId(sig: Uint8Array): Promise<string> {
  if (!sig || sig.length === 0) throw new Error("Missing wallet signature.");
  const ikm = await crypto.subtle.importKey("raw", toArrayBuffer(sig), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(te.encode(HKDF_SALT_ID)), info: toArrayBuffer(te.encode(HKDF_INFO_ID)) },
    ikm,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Encrypt the grant records into an opaque blob. Carries no secret (public requirement values only). */
export async function encryptBondGrants(sig: Uint8Array, grants: BondGrantRecord[]): Promise<BondGrantsBlob> {
  const key = await deriveKey(sig);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = te.encode(JSON.stringify(grants));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(pt)));
  return { magic: MAGIC, version: VERSION, alg: "AES-256-GCM", iv: b64encode(iv), ct: b64encode(ct) };
}

const isHex64 = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);

// Validate one decrypted record (a tampered-but-decryptable blob cannot inject junk; recordBondGrant
// re-sanitizes on merge, so this is a first, conservative filter).
function validRecord(r: unknown): r is BondGrantRecord {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return (
    isHex64(o.reqId) &&
    typeof o.tokenSymbol === "string" &&
    o.tokenSymbol.length > 0 &&
    typeof o.minAmount === "string" &&
    /^\d{1,40}$/.test(o.minAmount) &&
    Number.isInteger(o.decimals) &&
    (o.decimals as number) >= 0 &&
    (o.decimals as number) <= 18 &&
    Number.isFinite(o.deadline) &&
    (o.deadline as number) > 0
  );
}

/** Decrypt the grants blob with the same wallet's signature. Throws on a wrong wallet or a malformed/foreign
 *  blob; returns only the records that pass a shape check (junk rows dropped). */
export async function decryptBondGrants(sig: Uint8Array, file: unknown): Promise<BondGrantRecord[]> {
  const f = file as Partial<BondGrantsBlob> | null;
  if (!f || typeof f !== "object" || f.magic !== MAGIC) throw new Error("Not a zkorage bond grants blob.");
  if (f.version !== VERSION) throw new Error(`Unsupported grants version (${String(f.version)}).`);
  if (f.alg !== "AES-256-GCM" || typeof f.iv !== "string" || typeof f.ct !== "string") throw new Error("Malformed grants blob.");
  const key = await deriveKey(sig);
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(b64decode(f.iv)) }, key, toArrayBuffer(b64decode(f.ct)));
  } catch {
    throw new Error("Could not decrypt. This list was saved by a different wallet.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(td.decode(ptBuf));
  } catch {
    throw new Error("Malformed grants contents.");
  }
  if (!Array.isArray(parsed)) throw new Error("Malformed grants contents.");
  return parsed.filter(validRecord);
}
