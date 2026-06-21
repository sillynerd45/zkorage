// M7 live e2e — the access-batching TIMING DEFENSE against a real prover + the live chain.
//
// The money shot: several approved members prove membership at DIFFERENT times (proving is serial, so they
// naturally queue minutes apart), but their on-chain request_access grants all land CLUSTERED at one flush
// instant, in SHUFFLED order. So a room owner reading the chain sees "some approved members accessed in this
// window", not WHEN each member acted or in what order. That is the owner-roster timing channel, closed.
//
// It also exercises timing defense #2: the 5 members are admitted in ONE approve-batch with randomized leaf
// order (approval order != leaf position).
//
// Runs against a LOCAL backend that has the M7 code, pointed at the self-hosted prover tunnel + testnet. The
// keeper OPEN path is intentionally out of scope here (covered by m3-live-e2e); M7 is about how/when the grant
// lands on-chain. A FRESH room per run (timestamped label), so nullifiers never collide.
//
//   cd backend && \
//     ZK_API=http://localhost:8788 ../sdk/node_modules/.bin/tsx scripts/m7-live-e2e.mjs
import { sha256 } from "@noble/hashes/sha256";
import { deriveDataRoomIdentity, toHex } from "zkorage-sdk";

const BASE = process.env.ZK_API || "http://localhost:8788";
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`non-JSON from ${r.url}: ${t.slice(0, 200)}`); } };
const get = (p) => fetch(`${BASE}${p}`).then(j);
const post = (p, b) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label) => { console.log(`${c ? "✓" : "✗"} ${label}`); if (!c) failures++; };

// A fresh room per run (so the 5 members + their nullifiers are always unused).
const STAMP = Date.now().toString(36);
const LABEL = `zkorage-m7-batch-${STAMP}`;
const ROOM = toHex(sha256(new TextEncoder().encode(LABEL)));
const FLOOR = 5;
const N_MEMBERS = 5;     // enrolled (the anonymity floor)
const N_BURST = 3;       // how many actually access in the window (the batch)

// Derive N distinct member identities (each from its own fixed "wallet signature").
const members = Array.from({ length: N_MEMBERS }, (_, i) =>
  deriveDataRoomIdentity(sha256(new TextEncoder().encode(`zkorage:m7:member-${i}:${STAMP}`)), ROOM));
ok(new Set(members.map((m) => m.accessor)).size === N_MEMBERS, `${N_MEMBERS} distinct member identities derived`);

// 1) fresh room.
const room = await post("/dataroom/create-room", { roomId: LABEL });
ok(room.ok && room.roomId === ROOM, `created fresh room (${ROOM.slice(0, 8)}…)`);

// 2) all members request to join, then the owner admits them in ONE randomized batch (#2).
for (const m of members) await post("/dataroom/enroll/request", { roomId: ROOM, commitment: m.idCommitment });
const approvalOrder = members.map((m) => m.idCommitment);
const appr = await post("/dataroom/enroll/approve-batch", { roomId: ROOM, commitments: approvalOrder });
ok(appr.ok && Number(appr.approved) === N_MEMBERS, `approve-batch admitted all ${N_MEMBERS} in one set_eligible_root (tx ${String(appr.txHash).slice(0, 8)}…)`);
const leafOrder = appr.approvedCommitments || [];
const samePermutation = leafOrder.length === approvalOrder.length && new Set(leafOrder).size === approvalOrder.length && leafOrder.every((c) => approvalOrder.includes(c));
ok(samePermutation, "the batch is a permutation of the approved set (no loss/dup)");
console.log(`  #2 leaf order ${JSON.stringify(leafOrder.map((c) => c.slice(0, 4)))} vs approval order ${JSON.stringify(approvalOrder.map((c) => c.slice(0, 4)))}${JSON.stringify(leafOrder) !== JSON.stringify(approvalOrder) ? " (shuffled)" : " (identity this draw)"}`);

