// zkorage DR3 — a single threshold-ECIES keyper service.
//
// One process per committee member (3 members, threshold 2). A keyper:
//   • holds ONE Shamir share of each document's key K (information-theoretically blind to K on its own);
//   • on /share, INDEPENDENTLY reads the per-document admission from its OWN Soroban RPC (`is_doc_admitted`
//     + `get_grant` for the recipient key), and only if the requester is admitted to THIS document (proved
//     the document's policy) does it ECIES-seal its share to the proof-bound `recipient_pub` (read from
//     chain, NEVER from the request) and return it.
//
// Trust story: no shared oracle, no single key holder. A non-granted caller gets nothing (403); a released
// share is decryptable only by the holder of the recipient secret the eligibility proof bound; fewer than
// `t` keypers cannot reconstruct K. Disclosed caveat: the dealer (upload service) briefly holds K at
// split-time before deleting it (a full DKG removes even that — the documented hardening path).
//
// Config via env: KEYPER_INDEX (1..n), KEYPER_PORT, DEAL_TOKEN (bearer for /deal), DATAROOM_CONTRACT_ID,
// STELLAR_RPC_URL, SIM_SOURCE_PUBKEY, SHARE_STORE_PATH.
import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomBytes } from "node:crypto";
import { ShareStore } from "./store.js";
import { shareEciesSeal } from "./share-ecies.js";
import { isDocAdmitted, getGrantRecipientPub, rpcUrl } from "./chain.js";

const HEX32 = /^[0-9a-f]{64}$/;
const hexBytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));

const KEYPER_INDEX = Number(process.env.KEYPER_INDEX || "0");
const PORT = Number(process.env.KEYPER_PORT || "8801");
const DEAL_TOKEN = process.env.DEAL_TOKEN || "";
const CONTRACT_ID = process.env.DATAROOM_CONTRACT_ID || "";
const STORE_PATH = process.env.SHARE_STORE_PATH || `./data/keyper-${KEYPER_INDEX}.json`;

if (KEYPER_INDEX < 1 || KEYPER_INDEX > 255) {
  throw new Error("KEYPER_INDEX must be set to this keyper's Shamir x-coordinate (1..255)");
}
if (!CONTRACT_ID) throw new Error("DATAROOM_CONTRACT_ID must be set");
if (!DEAL_TOKEN) console.warn("[keyper] WARNING: DEAL_TOKEN is empty → /deal is fail-CLOSED (every deal 503s until a token is set)");

const store = new ShareStore(STORE_PATH);
const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    keyper_index: KEYPER_INDEX,
    rpc: rpcUrl(),
    contract: CONTRACT_ID,
    shares: store.count(),
  });
});

// Dealer → keyper: store this keyper's share for a document. Bearer-token gated (the share itself is not
// secret to the recipient — but only the dealer may POPULATE the committee, so randos can't inject shares).
app.post("/deal", (req: Request, res: Response) => {
  // Fail CLOSED: with no DEAL_TOKEN configured, refuse every deal (never silently accept unauthenticated
  // share injection). /deal is the only thing stopping an attacker from clobbering a keyper's shares.
  if (!DEAL_TOKEN) return res.status(503).json({ error: "keyper not accepting deals: DEAL_TOKEN unset (fail-closed)" });
  const auth = req.header("authorization") || "";
  if (auth !== `Bearer ${DEAL_TOKEN}`) return res.status(401).json({ error: "unauthorized" });
  const { room_id, doc_id, keyper_index, share_y } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof room_id !== "string" || !HEX32.test(room_id)) return res.status(400).json({ error: "room_id must be 32-byte hex" });
  if (typeof doc_id !== "string" || !HEX32.test(doc_id)) return res.status(400).json({ error: "doc_id must be 32-byte hex" });
  if (typeof share_y !== "string" || !HEX32.test(share_y)) return res.status(400).json({ error: "share_y must be 32-byte hex" });
  if (keyper_index !== KEYPER_INDEX) {
    return res.status(400).json({ error: `share is for keyper ${keyper_index}, this is keyper ${KEYPER_INDEX}` });
  }
  try {
    store.put(room_id, doc_id, share_y);
    return res.json({ ok: true, keyper_index: KEYPER_INDEX, stored: `${room_id}:${doc_id}` });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Public: release this keyper's sealed share IFF the requester holds a live on-chain grant. The share is
// sealed to the grant's recorded recipient_pub (read from chain), so the response is useless to anyone else.
app.post("/share", async (req: Request, res: Response) => {
  const { room_id, doc_id, accessor } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof room_id !== "string" || !HEX32.test(room_id)) return res.status(400).json({ error: "room_id must be 32-byte hex" });
  if (typeof doc_id !== "string" || !HEX32.test(doc_id)) return res.status(400).json({ error: "doc_id must be 32-byte hex" });
  if (typeof accessor !== "string" || !HEX32.test(accessor)) return res.status(400).json({ error: "accessor must be 32-byte hex" });

  // (1) Do we even hold a share for this document?
  const shareYHex = store.get(room_id, doc_id);
  if (!shareYHex) return res.status(404).json({ error: "no share for this document" });

  try {
    // (2) The LIVE access decision — this keyper's OWN RPC, no shared oracle. Pattern 2: gate on the
    // PER-DOCUMENT policy (is_doc_admitted = the doc policy, else the room policy, else bare DR2 membership),
    // so a reader gets a share only by proving THIS document's policy. Backward-compatible: a committee doc
    // with no policy falls back to membership, exactly the prior is_granted behavior.
    if (!(await isDocAdmitted(CONTRACT_ID, room_id, doc_id, accessor))) {
      return res.status(403).json({ error: "accessor is not admitted to this document (policy not satisfied)" });
    }
    // (3) The proof-bound recipient key — from chain, NOT the request.
    const recipientPubHex = await getGrantRecipientPub(CONTRACT_ID, room_id, accessor);
    if (!recipientPubHex) return res.status(409).json({ error: "grant has no recipient_pub" });

    // (4) Seal our share to the on-chain recipient_pub with a fresh ephemeral key.
    const sealed = shareEciesSeal(
      hexBytes(shareYHex),
      KEYPER_INDEX,
      hexBytes(recipientPubHex),
      new Uint8Array(randomBytes(32)),
      hexBytes(room_id),
      hexBytes(doc_id),
    );
    return res.json({
      keyper_index: sealed.keyperIndex,
      eph_pub: Buffer.from(sealed.ephPub).toString("hex"),
      ct: Buffer.from(sealed.ct).toString("hex"),
      tag: Buffer.from(sealed.tag).toString("hex"),
      recipient_pub: recipientPubHex,
    });
  } catch (e) {
    return res.status(502).json({ error: `chain read / seal failed: ${(e as Error).message}` });
  }
});

app.listen(PORT, () => {
  console.log(`[keyper ${KEYPER_INDEX}] listening on :${PORT} | contract ${CONTRACT_ID} | rpc ${rpcUrl()} | shares ${store.count()}`);
});
