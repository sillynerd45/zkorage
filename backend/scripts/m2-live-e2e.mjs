// M2 live e2e — drive the REAL browser-dealer path against the deployed stack (apizk + the 3 keepers + the
// chain). Simulates exactly what the browser does: read the keepers' seal_pubs, generate K, encrypt, split,
// seal each share to its keeper, seal an owner-escrow copy, POST /committee/deal-sealed, anchor (relay), then
// reopen via the owner-escrow copy + the stored ciphertext. Proves the keepers accept SEALED deals live and
// the relay never needed K.
//   cd backend && ZK_API=https://apizk.wazowsky.id ../sdk/node_modules/.bin/tsx scripts/m2-live-e2e.mjs
import { sha256 } from "@noble/hashes/sha256";
import {
  aeadSeal, aeadDecrypt, randomKey, randomBytes, shamirSplit, sealShare, sealDocumentKey,
  recoverDocumentKey, recipientPublicKeyFromSecret, toHex,
} from "zkorage-sdk";

const BASE = process.env.ZK_API || "https://apizk.wazowsky.id";
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`non-JSON from ${r.url}: ${t.slice(0, 200)}`); } };
const post = (p, b) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
let failures = 0;
const ok = (c, label) => { console.log(`${c ? "✓" : "✗"} ${label}`); if (!c) failures++; };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// The demo recipient keypair (the owner-escrow copy is sealed to it so this script can reopen it).
const OWNER_SECRET = toHex(sha256(new TextEncoder().encode("zkorage-demo-dataroom-recipient-key")).slice(0, 32));
const OWNER_PUB = recipientPublicKeyFromSecret(OWNER_SECRET);

const info = await fetch(`${BASE}/dataroom/committee/info`).then(j);
ok(info.online === info.n, `committee ${info.online}/${info.n} online`);
const keepers = info.keypers.filter((k) => k.ok && k.sealPub && k.keyperIndex);
ok(keepers.length === info.n, `all ${info.n} keepers expose a seal_pub`);

// 1) a fresh ADMIN-owned room (relay-created; unique label per run).
const label = `zkorage-m2-live-${Date.now()}`;
const room = await post("/dataroom/create-room", { roomId: label });
ok(room.ok && /^[0-9a-f]{64}$/.test(room.roomId || ""), `created room ${String(room.roomId).slice(0, 8)}…`);
const roomId = room.roomId;

// 2) THE BROWSER DEALER (here, in this script): K never leaves this process except as sealed material.
const plaintext = new TextEncoder().encode(`m2 live e2e — server never saw this — ${label}`);
const k = randomKey();
const blob = await aeadSeal(plaintext, k);
const contentHash = toHex(sha256(blob));
const kCommitment = toHex(sha256(k));
const docId = toHex(randomBytes(32));
const shares = shamirSplit(k, info.threshold, info.n);
const sealedShares = shares.map((sh) => {
  const keeper = keepers.find((kp) => kp.keyperIndex === sh.x);
  const s = sealShare(sh.y, sh.x, keeper.sealPub, roomId, docId);
  return { keyperIndex: sh.x, eph_pub: s.ephPub, ct: s.ct, tag: s.tag };
});
const escrow = sealDocumentKey(k, OWNER_PUB, contentHash, roomId, docId);

// 3) relay: ciphertext + sealed shares + escrow (the LIVE keepers must OPEN the sealed deals to store shares).
const blobB64 = Buffer.from(blob).toString("base64");
const dealt = await post("/dataroom/committee/deal-sealed", {
  roomId, docId, blobB64, kCommitment, sealedShares,
  escrow: { ephPub: escrow.ephPub, ct: escrow.ct, tag: escrow.tag, recipientPub: OWNER_PUB },
});
ok(dealt.ok && dealt.dealt === info.n, `deal-sealed accepted by all ${info.n} keepers (server never saw K)`);

// 4) anchor on-chain (relay signs, since the room is ADMIN-owned).
const anchored = await post("/dataroom/committee/anchor", { roomId, docId, contentHash: dealt.contentHash, kCommitment, blobPointer: dealt.blobPointer });
ok(anchored.ok && anchored.txHash, `anchored put_committee_document (tx ${String(anchored.txHash).slice(0, 8)}…)`);

// 5) reopen via the owner-escrow copy + the stored ciphertext (proves the escrow + blob round-trip live).
const esc = await fetch(`${BASE}/dataroom/committee/escrow/${roomId}/${docId}`).then(j);
ok(!!esc.escrow, "owner-escrow copy stored + retrievable");
const rec = recoverDocumentKey(
  { ephPub: esc.escrow.ephPub, ct: esc.escrow.ct, tag: esc.escrow.tag, contentHash: esc.escrow.contentHash, roomId: esc.escrow.roomId, docId: esc.escrow.docId },
  OWNER_SECRET,
);
ok(rec.faithful, "owner-escrow opens faithfully (recovers K)");
const storedBlob = new Uint8Array(await fetch(`${BASE}/dataroom/blob/${dealt.contentHash}`).then((r) => r.arrayBuffer()));
ok(eq(await aeadDecrypt(storedBlob, rec.k), plaintext), "escrow K decrypts the STORED ciphertext back to the plaintext");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}  (room ${String(roomId).slice(0, 8)}… doc ${docId.slice(0, 8)}…)`);
process.exit(failures === 0 ? 0 : 1);
