// zkorage Confidential Data Room — DR1 blob storage adapter.
//
// The encrypted document ciphertext lives OFF-CHAIN; only a `sha256(ciphertext)` commitment + the ECIES
// disclosure are anchored on Soroban (DataRoom `put_document`). This module is the off-chain store behind
// a tiny interface so the rest of the backend never cares where bytes physically live:
//   * **Cloudflare R2** (S3-compatible) when R2 creds are present in the env — the decided primary store
//     (zero egress, CDN-backed → snappy "decrypt-now" retrieval; PLAN §8).
//   * a **LOCAL filesystem stand-in** (backend/data/blobs) otherwise — so the slice is fully self-testable
//     with no external dependency. Same interface, same content-addressing.
//
// Blobs are **content-addressed by `sha256(ciphertext)`** — the object key IS the hash, so storage is
// idempotent (re-`put` of identical bytes dedups) and a fetcher can verify the bytes regardless of which
// store/CDN/mirror served them (the on-chain `content_hash` is the source of truth). The blob is ALWAYS
// ciphertext — storage is an availability/censorship concern here, never a confidentiality one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { toHex } from "./envelope.js";

export type StorageBackend = "r2" | "local";

export interface PutResult {
  /** sha256(ciphertext) as 64-char lowercase hex — the on-chain content commitment + the object key. */
  contentHash: string;
  /** Opaque off-chain pointer stored on-chain as metadata (e.g. `r2://bucket/blobs/<hash>.bin`). */
  blobPointer: string;
  size: number;
  /** True if the bytes were already present (content-addressed dedup) and no upload happened. */
  deduped: boolean;
}

export interface BlobStore {
  readonly backend: StorageBackend;
  /** Store `bytes`, returning the content hash + a retrieval pointer. Idempotent (dedups by hash). */
  put(bytes: Uint8Array): Promise<PutResult>;
  /** Fetch by content hash. Returns null if absent. Callers MUST re-verify sha256 == contentHash. */
  get(contentHash: string): Promise<Uint8Array | null>;
  /** True iff a blob with this content hash is already stored. */
  has(contentHash: string): Promise<boolean>;
}

/** Object key for a content hash. Namespaced so the bucket/dir can hold other zkorage artifacts. */
function keyFor(contentHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new Error("contentHash must be 32-byte hex");
  return `blobs/${contentHash}.bin`;
}

// ─────────────────────────────── Local filesystem stand-in ───────────────────────────────

class LocalBlobStore implements BlobStore {
  readonly backend = "local" as const;
  constructor(private dir: string) {}

  private pathFor(contentHash: string): string {
    return path.join(this.dir, keyFor(contentHash));
  }

  async put(bytes: Uint8Array): Promise<PutResult> {
    const contentHash = toHex(sha256(bytes));
    const file = this.pathFor(contentHash);
    const blobPointer = `local://${keyFor(contentHash)}`;
    if (fs.existsSync(file)) return { contentHash, blobPointer, size: bytes.length, deduped: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return { contentHash, blobPointer, size: bytes.length, deduped: false };
  }

  async get(contentHash: string): Promise<Uint8Array | null> {
    const file = this.pathFor(contentHash);
    if (!fs.existsSync(file)) return null;
    return new Uint8Array(fs.readFileSync(file));
  }

  async has(contentHash: string): Promise<boolean> {
    return fs.existsSync(this.pathFor(contentHash));
  }
}

// ─────────────────────────────────── Cloudflare R2 (S3) ───────────────────────────────────

interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// The S3 client + commands are imported lazily so a local-only deployment never loads the AWS SDK.
class R2BlobStore implements BlobStore {
  readonly backend = "r2" as const;
  private clientPromise: Promise<{
    client: import("@aws-sdk/client-s3").S3Client;
    PutObjectCommand: typeof import("@aws-sdk/client-s3").PutObjectCommand;
    GetObjectCommand: typeof import("@aws-sdk/client-s3").GetObjectCommand;
    HeadObjectCommand: typeof import("@aws-sdk/client-s3").HeadObjectCommand;
  }> | null = null;

