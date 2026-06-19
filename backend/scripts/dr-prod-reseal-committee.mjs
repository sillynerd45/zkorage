// Re-seed the demo committee documents' Shamir shares to a FRESH keeper committee (e.g. the production
// keepers on the VM, which start with empty share stores). For each demo doc it re-splits a fresh K' and
// re-deals one share per keeper, then re-anchors on-chain (rotate_committee_document bumps key_epoch). The
// room/doc/recipient IDs and the demo recipient secret are unchanged, so the frontend demo constants and
// the key-free opener still work; only the on-chain k_commitment + the keepers' stored shares change.
//
// Run this AFTER the 3 keepers are up and healthy (rotate-doc aborts unless all keepers accept the deal):
//   docker exec zkorage-backend node scripts/dr-prod-reseal-committee.mjs
// Idempotent: re-running just rotates to another fresh K'. If a doc is not yet anchored it seal-docs it.
//
// The content strings below are byte-identical to the DR3 / DR6 demo seeds (dr3-anchor-demo.mjs /
// dr6-anchor-demo.mjs) so the decrypted document reads exactly as before. Do not edit them.
import { sha256 } from "@noble/hashes/sha256";

const BASE = process.env.BASE || "http://localhost:8787";
const enc = (s) => new TextEncoder().encode(s);
const toHex = (u) => Buffer.from(u).toString("hex");
// The fixed demo accessor (member id 0x11/0x22, holder 0x03) admitted in both demo rooms.
const ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";

const DOCS = [
  {
    name: "DR3 committee-released",
    roomLabel: "zkorage-dr3-committee-demo",
    docLabel: "dr3-committee-welcome-doc",
    content:
      "zkorage Confidential Data Room — DR3 committee-released document. If you can read this, the 2-of-3 keyper " +
      "committee released its shares to your proof-bound key, you reconstructed K from a 2-of-3 quorum, and the " +
      "ciphertext matched its on-chain sha256(K) commitment. No single keyper ever held the key. 🔐🗝️",
  },
  {
    name: "DR6 / Pattern-2 composite-policy",
    roomLabel: "zkorage-dr6-policy-demo",
    docLabel: "dr6-policy-welcome-doc",
    content:
      "zkorage Confidential Data Room — DR6 finale. You entered this room by proving a COMPOSITE policy " +
      "anonymously: you are an eligible member AND KYC-passed AND accredited AND not sanctioned — without " +
      "revealing which member you are or any attribute. A revoked member loses access surgically and the " +
      "committee key rotates so their cached shares are useless. 🔐🧩",
  },
];

const jpost = async (p, b) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) });
  return [r.status, await r.json().catch(() => ({}))];
};
const jget = async (p) => {
  const r = await fetch(BASE + p);
  return [r.status, await r.json().catch(() => ({}))];
};

// 0) The committee must have all keepers reachable, or rotate/seal aborts on the partial deal.
const [, info] = await jget("/dataroom/committee/info");
console.log(`[reseal] committee: ${info.online}/${info.n} keepers online, threshold ${info.threshold}`);
if (!info.n || info.online < info.n) {
  console.error(`[reseal] ABORT: need all ${info.n ?? "?"} keepers online (a partial deal would strand shares). Bring every keeper up first.`);
  process.exit(1);
}

let allOk = true;
for (const d of DOCS) {
  const roomId = toHex(sha256(enc(d.roomLabel)));
  const docId = toHex(sha256(enc(d.docLabel)));
  console.log(`\n[reseal] ${d.name}: room=${roomId.slice(0, 12)}… doc=${docId.slice(0, 12)}…`);

  // 1) re-deal a fresh K' to the keepers. rotate-doc if anchored, else seal-doc (both deal one share/keeper).
  const [, cd] = await jget(`/dataroom/committee/document/${roomId}/${docId}`);
  const path = cd.document ? "/dataroom/committee/rotate-doc" : "/dataroom/committee/seal-doc";
  const [ds, deal] = await jpost(path, { roomId, docId, content: d.content });
  if (ds !== 200 || !deal.ok) {
    console.error(`[reseal]   ${path} FAILED: ${JSON.stringify(deal)}`);
    allOk = false;
    continue;
  }
  console.log(`[reseal]   ${cd.document ? "rotated" : "sealed"}: tx=${deal.txHash} reDealt=${deal.reDealt ?? deal.dealt} keyEpoch=${deal.keyEpoch ?? "-"} k=${deal.kCommitment?.slice(0, 12)}…`);

  // 2) verify the full round-trip via the backend opener (demo recipient secret) → faithful + content match.
  const [, open] = await jpost(`/dataroom/committee/open/${roomId}/${docId}`, { accessor: ACCESSOR });
  const match = open.ok && open.faithful && open.content === d.content;
  console.log(`[reseal]   round-trip open: released=${open.released ?? "?"} faithful=${open.faithful} pair=${JSON.stringify(open.reconstructedFromPair)} contentMatch=${open.content === d.content}`);
  if (!match) {
    console.error(`[reseal]   VERIFY FAILED: ${JSON.stringify({ ok: open.ok, faithful: open.faithful, reason: open.reason, error: open.error })}`);
    allOk = false;
  }
}

console.log(allOk ? "\n[reseal] all demo committee docs re-sealed + verified ✓" : "\n[reseal] one or more docs FAILED ✗");
process.exit(allOk ? 0 : 1);
