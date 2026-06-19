// DR3 Ch1 — committee service self-test (drives 3 LIVE keypers against the real DataRoom contract).
//
// What it proves (fast, no new proof needed): the keyper service correctly (a) gates share release on the
// on-chain per-document admission (`is_doc_admitted`, which falls back to the DR2 `is_granted` for a
// policy-less committee doc, as here), (b) seals THIS keyper's exact share to the grant's recorded
// recipient_pub (verified via the share tag — needs no secret), (c) rejects non-admitted accessors (403),
// unknown documents (404), and unauthenticated /deal (401). Combined with the Ch0 crypto round-trip
// (open + Lagrange-reconstruct + AES-GCM, proven in backend/src/committee.ts) this is the full guarantee,
// factored: Ch1 = "the live committee seals the right share to the right recipient", Ch0 = "the right shares
// reconstruct K". The end-to-end decrypt with a recipient-secret-holder lands in the Ch3 backend e2e.
//
// Prereq: 3 keypers running (see keyper/README or the launch block in PROGRESS). Uses the existing DR2 demo
// grant: room c1c33201… / accessor ed4928c6… (is_granted=true, recipient_pub 0xad*32).
import { randomBytes } from "node:crypto";
import { shamirSplit } from "../../backend/src/shamir.ts";
import { shareTag, assertFrozenVector } from "../src/share-ecies.ts";

const KEYPERS = (process.env.KEYPERS || "http://localhost:8801,http://localhost:8802,http://localhost:8803").split(",");
const CONTRACT = process.env.DATAROOM_CONTRACT_ID || "CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN";
const DEAL_TOKEN = process.env.DEAL_TOKEN || "dr3-demo-deal-token";
const ROOM = process.env.DR3_ROOM || "c1c33201dad189af07b344cc6b20a9a3e6b75601f04344e618d5281cefa46d75";
const GRANTED = process.env.DR3_ACCESSOR || "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";
// A doc id unique to this run so re-runs don't depend on prior state.
const DOC = Buffer.from(randomBytes(32)).toString("hex");
const UNDEALT_DOC = Buffer.from(randomBytes(32)).toString("hex");
const NOT_GRANTED = Buffer.from(randomBytes(32)).toString("hex");

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
};

const jpost = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  let j: unknown = null;
  try { j = await r.json(); } catch { /* non-json */ }
  return [r.status, j] as const;
};
const jget = async (url: string) => {
  const r = await fetch(url);
  return [r.status, await r.json()] as const;
};

