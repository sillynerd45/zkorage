// zkorage DR4 — document-authenticity (zkPDF in-engine) helpers. Models the THIRD-PARTY signer (a bank)
// whose RSA-2048 signature the docauth guest re-verifies in-zkVM, and builds the prover job.
//
// Byte-exact with the RISC0 docauth guest (prover/methods/guest-docauth/src/main.rs) and the DataRoom
// contract's attest_document_fact:
//   statement (88 B, fixed layout) = "zkorage-bankstmt"(16) ‖ version u32=1 ‖ field_tag u32=1 ‖
//                                    account_ref(32) ‖ value u64 ‖ issued_at u64 ‖ expiry u64 ‖ "USD\0..."(8)
//   the bank signs RSA PKCS#1 v1.5 over sha256(statement) (SHA-256, e=65537)
//   issuer_key_hash = sha256(modulus n, 256 B big-endian)   (the allowlisted third-party key id)
//   msg_digest      = sha256(statement)                     (binds the fact to the exact document)
// The guest proves "value >= threshold" WITHOUT revealing the statement; only the predicate, threshold,
// issuer_key_hash, room_id and msg_digest are public. This is "third-party truth on self-uploaded data":
// a self-minted RSA key is rejected on-chain (the issuer must be allowlisted).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toHex } from "./envelope.js";

export const STATEMENT_LEN = 88;
const STATEMENT_DOMAIN = Buffer.from("zkorage-bankstmt", "ascii"); // 16 bytes
const STATEMENT_VERSION = 1;
export const FIELD_TAG_BALANCE = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The mock bank's persistent RSA key (so the on-chain issuer allowlist + any seeded demo fact stay valid
// across restarts). In production this key belongs to the bank/authority — we never hold it; we only verify
// its signature and allowlist its public key. Overridable via DR4_ISSUER_KEY_FILE.
const ISSUER_KEY_FILE =
  process.env.DR4_ISSUER_KEY_FILE || path.resolve(HERE, "../data/dr4-bank-issuer.pem");

export interface BankIssuer {
  privateKey: crypto.KeyObject;
  /** RSA modulus n as 256-byte big-endian hex (RSA-2048). */
  nHex: string;
  /** sha256(n) — the allowlisted issuer key id the contract pins. */
  issuerKeyHash: string;
}

let cached: BankIssuer | undefined;

/** The RSA modulus n (256-byte big-endian) of an RSA public key, as a Buffer. */
function modulusBE(pub: crypto.KeyObject): Buffer {
  const jwk = pub.export({ format: "jwk" }) as { n?: string };
  if (!jwk.n) throw new Error("not an RSA key");
  let n = Buffer.from(jwk.n, "base64url");
  if (n.length > 256) {
    // strip a leading zero byte if present (shouldn't happen for a 2048-bit modulus)
    n = n.subarray(n.length - 256);
  } else if (n.length < 256) {
    n = Buffer.concat([Buffer.alloc(256 - n.length), n]);
  }
  return n;
}

/** Load the persistent mock-bank RSA-2048 issuer, generating + saving it on first use. */
export function bankIssuer(): BankIssuer {
  if (cached) return cached;
  let privateKey: crypto.KeyObject;
  if (fs.existsSync(ISSUER_KEY_FILE)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(ISSUER_KEY_FILE, "utf8"));
  } else {
    const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKey = kp.privateKey;
    fs.mkdirSync(path.dirname(ISSUER_KEY_FILE), { recursive: true });
    fs.writeFileSync(
      ISSUER_KEY_FILE,
      privateKey.export({ format: "pem", type: "pkcs8" }) as string,
      { mode: 0o600 },
    );
  }
  const pub = crypto.createPublicKey(privateKey);
  const n = modulusBE(pub);
  const issuerKeyHash = crypto.createHash("sha256").update(n).digest();
  cached = { privateKey, nHex: toHex(n), issuerKeyHash: toHex(issuerKeyHash) };
  return cached;
}

export interface StatementFields {
  /** 32-byte opaque account reference (stays private). Defaults to a fixed demo account. */
  accountRef?: Uint8Array;
  /** the attested balance in minor units (e.g. cents) — stays PRIVATE. */
  value: bigint | number;
  /** unix seconds the statement was issued. */
  issuedAt?: bigint | number;
  /** unix seconds the statement expires (0 = none). */
  expiry?: bigint | number;
}

/** Build the fixed-layout 88-byte signed bank statement (byte-exact with the guest). */
export function buildStatement(f: StatementFields): Buffer {
  const account = f.accountRef ? Buffer.from(f.accountRef) : Buffer.alloc(32, 0x44);
  if (account.length !== 32) throw new Error("accountRef must be 32 bytes");
  const b = Buffer.alloc(STATEMENT_LEN);
  STATEMENT_DOMAIN.copy(b, 0); // [0..16]
  b.writeUInt32BE(STATEMENT_VERSION, 16); // [16..20]
  b.writeUInt32BE(FIELD_TAG_BALANCE, 20); // [20..24]
  account.copy(b, 24); // [24..56]
  b.writeBigUInt64BE(BigInt(f.value), 56); // [56..64]
  b.writeBigUInt64BE(BigInt(f.issuedAt ?? 1_750_000_000), 64); // [64..72]
  b.writeBigUInt64BE(BigInt(f.expiry ?? 0), 72); // [72..80]
  Buffer.from("USD\0\0\0\0\0", "binary").copy(b, 80); // [80..88]
  return b;
}

/** RSA PKCS#1 v1.5 sign sha256(statement) with the bank's key — exactly what the guest verifies. */
export function signStatement(privateKey: crypto.KeyObject, statement: Buffer): Buffer {
  return crypto.sign("sha256", statement, {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
}

export interface DocauthJob {
  job: {
    kind: "docauth";
    n_hex: string;
    sig_hex: string;
    statement_hex: string;
    threshold: string;
    room_id_hex: string;
  };
  msgDigest: string;
  issuerKeyHash: string;
  statementHex: string;
}

/** Build a docauth prover job: the bank signs a statement asserting `value`, and we prove `value >= threshold`. */
export function buildDocauthJob(opts: {
  roomIdHex: string;
  value: bigint | number;
  threshold: bigint | number;
  accountRef?: Uint8Array;
  issuedAt?: bigint | number;
  expiry?: bigint | number;
}): DocauthJob {
  const issuer = bankIssuer();
  const room = Buffer.from(opts.roomIdHex, "hex");
  if (room.length !== 32) throw new Error("roomId must be 32-byte hex");
  const statement = buildStatement({
    accountRef: opts.accountRef,
    value: opts.value,
    issuedAt: opts.issuedAt,
    expiry: opts.expiry,
  });
  const sig = signStatement(issuer.privateKey, statement);
  if (sig.length !== 256) throw new Error("unexpected RSA signature length");
  const msgDigest = crypto.createHash("sha256").update(statement).digest();
  const threshold = BigInt(opts.threshold);
  if (threshold < 0n || threshold > 0xffffffffffffffffn) throw new Error("threshold out of u64 range");
  return {
    job: {
      kind: "docauth",
      n_hex: issuer.nHex,
      sig_hex: toHex(sig),
      statement_hex: toHex(statement),
      threshold: threshold.toString(),
      room_id_hex: opts.roomIdHex,
    },
    msgDigest: toHex(msgDigest),
    issuerKeyHash: issuer.issuerKeyHash,
    statementHex: toHex(statement),
  };
}
