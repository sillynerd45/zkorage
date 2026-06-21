// M2 Step 2 — verify the keyper's SEALED-deal path (Model B browser dealer).
// Start a keyper, then: build a sealed deal the way the browser dealer would (ECIES-seal a share to the
// keyper's static SEAL_PUB), POST it, and confirm the keyper opens it, stores the RAW share, exposes its
// seal_pub, and rejects a deal sealed to the wrong key.
//
//   cd keyper && KEYPER_INDEX=2 KEYPER_PORT=8899 DEAL_TOKEN=t KEYPER_SEAL_SECRET=s \
//     DATAROOM_CONTRACT_ID=CDUMMY SHARE_STORE_PATH=/tmp/zkm2-keyper.json npx tsx scripts/m2-deal-selftest.ts
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import { x25519 } from "@noble/curves/ed25519";
import { shareEciesSeal } from "../src/share-ecies.js";

const PORT = Number(process.env.KEYPER_PORT || "8899");
const TOKEN = process.env.DEAL_TOKEN || "t";
const INDEX = Number(process.env.KEYPER_INDEX || "2");
const STORE = process.env.SHARE_STORE_PATH || "/tmp/zkm2-keyper.json";
const BASE = `http://127.0.0.1:${PORT}`;
const toHex = (u: Uint8Array) => Buffer.from(u).toString("hex");

// Derive the keyper's static seal key EXACTLY as keyper.ts does (must stay in sync).
const sealSecret = sha256(new TextEncoder().encode(
  process.env.KEYPER_SEAL_SECRET ? `zkorage-keyper-seal-v1:${process.env.KEYPER_SEAL_SECRET}` : `zkorage-keyper-seal-dev-v1:${INDEX}`,
));
const sealPub = x25519.getPublicKey(sealSecret);

let failures = 0;
const ok = (c: boolean, label: string) => { console.log(`${c ? "✓" : "✗"} ${label}`); if (!c) failures++; };
const sealedFor = (recipientPub: Uint8Array, shareY: Uint8Array, room: Uint8Array, doc: Uint8Array) => {
  const s = shareEciesSeal(shareY, INDEX, recipientPub, sha256(new TextEncoder().encode("m2-eph")).slice(0, 32), room, doc);
  return { eph_pub: toHex(s.ephPub), ct: toHex(s.ct), tag: toHex(s.tag) };
};

const shareY = sha256(new TextEncoder().encode("m2-share")).slice(0, 32);
const room = sha256(new TextEncoder().encode("m2-room")).slice(0, 32);
const doc = sha256(new TextEncoder().encode("m2-doc")).slice(0, 32);
const roomHex = toHex(room), docHex = toHex(doc);

// /health exposes the static seal pub the dealer seals to.
const health = await (await fetch(`${BASE}/health`)).json();
ok(health.seal_pub === toHex(sealPub), "/health exposes seal_pub matching the derived static key");

// A sealed deal to the CORRECT seal key is opened + stored.
const good = await fetch(`${BASE}/deal`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ room_id: roomHex, doc_id: docHex, keyper_index: INDEX, sealed: sealedFor(sealPub, shareY, room, doc) }),
});
ok(good.status === 200, "sealed deal to the keyper's seal key is accepted (200)");
const stored = readFileSync(STORE, "utf8");
ok(stored.includes(toHex(shareY)), "the keyper stored the correctly DECRYPTED raw share");

// A sealed deal to the WRONG key fails to open (tag mismatch) → 400, never stored.
const wrongPub = x25519.getPublicKey(sha256(new TextEncoder().encode("not-the-keeper")).slice(0, 32));
const bad = await fetch(`${BASE}/deal`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ room_id: roomHex, doc_id: docHex, keyper_index: INDEX, sealed: sealedFor(wrongPub, shareY, room, doc) }),
});
ok(bad.status === 400, "a deal sealed to the wrong key is rejected (400)");

// The legacy raw-deal path still works (back-compat).
const raw = await fetch(`${BASE}/deal`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ room_id: roomHex, doc_id: toHex(sha256(new TextEncoder().encode("m2-doc2")).slice(0, 32)), keyper_index: INDEX, share_y: toHex(shareY) }),
});
ok(raw.status === 200, "legacy raw share_y deal still accepted (back-compat)");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