// 3) THE BURST: N_BURST members each prove membership on the real prover (serial -> they queue minutes apart),
// and hand the proven bundle to the batching relay. Record each member's QUEUE time to contrast with the
// on-chain landing time later.
const burst = members.slice(0, N_BURST);
const queued = [];
for (let i = 0; i < burst.length; i++) {
  const m = burst[i];
  console.log(`  proving membership for member ${i} on the self-hosted prover (this can take a few minutes)…`);
  const pa = await post("/dataroom/membership/prove-access", {
    roomId: ROOM, idSecret: m.idSecret, idTrapdoor: m.idTrapdoor, holderSeed: m.accessorSeed,
    recipientPub: m.recipientPub, minAnonSet: FLOOR,
  });
  if (!pa.jobId) { ok(false, `prove-access for member ${i}: ${pa.error || "no jobId"}`); break; }
  let bundle = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 12 * 60 * 1000) {
    const s = await get(`/prove-status/${pa.jobId}`);
    if (s.status === "done" && s.bundle) { bundle = s.bundle; break; }
    if (s.status === "error") throw new Error(s.error || "proving failed");
    process.stdout.write(`\r  member ${i} status: ${s.status}${s.by ? ` on ${s.by}` : ""} (${Math.round((Date.now() - t0) / 1000)}s) `);
    await sleep(4000);
  }
  console.log("");
  ok(!!bundle, `member ${i} membership proof produced`);
  const q = await post("/dataroom/membership/queue-access", {
    seal: bundle.seal, image_id: bundle.image_id, journal: bundle.journal,
    roomId: ROOM, accessor: m.accessor, nullifier: pa.nullifier,
  });
  ok(q.ok && q.ticket, `member ${i} queued for the window (ticket ${String(q.ticket).slice(0, 8)}…, lands ${new Date(q.flushAt).toISOString()})`);
  queued.push({ i, accessor: m.accessor, ticket: q.ticket, queuedAt: Date.now(), flushAt: q.flushAt });
}
ok(queued.length === N_BURST, `all ${N_BURST} accesses queued (none submitted on-chain yet)`);

// Before the flush, NONE of them is granted (their access is still off-chain in the relay queue).
let grantedBefore = 0;
for (const e of queued) { if ((await get(`/dataroom/membership/is-granted/${ROOM}/${e.accessor}`)).isGranted) grantedBefore++; }
ok(grantedBefore === 0, "no queued access is on-chain before the flush (the relay holds them)");

// 4) FLUSH: the relay submits the whole batch, shuffled, at the boundary.
const flushAtWall = Date.now();
const flush = await post("/dataroom/membership/flush-now", {});
ok(flush.ok && flush.summary && flush.summary.submitted === N_BURST, `flush submitted all ${N_BURST} grants, shuffled (order by ticket: ${JSON.stringify((flush.summary?.order || []).map((t) => t.slice(0, 6)))})`);

// 5) verify the landing: every burst member is now granted; the grants are CLUSTERED in time (the flush
// instant), in CONSECUTIVE grant-log slots (one batch, nothing interleaved), and ordered by the SHUFFLE.
const grants = [];
for (const e of queued) {
  const g = await get(`/dataroom/membership/grant/${ROOM}/${e.accessor}`);
  ok(g.grant, `member ${e.i} is granted on-chain (grant index ${g.grant?.index})`);
  if (g.grant) grants.push({ ...e, index: Number(g.grant.index), timestamp: Number(g.grant.timestamp) });
}

// consecutive grant-log indices => they landed as one uninterrupted batch.
const indices = grants.map((g) => g.index).sort((a, b) => a - b);
const consecutive = indices.length === N_BURST && indices.every((v, k) => k === 0 || v === indices[k - 1] + 1);
ok(consecutive, `the ${N_BURST} grants occupy consecutive grant-log slots [${indices.join(", ")}] (landed as one batch)`);

// on-chain timestamp spread (the flush instant) vs the queue-time spread (when members actually acted).
const tsSpread = Math.max(...grants.map((g) => g.timestamp)) - Math.min(...grants.map((g) => g.timestamp));
const queueSpread = Math.round((Math.max(...queued.map((e) => e.queuedAt)) - Math.min(...queued.map((e) => e.queuedAt))) / 1000);
ok(tsSpread <= 60, `the grants are CLUSTERED on-chain (timestamp spread ${tsSpread}s <= 60s = the flush instant)`);
console.log(`  TIMING DECORRELATION: members acted ${queueSpread}s apart (queue times), but their grants land within ${tsSpread}s on-chain. The owner reads the flush window, not when each member acted.`);

// the on-chain order (by grant index) vs the queue/arrival order: the shuffle decided it, not arrival.
const onChainOrder = [...grants].sort((a, b) => a.index - b.index).map((g) => g.i);
const arrivalOrder = queued.map((e) => e.i);
console.log(`  ON-CHAIN ORDER by member: ${JSON.stringify(onChainOrder)} vs arrival order ${JSON.stringify(arrivalOrder)}${JSON.stringify(onChainOrder) !== JSON.stringify(arrivalOrder) ? " (shuffled)" : " (identity this draw)"}`);
ok(onChainOrder.length === N_BURST && new Set(onChainOrder).size === N_BURST, "the on-chain order is a permutation of the burst (shuffle landed on-chain)");

// 6) soundness control: re-flushing submits nothing (the queue is drained; no double-spend of a nullifier).
const reflush = await post("/dataroom/membership/flush-now", {});
ok(reflush.ok && (reflush.summary?.flushed ?? 0) === 0, "a second flush is a no-op (queue drained, no nullifier re-spend)");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}  (room ${ROOM.slice(0, 8)}… | ${N_MEMBERS} members, ${N_BURST} batched accesses)`);
process.exit(failures === 0 ? 0 : 1);
