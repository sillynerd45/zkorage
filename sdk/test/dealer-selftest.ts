// M2 Step 1 — SDK dealer crypto, cross-checked BYTE-FOR-BYTE against the backend (the canonical impl).
//   cd sdk && npx tsx test/dealer-selftest.ts
// The browser dealer (Model B) must produce blobs/seals/shares the existing backend + keeper + recipient can
// open. We assert: SDK split matches the backend frozen vector; SDK aeadSeal -> backend aeadOpen; SDK
// sealDocumentKey -> backend dataroomEciesOpen; SDK sealShare -> backend shareEciesOpen; and SDK split ->
// SDK reconstruct round-trips.
import {
  aeadSeal,
  aeadDecrypt,
  sealDocumentKey,
  recoverDocumentKey,
  recipientPublicKeyFromSecret,
  shamirSplit,
  shamirReconstruct,
  sealShare,
  openShare,
  randomKey,
  toHex,
  fromHex,
} from "../src/index.js";
import { sha256 } from "@noble/hashes/sha256";
// Backend canonical implementations (node:crypto based).
import { aeadOpen, dataroomEciesOpen } from "../../backend/src/disclosure.js";
import { shareEciesOpen } from "../../backend/src/committee.js";

let failures = 0;
const ok = (c: boolean, label: string) => {
  console.log(`${c ? "✓" : "✗"} ${label}`);
  if (!c) failures++;
};
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const secretOf = (s: string) => sha256(new TextEncoder().encode(s)).slice(0, 32);

// ---- 1) shamirSplit byte-exact vs the backend frozen vector ----
const K_FROZEN = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const COEFF = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 31 + 17) & 0xff));
const fshares = shamirSplit(K_FROZEN, 2, 3, { coeffs: [COEFF] });
ok(toHex(fshares[0].y) === "123a5e76928ae6de326a0e36d2faa68e725abed6f20a267e52aa8e96b25a660e", "shamirSplit share x=1 matches backend frozen vector");
ok(toHex(fshares[1].y) === "216a8fc41e65a0fb2912c79c460df8b3713aff3475b5f00b4282d76c2dfda863", "shamirSplit share x=2 matches backend frozen vector");
ok(toHex(fshares[2].y) === "305ac0aa93c96b11203a80fac3a93b51701ac06a08294bd1bb9ae03a58691bb1", "shamirSplit share x=3 matches backend frozen vector");

// ---- 2) split -> reconstruct round-trip (random) ----
const K = randomKey();
const shares = shamirSplit(K, 2, 3);
ok(eq(shamirReconstruct([shares[0], shares[1]]), K), "split -> reconstruct (pair 1,2) recovers K");
ok(eq(shamirReconstruct([shares[1], shares[2]]), K), "split -> reconstruct (pair 2,3) recovers K");

// ---- 3) aeadSeal (SDK) -> aeadOpen (backend) and aeadDecrypt (SDK) ----
const plaintext = new TextEncoder().encode("zkorage Model B — the browser dealer sealed this 🔐");
const blob = await aeadSeal(plaintext, K);
ok(eq(aeadOpen(blob, K), plaintext), "SDK aeadSeal -> backend aeadOpen recovers the plaintext");
ok(eq(await aeadDecrypt(blob, K), plaintext), "SDK aeadSeal -> SDK aeadDecrypt round-trips");
const contentHash = toHex(sha256(blob));

// ---- 4) sealDocumentKey (SDK, owner-escrow / 1:1) -> recoverDocumentKey (SDK) + dataroomEciesOpen (backend) ----
const roomId = toHex(secretOf("m2-room"));
const docId = toHex(secretOf("m2-doc"));
const ownerSecret = secretOf("m2-owner-escrow");
const ownerPub = recipientPublicKeyFromSecret(toHex(ownerSecret));
const disc = sealDocumentKey(K, ownerPub, contentHash, roomId, docId);
const rec = recoverDocumentKey(disc, toHex(ownerSecret));
ok(rec.faithful && eq(rec.k, K), "SDK sealDocumentKey -> SDK recoverDocumentKey (faithful, K recovered)");
const beOpen = dataroomEciesOpen(fromHex(disc.ephPub), fromHex(disc.ct), fromHex(disc.tag), fromHex(contentHash), fromHex(roomId), fromHex(docId), ownerSecret);
ok(beOpen.faithful && eq(beOpen.k, K), "SDK sealDocumentKey -> backend dataroomEciesOpen (faithful, K recovered)");
// the escrow copy actually opens the blob
ok(eq(await aeadDecrypt(blob, rec.k), plaintext), "owner-escrow recovered K decrypts the blob");

// ---- 5) sealShare (SDK, deal to a keeper static key) -> openShare (SDK) + shareEciesOpen (backend) ----
const keeperSecret = secretOf("m2-keeper-2-static");
const keeperPub = recipientPublicKeyFromSecret(toHex(keeperSecret));
const sealed = sealShare(shares[1].y, shares[1].x, keeperPub, roomId, docId);
const opened = openShare(sealed, toHex(keeperSecret), roomId, docId, keeperPub);
ok(opened.faithful && eq(opened.shareY, shares[1].y), "SDK sealShare -> SDK openShare (faithful, share recovered)");
const beShare = shareEciesOpen(
  { keyperIndex: sealed.keyperIndex, ephPub: fromHex(sealed.ephPub), ct: fromHex(sealed.ct), tag: fromHex(sealed.tag) },
  keeperSecret,
  fromHex(roomId),
  fromHex(docId),
  fromHex(keeperPub),
);
ok(beShare.faithful && eq(beShare.shareY, shares[1].y), "SDK sealShare -> backend shareEciesOpen (faithful, share recovered)");
// wrong keeper key -> unfaithful
const wrong = openShare(sealed, toHex(secretOf("not-the-keeper")), roomId, docId, keeperPub);
ok(!wrong.faithful, "a wrong keeper key opens unfaithful (tag mismatch)");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
