// M2 Step 3 — the FULL browser-dealer pipeline, end to end, no HTTP/chain. Proves a document dealt by the
// browser (Model B) is recoverable BOTH ways: (a) the owner via the off-chain escrow copy, and (b) an
// eligible reader via the keeper committee. Mixes the SDK dealer/recipient crypto with the backend keeper
// crypto exactly as the live system wires them.
//   cd backend && ../sdk/node_modules/.bin/tsx scripts/m2-browser-dealer-selftest.ts
import { sha256 } from "@noble/hashes/sha256";
import {
  aeadSeal,
  aeadDecrypt,
  randomKey,
  shamirSplit,
  sealShare,
  sealDocumentKey,
  recoverDocumentKey,
  openShare,
  reconstructWithCommitment,
  recipientPublicKeyFromSecret,
  toHex,
  fromHex,
} from "zkorage-sdk";
// Backend keeper crypto: deal-open (keeper decrypts a sealed deal) + collect-seal (keeper re-seals to reader).
import { shareEciesOpen, shareEciesSeal } from "../src/committee.js";
import { aeadOpen } from "../src/disclosure.js";

let failures = 0;
const ok = (c: boolean, label: string) => { console.log(`${c ? "✓" : "✗"} ${label}`); if (!c) failures++; };
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const sec = (s: string) => sha256(new TextEncoder().encode(s)).slice(0, 32);

const room = toHex(sec("m2e2e-room"));
const doc = toHex(sec("m2e2e-doc"));
const plaintext = new TextEncoder().encode("Model B browser dealer: the server never saw this 🔐");

// ── 1) BROWSER DEALER (all in the owner's browser) ──
const K = randomKey();
const blob = await aeadSeal(plaintext, K);
const contentHash = toHex(sha256(blob));
const kCommitment = toHex(sha256(K));
const shares = shamirSplit(K, 2, 3);

// keepers' static seal keys (the dealer reads seal_pub from /health; here we derive them locally)
const keeperSecrets = [1, 2, 3].map((i) => sec(`m2e2e-keeper-${i}`));
const keeperPubs = keeperSecrets.map((s) => recipientPublicKeyFromSecret(toHex(s)));
const sealedDeals = shares.map((sh, i) => sealShare(sh.y, sh.x, keeperPubs[i], room, doc));

// owner-escrow copy (sealed to the owner's own sign-to-derive key)
const ownerSecret = sec("m2e2e-owner");
const ownerPub = recipientPublicKeyFromSecret(toHex(ownerSecret));
const escrow = sealDocumentKey(K, ownerPub, contentHash, room, doc);
// (the relay would now store blob + forward sealedDeals to keepers + stash escrow; K never left the browser)

// ── 2) KEEPERS open each sealed deal with their static key, recovering the raw share ──
const rawShares = sealedDeals.map((sd, i) =>
  shareEciesOpen(
    { keyperIndex: sd.keyperIndex, ephPub: fromHex(sd.ephPub), ct: fromHex(sd.ct), tag: fromHex(sd.tag) },
    keeperSecrets[i],
    fromHex(room),
    fromHex(doc),
    fromHex(keeperPubs[i]),
  ),
);
ok(rawShares.every((r, i) => r.faithful && eq(r.shareY, shares[i].y)), "every keeper opens its sealed deal to the correct raw share");

// ── 3a) OWNER reopens via the escrow copy (no committee) ──
const recOwner = recoverDocumentKey(escrow, toHex(ownerSecret));
ok(recOwner.faithful && eq(await aeadDecrypt(blob, recOwner.k), plaintext), "owner reopens the document via the escrow copy");

// ── 3b) An eligible READER reconstructs K via the committee (2 of 3) ──
const readerSecret = sec("m2e2e-reader");
const readerPub = recipientPublicKeyFromSecret(toHex(readerSecret));
// keepers re-seal their raw shares to the reader's recipient key (the /share collect step)
const collect = rawShares.map((r) =>
  shareEciesSeal(r.shareY, r.keyperIndex, fromHex(readerPub), sec(`eph-${r.keyperIndex}`), fromHex(room), fromHex(doc)),
);
const opened = collect.map((c) =>
  openShare({ keyperIndex: c.keyperIndex, ephPub: toHex(c.ephPub), ct: toHex(c.ct), tag: toHex(c.tag) }, toHex(readerSecret), room, doc, readerPub),
);
ok(opened.every((o) => o.faithful), "reader opens every released share faithfully");
const recReader = reconstructWithCommitment(opened, kCommitment);
ok(eq(await aeadDecrypt(blob, recReader.k), plaintext), "reader reconstructs K (2-of-3) and decrypts the document");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
