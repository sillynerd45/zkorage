// zkorage Model B (M2) — per-(room,doc) OWNER-ESCROW store (off-chain). When the browser dealer stores a
// committee document, it also ECIES-seals a copy of K to the OWNER's own sign-to-derive recipient key. That
// sealed copy lives here so the owner can reopen the document on any device WITHOUT going through the keeper
// committee. It is a sealed key (opens only with the owner's secret), never K in the clear. File-backed JSON
// (demo); atomic write + fail-loud, mirroring eligible-store / enroll-store.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_FILE = process.env.DR_ESCROW_FILE ||
  resolve(dirname(fileURLToPath(import.meta.url)), "../data/dr-escrow.json");

/** A sealed owner-escrow copy of K, opened with recoverDocumentKey + the owner's recipient secret. */
export interface EscrowCopy {
  ephPub: string;
  ct: string;
  tag: string;
  contentHash: string;
  roomId: string;
  docId: string;
  /** The owner's x25519 recipient public key this copy is sealed to (for display / sanity only). */
  recipientPub: string;
}

type Store = Record<string, EscrowCopy>; // `${roomIdHex}:${docIdHex}` -> sealed copy

const key = (room: string, doc: string) => `${room.toLowerCase()}:${doc.toLowerCase()}`;

function load(): Store {
  if (!existsSync(DATA_FILE)) return {};
  let raw: string;
  try {
    raw = readFileSync(DATA_FILE, "utf8");
  } catch (e) {
    throw new Error(`escrow-store: cannot read ${DATA_FILE}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Store;
  } catch {
    throw new Error(`escrow-store: ${DATA_FILE} is corrupt (invalid JSON) — refusing to proceed. Restore or remove it.`);
  }
}

function save(s: Store): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, DATA_FILE);
}

export function putEscrow(roomIdHex: string, docIdHex: string, copy: EscrowCopy): void {
  const s = load();
  s[key(roomIdHex, docIdHex)] = copy;
  save(s);
}

export function getEscrow(roomIdHex: string, docIdHex: string): EscrowCopy | null {
  return load()[key(roomIdHex, docIdHex)] ?? null;
}
