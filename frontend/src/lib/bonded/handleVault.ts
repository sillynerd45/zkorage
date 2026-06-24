// Wallet-derived sync for the standalone Bonded Access handle.
//
// The handle's secret (id_secret / id_trapdoor / holder_seed) normally lives only in this browser's
// localStorage, so it does not follow you to another device. This module encrypts that secret under a key
// HKDF'd from a wallet SIGNATURE (SEP-53 over a fixed message) and stores the CIPHERTEXT on the backend under
// a wallet-derived PSEUDONYM handle. So the backend holds an opaque blob it cannot read, indexed by a handle
// it cannot link to a wallet, and ONLY the same wallet can decrypt it. The handle then follows your wallet,
// not your browser: a new device signs the same message, derives the same key + vault id, and restores it.
//
// Dependency-light by design (Web Crypto only, no React / no @/ alias / no SDK), so it round-trips in the
// browser AND under tsx in Node 22 (globalThis.crypto.subtle), which keeps the selftest runnable offline.

// The SEP-53 message a wallet signs to derive the bond-handle vault key + id. Distinct from the Data Room's
// identity message, so this is its own domain (a separate, self-contained signature).
export const BOND_HANDLE_VAULT_MESSAGE = "zkorage Bonded Access handle backup v1";

const MAGIC = "zkorage-bond-handle";
const VERSION = 1;
const HKDF_SALT_KEY = "zkorage-bond-handle-key-salt-v1";
const HKDF_INFO_KEY = "zkorage:bond-handle-key:v1";
const HKDF_SALT_ID = "zkorage-bond-handle-vault-id-salt-v1";
const HKDF_INFO_ID = "zkorage:bond-handle-vault-id:v1";

// The five 32-byte hex fields of a minted bond handle (mirrors the frontend BondIdentity / backend mint).
export interface BondHandle {
  idSecret: string;
  idTrapdoor: string;
  holderSeed: string;
  accessor: string;
  qualCommitment: string;
}

export interface BondHandleBlob {
  magic: string;
  version: number;
  alg: "AES-256-GCM";
  iv: string; // base64, 12 bytes
  ct: string; // base64 ciphertext + tag of UTF-8 JSON(BondHandle)
}

const te = new TextEncoder();
const td = new TextDecoder();
const isHex32 = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);

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

// Copy a view into a fresh plain ArrayBuffer (WebCrypto's BufferSource rejects Uint8Array<ArrayBufferLike>).
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

/** A stable, wallet-derived PSEUDONYM that indexes the vault. Distinct salt+info from the enc key (and from
 *  the Data Room rooms-vault id), so the backend cannot link this handle to the wallet or to a room. 32-byte hex. */
export async function deriveBondHandleVaultId(sig: Uint8Array): Promise<string> {
  if (!sig || sig.length === 0) throw new Error("Missing wallet signature.");
  const ikm = await crypto.subtle.importKey("raw", toArrayBuffer(sig), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(te.encode(HKDF_SALT_ID)), info: toArrayBuffer(te.encode(HKDF_INFO_ID)) },
    ikm,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Encrypt a bond handle into an opaque blob. Carries no plaintext secret. */
export async function encryptBondHandle(sig: Uint8Array, handle: BondHandle): Promise<BondHandleBlob> {
  const key = await deriveKey(sig);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = te.encode(JSON.stringify(handle));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(pt)));
  return { magic: MAGIC, version: VERSION, alg: "AES-256-GCM", iv: b64encode(iv), ct: b64encode(ct) };
}

/** Decrypt a blob with the same wallet's signature. Throws on a wrong wallet or a malformed/foreign blob, and
 *  validates every field is 32-byte hex (a tampered-but-decryptable blob cannot inject junk into the handle). */
export async function decryptBondHandle(sig: Uint8Array, file: unknown): Promise<BondHandle> {
  const f = file as Partial<BondHandleBlob> | null;
  if (!f || typeof f !== "object" || f.magic !== MAGIC) throw new Error("Not a zkorage bond handle blob.");
  if (f.version !== VERSION) throw new Error(`Unsupported handle version (${String(f.version)}).`);
  if (f.alg !== "AES-256-GCM" || typeof f.iv !== "string" || typeof f.ct !== "string") throw new Error("Malformed handle blob.");
  const key = await deriveKey(sig);
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(b64decode(f.iv)) }, key, toArrayBuffer(b64decode(f.ct)));
  } catch {
    throw new Error("Could not decrypt. This handle was saved by a different wallet.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(td.decode(ptBuf));
  } catch {
    throw new Error("Malformed handle contents.");
  }
  const h = parsed as Partial<BondHandle> | null;
  if (!h || typeof h !== "object") throw new Error("Malformed handle contents.");
  if (!isHex32(h.idSecret) || !isHex32(h.idTrapdoor) || !isHex32(h.holderSeed) || !isHex32(h.accessor) || !isHex32(h.qualCommitment)) {
    throw new Error("Handle blob is missing or has invalid fields.");
  }
  return { idSecret: h.idSecret, idTrapdoor: h.idTrapdoor, holderSeed: h.holderSeed, accessor: h.accessor, qualCommitment: h.qualCommitment };
}
