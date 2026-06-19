// zkorage DR3 keyper — file-backed share store. Holds ONLY this keyper's shares (one share of each
// document's K), keyed by (room_id, doc_id). A single keyper's store is information-theoretically blind to
// any K (t=2 → one share reveals nothing). Atomic writes (temp + rename) so a crash can't corrupt the file.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const HEX32 = /^[0-9a-f]{64}$/;

function key(roomIdHex: string, docIdHex: string): string {
  return `${roomIdHex}:${docIdHex}`;
}

export class ShareStore {
  private path: string;
  private shares: Record<string, string>; // "room:doc" -> share_y hex (64 chars)

  constructor(path: string) {
    this.path = path;
    this.shares = {};
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object") this.shares = parsed as Record<string, string>;
      } catch (e) {
        // Fail LOUD: a corrupt store silently resetting to {} would drop every share (DR2's lesson).
        throw new Error(`keyper share store at ${path} is corrupt: ${(e as Error).message}`);
      }
    }
  }

  /** Store this keyper's share for a document. Idempotent; overwrites are allowed (re-deal). */
  put(roomIdHex: string, docIdHex: string, shareYHex: string): void {
    if (!HEX32.test(roomIdHex) || !HEX32.test(docIdHex)) throw new Error("room_id/doc_id must be 32-byte hex");
    if (!HEX32.test(shareYHex)) throw new Error("share_y must be 32-byte hex");
    this.shares[key(roomIdHex, docIdHex)] = shareYHex;
    this.flush();
  }

  /** This keyper's share for (room, doc), or null. */
  get(roomIdHex: string, docIdHex: string): string | null {
    return this.shares[key(roomIdHex, docIdHex)] ?? null;
  }

  has(roomIdHex: string, docIdHex: string): boolean {
    return key(roomIdHex, docIdHex) in this.shares;
  }

  count(): number {
    return Object.keys(this.shares).length;
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.shares, null, 2));
    renameSync(tmp, this.path); // atomic on the same filesystem
  }
}