  constructor(private cfg: R2Config) {}

  private async sdk() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = await import(
          "@aws-sdk/client-s3"
        );
        const client = new S3Client({
          // R2 ignores region but the SDK requires one; "auto" is Cloudflare's documented value.
          region: "auto",
          endpoint: this.cfg.endpoint,
          credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey },
          // Address the bucket by path against the account endpoint (robust for R2's account-level host).
          forcePathStyle: true,
        });
        return { client, PutObjectCommand, GetObjectCommand, HeadObjectCommand };
      })();
    }
    return this.clientPromise;
  }

  async put(bytes: Uint8Array): Promise<PutResult> {
    const contentHash = toHex(sha256(bytes));
    const key = keyFor(contentHash);
    const blobPointer = `r2://${this.cfg.bucket}/${key}`;
    // Benign check-then-act race: two concurrent puts of identical bytes may both upload, but storage is
    // content-addressed + idempotent (the second overwrites byte-identical content), so no lock is needed.
    if (await this.has(contentHash)) return { contentHash, blobPointer, size: bytes.length, deduped: true };
    const { client, PutObjectCommand } = await this.sdk();
    await client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
    );
    return { contentHash, blobPointer, size: bytes.length, deduped: false };
  }

  async get(contentHash: string): Promise<Uint8Array | null> {
    const key = keyFor(contentHash);
    const { client, GetObjectCommand } = await this.sdk();
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      if (!out.Body) return null;
      // The SDK's Node stream exposes transformToByteArray(); avoids manual stream plumbing.
      const arr = await (out.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      return new Uint8Array(arr);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async has(contentHash: string): Promise<boolean> {
    const key = keyFor(contentHash);
    const { client, HeadObjectCommand } = await this.sdk();
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }
}

function isNotFound(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

// ─────────────────────────────────────── Factory ───────────────────────────────────────────

let cached: BlobStore | null = null;

/** All R2 creds present? If so we use R2; otherwise the local stand-in (self-testable default). */
function r2ConfigFromEnv(): R2Config | null {
  const endpoint = process.env.R2_ENDPOINT?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    return { endpoint, bucket, accessKeyId, secretAccessKey };
  }
  return null;
}

/** The process-wide blob store (R2 when creds are configured, else the local stand-in). Cached. */
export function getBlobStore(): BlobStore {
  if (cached) return cached;
  const r2 = r2ConfigFromEnv();
  if (r2) {
    cached = new R2BlobStore(r2);
  } else {
    const dir = process.env.BLOB_DIR || path.join("data", "blobs");
    cached = new LocalBlobStore(dir);
  }
  return cached;
}

// CLI self-test: round-trip put → has → get for the active backend (`npx tsx src/storage.ts`).
// (Robust main-module check — a bare `file://${process.argv[1]}` never matches under tsx on Windows,
// where argv[1] is a relative path but import.meta.url is an absolute file URL.)
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  (async () => {
    const store = getBlobStore();
    const bytes = new TextEncoder().encode("zkorage dataroom storage self-test " + new Date().toISOString());
    const put = await store.put(bytes);
    const has = await store.has(put.contentHash);
    const got = await store.get(put.contentHash);
    const roundTrip = !!got && toHex(sha256(got)) === put.contentHash;
    const dedup = await store.put(bytes); // identical bytes → must dedup
    console.log("backend     =", store.backend);
    console.log("contentHash =", put.contentHash);
    console.log("blobPointer =", put.blobPointer);
    console.log("size        =", put.size, "deduped(1st)=", put.deduped);
    console.log("has         =", has);
    console.log("roundTrip   =", roundTrip);
    console.log("dedup(2nd)  =", dedup.deduped);
    if (!has || !roundTrip || !dedup.deduped) throw new Error("storage self-test FAILED");
    console.log("[ok] storage round-trip + content-addressed dedup");
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
