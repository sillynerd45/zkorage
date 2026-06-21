// M7 showcase provisioning — a STABLE green showcase room on testnet that demonstrates the timing defense
// LIVE (no wallet needed to view it). Provisions:
//   - a fixed room (deterministic id from the label) with N_MEMBERS genuine derived identities enrolled in ONE
//     randomized approve-batch (#2), so the anonymity meter reads GREEN (>= 20),
//   - N_BATCH real batched accesses: prove membership on the self-hosted prover, queue them, and flush once so
//     they land on-chain CLUSTERED in time + SHUFFLED in order (the money shot a visitor reads in the panel).
//
// Honest framing: these are N distinct cryptographic identities I control, not N independent people. The meter
// reports the eligible-SET size (genuinely N), and the ZK unlinkability (an access cannot be tied to a leaf)
// holds regardless of who controls them. It is a SHOWCASE of the mechanism, labeled as such in the UI.
//
// Run against a LOCAL M7 backend (manual flush) pointed at the prover tunnel + testnet, exactly like the e2e:
//   cd backend && rm -f /tmp/zkshow-*.json && \
//     PORT=8788 PROVER_URL=https://prover.wazowsky.id DR_BATCH_ALLOW_MANUAL_FLUSH=1 DR_BATCH_WINDOW_MS=3600000 \
//     DR2_ELIGIBLE_FILE=/tmp/zkshow-elig.json DR2_ENROLL_FILE=/tmp/zkshow-enroll.json DR_BATCH_FILE=/tmp/zkshow-batch.json \
//     npx tsx src/server.ts &   # then:
//   ZK_API=http://localhost:8788 ../sdk/node_modules/.bin/tsx scripts/m7-showcase-provision.mjs
// Idempotent: re-runs skip already-eligible members + already-granted accesses.
import { sha256 } from "@noble/hashes/sha256";
import { deriveDataRoomIdentity, toHex } from "zkorage-sdk";

const BASE = process.env.ZK_API || "http://localhost:8788";
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`non-JSON from ${r.url}: ${t.slice(0, 200)}`); } };
const get = (p) => fetch(`${BASE}${p}`).then(j);
const post = (p, b) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label) => { console.log(`${c ? "✓" : "✗"} ${label}`); if (!c) failures++; };

// STABLE: a fixed label -> a deterministic room id the frontend constant points at. Re-runnable.
const LABEL = "zkorage-m7-showcase-v2";
const ROOM = toHex(sha256(new TextEncoder().encode(LABEL)));
const N_MEMBERS = 24; // green meter (>= 20)
const N_BATCH = 4;    // batched accesses to land on-chain for the panel
const FLOOR = 5;

const members = Array.from({ length: N_MEMBERS }, (_, i) =>
  deriveDataRoomIdentity(sha256(new TextEncoder().encode(`zkorage:m7:showcase:member-${i}:v1`)), ROOM));
ok(new Set(members.map((m) => m.accessor)).size === N_MEMBERS, `${N_MEMBERS} distinct member identities derived`);
console.log(`  room ${ROOM} (label ${LABEL})`);

// 1) room (idempotent).
const room = await post("/dataroom/create-room", { roomId: LABEL });
ok(room.ok ? room.roomId === ROOM : /exist/i.test(room.error || ""), `room present (${ROOM.slice(0, 8)}…)`);

// 2) enroll every member, then admit the not-yet-eligible ones in ONE randomized batch (green meter, #2).
for (const m of members) await post("/dataroom/enroll/request", { roomId: ROOM, commitment: m.idCommitment });
const elig0 = await get(`/dataroom/membership/eligible/${ROOM}`).catch(() => ({ memberCount: 0 }));
if ((elig0.memberCount ?? 0) < N_MEMBERS) {
  const appr = await post("/dataroom/enroll/approve-batch", { roomId: ROOM }); // approve ALL pending, shuffled
  ok(appr.ok, `approve-batch admitted the pending members (tx ${String(appr.txHash).slice(0, 8)}…)`);
}
const elig = await get(`/dataroom/membership/eligible/${ROOM}`);
ok(elig.memberCount >= N_MEMBERS, `eligible set is ${elig.memberCount} (>= ${N_MEMBERS} -> GREEN meter)`);