async function main() {
  console.log(`[dr3-ch1] keypers=${KEYPERS.join(",")} contract=${CONTRACT}`);
  console.log(`[dr3-ch1] room=${ROOM.slice(0, 12)}… granted=${GRANTED.slice(0, 12)}… doc=${DOC.slice(0, 12)}…\n`);

  // 0a) OFFLINE drift gate: this keyper's share-ECIES must match the backend's frozen vector byte-for-byte.
  try { assertFrozenVector(); check("keyper share-ECIES matches the backend frozen vector (no drift)", true); }
  catch (e) { check("keyper share-ECIES matches the backend frozen vector (no drift)", false, String((e as Error).message)); }

  // 0) health — all 3 keypers up with the right index
  for (let i = 0; i < KEYPERS.length; i++) {
    const [s, hj] = await jget(`${KEYPERS[i]}/health`);
    const h = hj as { ok?: boolean; keyper_index?: number; contract?: string; shares?: number };
    check(`keyper ${i + 1} healthy`, s === 200 && h.ok === true && h.keyper_index === i + 1, `idx=${h.keyper_index} contract=${String(h.contract).slice(0, 8)}… shares=${h.shares}`);
  }

  // 1) mini-dealer: split a fresh K into 3 shares (x=1,2,3) and remember each keyper's share_y
  const K = new Uint8Array(randomBytes(32));
  const shares = shamirSplit(K, 2, 3); // x = 1,2,3
  const dealtY: Record<number, Uint8Array> = {};
  for (const sh of shares) dealtY[sh.x] = sh.y;

  // 2) /deal auth: 401 without bearer, 200 with — then deal all 3
  const [unauthStatus] = await jpost(`${KEYPERS[0]}/deal`, { room_id: ROOM, doc_id: DOC, keyper_index: 1, share_y: hex(dealtY[1]) });
  check("/deal without bearer → 401", unauthStatus === 401);
  for (let i = 0; i < 3; i++) {
    const idx = i + 1;
    const [s, j] = await jpost(`${KEYPERS[i]}/deal`, { room_id: ROOM, doc_id: DOC, keyper_index: idx, share_y: hex(dealtY[idx]) }, { authorization: `Bearer ${DEAL_TOKEN}` });
    check(`/deal share to keyper ${idx}`, s === 200 && (j as { ok?: boolean }).ok === true);
  }
  // wrong-index share is rejected (a share for keyper 2 sent to keyper 1)
  const [wrongIdx] = await jpost(`${KEYPERS[0]}/deal`, { room_id: ROOM, doc_id: DOC, keyper_index: 2, share_y: hex(dealtY[2]) }, { authorization: `Bearer ${DEAL_TOKEN}` });
  check("/deal mismatched keyper_index → 400", wrongIdx === 400);

  // 3) granted accessor → each keyper releases a sealed share bound to the ON-CHAIN recipient_pub
  const onchainRecipients = new Set<string>();
  let goodSeals = 0;
  for (let i = 0; i < 3; i++) {
    const idx = i + 1;
    const [s, j] = await jpost(`${KEYPERS[i]}/share`, { room_id: ROOM, doc_id: DOC, accessor: GRANTED });
    const resp = j as { keyper_index?: number; eph_pub?: string; ct?: string; tag?: string; recipient_pub?: string };
    if (s !== 200 || !resp.tag || !resp.recipient_pub) {
      check(`keyper ${idx} releases sealed share`, false, `status=${s} err=${JSON.stringify(j)}`);
      continue;
    }
    onchainRecipients.add(resp.recipient_pub);
    // The keyper sealed to the recipient_pub it READ FROM CHAIN — verify the tag binds OUR exact dealt share
    // to that recipient (no secret needed): tag == shareTag(idx, share_y, room, doc, onchain_recipient_pub).
    const expectTag = hex(shareTag(idx, dealtY[idx], bytes(ROOM), bytes(DOC), bytes(resp.recipient_pub)));
    const tagOk = resp.tag === expectTag && resp.keyper_index === idx;
    check(`keyper ${idx} sealed the CORRECT share to the on-chain recipient (tag-verified)`, tagOk, `recipient=${resp.recipient_pub.slice(0, 8)}…`);
    if (tagOk) goodSeals++;
  }
  check("all 3 keypers agree on the on-chain recipient_pub (no client could redirect it)", onchainRecipients.size === 1, `set=${[...onchainRecipients].map((r) => r.slice(0, 8)).join(",")}`);
  check("collected ≥ t=2 valid sealed shares (committee can release)", goodSeals >= 2, `goodSeals=${goodSeals}`);

  // 4) non-admitted accessor → 403 (the live is_doc_admitted gate, read independently per keyper)
  let denied = 0;
  for (let i = 0; i < 3; i++) {
    const [s] = await jpost(`${KEYPERS[i]}/share`, { room_id: ROOM, doc_id: DOC, accessor: NOT_GRANTED });
    if (s === 403) denied++;
  }
  check("non-admitted accessor → 403 from all 3 keypers (is_doc_admitted gate)", denied === 3);

  // 5) unknown document → 404 (keyper holds no share)
  const [noShare] = await jpost(`${KEYPERS[0]}/share`, { room_id: ROOM, doc_id: UNDEALT_DOC, accessor: GRANTED });
  check("undealt document → 404 (no share held)", noShare === 404);

  // 6) malformed input → 400
  const [badHex] = await jpost(`${KEYPERS[0]}/share`, { room_id: "xyz", doc_id: DOC, accessor: GRANTED });
  check("malformed room_id → 400", badHex === 400);

  console.log(`\n[dr3-ch1] threshold note: a single keyper releases only ITS sealed share; reconstructing K`);
  console.log(`[dr3-ch1] needs ≥ t=2 (Ch0 proved 1 share cannot). Shares are sealed to recipient_pub`);
  console.log(`[dr3-ch1] ${[...onchainRecipients][0]} — useless to anyone but that key's holder.`);
  console.log(failed === 0 ? "\nDR3 CH1 COMMITTEE SELF-TEST ALL GREEN ✓" : `\n${failed} CHECK(S) FAILED ✗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
