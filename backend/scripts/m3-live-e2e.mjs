// M3 live e2e — the sign-to-derive READER open path against the deployed stack (apizk + the 3 keepers + the
// chain + the self-hosted prover). Proves the whole Model B reader story end to end:
//   derive a per-room identity from a (fixed, demo) wallet signature ->
//   enroll the id_commitment (request + owner approve, pins the eligible root) ->
//   prove ANONYMOUS membership ONCE on the self-hosted prover -> request_access binds the accessor +
//   recipient key on-chain -> store a committee doc via the browser dealer (server never sees K) ->
//   open it with the wallet-DERIVED recipient secret (keepers release 2-of-3 sealed shares, reconstruct K,
//   AES-decrypt). It is idempotent: a re-run skips the (slow) proof if the accessor is already granted and
//   skips dealing if the doc is already anchored.
//
//   cd backend && ZK_API=https://apizk.wazowsky.id ../sdk/node_modules/.bin/tsx scripts/m3-live-e2e.mjs
import { sha256 } from "@noble/hashes/sha256";
import {
  ZkorageClient,
  deriveDataRoomIdentity,
  DEMO_MODELB_ROOM,
  DEMO_MODELB_DOC,
  aeadSeal, randomKey, shamirSplit, sealShare, sealDocumentKey, recipientPublicKeyFromSecret, toHex,
} from "zkorage-sdk";

const BASE = process.env.ZK_API || "https://apizk.wazowsky.id";
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`non-JSON from ${r.url}: ${t.slice(0, 200)}`); } };
const get = (p) => fetch(`${BASE}${p}`).then(j);
const post = (p, b) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label) => { console.log(`${c ? "✓" : "✗"} ${label}`); if (!c) failures++; };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// A FIXED demo "wallet signature" -> a deterministic, reproducible reader identity (so this provisions the
// SAME stable demo room/doc/accessor every run). A real reader derives from their own Freighter signature;
// this is NOT exposed to the frontend, so a site visitor still derives their own identity and is asked to join.
const DEMO_SIG = sha256(new TextEncoder().encode("zkorage:modelb:demo-reader:v1")); // 32 bytes (>= HKDF min)
const ROOM = DEMO_MODELB_ROOM;
const DOC = DEMO_MODELB_DOC;
const identity = deriveDataRoomIdentity(DEMO_SIG, ROOM);
ok(/^[0-9a-f]{64}$/.test(identity.accessor), `derived reader identity (accessor ${identity.accessor.slice(0, 8)}…)`);

// 0) committee + keepers (the reader open needs 2-of-3 online).
const info = await get("/dataroom/committee/info");
ok(info.online >= info.threshold, `committee ${info.online}/${info.n} online (threshold ${info.threshold})`);
const keepers = info.keypers.filter((k) => k.ok && k.sealPub && k.keyperIndex);

// 1) ensure the demo room exists (deterministic id from the label; idempotent).
const room = await post("/dataroom/create-room", { roomId: "zkorage-modelb-demo-v1" });
if (room.ok) ok(room.roomId === ROOM, `created room (${ROOM.slice(0, 8)}…)`);
else ok(/exist/i.test(room.error || ""), `room already exists (${ROOM.slice(0, 8)}…)`);

// 2) ensure the reader's id_commitment is on the room's eligible list (request -> owner approve, pins root).
await post("/dataroom/enroll/request", { roomId: ROOM, commitment: identity.idCommitment });
const st = await get(`/dataroom/enroll/status/${ROOM}/${identity.idCommitment}`);
if (st.state !== "eligible") {
  const appr = await post("/dataroom/enroll/approve", { roomId: ROOM, commitment: identity.idCommitment });
  ok(appr.ok, `owner approved the reader (eligible root pinned)`);
} else {
  ok(true, `reader already on the eligible list (index ${st.memberIndex})`);
}

// 3) grant: prove ANONYMOUS membership once (self-hosted prover), then request_access. Skip if already granted.
const granted0 = await get(`/dataroom/membership/is-granted/${ROOM}/${identity.accessor}`);
if (!granted0.isGranted) {
  console.log("  proving membership on the self-hosted prover (this can take a few minutes)…");
  const pa = await post("/dataroom/membership/prove-access", {
    roomId: ROOM,
    idSecret: identity.idSecret,
    idTrapdoor: identity.idTrapdoor,
    holderSeed: identity.accessorSeed,
    recipientPub: identity.recipientPub,
  });
  ok(!!pa.jobId, `prove-access enqueued (job ${String(pa.jobId).slice(0, 8)}…)`);
  let bundle = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 12 * 60 * 1000) {
    const s = await get(`/prove-status/${pa.jobId}`);
    if (s.status === "done" && s.bundle) { bundle = s.bundle; break; }
    if (s.status === "error") throw new Error(s.error || "proving failed");
    process.stdout.write(`\r  status: ${s.status}${s.by ? ` on ${s.by}` : ""}  (${Math.round((Date.now() - t0) / 1000)}s) `);
    await sleep(4000);
  }
  console.log("");
  ok(!!bundle, "membership proof produced (Groth16 bundle)");
  const ra = await post("/dataroom/membership/request-access", bundle);
  ok(ra.ok, `request_access granted (tx ${String(ra.txHash).slice(0, 8)}…)`);
  // nullifier soundness: re-submitting the SAME proof must be rejected (per-room one-shot).
  const ra2 = await post("/dataroom/membership/request-access", bundle);
  ok(ra2.ok === false && /#15|NullifierUsed/.test(ra2.error || ""), "re-submitting the same proof is rejected (nullifier used)");
} else {
  ok(true, "reader already granted on-chain (skipping the proof)");
}
const granted = await get(`/dataroom/membership/is-granted/${ROOM}/${identity.accessor}`);
ok(granted.isGranted, "accessor is granted (is_granted == true)");