// 3) the batch: prove N_BATCH members on the real prover (serial -> they queue apart), queue them, flush once.
// SKIP_PROOFS=1 only (re)builds the eligible set in the serving backend's store (the meter source) and re-pins
// the root, reusing the batched grants already on-chain (e.g. when pointing a deployed backend at a room whose
// grants were provisioned earlier). flush-now is gated in prod, so fall back to the natural window flusher.
const SKIP_PROOFS = process.env.SKIP_PROOFS === "1";
const burst = SKIP_PROOFS ? [] : members.slice(0, N_BATCH);
const queued = [];
for (let i = 0; i < burst.length; i++) {
  const m = burst[i];
  const g = await get(`/dataroom/membership/is-granted/${ROOM}/${m.accessor}`);
  if (g.isGranted) { ok(true, `member ${i} already granted (skip proof)`); continue; }
  console.log(`  proving member ${i} on the self-hosted prover (a few minutes)…`);
  const pa = await post("/dataroom/membership/prove-access", {
    roomId: ROOM, idSecret: m.idSecret, idTrapdoor: m.idTrapdoor, holderSeed: m.accessorSeed,
    recipientPub: m.recipientPub, minAnonSet: FLOOR,
  });
  if (!pa.jobId) { ok(false, `prove-access member ${i}: ${pa.error || "no jobId"}`); break; }
  let bundle = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 12 * 60 * 1000) {
    const s = await get(`/prove-status/${pa.jobId}`);
    if (s.status === "done" && s.bundle) { bundle = s.bundle; break; }
    if (s.status === "error") throw new Error(s.error || "proving failed");
    process.stdout.write(`\r  member ${i}: ${s.status}${s.by ? ` on ${s.by}` : ""} (${Math.round((Date.now() - t0) / 1000)}s) `);
    await sleep(4000);
  }
  console.log("");
  ok(!!bundle, `member ${i} proof produced`);
  const q = await post("/dataroom/membership/queue-access", {
    seal: bundle.seal, image_id: bundle.image_id, journal: bundle.journal,
    roomId: ROOM, accessor: m.accessor, nullifier: pa.nullifier,
  });
  ok(q.ok && q.ticket, `member ${i} queued (ticket ${String(q.ticket).slice(0, 8)}…)`);
  queued.push(m);
}
if (queued.length > 0) {
  const flush = await post("/dataroom/membership/flush-now", {});
  if (flush.ok) {
    ok(flush.summary?.submitted === queued.length, `flushed ${flush.summary?.submitted}/${queued.length} grants, shuffled`);
  } else {
    // flush-now disabled in prod -> wait for the fixed-window flusher to land them.
    console.log("  flush-now disabled; waiting for the natural window flush (up to ~11 min)…");
    const want = queued.map((m) => m.accessor);
    const deadline = Date.now() + 11 * 60 * 1000;
    let landed = 0;
    while (Date.now() < deadline && landed < want.length) {
      await sleep(10_000);
      const checks = await Promise.all(want.map((a) => get(`/dataroom/membership/is-granted/${ROOM}/${a}`).then((r) => r.isGranted).catch(() => false)));
      landed = checks.filter(Boolean).length;
      process.stdout.write(`\r  landed ${landed}/${want.length} `);
    }
    console.log("");
    ok(landed === want.length, `all ${want.length} queued accesses landed via the window flush`);
  }
}

// 4) verify the on-chain grant log (what the panel reads): the batched grants are clustered + ordered by the
// shuffle, in consecutive recent slots.
const log = await get(`/dataroom/membership/grants/${ROOM}?limit=24`);
ok(log.count >= N_BATCH, `grant log has ${log.count} grants`);
const recent = log.grants.slice(-N_BATCH);
const tsSpread = recent.length ? Math.max(...recent.map((g) => g.timestamp)) - Math.min(...recent.map((g) => g.timestamp)) : 0;
ok(tsSpread <= 60, `the ${recent.length} recent grants are clustered on-chain (timestamp spread ${tsSpread}s)`);
console.log(`  recent grant order by index: ${JSON.stringify(recent.map((g) => g.index))}, accessors ${JSON.stringify(recent.map((g) => g.accessor.slice(0, 6)))}`);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
console.log(`\nSHOWCASE ROOM (for the SDK constant): ${ROOM}`);
process.exit(failures === 0 ? 0 : 1);
