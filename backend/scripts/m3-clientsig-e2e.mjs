// Client-side-signing e2e — proves the NEW-5 consent can be signed IN THE BROWSER so accessor_seed never
// reaches the backend/prover. Uses a FRESH room + identity each run (no shared demo state), against a backend
// that has the client-sign route (default the LOCAL dev backend, which forwards to the self-hosted prover).
//
//   cd backend && ZK_API=http://localhost:8787 ../sdk/node_modules/.bin/tsx scripts/m3-clientsig-e2e.mjs
import { deriveDataRoomIdentity, signDataRoomAccess } from "zkorage-sdk";
import { sha256 } from "@noble/hashes/sha256";

const BASE = process.env.ZK_API || "http://localhost:8787";
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`non-JSON from ${r.url}: ${t.slice(0, 200)}`); } };
const get = (p) => fetch(`${BASE}${p}`).then(j);
const post = (p, b) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label) => { console.log(`${c ? "✓" : "✗"} ${label}`); if (!c) failures++; };

// A fresh identity for a fresh room (unique per run), so this never touches the stable demo state.
const tag = `clientsig-${Date.now()}`;
const label = `zkorage-${tag}`;
const room = await post("/dataroom/create-room", { roomId: label });
ok(room.ok && /^[0-9a-f]{64}$/.test(room.roomId || ""), `created fresh room (${String(room.roomId).slice(0, 8)}…)`);
const ROOM = room.roomId;
// Derive the reader identity from a (demo) wallet signature; a real reader derives from their Freighter sig.
const identity = deriveDataRoomIdentity(sha256(new TextEncoder().encode(`zkorage:${tag}:sig`)), ROOM);
ok(/^[0-9a-f]{64}$/.test(identity.accessor), `derived identity (accessor ${identity.accessor.slice(0, 8)}…)`);

// Enroll the commitment (request + owner approve pins the root).
await post("/dataroom/enroll/request", { roomId: ROOM, commitment: identity.idCommitment });
const appr = await post("/dataroom/enroll/approve", { roomId: ROOM, commitment: identity.idCommitment });
ok(appr.ok, "owner approved the reader (eligible root pinned)");

// THE POINT: sign the NEW-5 consent IN THIS PROCESS (the "browser"); send accessor + sig, NOT accessor_seed.
const holderSig = signDataRoomAccess(identity);

// Negative control: a tampered signature must be rejected by the backend's verification, before any proving.
const badSig = holderSig.slice(0, -2) + (holderSig.endsWith("00") ? "11" : "00");
const bad = await post("/dataroom/membership/prove-access", {
  roomId: ROOM, idSecret: identity.idSecret, idTrapdoor: identity.idTrapdoor,
  accessor: identity.accessor, holderSig: badSig, recipientPub: identity.recipientPub,
});
ok(!bad.jobId && /verify|signature/i.test(bad.error || ""), `tampered signature rejected (${(bad.error || "").slice(0, 48)}…)`);

// The real client-signed proof: NO accessor_seed/holderSeed in the request.
console.log("  proving membership on the self-hosted prover (client-signed consent)…");
const pa = await post("/dataroom/membership/prove-access", {
  roomId: ROOM, idSecret: identity.idSecret, idTrapdoor: identity.idTrapdoor,
  accessor: identity.accessor, holderSig, recipientPub: identity.recipientPub,
});
ok(!!pa.jobId, `prove-access accepted the client signature (job ${String(pa.jobId).slice(0, 8)}…)`);
ok(pa.accessor === identity.accessor, "prover job bound the client's accessor");
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
ok(!!bundle, "membership proof produced from the client-signed consent");
const ra = await post("/dataroom/membership/request-access", bundle);
ok(ra.ok, `request_access granted (tx ${String(ra.txHash).slice(0, 8)}…)`);
const granted = await get(`/dataroom/membership/is-granted/${ROOM}/${identity.accessor}`);
ok(granted.isGranted, "accessor is granted on-chain (client-signed, accessor_seed never left the device)");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}  (room ${ROOM.slice(0, 8)}… accessor ${identity.accessor.slice(0, 8)}…)`);
process.exit(failures === 0 ? 0 : 1);