// 4) ensure a committee doc exists at DOC (browser dealer; server never sees K). Skip if already anchored.
const plaintext = new TextEncoder().encode("zkorage Model B demo: an approved member opened this anonymously.");
const existing = await get(`/dataroom/committee/document/${ROOM}/${DOC}`).catch(() => ({ document: null }));
if (!existing.document) {
  const k = randomKey();
  const blob = await aeadSeal(plaintext, k);
  const contentHash = toHex(sha256(blob));
  const kCommitment = toHex(sha256(k));
  const shares = shamirSplit(k, info.threshold, info.n);
  const sealedShares = shares.map((sh) => {
    const keeper = keepers.find((kp) => kp.keyperIndex === sh.x);
    const s = sealShare(sh.y, sh.x, keeper.sealPub, ROOM, DOC);
    return { keyperIndex: sh.x, eph_pub: s.ephPub, ct: s.ct, tag: s.tag };
  });
  // owner-escrow copy (M2 demo owner key) — stored, not used by the reader open below.
  const ownerSecret = toHex(sha256(new TextEncoder().encode("zkorage-demo-dataroom-recipient-key")).slice(0, 32));
  const ownerPub = recipientPublicKeyFromSecret(ownerSecret);
  const escrow = sealDocumentKey(k, ownerPub, contentHash, ROOM, DOC);
  const dealt = await post("/dataroom/committee/deal-sealed", {
    roomId: ROOM, docId: DOC, blobB64: Buffer.from(blob).toString("base64"), kCommitment, sealedShares,
    escrow: { ephPub: escrow.ephPub, ct: escrow.ct, tag: escrow.tag, recipientPub: ownerPub },
  });
  ok(dealt.ok && dealt.dealt === info.n, `dealt sealed shares to all ${info.n} keepers (server never saw K)`);
  const anchored = await post("/dataroom/committee/anchor", { roomId: ROOM, docId: DOC, contentHash: dealt.contentHash, kCommitment, blobPointer: dealt.blobPointer });
  ok(anchored.ok && anchored.txHash, `anchored put_committee_document (tx ${String(anchored.txHash).slice(0, 8)}…)`);
} else {
  ok(true, `committee doc already anchored (${DOC.slice(0, 8)}…)`);
}

// 5) THE M3 PAYOFF: open the doc with the wallet-DERIVED recipient secret (key-free committee open).
const client = new ZkorageClient({ apiBaseUrl: BASE });
const opened = await client.openCommitteeDocument(ROOM, DOC, identity.accessor, identity.recipientSecret);
ok(opened.found, "committee doc found on-chain");
ok(opened.released && opened.faithfulShares >= info.threshold, `keepers released ${opened.faithfulShares} sealed parts to the derived recipient key`);
ok(opened.reconstructed && opened.contentHashVerified, "reconstructed K (2-of-3) and the file matched its fingerprint");
ok(!!opened.plaintext && eq(opened.plaintext, plaintext), "decrypted plaintext matches (anonymous member opened it)");

// 6) negative control: a DIFFERENT (non-member) identity must NOT open it.
const stranger = deriveDataRoomIdentity(sha256(new TextEncoder().encode("zkorage:modelb:stranger:v1")), ROOM);
const strangerGranted = await get(`/dataroom/membership/is-granted/${ROOM}/${stranger.accessor}`);
ok(!strangerGranted.isGranted, "a non-member accessor is not granted");
const strangerOpen = await client.openCommitteeDocument(ROOM, DOC, stranger.accessor, stranger.recipientSecret);
ok(!strangerOpen.reconstructed, "a non-member cannot open (keepers release nothing to a non-granted accessor)");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}  (room ${ROOM.slice(0, 8)}… doc ${DOC.slice(0, 8)}… accessor ${identity.accessor.slice(0, 8)}…)`);
process.exit(failures === 0 ? 0 : 1);
