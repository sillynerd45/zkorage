// zkorage orchestration API (Weeks 1–6: Proof-of-Reserves + Identity/KYC + Compliance).
//
//   PoR (W1–W3): /attest /attest-reserves /prove-reserves /prove-status/:id /submit /result /supply
//                /mint /burn /verify /bundle/latest /count /history /result/:issuer /audit/* /badge* /docs
//   Identity/KYC (W5): /attest-kyc /prove-kyc /grant-access /gate/info /gate/count /gate/history
//                      /gate/access/:accessor
//   Compliance — KYC ∧ not-sanctioned (W6): /denylist /prove-compliance /grant-compliance
//                /compliance/info /compliance/count /compliance/history /compliance/access/:accessor
//   Confidential Data Room (DR1): /dataroom/info /dataroom/create-room /dataroom/prove-seal
//                /dataroom/submit-document /dataroom/room/:id /dataroom/document/:room/:doc
//                /dataroom/documents/:room /dataroom/blob/:hash /dataroom/open/:room/:doc
//   Data Room — threshold committee (DR3): /dataroom/committee/info /dataroom/committee/seal-doc
//                /dataroom/committee/document/:room/:doc /dataroom/committee/collect/:room/:doc
//                /dataroom/committee/open/:room/:doc
//   /health -> liveness ; /info -> all contract IDs + image_ids + deny-list snapshot.
import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { StrKey, xdr } from "@stellar/stellar-sdk";
import {
  attest, attestKyc, attestPayroll, attestAccredited, attestRevenue, attestTeaser, attestSolvency,
  kycIssuerPubkey, payrollAttesterPubkey, accreditedIssuerPubkey, revenueAttesterPubkey, teaserAttesterPubkey,
  solvencyAuditorPubkey, demoSubjectId, demoInvestorId,
} from "./signer.js";
import {
  redact, publicView, teaserFigure,
  DEMO_FINANCIAL_DOC, DEMO_FINANCIAL_POLICY, DEMO_TEASER_FIELD, FIELD_TAG_REVENUE,
  type DisclosurePolicy, type StructuredDoc,
} from "./redaction.js";
import {
  decodeJournal,
  decodeIdentityJournal,
  decodeComplianceJournal,
  decodePayrollJournal,
  decodeDataroomSealJournal,
  fromHex,
  toHex,
  type PublicClaim,
  type PublicIdentityClaim,
  type PublicComplianceClaim,
  type PublicPayrollClaim,
} from "./envelope.js";
import { sha256 } from "@noble/hashes/sha256";
import {
  auditorPublicKey, auditorViewSecret, eciesOpen,
  recipientPublicKey, recipientViewSecret, dataroomEciesOpen, aeadSeal, aeadOpen, randomKey,
} from "./disclosure.js";
import { getBlobStore } from "./storage.js";
import { shamirSplit } from "./shamir.js";
import { shareEciesOpen, reconstructWithCommitment, type SealedShare } from "./committee.js";
import { buildMembershipJob, buildEligibleTree, idCommitment, freshIdentity } from "./membership.js";
import { buildDocauthJob, bankIssuer } from "./docauth.js";
import { getEligible, addEligible, addEligibleBatch, indexOfCommitment } from "./eligible-store.js";
import { addRequest, listRequests, removeRequest, hasRequest } from "./enroll-store.js";
import { putEscrow, getEscrow } from "./escrow-store.js";
import {
  enqueue as enqueueBatch, getByTicket as getBatchTicket, listQueued as listBatchQueued,
  flush as flushBatch, nextFlushAt, queuedCount as batchQueuedCount, purgeTerminal as purgeBatchTerminal,
  findQueuedByNullifier as findQueuedBatch, type QueuedBundle,
} from "./batch-queue-store.js";
import { demoDenyTree, DENY_DEPTH } from "./denylist.js";
import { verifyOnChain, type Bundle } from "./verify.js";
import { readContract, invokeContract, buildUnsignedXdr, submitSignedXdr, scBytes, scAddress, scOptAddress, scI128, scU32, scU64, scBool, jsonSafe } from "./chain.js";
import {
  recordRoom,
  listRoomsByOwner,
  getRoom,
  setRoomVisibility,
  listListedRooms,
  memberBucket,
  bucketTier,
  type RoomVisibility,
} from "./rooms-store.js";
import { ESCROW_ID, BOND_TOKEN_ID, listLocks, getLock as escrowGetLock, isLocked as escrowIsLocked, bondBalance as escrowBondBalance } from "./escrow.js";
import {
  SOLVENCY_GATE_ID, SOLVENCY_IMAGE_ID, SOLVENCY_SUPPLY_TOKEN_ID,
  isSolvencyGranted, getSolvencyRecord, getSolvencyConfig, supplyTokenSupply, guardLock, buildSolvencyJob,
} from "./solvency.js";
import {
  TIER_GATE_ID, TIER_IMAGE_ID, TIER_MIN_ANON_SET, TIER_MEMBER_SET_ID,
  buildTierJob, buildQualSet, freshTierIdentity,
  isTierGranted, getTierGrant, isTierNullifierUsed, getTierConfig, getTierMemberRoot, getTierQualRing, getTierGrantCount,
} from "./tier.js";
import { verifyBundle, cliRecipe, type AuditContext } from "./audit.js";

const PORT = Number(process.env.PORT || 8787);
const VERIFIER_ID =
  process.env.VERIFIER_CONTRACT_ID || "CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW";
const TOKEN_ID = process.env.TOKEN_CONTRACT_ID || "";
const POLICY_ID = process.env.POLICY_CONTRACT_ID || "";
const GATE_ID = process.env.GATE_CONTRACT_ID || "";
const COMPLIANCE_ID = process.env.COMPLIANCE_CONTRACT_ID || "";
const PAYROLL_ID = process.env.PAYROLL_CONTRACT_ID || "";
// Canonical payroll guest image_id (pinned by the payroll gate). Deterministic Docker build (W7).
const PAYROLL_IMAGE_ID =
  process.env.PAYROLL_IMAGE_ID ||
  "2c9cc61b0dc261290209067783365842eca14b77981486eb535bbacfbd1e2785";
// Canonical identity guest image_id (pinned by the gate). Deterministic Docker build.
const IDENTITY_IMAGE_ID =
  process.env.IDENTITY_IMAGE_ID ||
  "a5198a5a359359b08dc1b0faa260e253d413dea5035c1375d19b742f7deaeb3b";
// Canonical compliance guest image_id (pinned by the compliance gate). Deterministic Docker build.
const COMPLIANCE_IMAGE_ID =
  process.env.COMPLIANCE_IMAGE_ID ||
  "54d5921c58280b63ef80905ffe6d4e506f77031b53ff2a347fe84ace423cb129";
// Week 8 — Fundraising (composition): the accredited gate (identity leg) + the fundraise contract.
const ACCREDITED_ID = process.env.ACCREDITED_CONTRACT_ID || "";
const FUNDRAISE_ID = process.env.FUNDRAISE_CONTRACT_ID || "";
// Canonical accredited guest image_id (pinned by the accredited gate). Deterministic Docker build (W8).
const ACCREDITED_IMAGE_ID =
  process.env.ACCREDITED_IMAGE_ID ||
  "26d743739468287991220d6da2cb891616aa7c6b90da2eda9836395f31bcc947";
// Revenue reuses the GENERIC claim_predicate guest (same image as PoR) — claim_type 6, value≥threshold.
const REVENUE_IMAGE_ID =
  process.env.REVENUE_IMAGE_ID ||
  "973c983125ad3a9f115b2f4d8d12ec39e3f1b107f15c57643f72baf36f923502";
// The public revenue floor X the fundraise pins (demo: $1,000,000, whole USD). Must match on-chain.
const FUNDRAISE_THRESHOLD = BigInt(process.env.FUNDRAISE_THRESHOLD || "1000000");
// DR1 — Confidential Data Room. The contract + the canonical seal guest image_id it pins.
const DATAROOM_ID = process.env.DATAROOM_CONTRACT_ID || "";
const DATAROOM_IMAGE_ID =
  process.env.DATAROOM_IMAGE_ID ||
  "8f24842d0647a0671ed1b898f6a42c2d104ff04b3f152067c93d9449bf65a3ce";
// DR2 — the canonical membership guest image_id the DataRoom contract pins for request_access (claim_type 9).
const MEMBERSHIP_IMAGE_ID =
  process.env.MEMBERSHIP_IMAGE_ID ||
  "9550a12e84a9b26bc3926e79e271dc0f1a740f45d86f88c19d3e3e438939011c";
// DR4 — the canonical docauth guest image_id the DataRoom contract pins for attest_document_fact (claim_type 10).
const DOCAUTH_IMAGE_ID =
  process.env.DOCAUTH_IMAGE_ID ||
  "e4f4a356cbacde61ef901500a6d396d2fa83a666b31224be2848fd69bbff8741";
// DR5 — the teaser image the DataRoom pins for attest_teaser: the GENERIC value>=threshold guest (claim_type
// 11), reused unchanged (no new guest). Same image as the PoR/revenue guest.
const TEASER_IMAGE_ID =
  process.env.TEASER_IMAGE_ID ||
  "973c983125ad3a9f115b2f4d8d12ec39e3f1b107f15c57643f72baf36f923502";
const ADMIN_ADDRESS =
  process.env.ADMIN_ADDRESS || process.env.SIM_SOURCE_PUBKEY || "";
// DR3 — the off-chain threshold-ECIES keyper committee. The backend is the DEALER: it splits each
// document key K into shares and distributes one per keyper (bearer-token /deal), then deletes K. The
// keypers independently watch the on-chain DR2 grant and release sealed shares to the granted recipient.
const KEYPER_ENDPOINTS = (process.env.KEYPER_ENDPOINTS || "http://localhost:8801,http://localhost:8802,http://localhost:8803")
  .split(",").map((s) => s.trim()).filter(Boolean);
const KEYPER_DEAL_TOKEN = process.env.KEYPER_DEAL_TOKEN || "dr3-demo-deal-token";
const COMMITTEE_THRESHOLD = Number(process.env.COMMITTEE_THRESHOLD || "2");
const NETWORK = process.env.STELLAR_NETWORK || "testnet";
const PROVER_URL = process.env.PROVER_URL || "";
// M7 — anonymous-access batching window (the timing defense). The relay holds proven request_access bundles
// and flushes them, SHUFFLED, at fixed epoch-aligned boundaries every DR_BATCH_WINDOW_MS, so the on-chain
// grant timestamp+order bins to the window instead of tracking the member's action. Longer = more cover but
// more latency; shorter = snappier but thinner cover (the demo/e2e set it low to show the mechanism quickly,
// production runs it ~10 min). The on-chain decorrelation story is identical at any window length.
const DR_BATCH_WINDOW_MS = Math.max(1000, Number(process.env.DR_BATCH_WINDOW_MS || 10 * 60_000));
// Bound the queue against griefing: batching amplifies a junk-bundle spray (one flush would try every queued
// bundle serially through the relay account). The nullifier-dedup + the image_id pre-filter reject the easy
// junk; this caps the rest. Terminal (submitted/error) entries age out after DR_BATCH_PURGE_MS.
const DR_BATCH_MAX_QUEUE = Math.max(1, Number(process.env.DR_BATCH_MAX_QUEUE || 500));
const DR_BATCH_PURGE_MS = Math.max(60_000, Number(process.env.DR_BATCH_PURGE_MS || 60 * 60_000));
const BUNDLE_PATH = process.env.BUNDLE_PATH || path.join("data", "bundle.json");
// Public RPC the trust-minimized "verify it yourself" channels point at (page + CLI). Not our server.
const PUBLIC_RPC_URL = process.env.PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org";
const DECIMALS = 7;

const auditCtx = (): AuditContext => ({ verifierId: VERIFIER_ID, tokenId: TOKEN_ID, policyId: POLICY_ID });

function loadBundle(): Bundle | null {
  try {
    return JSON.parse(fs.readFileSync(BUNDLE_PATH, "utf8")) as Bundle;
  } catch {
    return null;
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" })); // headroom for base64 document uploads (PDF/image) on prove-seal + committee seal

function journalView(journalHex: string): Record<string, unknown> {
  const j: PublicClaim = decodeJournal(fromHex(journalHex));
  return {
    result: j.result,
    claimType: j.claimType,
    issuerId: j.issuerId,
    supply: j.threshold.toString(), // for PoR, the journal "threshold" field IS the bound supply
    nonce: j.nonce.toString(),
    expiry: j.expiry.toString(),
  };
}

function identityJournalView(journalHex: string): Record<string, unknown> {
  const j: PublicIdentityClaim = decodeIdentityJournal(fromHex(journalHex));
  return {
    result: j.result,
    claimType: j.claimType,
    issuerId: j.issuerId,
    accessor: j.accessor,
    nonce: j.nonce.toString(),
    expiry: j.expiry.toString(),
    note: "subject_id is intentionally absent — identity is hidden (selective disclosure)",
  };
}

function complianceJournalView(journalHex: string): Record<string, unknown> {
  const j: PublicComplianceClaim = decodeComplianceJournal(fromHex(journalHex));
  return {
    result: j.result,
    claimType: j.claimType,
    issuerId: j.issuerId,
    denyRoot: j.denyRoot,
    accessor: j.accessor,
    nonce: j.nonce.toString(),
    expiry: j.expiry.toString(),
    note: "subject_id is intentionally absent — identity hidden; result=true ⇒ KYC passed AND not sanctioned",
  };
}

function payrollJournalView(journalHex: string): Record<string, unknown> {
  const j: PublicPayrollClaim = decodePayrollJournal(fromHex(journalHex));
  return {
    result: j.result,
    claimType: j.claimType,
    issuerId: j.issuerId,
    threshold: j.threshold.toString(),
    accessor: j.accessor,
    auditorPub: j.auditorPub,
    nonce: j.nonce.toString(),
    expiry: j.expiry.toString(),
    note: "salary is intentionally absent — paid ≥ threshold proven; the exact figure is encrypted to the auditor's view key",
  };
}

/** Normalize an accessor input (G-address or 32-byte hex) to 64-char lowercase hex. */
function accessorToHex(input: unknown): string {
  const s = String(input ?? "").trim();
  if (/^G[A-Z2-7]{55}$/.test(s)) return toHex(StrKey.decodeEd25519PublicKey(s));
  const h = s.replace(/^0x/i, "").toLowerCase();
  if (/^[0-9a-f]{64}$/.test(h)) return h;
  throw new Error("accessor must be a Stellar G-address or 32-byte hex");
}

/** Validate a KYC status: only 0 (failed → no receipt) or 1 (passed) are meaningful. */
function toKycStatus(v: unknown): bigint {
  const n = BigInt(v as string | number | bigint);
  if (n !== 0n && n !== 1n) throw new Error("kycStatus must be 0 or 1");
  return n;
}

/** Convert {whole?} or {amount?} into base-unit bigint (7 dp). */
function toBaseUnits(body: { whole?: unknown; amount?: unknown }): bigint {
  if (body.amount !== undefined) return BigInt(body.amount as string);
  if (body.whole !== undefined) return BigInt(body.whole as string) * 10n ** BigInt(DECIMALS);
  throw new Error("amount (base units) or whole (tokens) required");
}

const err = (e: unknown) => String((e as Error)?.message ?? e);

// ── Client-side signing (Freighter) ─────────────────────────────────────────────────────────────
// A write request MAY include `source` = the caller's Stellar G-address. When present (and valid), we
// build the tx UNSIGNED with that source and return its XDR for the wallet to sign — the user submits
// + pays their own gas via POST /tx/submit. When absent, the existing server-relay path runs unchanged.
// Only the PERMISSIONLESS proof entrypoints opt in (the proof is the authorization); admin/owner ops
// and the anonymous DR2/DR6 flows stay relay-only.
function userSource(req: express.Request): string | null {
  const s = (req.body as { source?: unknown } | undefined)?.source;
  return typeof s === "string" && StrKey.isValidEd25519PublicKey(s) ? s : null;
}

/** If the request carries a valid `source`, respond with unsigned XDR and return true (handler should
 *  then `return`). Otherwise return false so the handler proceeds with the server-relay path. Any build
 *  error is thrown for the handler's catch block to format. */
async function maybeXdr(
  req: express.Request,
  res: express.Response,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  idField: Record<string, string>,
): Promise<boolean> {
  const source = userSource(req);
  if (!source) return false;
  const { xdr: x, cost } = await buildUnsignedXdr(contractId, method, args, source);
  res.json({ ok: true, mode: "xdr", xdr: x, cost, source, ...idField });
  return true;
}

/** Best-effort client IP for rate-limiting. Behind Cloudflare the real client is in CF-Connecting-IP;
 *  otherwise fall back to the first X-Forwarded-For hop, then the socket. Spoofable when not behind a
 *  trusted proxy, which is acceptable for a demo griefing throttle (not a security control). */
function clientIp(req: express.Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/info", (_req, res) =>
  res.json({
    verifierId: VERIFIER_ID,
    tokenId: TOKEN_ID || null,
    policyId: POLICY_ID || null,
    gateId: GATE_ID || null,
    complianceId: COMPLIANCE_ID || null,
    payrollId: PAYROLL_ID || null,
    network: NETWORK,
    proverUrl: PROVER_URL || null,
    publicRpc: PUBLIC_RPC_URL,
    decimals: DECIMALS,
    kycIssuerId: toHex(kycIssuerPubkey()),
    identityImageId: IDENTITY_IMAGE_ID,
    complianceImageId: COMPLIANCE_IMAGE_ID,
    payrollImageId: PAYROLL_IMAGE_ID,
    payrollAttesterId: toHex(payrollAttesterPubkey()),
    auditorPub: toHex(auditorPublicKey()),
    denyRoot: demoDenyTree().rootHex(),
    denyDepth: DENY_DEPTH,
    denySize: demoDenyTree().size(),
    // Week 8 — fundraising composition
    accreditedId: ACCREDITED_ID || null,
    fundraiseId: FUNDRAISE_ID || null,
    accreditedImageId: ACCREDITED_IMAGE_ID,
    accreditedIssuerId: toHex(accreditedIssuerPubkey()),
    revenueImageId: REVENUE_IMAGE_ID,
    revenueAttesterId: toHex(revenueAttesterPubkey()),
    fundraiseThreshold: FUNDRAISE_THRESHOLD.toString(),
    // DR1 — Confidential Data Room
    dataroomId: DATAROOM_ID || null,
    dataroomImageId: DATAROOM_IMAGE_ID,
    dataroomRecipientPub: toHex(recipientPublicKey()),
    blobStorage: getBlobStore().backend,
  }),
);

app.get("/supply", async (_req, res) => {
  if (!TOKEN_ID) return res.status(503).json({ error: "TOKEN_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(TOKEN_ID, "total_supply");
    res.json({ supply: String(value), decimals: DECIMALS });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.post("/attest", (req, res) => {
  const { claimType = 1, value, nonce = 1, expiry = 9_999_999_999 } = req.body ?? {};
  if (value === undefined) return res.status(400).json({ error: "value required" });
  try {
    res.json(attest({ claimType: Number(claimType), value: BigInt(value), nonce: BigInt(nonce), expiry: BigInt(expiry) }));
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Mock custodian attestation for Proof-of-Reserves. `reserves` stays server-side (private witness).
app.post("/attest-reserves", (req, res) => {
  const { reserves, nonce = 1, expiry = 9_999_999_999 } = req.body ?? {};
  if (reserves === undefined) return res.status(400).json({ error: "reserves required" });
  try {
    res.json(attest({ claimType: 2, value: BigInt(reserves), nonce: BigInt(nonce), expiry: BigInt(expiry) }));
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Read on-chain supply, bind it as the threshold, attest reserves, submit a proving job to the gateway.
app.post("/prove-reserves", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  if (!TOKEN_ID) return res.status(503).json({ error: "TOKEN_CONTRACT_ID not configured" });
  const { reserves, expiry = 9_999_999_999, nonce = 1 } = req.body ?? {};
  if (reserves === undefined) return res.status(400).json({ error: "reserves required" });
  try {
    const { value: supplyRaw } = await readContract(TOKEN_ID, "total_supply");
    const supply = BigInt(String(supplyRaw));
    const a = attest({ claimType: 2, value: BigInt(reserves), nonce: BigInt(nonce), expiry: BigInt(expiry) });
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        envelope_hex: a.envelope,
        signature_hex: a.signature,
        issuer_pubkey_hex: a.issuer_pubkey,
        // String, not Number — a u64 supply can exceed 2^53; the gateway + host parse it exactly.
        threshold: supply.toString(),
      }),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    res.json({ jobId: j.job_id, supply: supply.toString(), issuerId: a.issuer_pubkey });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/prove-status/:id", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  try {
    const r = await fetch(`${PROVER_URL}/prove/${req.params.id}`);
    const j = (await r.json()) as { status?: string; bundle?: Bundle };
    if (j.status === "done" && j.bundle) {
      // BUNDLE_PATH is the cache the PoR `/audit/latest` channel serves — cache ONLY genuine
      // Proof-of-Reserves bundles (61-byte journal, claim_type 2). `/prove-status` is generic (it
      // proxies KYC / compliance / payroll / accredited / revenue jobs too), so without this guard a
      // poll of any other kind would clobber the PoR audit bundle with a non-PoR journal.
      const bundle = j.bundle;
      const jrnl = bundle.journal;
      const dj = jrnl ? safe(() => decodeJournal(fromHex(jrnl))) : undefined;
      if (dj && dj.claimType === 2) {
        fs.mkdirSync(path.dirname(BUNDLE_PATH), { recursive: true });
        fs.writeFileSync(BUNDLE_PATH, JSON.stringify(bundle));
      }
    }
    res.status(r.status).json(j);
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// Server-sign + send the policy submit_proof_of_reserves tx (verify + supply-binding + persist).
app.post("/submit", async (req, res) => {
  if (!POLICY_ID) return res.status(503).json({ error: "POLICY_CONTRACT_ID not configured" });
  const b = req.body as Bundle;
  if (!b?.seal || !b?.image_id || !b?.journal) {
    return res.status(400).json({ error: "seal, image_id, journal (raw) required" });
  }
  try {
    const args = [scBytes(b.seal), scBytes(b.image_id), scBytes(b.journal)];
    if (await maybeXdr(req, res, POLICY_ID, "submit_proof_of_reserves", args, { policyId: POLICY_ID })) return;
    const out = await invokeContract(POLICY_ID, "submit_proof_of_reserves", args);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, result: jsonSafe(out.returnValue), policyId: POLICY_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), policyId: POLICY_ID });
  }
});

// Submit a client-signed tx XDR (the wallet path's second half). Pairs with the `source` opt-in on the
// permissionless write routes: those return unsigned XDR, Freighter signs it, this submits + confirms.
app.post("/tx/submit", async (req, res) => {
  const signedXdr = (req.body as { signedXdr?: unknown })?.signedXdr;
  if (typeof signedXdr !== "string" || !signedXdr) {
    return res.status(400).json({ ok: false, error: "signedXdr (string) required" });
  }
  try {
    const out = await submitSignedXdr(signedXdr);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, result: jsonSafe(out.returnValue) });
  } catch (e) {
    res.json({ ok: false, error: err(e) });
  }
});

app.get("/result", async (_req, res) => {
  if (!POLICY_ID) return res.status(503).json({ error: "POLICY_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(POLICY_ID, "get_latest_result");
    res.json({ result: value ? jsonSafe(value) : null, policyId: POLICY_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// --- demo-only supply controls (server-signed admin) ---
app.post("/mint", async (req, res) => {
  if (!TOKEN_ID || !ADMIN_ADDRESS) return res.status(503).json({ error: "TOKEN_CONTRACT_ID/ADMIN_ADDRESS not configured" });
  try {
    const amount = toBaseUnits(req.body ?? {});
    const out = await invokeContract(TOKEN_ID, "mint", [scAddress(ADMIN_ADDRESS), scI128(amount)]);
    const { value: supply } = await readContract(TOKEN_ID, "total_supply");
    res.json({ ok: true, txHash: out.hash, minted: amount.toString(), supply: String(supply) });
  } catch (e) {
    res.status(500).json({ ok: false, error: err(e) });
  }
});

app.post("/burn", async (req, res) => {
  if (!TOKEN_ID || !ADMIN_ADDRESS) return res.status(503).json({ error: "TOKEN_CONTRACT_ID/ADMIN_ADDRESS not configured" });
  try {
    const amount = toBaseUnits(req.body ?? {});
    const out = await invokeContract(TOKEN_ID, "burn", [scAddress(ADMIN_ADDRESS), scI128(amount)]);
    const { value: supply } = await readContract(TOKEN_ID, "total_supply");
    res.json({ ok: true, txHash: out.hash, burned: amount.toString(), supply: String(supply) });
  } catch (e) {
    res.status(500).json({ ok: false, error: err(e) });
  }
});

// W1: bare-verifier simulate (kept for the tamper/adversarial demo).
app.post("/verify", async (req, res) => {
  const b = req.body as Bundle;
  if (!b?.seal || !b?.image_id || !b?.journal_digest) {
    return res.status(400).json({ error: "seal, image_id, journal_digest required" });
  }
  try {
    const result = await verifyOnChain(VERIFIER_ID, b);
    const journal = b.journal ? safe(() => journalView(b.journal!)) : undefined;
    res.json({ ...result, contractId: VERIFIER_ID, journal });
  } catch (e) {
    res.status(500).json({ ok: false, error: err(e) });
  }
});

app.get("/bundle/latest", (_req, res) => {
  const b = loadBundle();
  if (!b) return res.status(404).json({ error: "no bundle yet" });
  res.json(b);
});

// ---------------------------------------------------------------------------------------------------
// Week 3 — verification channels: on-chain history listing + shareable audit bundle + independent
// re-verify + embeddable badge + API docs. All reads are trust-minimized (simulate, no signer).
// ---------------------------------------------------------------------------------------------------

// Total number of verified results in the on-chain append-only log.
app.get("/count", async (_req, res) => {
  if (!POLICY_ID) return res.status(503).json({ error: "POLICY_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(POLICY_ID, "get_count");
    res.json({ count: Number(value ?? 0), policyId: POLICY_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// A page of the on-chain verified-results history. ?start=0&limit=50 (limit clamped to 50 on-chain).
app.get("/history", async (req, res) => {
  if (!POLICY_ID) return res.status(503).json({ error: "POLICY_CONTRACT_ID not configured" });
  const start = Math.max(0, Number(req.query.start ?? 0) | 0);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 50) | 0));
  try {
    const [{ value: countRaw }, { value: rows }] = await Promise.all([
      readContract(POLICY_ID, "get_count"),
      readContract(POLICY_ID, "get_history", [scU32(start), scU32(limit)]),
    ]);
    res.json({
      count: Number(countRaw ?? 0),
      start,
      limit,
      results: rows ? (jsonSafe(rows) as unknown[]) : [],
      policyId: POLICY_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// The persisted result for a specific issuer (hex 32-byte issuer_id).
app.get("/result/:issuer", async (req, res) => {
  if (!POLICY_ID) return res.status(503).json({ error: "POLICY_CONTRACT_ID not configured" });
  const issuer = String(req.params.issuer || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(issuer)) return res.status(400).json({ error: "issuer must be 32-byte hex" });
  try {
    const { value } = await readContract(POLICY_ID, "get_result", [scBytes(issuer)]);
    if (!value) return res.status(404).json({ error: "no result for issuer", issuer });
    res.json({ result: jsonSafe(value), policyId: POLICY_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Shareable audit bundle: everything a third party needs to re-verify a claim independently.
async function buildAudit(issuer?: string) {
  const method = issuer ? "get_result" : "get_latest_result";
  const args = issuer ? [scBytes(issuer)] : [];
  const [{ value: stored }, { value: cfg }, { value: supply }] = await Promise.all([
    readContract(POLICY_ID, method, args),
    readContract(POLICY_ID, "get_config"),
    TOKEN_ID ? readContract(TOKEN_ID, "total_supply") : Promise.resolve({ value: null, cost: {} }),
  ]);
  const config = cfg ? (jsonSafe(cfg) as Record<string, unknown>) : null;
  const proof = loadBundle();
  return {
    network: NETWORK,
    rpc: PUBLIC_RPC_URL,
    contracts: { verifier: VERIFIER_ID, token: TOKEN_ID || null, policy: POLICY_ID || null },
    canonicalImageId: (config?.image_id as string) ?? null,
    claimType: (config?.claim_type as number) ?? null,
    proof, // most recent proof bundle (seal, image_id, journal, journal_digest)
    decodedJournal: proof?.journal ? safe(() => journalView(proof.journal!)) : null,
    onChainResult: stored ? jsonSafe(stored) : null,
    currentSupply: supply != null ? String(supply) : null,
    decimals: DECIMALS,
    recipe: cliRecipe(auditCtx(), proof),
  };
}

app.get("/audit/latest", async (_req, res) => {
  if (!POLICY_ID) return res.status(503).json({ error: "POLICY_CONTRACT_ID not configured" });
  try {
    res.json(await buildAudit());
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/audit/verify", (_req, res) =>
  res.status(405).json({ error: "use POST /audit/verify with a bundle, or GET /audit/:issuer" }),
);

app.get("/audit/:issuer", async (req, res) => {
  if (!POLICY_ID) return res.status(503).json({ error: "POLICY_CONTRACT_ID not configured" });
  const issuer = String(req.params.issuer || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(issuer)) return res.status(400).json({ error: "issuer must be 32-byte hex" });
  try {
    res.json(await buildAudit(issuer));
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Independent re-verify of a posted bundle (or the cached one) → checklist + verdict.
app.post("/audit/verify", async (req, res) => {
  if (!POLICY_ID || !TOKEN_ID) return res.status(503).json({ error: "POLICY/TOKEN not configured" });
  const b = (req.body && Object.keys(req.body).length ? req.body : loadBundle()) as Bundle | null;
  if (!b) return res.status(400).json({ error: "no bundle posted and none cached" });
  try {
    const out = await verifyBundle(auditCtx(), b);
    res.json({ ...out, recipe: cliRecipe(auditCtx(), b, out.recomputedDigest) });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Embeddable SVG badge reflecting the on-chain state (VERIFIED / SUPPLY STALE / UNVERIFIED).
async function badgeSvg(issuer?: string): Promise<string> {
  let label = "UNVERIFIED";
  let fill = "#6b7280";
  let supplyStr = "";
  try {
    const method = issuer ? "get_result" : "get_latest_result";
    const args = issuer ? [scBytes(issuer)] : [];
    const [{ value: stored }, supplyRes] = await Promise.all([
      readContract(POLICY_ID, method, args),
      TOKEN_ID ? readContract(TOKEN_ID, "total_supply") : Promise.resolve({ value: null, cost: {} }),
    ]);
    if (stored) {
      const r = jsonSafe(stored) as { supply?: string | number };
      const bound = String(r.supply ?? "");
      const live = supplyRes.value != null ? String(supplyRes.value) : "";
      supplyStr = bound ? `${(BigInt(bound) / 10n ** BigInt(DECIMALS)).toLocaleString("en-US")} zUSD` : "";
      if (live && bound && live === bound) { label = "VERIFIED"; fill = "#2563EB"; }
      else { label = "SUPPLY STALE"; fill = "#f59e0b"; }
    }
  } catch { /* fall through to UNVERIFIED */ }
  const right = label === "VERIFIED" ? `reserves ≥ supply · ${supplyStr}` : label;
  const w = 360, h = 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="zkorage ${label}">
  <rect width="${w}" height="${h}" rx="8" fill="#0b0b0f"/>
  <rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="7" fill="none" stroke="${fill}" stroke-opacity="0.5"/>
  <circle cx="20" cy="${h / 2}" r="5" fill="${fill}"/>
  <text x="36" y="17" font-family="Verdana,Segoe UI,sans-serif" font-size="12" fill="#e5e7eb" font-weight="700">zkorage · Proof-of-Reserves</text>
  <text x="36" y="31" font-family="Verdana,Segoe UI,sans-serif" font-size="11" fill="${fill}">${right}</text>
</svg>`;
}

function sendSvg(res: express.Response, svg: string) {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, max-age=0");
  res.send(svg);
}

app.get("/badge.svg", async (_req, res) => {
  try { sendSvg(res, await badgeSvg()); } catch (e) { res.status(500).json({ error: err(e) }); }
});
app.get("/badge/:issuer.svg", async (req, res) => {
  const issuer = String(req.params.issuer || "").replace(/^0x/, "");
  try { sendSvg(res, await badgeSvg(/^[0-9a-fA-F]{64}$/.test(issuer) ? issuer : undefined)); }
  catch (e) { res.status(500).json({ error: err(e) }); }
});

// API docs: the OpenAPI spec + a Swagger-UI page (CDN).
app.get("/openapi.yaml", (_req, res) => {
  try {
    res.setHeader("Content-Type", "application/yaml; charset=utf-8");
    res.send(fs.readFileSync(path.join(process.cwd(), "openapi.yaml"), "utf8"));
  } catch {
    res.status(404).json({ error: "openapi.yaml not found" });
  }
});
app.get("/docs", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>zkorage REST API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.onload=()=>SwaggerUIBundle({url:'/openapi.yaml',dom_id:'#ui'});</script>
</body></html>`);
});

// ---------------------------------------------------------------------------------------------------
// Week 5 — Identity (KYC selective disclosure): mock KYC issuer + identity prover + relying-party gate.
// A user proves "KYC = passed" (signed by an allow-listed KYC provider) WITHOUT revealing their
// identity; the proof is bound to a public `accessor` (a Stellar account) the gate grants access to.
// ---------------------------------------------------------------------------------------------------

// Mock KYC provider: sign an identity credential. `subject` (label or 32-byte hex) is the PRIVATE
// identity and never reaches the journal. Returns the signed envelope (prover-side material).
app.post("/attest-kyc", (req, res) => {
  const { subject = "alice", kycStatus = 1, nonce = 1, expiry = 9_999_999_999 } = req.body ?? {};
  try {
    const subj = String(subject);
    const subjectId = /^[0-9a-fA-F]{64}$/.test(subj) ? fromHex(subj) : demoSubjectId(subj);
    res.json(
      attestKyc({
        subjectId,
        kycStatus: toKycStatus(kycStatus),
        nonce: BigInt(nonce),
        expiry: BigInt(expiry),
      }),
    );
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Attest a KYC credential for a subject + bind it to `accessor`, then submit an identity proving job.
app.post("/prove-kyc", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  const { subject = "alice", accessor, kycStatus = 1, nonce = 1, expiry = 9_999_999_999 } = req.body ?? {};
  if (accessor === undefined) return res.status(400).json({ error: "accessor required (G-address or 32-byte hex)" });
  // Validate + build the (deterministic, input-dependent) envelope first → 400 on bad client input.
  let accessorHex: string;
  let a: ReturnType<typeof attestKyc>;
  try {
    accessorHex = accessorToHex(accessor);
    const subj = String(subject);
    const subjectId = /^[0-9a-fA-F]{64}$/.test(subj) ? fromHex(subj) : demoSubjectId(subj);
    a = attestKyc({ subjectId, kycStatus: toKycStatus(kycStatus), nonce: BigInt(nonce), expiry: BigInt(expiry) });
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  // The prover round-trip → 502 on upstream failure.
  try {
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "identity",
        envelope_hex: a.envelope,
        signature_hex: a.signature,
        issuer_pubkey_hex: a.issuer_pubkey,
        accessor_hex: accessorHex,
      }),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    res.json({ jobId: j.job_id, accessor: accessorHex, issuerId: a.issuer_pubkey });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// Server-sign + send the gate request_access tx (verify + identity policy + grant). Permissionless.
app.post("/grant-access", async (req, res) => {
  if (!GATE_ID) return res.status(503).json({ error: "GATE_CONTRACT_ID not configured" });
  const b = req.body as Bundle;
  if (!b?.seal || !b?.image_id || !b?.journal) {
    return res.status(400).json({ error: "seal, image_id, journal (raw) required" });
  }
  try {
    const args = [scBytes(b.seal), scBytes(b.image_id), scBytes(b.journal)];
    if (await maybeXdr(req, res, GATE_ID, "request_access", args, { gateId: GATE_ID })) return;
    const out = await invokeContract(GATE_ID, "request_access", args);
    const journal = b.journal ? safe(() => identityJournalView(b.journal!)) : undefined;
    res.json({ ok: true, txHash: out.hash, cost: out.cost, result: jsonSafe(out.returnValue), journal, gateId: GATE_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), gateId: GATE_ID });
  }
});

app.get("/gate/info", async (_req, res) => {
  if (!GATE_ID) return res.status(503).json({ error: "GATE_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(GATE_ID, "get_config");
    res.json({ config: value ? jsonSafe(value) : null, gateId: GATE_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/gate/count", async (_req, res) => {
  if (!GATE_ID) return res.status(503).json({ error: "GATE_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(GATE_ID, "get_count");
    res.json({ count: Number(value ?? 0), gateId: GATE_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// A page of the on-chain access-grant history. ?start=0&limit=50 (limit clamped to 50 on-chain).
app.get("/gate/history", async (req, res) => {
  if (!GATE_ID) return res.status(503).json({ error: "GATE_CONTRACT_ID not configured" });
  const start = Math.max(0, Number(req.query.start ?? 0) | 0);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 50) | 0));
  try {
    const [{ value: countRaw }, { value: rows }] = await Promise.all([
      readContract(GATE_ID, "get_count"),
      readContract(GATE_ID, "get_history", [scU32(start), scU32(limit)]),
    ]);
    res.json({
      count: Number(countRaw ?? 0),
      start,
      limit,
      results: rows ? (jsonSafe(rows) as unknown[]) : [],
      gateId: GATE_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Is this accessor KYC-gated? (G-address or 32-byte hex.) Returns { granted, record }.
app.get("/gate/access/:accessor", async (req, res) => {
  if (!GATE_ID) return res.status(503).json({ error: "GATE_CONTRACT_ID not configured" });
  let accessorHex: string;
  try {
    accessorHex = accessorToHex(req.params.accessor);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const [{ value: granted }, { value: record }] = await Promise.all([
      readContract(GATE_ID, "is_granted", [scBytes(accessorHex)]),
      readContract(GATE_ID, "get_access", [scBytes(accessorHex)]),
    ]);
    res.json({
      accessor: accessorHex,
      granted: Boolean(granted),
      record: record ? jsonSafe(record) : null,
      gateId: GATE_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// ---------------------------------------------------------------------------------------------------
// Week 6 — Compliance (KYC ∧ not-sanctioned): mock KYC issuer + sanctions deny-list (IMT, sha256) +
// combined prover + compliance gate. A user proves "KYC = passed by an allow-listed provider AND not in
// the sanctions deny-list" WITHOUT revealing their identity, bound to a public `accessor`. The deny-list
// tree-builder (denylist.ts) is the off-chain authority; the gate pins its root.
// ---------------------------------------------------------------------------------------------------

// The public deny-list snapshot (root/depth/size). The identities themselves are not exposed.
app.get("/denylist", (_req, res) => {
  const tree = demoDenyTree();
  res.json({ root: tree.rootHex(), depth: DENY_DEPTH, size: tree.size() });
});

// Attest a KYC credential for a subject, build its sanctions non-membership witness, bind `accessor`,
// and submit a combined compliance proving job. A SANCTIONED subject has no witness ⇒ short-circuit
// (the tree-builder, as the authority, cannot produce one; the guest+gate enforce this regardless).
app.post("/prove-compliance", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  const { subject = "alice", accessor, kycStatus = 1, nonce = 1, expiry = 9_999_999_999 } = req.body ?? {};
  if (accessor === undefined) return res.status(400).json({ error: "accessor required (G-address or 32-byte hex)" });
  let accessorHex: string;
  let subjectId: Uint8Array;
  let a: ReturnType<typeof attestKyc>;
  let witness: string;
  try {
    accessorHex = accessorToHex(accessor);
    const subj = String(subject);
    subjectId = /^[0-9a-fA-F]{64}$/.test(subj) ? fromHex(subj) : demoSubjectId(subj);
    const tree = demoDenyTree();
    if (tree.isMember(subjectId)) {
      // The honest ✗ case: a sanctioned subject cannot prove non-membership (no bracketing low-leaf).
      return res.json({
        sanctioned: true,
        subject: subj,
        denyRoot: tree.rootHex(),
        message: "Subject is on the sanctions deny-list — no non-membership proof can be generated.",
      });
    }
    a = attestKyc({ subjectId, kycStatus: toKycStatus(kycStatus), nonce: BigInt(nonce), expiry: BigInt(expiry) });
    witness = tree.nonMembershipWitness(subjectId);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "compliance",
        envelope_hex: a.envelope,
        signature_hex: a.signature,
        issuer_pubkey_hex: a.issuer_pubkey,
        accessor_hex: accessorHex,
        witness_hex: witness,
      }),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    res.json({ jobId: j.job_id, accessor: accessorHex, issuerId: a.issuer_pubkey, denyRoot: demoDenyTree().rootHex() });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// Server-sign + send the compliance gate request_access tx (verify + compliance policy + grant).
app.post("/grant-compliance", async (req, res) => {
  if (!COMPLIANCE_ID) return res.status(503).json({ error: "COMPLIANCE_CONTRACT_ID not configured" });
  const b = req.body as Bundle;
  if (!b?.seal || !b?.image_id || !b?.journal) {
    return res.status(400).json({ error: "seal, image_id, journal (raw) required" });
  }
  try {
    const args = [scBytes(b.seal), scBytes(b.image_id), scBytes(b.journal)];
    if (await maybeXdr(req, res, COMPLIANCE_ID, "request_access", args, { complianceId: COMPLIANCE_ID })) return;
    const out = await invokeContract(COMPLIANCE_ID, "request_access", args);
    const journal = b.journal ? safe(() => complianceJournalView(b.journal!)) : undefined;
    res.json({ ok: true, txHash: out.hash, cost: out.cost, result: jsonSafe(out.returnValue), journal, complianceId: COMPLIANCE_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), complianceId: COMPLIANCE_ID });
  }
});

app.get("/compliance/info", async (_req, res) => {
  if (!COMPLIANCE_ID) return res.status(503).json({ error: "COMPLIANCE_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(COMPLIANCE_ID, "get_config");
    res.json({ config: value ? jsonSafe(value) : null, complianceId: COMPLIANCE_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/compliance/count", async (_req, res) => {
  if (!COMPLIANCE_ID) return res.status(503).json({ error: "COMPLIANCE_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(COMPLIANCE_ID, "get_count");
    res.json({ count: Number(value ?? 0), complianceId: COMPLIANCE_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// A page of the on-chain compliance access-grant history. ?start=0&limit=50 (clamped to 50 on-chain).
app.get("/compliance/history", async (req, res) => {
  if (!COMPLIANCE_ID) return res.status(503).json({ error: "COMPLIANCE_CONTRACT_ID not configured" });
  const start = Math.max(0, Number(req.query.start ?? 0) | 0);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 50) | 0));
  try {
    const [{ value: countRaw }, { value: rows }] = await Promise.all([
      readContract(COMPLIANCE_ID, "get_count"),
      readContract(COMPLIANCE_ID, "get_history", [scU32(start), scU32(limit)]),
    ]);
    res.json({
      count: Number(countRaw ?? 0),
      start,
      limit,
      results: rows ? (jsonSafe(rows) as unknown[]) : [],
      complianceId: COMPLIANCE_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Is this accessor compliance-gated (KYC'd & not-sanctioned)? (G-address or 32-byte hex.)
app.get("/compliance/access/:accessor", async (req, res) => {
  if (!COMPLIANCE_ID) return res.status(503).json({ error: "COMPLIANCE_CONTRACT_ID not configured" });
  let accessorHex: string;
  try {
    accessorHex = accessorToHex(req.params.accessor);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const [{ value: granted }, { value: record }] = await Promise.all([
      readContract(COMPLIANCE_ID, "is_granted", [scBytes(accessorHex)]),
      readContract(COMPLIANCE_ID, "get_access", [scBytes(accessorHex)]),
    ]);
    res.json({
      accessor: accessorHex,
      granted: Boolean(granted),
      record: record ? jsonSafe(record) : null,
      complianceId: COMPLIANCE_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// ---------------------------------------------------------------------------------------------------
// Week 7 — Confidential payroll (proof-of-income + auditor view-key): mock payroll attester + payroll
// prover (in-guest ECIES to the auditor) + payroll gate. An employee proves "paid ≥ THRESHOLD" WITHOUT
// revealing the salary; the salary is encrypted IN-GUEST to an allow-listed auditor's x25519 key. The
// public sees only the boolean + the opaque ciphertext; the auditor's VIEW KEY unlocks the exact figure
// (provably faithful — bound to the signed salary by the proof).
//
// ⚠️ DEMO POSTURE (NOT production): `/payroll/open` + `/payroll/audit` fall back to a SERVER-HELD demo
// auditor secret when no `viewKey` is supplied, and (like all routes here) are unauthenticated under
// open CORS. That is fine for the hosted demo — this backend already custodies every signer key — but it
// means anyone who can reach this backend can decrypt salaries. This does NOT weaken the on-chain
// soundness or the cryptographic hiding of the PUBLIC journal (the leak is only via the server that
// holds the key). The trust-minimized, KEY-FREE path is the SDK's `openPayrollDisclosure(accessor,
// viewKey)`, which is pure and never custodies a key. Before any production use: drop the demo-secret
// fallback (require a caller-supplied `viewKey`), add auth, and restrict CORS.
// ---------------------------------------------------------------------------------------------------

/** Validate a positive u64-range amount (salary / threshold). */
function toU64(v: unknown, name: string): bigint {
  // Reject missing/empty BEFORE BigInt() — `BigInt("")` and `BigInt("  ")` both return 0n, which would
  // silently pass as a valid u64 (e.g. an empty revenue/salary box -> a wasted proving run that proves 0).
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    throw new Error(`${name} is required`);
  }
  const n = BigInt(v as string | number | bigint);
  if (n < 0n || n > 18_446_744_073_709_551_615n) throw new Error(`${name} must be a u64`);
  return n;
}

/** Resolve the auditor view-key secret: the caller's hex key if supplied, else the demo auditor's.
 * The demo-secret fallback is a DEMO convenience only (see the section banner above). */
function resolveViewSecret(input: unknown): Uint8Array {
  const s = String(input ?? "").trim();
  if (!s) return auditorViewSecret();
  const h = s.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("viewKey must be 32-byte hex");
  return fromHex(h);
}

// Mock payroll attester: sign a payroll record. `salary` stays server-side (private witness) and never
// reaches the journal in cleartext — the ZK proof hides it (only the auditor's view key opens it).
app.post("/attest-payroll", (req, res) => {
  const { salary, nonce = 1, expiry = 9_999_999_999 } = req.body ?? {};
  if (salary === undefined) return res.status(400).json({ error: "salary required" });
  try {
    res.json(attestPayroll({ salary: toU64(salary, "salary"), nonce: BigInt(nonce), expiry: BigInt(expiry) }));
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Attest a payroll record + bind `accessor` and the `auditorPub` disclosure target, then submit a
// payroll proving job (in-guest ECIES). `threshold` is the PUBLIC income bar the salary is proven ≥.
app.post("/prove-payroll", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  const { salary, threshold, accessor, auditorPub, nonce = 1, expiry = 9_999_999_999 } = req.body ?? {};
  if (salary === undefined || threshold === undefined || accessor === undefined) {
    return res.status(400).json({ error: "salary, threshold, accessor required" });
  }
  // Validate + build (deterministic) material first → 400 on bad client input.
  let accessorHex: string;
  let auditorHex: string;
  let thr: bigint;
  let a: ReturnType<typeof attestPayroll>;
  try {
    accessorHex = accessorToHex(accessor);
    auditorHex = auditorPub ? accessorToHex(auditorPub) : toHex(auditorPublicKey());
    thr = toU64(threshold, "threshold");
    a = attestPayroll({ salary: toU64(salary, "salary"), nonce: BigInt(nonce), expiry: BigInt(expiry) });
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  // The prover round-trip → 502 on upstream failure.
  try {
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "payroll",
        envelope_hex: a.envelope,
        signature_hex: a.signature,
        issuer_pubkey_hex: a.issuer_pubkey,
        accessor_hex: accessorHex,
        auditor_pubkey_hex: auditorHex,
        // Send the threshold as a STRING — a full u64 can exceed JS's 2^53 safe-integer range, and the
        // gateway (str(int(...))) + host (u64 parse) handle a string exactly (avoids silent rounding).
        threshold: thr.toString(),
      }),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    res.json({ jobId: j.job_id, accessor: accessorHex, auditorPub: auditorHex, threshold: thr.toString(), issuerId: a.issuer_pubkey });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// Server-sign + send the payroll gate submit_payroll_proof tx (verify + payroll policy + grant).
app.post("/submit-payroll", async (req, res) => {
  if (!PAYROLL_ID) return res.status(503).json({ error: "PAYROLL_CONTRACT_ID not configured" });
  const b = req.body as Bundle;
  if (!b?.seal || !b?.image_id || !b?.journal) {
    return res.status(400).json({ error: "seal, image_id, journal (raw) required" });
  }
  try {
    const args = [scBytes(b.seal), scBytes(b.image_id), scBytes(b.journal)];
    if (await maybeXdr(req, res, PAYROLL_ID, "submit_payroll_proof", args, { payrollId: PAYROLL_ID })) return;
    const out = await invokeContract(PAYROLL_ID, "submit_payroll_proof", args);
    const journal = b.journal ? safe(() => payrollJournalView(b.journal!)) : undefined;
    res.json({ ok: true, txHash: out.hash, cost: out.cost, result: jsonSafe(out.returnValue), journal, payrollId: PAYROLL_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), payrollId: PAYROLL_ID });
  }
});

app.get("/payroll/info", async (_req, res) => {
  if (!PAYROLL_ID) return res.status(503).json({ error: "PAYROLL_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(PAYROLL_ID, "get_config");
    res.json({ config: value ? jsonSafe(value) : null, auditorPub: toHex(auditorPublicKey()), payrollId: PAYROLL_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/payroll/count", async (_req, res) => {
  if (!PAYROLL_ID) return res.status(503).json({ error: "PAYROLL_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(PAYROLL_ID, "get_count");
    res.json({ count: Number(value ?? 0), payrollId: PAYROLL_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// A page of the on-chain income-verified history. ?start=0&limit=50 (clamped to 50 on-chain).
app.get("/payroll/history", async (req, res) => {
  if (!PAYROLL_ID) return res.status(503).json({ error: "PAYROLL_CONTRACT_ID not configured" });
  const start = Math.max(0, Number(req.query.start ?? 0) | 0);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 50) | 0));
  try {
    const [{ value: countRaw }, { value: rows }] = await Promise.all([
      readContract(PAYROLL_ID, "get_count"),
      readContract(PAYROLL_ID, "get_history", [scU32(start), scU32(limit)]),
    ]);
    res.json({
      count: Number(countRaw ?? 0),
      start,
      limit,
      results: rows ? (jsonSafe(rows) as unknown[]) : [],
      payrollId: PAYROLL_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Is this accessor income-verified? (G-address or 32-byte hex.) The public read — salary stays hidden.
app.get("/payroll/access/:accessor", async (req, res) => {
  if (!PAYROLL_ID) return res.status(503).json({ error: "PAYROLL_CONTRACT_ID not configured" });
  let accessorHex: string;
  try {
    accessorHex = accessorToHex(req.params.accessor);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const [{ value: granted }, { value: record }] = await Promise.all([
      readContract(PAYROLL_ID, "is_granted", [scBytes(accessorHex)]),
      readContract(PAYROLL_ID, "get_access", [scBytes(accessorHex)]),
    ]);
    res.json({
      accessor: accessorHex,
      granted: Boolean(granted),
      record: record ? jsonSafe(record) : null,
      payrollId: PAYROLL_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// AUDITOR VIEW-KEY: open one accessor's disclosure → the exact salary + a `faithful` proof. The view
// key is the caller's (body.viewKey hex) or the demo auditor's. The PUBLIC has no key → cannot decrypt.
app.post("/payroll/open/:accessor", async (req, res) => {
  if (!PAYROLL_ID) return res.status(503).json({ error: "PAYROLL_CONTRACT_ID not configured" });
  let accessorHex: string;
  let viewSecret: Uint8Array;
  try {
    accessorHex = accessorToHex(req.params.accessor);
    viewSecret = resolveViewSecret(req.body?.viewKey);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const { value: rec } = await readContract(PAYROLL_ID, "get_access", [scBytes(accessorHex)]);
    if (!rec) return res.status(404).json({ error: "no grant for accessor", accessor: accessorHex });
    const r = rec as { eph_pub: Uint8Array; ct: Uint8Array; tag: Uint8Array; threshold: bigint };
    const opened = eciesOpen(new Uint8Array(r.eph_pub), new Uint8Array(r.ct), new Uint8Array(r.tag), viewSecret);
    res.json({
      accessor: accessorHex,
      threshold: String(r.threshold),
      salary: opened.faithful ? opened.salary.toString() : null,
      faithful: opened.faithful,
      payrollId: PAYROLL_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// AUDITOR DASHBOARD: open the grant history → per-EMPLOYEE salaries + the payroll TOTAL. (Q3:
// per-employee disclosure; the auditor sums.) Deduped by `accessor` keeping the LATEST grant (the
// append-only log can hold re-proofs for the same employee — a payroll total must count each employee
// once, not per income-verification event). Only faithful entries count toward the total.
app.post("/payroll/audit", async (req, res) => {
  if (!PAYROLL_ID) return res.status(503).json({ error: "PAYROLL_CONTRACT_ID not configured" });
  let viewSecret: Uint8Array;
  try {
    viewSecret = resolveViewSecret(req.body?.viewKey);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const { value: grantsRaw } = await readContract(PAYROLL_ID, "get_count");
    const grants = Number(grantsRaw ?? 0);
    type Row = { accessor: Uint8Array; threshold: bigint; eph_pub: Uint8Array; ct: Uint8Array; tag: Uint8Array; index: number };
    // Page through the FULL append-only log — `get_history` clamps `limit` to MAX_PAGE (50), so a single
    // read would silently understate the total once the log exceeds 50 income-verification events.
    const list: Row[] = [];
    for (let start = 0; start < grants; start += 50) {
      const { value: rows } = await readContract(PAYROLL_ID, "get_history", [scU32(start), scU32(50)]);
      list.push(...(((rows as Row[]) ?? [])));
    }
    // Dedup by accessor — history is index-ascending, so the last occurrence is the latest grant.
    const byAccessor = new Map<string, { index: number; accessor: string; threshold: string; salary: string | null; faithful: boolean }>();
    for (const r of list) {
      let salary: string | null = null;
      let faithful = false;
      try {
        // One malformed disclosure must NOT 500 the whole audit — mark that row unfaithful and continue.
        const opened = eciesOpen(new Uint8Array(r.eph_pub), new Uint8Array(r.ct), new Uint8Array(r.tag), viewSecret);
        faithful = opened.faithful;
        salary = opened.faithful ? opened.salary.toString() : null;
      } catch { /* unfaithful row */ }
      byAccessor.set(toHex(new Uint8Array(r.accessor)), {
        index: Number(r.index),
        accessor: toHex(new Uint8Array(r.accessor)),
        threshold: String(r.threshold),
        salary,
        faithful,
      });
    }
    const entries = [...byAccessor.values()].sort((a, b) => a.index - b.index);
    let total = 0n;
    for (const e of entries) if (e.faithful && e.salary) total += BigInt(e.salary);
    // `count` = distinct employees; `grants` = total income-verification events in the log.
    res.json({ count: entries.length, grants, total: total.toString(), entries, payrollId: PAYROLL_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// ─────────────────────────── Week 8 — Fundraising (composition) ───────────────────────────
// Investor access requires BOTH: (a) an "accredited = yes" proof (the accredited gate, identity-style)
// AND (b) a "revenue ≥ X" proof (generic value≥threshold claim, ingested by the fundraise contract).
// fundraise.request_investor_access AND's them on-chain (cross-call is_granted ∧ is_revenue_verified).

function revenueJournalView(journalHex: string): Record<string, unknown> {
  return jsonSafe(decodeJournal(fromHex(journalHex))) as Record<string, unknown>;
}

// --- accredited credential (identity leg) ---

app.post("/attest-accredited", (req, res) => {
  const { subject = "ivy", accreditedStatus = 1, nonce = 1, expiry = 9_999_999_999 } = req.body ?? {};
  try {
    const subj = String(subject);
    const subjectId = /^[0-9a-fA-F]{64}$/.test(subj) ? fromHex(subj) : demoInvestorId(subj);
    res.json(attestAccredited({ subjectId, accreditedStatus: BigInt(accreditedStatus), nonce: BigInt(nonce), expiry: BigInt(expiry) }));
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Attest "accredited = yes" for an investor + bind to `accessor`, then submit an accredited proving job.
app.post("/prove-accredited", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  const { subject = "ivy", accessor, accreditedStatus = 1, nonce = 1, expiry = 9_999_999_999 } = req.body ?? {};
  if (accessor === undefined) return res.status(400).json({ error: "accessor required (G-address or 32-byte hex)" });
  let accessorHex: string;
  let a: ReturnType<typeof attestAccredited>;
  try {
    accessorHex = accessorToHex(accessor);
    const subj = String(subject);
    const subjectId = /^[0-9a-fA-F]{64}$/.test(subj) ? fromHex(subj) : demoInvestorId(subj);
    a = attestAccredited({ subjectId, accreditedStatus: BigInt(accreditedStatus), nonce: BigInt(nonce), expiry: BigInt(expiry) });
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "accredited", envelope_hex: a.envelope, signature_hex: a.signature, issuer_pubkey_hex: a.issuer_pubkey, accessor_hex: accessorHex }),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    res.json({ jobId: j.job_id, accessor: accessorHex, issuerId: a.issuer_pubkey });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// Server-sign + send accredited.request_access (verify + accredited policy + grant). Permissionless.
app.post("/grant-accredited", async (req, res) => {
  if (!ACCREDITED_ID) return res.status(503).json({ error: "ACCREDITED_CONTRACT_ID not configured" });
  const b = req.body as Bundle;
  if (!b?.seal || !b?.image_id || !b?.journal) return res.status(400).json({ error: "seal, image_id, journal (raw) required" });
  try {
    const args = [scBytes(b.seal), scBytes(b.image_id), scBytes(b.journal)];
    if (await maybeXdr(req, res, ACCREDITED_ID, "request_access", args, { accreditedId: ACCREDITED_ID })) return;
    const out = await invokeContract(ACCREDITED_ID, "request_access", args);
    const journal = b.journal ? safe(() => identityJournalView(b.journal!)) : undefined;
    res.json({ ok: true, txHash: out.hash, cost: out.cost, result: jsonSafe(out.returnValue), journal, accreditedId: ACCREDITED_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), accreditedId: ACCREDITED_ID });
  }
});

app.get("/accredited/info", async (_req, res) => {
  if (!ACCREDITED_ID) return res.status(503).json({ error: "ACCREDITED_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(ACCREDITED_ID, "get_config");
    res.json({ config: value ? jsonSafe(value) : null, accreditedId: ACCREDITED_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/accredited/count", async (_req, res) => {
  if (!ACCREDITED_ID) return res.status(503).json({ error: "ACCREDITED_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(ACCREDITED_ID, "get_count");
    res.json({ count: Number(value ?? 0), accreditedId: ACCREDITED_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/accredited/history", async (req, res) => {
  if (!ACCREDITED_ID) return res.status(503).json({ error: "ACCREDITED_CONTRACT_ID not configured" });
  const start = Math.max(0, Number(req.query.start ?? 0) | 0);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 50) | 0));
  try {
    const [{ value: countRaw }, { value: rows }] = await Promise.all([
      readContract(ACCREDITED_ID, "get_count"),
      readContract(ACCREDITED_ID, "get_history", [scU32(start), scU32(limit)]),
    ]);
    res.json({ count: Number(countRaw ?? 0), start, limit, results: rows ? (jsonSafe(rows) as unknown[]) : [], accreditedId: ACCREDITED_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/accredited/access/:accessor", async (req, res) => {
  if (!ACCREDITED_ID) return res.status(503).json({ error: "ACCREDITED_CONTRACT_ID not configured" });
  let accessorHex: string;
  try { accessorHex = accessorToHex(req.params.accessor); } catch (e) { return res.status(400).json({ error: err(e) }); }
  try {
    const [{ value: granted }, { value: record }] = await Promise.all([
      readContract(ACCREDITED_ID, "is_granted", [scBytes(accessorHex)]),
      readContract(ACCREDITED_ID, "get_access", [scBytes(accessorHex)]),
    ]);
    res.json({ accessor: accessorHex, granted: Boolean(granted), record: record ? jsonSafe(record) : null, accreditedId: ACCREDITED_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// --- revenue claim (financial leg) ---

app.post("/attest-revenue", (req, res) => {
  const { revenue = 1_500_000, nonce = 1, expiry = 9_999_999_999 } = req.body ?? {};
  try {
    res.json(attestRevenue({ revenue: toU64(revenue, "revenue"), nonce: BigInt(nonce), expiry: BigInt(expiry) }));
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Attest revenue + submit a value≥threshold proving job (reserves kind; threshold = the public floor X).
// `revenue` is REQUIRED + validated (an empty/non-numeric value would otherwise burn a real proving run).
app.post("/prove-revenue", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  const { revenue, nonce = 1, expiry = 9_999_999_999 } = req.body ?? {};
  let a: ReturnType<typeof attestRevenue>;
  try {
    a = attestRevenue({ revenue: toU64(revenue, "revenue"), nonce: BigInt(nonce), expiry: BigInt(expiry) });
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "reserves", envelope_hex: a.envelope, signature_hex: a.signature, issuer_pubkey_hex: a.issuer_pubkey, threshold: FUNDRAISE_THRESHOLD.toString() }),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    res.json({ jobId: j.job_id, threshold: FUNDRAISE_THRESHOLD.toString(), issuerId: a.issuer_pubkey });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// --- fundraise (the composition) ---

// Server-sign + send fundraise.submit_revenue_proof (ingest the revenue ≥ X proof, the financial leg).
app.post("/fundraise/submit-revenue", async (req, res) => {
  if (!FUNDRAISE_ID) return res.status(503).json({ error: "FUNDRAISE_CONTRACT_ID not configured" });
  const b = req.body as Bundle;
  if (!b?.seal || !b?.image_id || !b?.journal) return res.status(400).json({ error: "seal, image_id, journal (raw) required" });
  try {
    const args = [scBytes(b.seal), scBytes(b.image_id), scBytes(b.journal)];
    if (await maybeXdr(req, res, FUNDRAISE_ID, "submit_revenue_proof", args, { fundraiseId: FUNDRAISE_ID })) return;
    const out = await invokeContract(FUNDRAISE_ID, "submit_revenue_proof", args);
    const journal = b.journal ? safe(() => revenueJournalView(b.journal!)) : undefined;
    res.json({ ok: true, txHash: out.hash, cost: out.cost, result: jsonSafe(out.returnValue), journal, fundraiseId: FUNDRAISE_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), fundraiseId: FUNDRAISE_ID });
  }
});

// Server-sign + send fundraise.request_investor_access (the AND: accredited ∧ revenue → admit). Permissionless.
app.post("/fundraise/request-access", async (req, res) => {
  if (!FUNDRAISE_ID) return res.status(503).json({ error: "FUNDRAISE_CONTRACT_ID not configured" });
  const { accessor } = req.body ?? {};
  if (accessor === undefined) return res.status(400).json({ error: "accessor required (G-address or 32-byte hex)" });
  let accessorHex: string;
  try { accessorHex = accessorToHex(accessor); } catch (e) { return res.status(400).json({ error: err(e) }); }
  try {
    const args = [scBytes(accessorHex)];
    if (await maybeXdr(req, res, FUNDRAISE_ID, "request_investor_access", args, { accessor: accessorHex, fundraiseId: FUNDRAISE_ID })) return;
    const out = await invokeContract(FUNDRAISE_ID, "request_investor_access", args);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, result: jsonSafe(out.returnValue), accessor: accessorHex, fundraiseId: FUNDRAISE_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), accessor: accessorHex, fundraiseId: FUNDRAISE_ID });
  }
});

app.get("/fundraise/info", async (_req, res) => {
  if (!FUNDRAISE_ID) return res.status(503).json({ error: "FUNDRAISE_CONTRACT_ID not configured" });
  try {
    const [{ value: config }, { value: revenueVerified }, { value: revenueRecord }, { value: count }] = await Promise.all([
      readContract(FUNDRAISE_ID, "get_config"),
      readContract(FUNDRAISE_ID, "is_revenue_verified"),
      readContract(FUNDRAISE_ID, "get_revenue_record"),
      readContract(FUNDRAISE_ID, "get_count"),
    ]);
    res.json({
      config: config ? jsonSafe(config) : null,
      revenueVerified: Boolean(revenueVerified),
      revenueRecord: revenueRecord ? jsonSafe(revenueRecord) : null,
      admissions: Number(count ?? 0),
      accreditedId: ACCREDITED_ID || null,
      fundraiseId: FUNDRAISE_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// The composed live decision: can this accessor access the fundraise? (revenue ∧ accredited, on-chain.)
app.get("/fundraise/can-access/:accessor", async (req, res) => {
  if (!FUNDRAISE_ID) return res.status(503).json({ error: "FUNDRAISE_CONTRACT_ID not configured" });
  let accessorHex: string;
  try { accessorHex = accessorToHex(req.params.accessor); } catch (e) { return res.status(400).json({ error: err(e) }); }
  try {
    // Read the accredited leg from the gate the FUNDRAISE CONTRACT points at (its Config.accredited_gate),
    // NOT the backend's ACCREDITED_ID env — so the per-leg breakdown can never contradict the authoritative
    // on-chain `can_access` (which AND's revenue ∧ that same gate). Falls back to the env only if the read fails.
    const [{ value: canAccess }, { value: revenueVerified }, { value: cfg }] = await Promise.all([
      readContract(FUNDRAISE_ID, "can_access", [scBytes(accessorHex)]),
      readContract(FUNDRAISE_ID, "is_revenue_verified"),
      readContract(FUNDRAISE_ID, "get_config"),
    ]);
    const gateId = (cfg as { accredited_gate?: string } | null)?.accredited_gate ?? ACCREDITED_ID;
    let accredited: boolean | null = null;
    if (gateId) {
      try { accredited = Boolean((await readContract(gateId, "is_granted", [scBytes(accessorHex)])).value); }
      catch { accredited = null; }
    }
    res.json({
      accessor: accessorHex,
      canAccess: Boolean(canAccess),
      revenueVerified: Boolean(revenueVerified),
      accredited,
      fundraiseId: FUNDRAISE_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/fundraise/access/:accessor", async (req, res) => {
  if (!FUNDRAISE_ID) return res.status(503).json({ error: "FUNDRAISE_CONTRACT_ID not configured" });
  let accessorHex: string;
  try { accessorHex = accessorToHex(req.params.accessor); } catch (e) { return res.status(400).json({ error: err(e) }); }
  try {
    const { value: record } = await readContract(FUNDRAISE_ID, "get_investor_access", [scBytes(accessorHex)]);
    res.json({ accessor: accessorHex, record: record ? jsonSafe(record) : null, fundraiseId: FUNDRAISE_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/fundraise/count", async (_req, res) => {
  if (!FUNDRAISE_ID) return res.status(503).json({ error: "FUNDRAISE_CONTRACT_ID not configured" });
  try {
    const { value } = await readContract(FUNDRAISE_ID, "get_count");
    res.json({ count: Number(value ?? 0), fundraiseId: FUNDRAISE_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/fundraise/history", async (req, res) => {
  if (!FUNDRAISE_ID) return res.status(503).json({ error: "FUNDRAISE_CONTRACT_ID not configured" });
  const start = Math.max(0, Number(req.query.start ?? 0) | 0);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 50) | 0));
  try {
    const [{ value: countRaw }, { value: rows }] = await Promise.all([
      readContract(FUNDRAISE_ID, "get_count"),
      readContract(FUNDRAISE_ID, "get_history", [scU32(start), scU32(limit)]),
    ]);
    res.json({ count: Number(countRaw ?? 0), start, limit, results: rows ? (jsonSafe(rows) as unknown[]) : [], fundraiseId: FUNDRAISE_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// ───────────────────────── DR1 — Confidential Data Room (data plane) ─────────────────────────
// Upload → encrypt (fresh K, AES-256-GCM) → store ciphertext off-chain (R2, or the local stand-in) →
// prove the seal (kind dataroom_seal, worker-first via the gateway) → anchor on Soroban (put_document).
// The blob is content-addressed by sha256(ciphertext); the on-chain proof binds the ECIES-sealed K to
// that content_hash + room_id + doc_id (faithful disclosure). ZK is plumbing in DR1 (load-bearing from
// DR2). Routes:
//   /dataroom/info ; POST /dataroom/create-room ; POST /dataroom/prove-seal (encrypt+upload+enqueue;
//   poll the generic /prove-status/:id) ; POST /dataroom/submit-document ; reads /dataroom/room/:roomId,
//   /dataroom/document/:roomId/:docId, /dataroom/documents/:roomId, GET /dataroom/blob/:contentHash ;
//   POST /dataroom/open/:roomId/:docId (recipient opener — DEMO convenience; the key-free path is the SDK).

/** Normalize a room/doc id to 64-char lowercase hex: 32-byte hex passes through; any other non-empty
 *  string is sha256-hashed to 32 bytes (human-friendly labels); empty → random 32 bytes if allowed. */
function toBytes32(input: unknown, opts: { random?: boolean } = {}): string {
  const s = String(input ?? "").trim();
  if (!s) {
    if (opts.random) return toHex(randomKey());
    throw new Error("id required (32-byte hex or a label)");
  }
  const h = s.replace(/^0x/i, "").toLowerCase();
  if (/^[0-9a-f]{64}$/.test(h)) return h;
  return toHex(sha256(new TextEncoder().encode(s)));
}

/** An x25519 recipient public key must be 32-byte hex (NOT a G-address — it's an encryption key). */
function toX25519PubHex(input: unknown, fallback: () => string): string {
  const s = String(input ?? "").trim();
  if (!s) return fallback();
  const h = s.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("recipientPub must be 32-byte x25519 hex");
  return h;
}

/** Resolve the recipient x25519 SECRET: caller's hex key if supplied, else the demo recipient's.
 *  The demo-secret fallback is a DEMO convenience only (see the payroll-open section banner). */
function resolveRecipientSecret(input: unknown): Uint8Array {
  const s = String(input ?? "").trim();
  if (!s) return recipientViewSecret();
  const h = s.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("recipientKey must be 32-byte hex");
  return fromHex(h);
}

/** Decode a journal hex into a friendly data-room seal view (K is absent — only public fields). */
function dataroomJournalView(journalHex: string): Record<string, unknown> {
  const j = decodeDataroomSealJournal(fromHex(journalHex));
  return {
    result: j.result,
    claimType: j.claimType,
    roomId: j.roomId,
    docId: j.docId,
    recipientPub: j.recipientPub,
    contentHash: j.contentHash,
    ephPub: j.ephPub,
    ct: j.ct,
    tag: j.tag,
    note: "the 32-byte document key K is absent — sealed (ECIES) to recipientPub and bound to content_hash/room_id/doc_id",
  };
}

/** jsonSafe a Document, then decode its blob_pointer back to its UTF-8 string for readability. The pointer
 *  is stored on-chain as the UTF-8 bytes of a string (via `scBytesUtf8`), and `jsonSafe` renders on-chain
 *  Bytes as hex — so blob_pointer arrives here ALWAYS as an even-length hex string, and exactly ONE
 *  hex→utf8 decode recovers the original pointer (`r2://…`, `local://…`, or a bare content hash). The
 *  regex + try/catch are defensive only; for all pointers we write, the decode is unconditional + correct. */
function dataroomDocView(doc: unknown): unknown {
  const d = jsonSafe(doc) as Record<string, unknown> | null;
  if (d && typeof d.blob_pointer === "string" && /^([0-9a-f]{2})*$/i.test(d.blob_pointer)) {
    try { d.blob_pointer = Buffer.from(d.blob_pointer, "hex").toString("utf8"); } catch { /* leave hex */ }
  }
  return d;
}

/** A blob_pointer string → an scvBytes ScVal (the contract stores it as raw Bytes). */
const scBytesUtf8 = (s: string) => scBytes(toHex(new TextEncoder().encode(s)));

app.get("/dataroom/info", async (_req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const [{ value: config }, { value: roomCount }] = await Promise.all([
      readContract(DATAROOM_ID, "get_config"),
      readContract(DATAROOM_ID, "get_room_count"),
    ]);
    res.json({
      config: config ? jsonSafe(config) : null,
      roomCount: Number(roomCount ?? 0),
      dataroomImageId: DATAROOM_IMAGE_ID,
      recipientPub: toHex(recipientPublicKey()),
      storage: getBlobStore().backend,
      dataroomId: DATAROOM_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Create a room owned by the server admin (authenticated by SIGNER_SECRET). `roomId` may be a label
// (sha256-hashed) or 32-byte hex; omit it for a random room id.
app.post("/dataroom/create-room", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  if (!ADMIN_ADDRESS) return res.status(503).json({ error: "ADMIN_ADDRESS not configured" });
  let roomIdHex: string;
  let label: string | undefined;
  try {
    const raw = String(req.body?.roomId ?? "").trim();
    // Keep a human label (e.g. "Series A data room") for the owner's "my rooms" list; a 64-hex id has none.
    label = raw && !/^(0x)?[0-9a-fA-F]{64}$/.test(raw) ? raw : undefined;
    roomIdHex = toBytes32(req.body?.roomId, { random: true });
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  // When a wallet is connected (`source`), the ROOM is owned by that wallet ON-CHAIN — it signs create_room
  // here and put_document later, so "Browse = rooms your wallet owns" reads the authoritative on-chain owner.
  // No wallet → the server relay owns it (the demo default). DR1 owner ops carry no anonymity concern (unlike
  // the DR2/DR6 anonymous flows), so attributing them to the wallet is sound. The room is recorded in the
  // enumeration index either way (the chain stays authoritative; the index is only the set of ids to check).
  const source = userSource(req);
  const owner = source || ADMIN_ADDRESS;
  try { recordRoom(roomIdHex, owner, label); } catch (e) { return res.status(500).json({ error: err(e) }); }
  if (source) {
    try {
      if (await maybeXdr(req, res, DATAROOM_ID, "create_room", [scAddress(source), scBytes(roomIdHex)], { roomId: roomIdHex, owner })) return;
    } catch (e) {
      return res.json({ ok: false, error: err(e), roomId: roomIdHex, dataroomId: DATAROOM_ID });
    }
  }
  try {
    const out = await invokeContract(DATAROOM_ID, "create_room", [scAddress(ADMIN_ADDRESS), scBytes(roomIdHex)]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, roomId: roomIdHex, owner: ADMIN_ADDRESS, room: jsonSafe(out.returnValue), dataroomId: DATAROOM_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), roomId: roomIdHex, dataroomId: DATAROOM_ID });
  }
});

// List the rooms a given owner (a Stellar G-address) owns, for the owner's "my documents" view. The
// enumeration index gives the candidate room_ids; each is RE-VERIFIED on-chain (get_room.owner == owner) so
// the registry is never trusted for ownership, and a doc count is included. A new wallet owns nothing → [].
app.get("/dataroom/rooms", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  const owner = String(req.query.owner ?? "").trim();
  if (!StrKey.isValidEd25519PublicKey(owner)) {
    return res.status(400).json({ error: "owner must be a Stellar account (G-address)" });
  }
  try {
    const candidates = listRoomsByOwner(owner);
    const rooms = (
      await Promise.all(
        candidates.map(async (c) => {
          const { value: room } = await readContract(DATAROOM_ID, "get_room", [scBytes(c.roomId)]);
          const r = room ? (jsonSafe(room) as { owner?: string }) : null;
          if (!r || r.owner !== owner) return null; // chain is authoritative; drop stale/unsubmitted entries
          const { value: cnt } = await readContract(DATAROOM_ID, "get_doc_count", [scBytes(c.roomId)]);
          // M5: include the owner's OWN discovery settings (their own rooms — not a public leak) so the
          // visibility control can show + prefill the current state. Absent visibility reads as "private".
          return {
            roomId: c.roomId,
            label: c.label ?? null,
            owner,
            docCount: Number(cnt ?? 0),
            ledger: (r as { ledger?: number }).ledger ?? null,
            visibility: c.visibility ?? "private",
            name: c.name ?? null,
            description: c.description ?? null,
          };
        }),
      )
    ).filter(Boolean);
    res.json({ owner, count: rooms.length, rooms, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Encrypt a document (fresh K, AES-256-GCM), upload the ciphertext to the blob store (content-addressed),
// then enqueue the seal proof (kind dataroom_seal) worker-first via the gateway. Poll the generic
// /prove-status/:id for the bundle, then POST /dataroom/submit-document. K never leaves the server.
app.post("/dataroom/prove-seal", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  const { roomId, docId, content, contentB64, recipientPub } = req.body ?? {};
  // Validate + build (deterministic) material first → 400 on bad client input.
  let roomIdHex: string;
  let docIdHex: string;
  let recipientPubHex: string;
  let plaintext: Uint8Array;
  try {
    roomIdHex = toBytes32(roomId);
    docIdHex = toBytes32(docId, { random: true });
    recipientPubHex = toX25519PubHex(recipientPub, () => toHex(recipientPublicKey()));
    if (typeof content === "string") plaintext = new TextEncoder().encode(content);
    else if (typeof contentB64 === "string") plaintext = new Uint8Array(Buffer.from(contentB64, "base64"));
    else throw new Error("content (utf8 text) or contentB64 (base64) required");
    if (plaintext.length === 0) throw new Error("document content must be non-empty");
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  // Fail fast: the room must exist (put_document later requires the room owner's auth) — don't burn a
  // proving run anchoring into a non-existent room.
  try {
    const { value: room } = await readContract(DATAROOM_ID, "get_room", [scBytes(roomIdHex)]);
    if (!room) return res.status(404).json({ error: "room not found — create it first", roomId: roomIdHex });
  } catch (e) {
    return res.status(502).json({ error: err(e) });
  }
  // Encrypt, then enqueue the proof FIRST (it needs only the content hash, computable in-memory) and
  // upload the ciphertext only after the gateway accepts the job — so a prover-down / enqueue failure
  // never orphans a blob in the store. (A caller that enqueues but then abandons the flow still leaves a
  // content-addressed blob; that is inherent and harmless — encrypted bytes, dedupable, no PII.)
  try {
    const k = randomKey();
    const blob = aeadSeal(plaintext, k);
    const contentHash = toHex(sha256(blob));
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "dataroom_seal",
        doc_key_hex: toHex(k),
        recipient_pubkey_hex: recipientPubHex,
        content_hash_hex: contentHash,
        room_id_hex: roomIdHex,
        doc_id_hex: docIdHex,
      }),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    // Proof queued → persist the ciphertext so the recipient can fetch it once the document is anchored.
    const put = await getBlobStore().put(blob);
    res.json({
      jobId: j.job_id,
      roomId: roomIdHex,
      docId: docIdHex,
      recipientPub: recipientPubHex,
      contentHash: put.contentHash,
      blobPointer: put.blobPointer,
      size: put.size,
      deduped: put.deduped,
      storage: getBlobStore().backend,
      note: "poll /prove-status/<jobId>; on done, POST /dataroom/submit-document {seal,image_id,journal,blobPointer}",
    });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// Server-sign + send the DataRoom put_document tx (image pin → on-chain sha256(journal) → bare-verifier
// cross-call → result∧claim_type(8) → room exists ∧ owner auth → dedup → anchor). `blobPointer` is the
// off-chain pointer from /dataroom/prove-seal; defaults to the journal's content_hash if omitted.
app.post("/dataroom/submit-document", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  const b = req.body as Bundle & { blobPointer?: string };
  if (!b?.seal || !b?.image_id || !b?.journal) {
    return res.status(400).json({ error: "seal, image_id, journal (raw) required" });
  }
  let pointer: string;
  try {
    // Default the pointer to the journal's content_hash (the blob is content-addressed, so the hash alone
    // is a valid retrieval key) when the caller doesn't pass the richer pointer from prove-seal.
    const view = decodeDataroomSealJournal(fromHex(b.journal));
    pointer = typeof b.blobPointer === "string" && b.blobPointer.trim() ? b.blobPointer.trim() : view.contentHash;
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  // When a wallet is connected, IT is the room owner on-chain, so it must sign put_document (require_auth on
  // room.owner). Build unsigned XDR for the wallet to sign; no wallet → the server relay signs (demo default).
  const putArgs = [scBytes(b.seal), scBytes(b.image_id), scBytes(b.journal), scBytesUtf8(pointer)];
  try {
    if (await maybeXdr(req, res, DATAROOM_ID, "put_document", putArgs, { blobPointer: pointer })) return;
  } catch (e) {
    return res.json({ ok: false, error: err(e), dataroomId: DATAROOM_ID });
  }
  try {
    const out = await invokeContract(DATAROOM_ID, "put_document", putArgs);
    const journal = safe(() => dataroomJournalView(b.journal!));
    res.json({ ok: true, txHash: out.hash, cost: out.cost, result: dataroomDocView(out.returnValue), journal, blobPointer: pointer, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), dataroomId: DATAROOM_ID });
  }
});

app.get("/dataroom/room/:roomId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string;
  try { roomIdHex = toBytes32(req.params.roomId); } catch (e) { return res.status(400).json({ error: err(e) }); }
  try {
    const { value: room } = await readContract(DATAROOM_ID, "get_room", [scBytes(roomIdHex)]);
    res.json({ roomId: roomIdHex, room: room ? jsonSafe(room) : null, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/dataroom/document/:roomId/:docId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string;
  let docIdHex: string;
  try { roomIdHex = toBytes32(req.params.roomId); docIdHex = toBytes32(req.params.docId); }
  catch (e) { return res.status(400).json({ error: err(e) }); }
  try {
    const { value: doc } = await readContract(DATAROOM_ID, "get_document", [scBytes(roomIdHex), scBytes(docIdHex)]);
    res.json({ roomId: roomIdHex, docId: docIdHex, document: doc ? dataroomDocView(doc) : null, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// List a room's anchored documents (the append-only log). ?start=0&limit=50.
app.get("/dataroom/documents/:roomId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string;
  try { roomIdHex = toBytes32(req.params.roomId); } catch (e) { return res.status(400).json({ error: err(e) }); }
  const start = Math.max(0, Number(req.query.start ?? 0) | 0);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 50) | 0));
  try {
    const { value: countRaw } = await readContract(DATAROOM_ID, "get_doc_count", [scBytes(roomIdHex)]);
    const count = Number(countRaw ?? 0);
    const end = Math.min(count, start + limit);
    const idxs: number[] = [];
    for (let i = start; i < end; i++) idxs.push(i);
    // Fetch the page's documents in parallel (the contract has no batch read; one simulate per index).
    const rows = await Promise.all(idxs.map((i) => readContract(DATAROOM_ID, "get_doc_by_index", [scBytes(roomIdHex), scU32(i)])));
    const docs = rows.map((r) => r.value).filter(Boolean).map((doc) => dataroomDocView(doc));
    res.json({ roomId: roomIdHex, count, start, limit, documents: docs, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Fetch the raw encrypted ciphertext blob by content hash (octet-stream). The blob is encrypted; this is
// the public availability path the recipient/SDK fetches before AEAD-decrypting. We re-verify the bytes.
app.get("/dataroom/blob/:contentHash", async (req, res) => {
  const h = String(req.params.contentHash || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) return res.status(400).json({ error: "contentHash must be 32-byte hex" });
  try {
    const bytes = await getBlobStore().get(h);
    if (!bytes) return res.status(404).json({ error: "blob not found", contentHash: h });
    if (toHex(sha256(bytes)) !== h) return res.status(502).json({ error: "stored blob hash mismatch", contentHash: h });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Content-Hash", h);
    res.send(Buffer.from(bytes));
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// RECIPIENT OPENER (DEMO convenience — the trust-minimized KEY-FREE path is the SDK's openDocument, which
// never custodies a key; see the payroll-open section banner for the production hardening notes). Reads the
// on-chain Document, recovers K with the recipient x25519 secret, verifies the faithful tag, fetches the
// blob by content_hash (re-verifying the bytes), then AES-256-GCM-decrypts → the document plaintext.
app.post("/dataroom/open/:roomId/:docId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string;
  let docIdHex: string;
  let recipientSecret: Uint8Array;
  try {
    roomIdHex = toBytes32(req.params.roomId);
    docIdHex = toBytes32(req.params.docId);
    recipientSecret = resolveRecipientSecret(req.body?.recipientKey);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const { value: docRaw } = await readContract(DATAROOM_ID, "get_document", [scBytes(roomIdHex), scBytes(docIdHex)]);
    if (!docRaw) return res.status(404).json({ error: "document not found", roomId: roomIdHex, docId: docIdHex });
    const d = docRaw as { recipient_pub: Uint8Array; content_hash: Uint8Array; eph_pub: Uint8Array; ct: Uint8Array; tag: Uint8Array; room_id: Uint8Array; doc_id: Uint8Array };
    const contentHash = new Uint8Array(d.content_hash);
    // Verify the faithful tag against the DOCUMENT's OWN on-chain room_id/doc_id (not the request-path ids)
    // — self-consistent against the object being authenticated. (They're equal here since get_document is
    // keyed by them, but this stays correct if the read path ever changes.)
    const opened = dataroomEciesOpen(
      new Uint8Array(d.eph_pub), new Uint8Array(d.ct), new Uint8Array(d.tag),
      contentHash, new Uint8Array(d.room_id), new Uint8Array(d.doc_id), recipientSecret,
    );
    if (!opened.faithful) {
      // Wrong recipient key, or a tag that doesn't bind K to THIS document — refuse to decrypt.
      return res.json({ roomId: roomIdHex, docId: docIdHex, faithful: false, recipientPub: toHex(new Uint8Array(d.recipient_pub)), contentHash: toHex(contentHash), dataroomId: DATAROOM_ID });
    }
    const blob = await getBlobStore().get(toHex(contentHash));
    if (!blob) return res.status(404).json({ error: "blob not found for content_hash", contentHash: toHex(contentHash) });
    const contentHashVerified = toHex(sha256(blob)) === toHex(contentHash);
    // 502 (not 500): a hash mismatch is the upstream store serving wrong/corrupt bytes, not a server bug.
    if (!contentHashVerified) return res.status(502).json({ error: "fetched blob hash mismatch", contentHash: toHex(contentHash) });
    const plaintext = aeadOpen(blob, opened.k);
    res.json({
      roomId: roomIdHex,
      docId: docIdHex,
      faithful: true,
      contentHashVerified: true,
      recipientPub: toHex(new Uint8Array(d.recipient_pub)),
      contentHash: toHex(contentHash),
      size: plaintext.length,
      plaintextB64: Buffer.from(plaintext).toString("base64"),
      plaintextUtf8: safe(() => new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) ?? null,
      dataroomId: DATAROOM_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// ===========================================================================================
// DR2 — anonymous eligibility (membership + nullifier). A requester gains access to a room ONLY by
// proving, in ZK, that they are an eligible member — anonymously and once per room. The marquee
// load-bearing ZK: an ACL cannot reproduce anonymous-but-eligible, unlinkable, quota-limited access.
//   GET  /dataroom/membership/info
//   POST /dataroom/membership/register     (add an id_commitment; demo: mint a fresh identity)
//   GET  /dataroom/membership/eligible/:roomId
//   POST /dataroom/membership/set-root      (push the room's computed eligible root on-chain; owner=admin)
//   POST /dataroom/membership/prove-access  (build the Merkle witness + NEW-5 sig → enqueue worker-first)
//   POST /dataroom/membership/request-access (submit the proof → request_access → grant or #NullifierUsed)
//   GET  /dataroom/membership/is-granted/:roomId/:accessor
//   GET  /dataroom/membership/nullifier/:roomId/:nullifier
//   GET  /dataroom/membership/grant/:roomId/:accessor
// The id_secret/id_trapdoor are PRIVATE witness; they reach the self-hosted (trusted) prover, never the
// chain — anonymity is vs the on-chain verifier + the public, exactly the project's "prover sees plaintext".

/** A 32-byte hex value (id_secret/id_trapdoor/holder seed/nullifier/commitment) — throws on bad input. */
function hex32(input: unknown, name: string): Uint8Array {
  const s = String(input ?? "").trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`${name} must be 32-byte hex (64 hex chars)`);
  return fromHex(s);
}

app.get("/dataroom/membership/info", async (_req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const { value: onchain } = await readContract(DATAROOM_ID, "get_membership_image_id");
    res.json({
      dataroomId: DATAROOM_ID,
      membershipImageId: MEMBERSHIP_IMAGE_ID,
      membershipImageOnchain: onchain ? toHex(new Uint8Array(onchain as Uint8Array)) : null,
      claimType: 9,
      treeDepth: 20,
      recipientPub: toHex(recipientPublicKey()),
      note: "request_access(seal,image_id,journal): proves depth-20 sha256-Merkle membership + per-room nullifier + NEW-5 holder sig (pk==accessor); first use grants, reuse → #NullifierUsed.",
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Register a member in a room's eligible set. Body: { roomId, idCommitment?, mint? }. With `mint` (or no
// commitment) the DEMO backend mints a fresh identity and RETURNS its secrets (in production the member
// generates these client-side and registers only the public commitment). Recomputes the off-chain root;
// call /set-root to push it on-chain.
app.post("/dataroom/membership/register", (req, res) => {
  let roomIdHex: string;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    let commitmentHex: string;
    let minted: Record<string, string> | undefined;
    if (req.body?.idCommitment && !req.body?.mint) {
      commitmentHex = toHex(hex32(req.body.idCommitment, "idCommitment"));
    } else {
      const id = freshIdentity();
      commitmentHex = toHex(id.commitment);
      minted = {
        idSecret: toHex(id.idSecret),
        idTrapdoor: toHex(id.idTrapdoor),
        holderSeed: toHex(id.holderSeed),
        accessor: toHex(id.accessor),
        note: "DEMO ONLY — in production the member generates + holds these client-side and registers only idCommitment.",
      };
    }
    const { index, added, total } = addEligible(roomIdHex, commitmentHex);
    const commitments = getEligible(roomIdHex).map((h) => fromHex(h));
    const { root } = buildEligibleTree(commitments);
    res.json({
      ok: true,
      roomId: roomIdHex,
      idCommitment: commitmentHex,
      memberIndex: index,
      added,
      memberCount: total,
      eligibleRoot: toHex(root),
      minted,
      note: "call POST /dataroom/membership/set-root {roomId} to pin this root on-chain.",
    });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

app.get("/dataroom/membership/eligible/:roomId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string;
  try {
    roomIdHex = toBytes32(req.params.roomId);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const commitmentsHex = getEligible(roomIdHex);
    const { root } = buildEligibleTree(commitmentsHex.map((h) => fromHex(h)));
    const computedRoot = toHex(root);
    const { value: pinned } = await readContract(DATAROOM_ID, "get_eligible_root", [scBytes(roomIdHex)]);
    const pinnedRoot = pinned ? toHex(new Uint8Array(pinned as Uint8Array)) : null;
    res.json({
      roomId: roomIdHex,
      memberCount: commitmentsHex.length,
      commitments: commitmentsHex,
      computedRoot,
      pinnedRoot,
      inSync: pinnedRoot === computedRoot,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Push the room's current (off-chain computed) eligible root on-chain. set_eligible_root requires the
// room owner's auth — the server admin (SIGNER_SECRET) owns the demo rooms. Re-pinning rotates the set.
app.post("/dataroom/membership/set-root", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const commitments = getEligible(roomIdHex).map((h) => fromHex(h));
    if (commitments.length === 0) return res.status(400).json({ error: "no members registered for this room" });
    const { root } = buildEligibleTree(commitments);
    const rootHex = toHex(root);
    const out = await invokeContract(DATAROOM_ID, "set_eligible_root", [scBytes(roomIdHex), scBytes(rootHex)]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, roomId: roomIdHex, eligibleRoot: rootHex, memberCount: commitments.length });
  } catch (e) {
    res.json({ ok: false, error: err(e), roomId: roomIdHex });
  }
});

// M5 — griefing throttle on the (now publicly discoverable) join-request endpoint. A rolling window per
// client IP plus a per-room pending-queue cap. Idempotent repeats (same commitment) are already deduped by
// enroll-store, so this only bounds genuinely-FRESH requests. In-memory (demo); a shared store in production.
const ENROLL_RL_WINDOW_MS = 10 * 60_000; // 10 minutes
const ENROLL_RL_MAX = Math.max(1, Number(process.env.DR_ENROLL_RL_MAX || 10)); // new requests per IP per window (env-tunable for bulk provisioning; prod default 10)
const ENROLL_RL_MAX_IPS = 10_000; // hard cap on tracked IPs (backstop vs header-spoofed key churn)
const ENROLL_PENDING_CAP = 200; // max pending requests held per room
const enrollHits = new Map<string, number[]>();

/** Record a hit for `ip` and report whether it is now over the window limit. Keeps the map BOUNDED: only
 *  when it crosses ENROLL_RL_MAX_IPS do we sweep window-expired entries (cheap O(1) the rest of the time),
 *  and if it is still over the cap afterwards (e.g. spoofed X-Forwarded-For churn from a direct-to-origin
 *  caller) we evict the oldest-inserted entries so memory cannot grow without bound. The throttle itself is
 *  best-effort: behind Cloudflare CF-Connecting-IP is authoritative, but a direct caller can spoof the IP,
 *  so this is a griefing speed-bump, not a security control. */
function enrollRateLimited(ip: string, nowMs: number): boolean {
  if (enrollHits.size > ENROLL_RL_MAX_IPS) {
    for (const [k, ts] of enrollHits) {
      const live = ts.filter((t) => nowMs - t < ENROLL_RL_WINDOW_MS);
      if (live.length === 0) enrollHits.delete(k);
      else enrollHits.set(k, live);
    }
    if (enrollHits.size > ENROLL_RL_MAX_IPS) {
      let toEvict = enrollHits.size - ENROLL_RL_MAX_IPS;
      for (const k of enrollHits.keys()) {
        if (toEvict-- <= 0) break;
        enrollHits.delete(k); // Map iterates in insertion order -> evicts the oldest first
      }
    }
  }
  const hits = (enrollHits.get(ip) ?? []).filter((t) => nowMs - t < ENROLL_RL_WINDOW_MS);
  hits.push(nowMs);
  enrollHits.set(ip, hits);
  return hits.length > ENROLL_RL_MAX;
}

// ---- M1: request-then-approve enrollment (Model B) ----
// A would-be member REQUESTS to join (submits only their public id_commitment); the room OWNER approves,
// which appends the commitment to the eligible set and re-pins the root (owner-signed via the wallet XDR
// path, else the server relay if it owns the room). Joining is identified (the owner sees who they approve);
// accessing stays anonymous (the membership proof hides which member). Pending requests are off-chain and
// have NO on-chain effect until approval; the eligible ROOT is the on-chain gate.

// Member: file a pending join request (public id_commitment only; an optional label/requester identifies the
// asker to the owner). No-op-friendly: already-eligible => eligible; already-pending => pending.
app.post("/dataroom/enroll/request", (req, res) => {
  let roomIdHex: string;
  let commitmentHex: string;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    commitmentHex = toHex(hex32(req.body?.commitment, "commitment"));
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  const label = typeof req.body?.label === "string" ? req.body.label.slice(0, 200) : undefined;
  const requester = userSource(req) ?? undefined;
  try {
    // Idempotent reads first (a member polling their own status), NOT counted against the rate limit.
    if (indexOfCommitment(roomIdHex, commitmentHex) >= 0) {
      return res.json({ ok: true, state: "eligible", roomId: roomIdHex, commitment: commitmentHex });
    }
    if (hasRequest(roomIdHex, commitmentHex)) {
      return res.json({ ok: true, state: "pending", added: false, roomId: roomIdHex, commitment: commitmentHex });
    }
    // A genuinely NEW request: throttle by IP + cap the per-room queue (blunts directory griefing).
    if (enrollRateLimited(clientIp(req), Date.now())) {
      return res.status(429).json({ ok: false, error: "too many join requests; please try again later" });
    }
    if (listRequests(roomIdHex).length >= ENROLL_PENDING_CAP) {
      return res.status(429).json({ ok: false, error: "this room's request queue is full; please try again later" });
    }
    const { added } = addRequest(roomIdHex, { commitment: commitmentHex, label, requester, ts: Date.now() });
    res.json({ ok: true, state: "pending", added, roomId: roomIdHex, commitment: commitmentHex });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Owner view: the pending requests for a room + the current approved member count. (Demo: not auth-gated;
// production would require the owner to authenticate. Pending entries are identified-join, not anonymous.)
app.get("/dataroom/enroll/requests/:roomId", (req, res) => {
  let roomIdHex: string;
  try {
    roomIdHex = toBytes32(req.params.roomId);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    res.json({ roomId: roomIdHex, pending: listRequests(roomIdHex), memberCount: getEligible(roomIdHex).length });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Anyone: the state of a commitment in a room (eligible | pending | none).
app.get("/dataroom/enroll/status/:roomId/:commitment", (req, res) => {
  let roomIdHex: string;
  let commitmentHex: string;
  try {
    roomIdHex = toBytes32(req.params.roomId);
    commitmentHex = toHex(hex32(req.params.commitment, "commitment"));
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  const idx = indexOfCommitment(roomIdHex, commitmentHex);
  if (idx >= 0) return res.json({ state: "eligible", memberIndex: idx });
  if (hasRequest(roomIdHex, commitmentHex)) return res.json({ state: "pending" });
  res.json({ state: "none" });
});

// Owner: reject (drop) a pending request without admitting it.
app.post("/dataroom/enroll/reject", (req, res) => {
  let roomIdHex: string;
  let commitmentHex: string;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    commitmentHex = toHex(hex32(req.body?.commitment, "commitment"));
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    res.json({ ok: true, removed: removeRequest(roomIdHex, commitmentHex) });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Owner: approve a pending request — append the commitment to the eligible set, recompute the root, and pin
// it on-chain. Verifies on-chain that the caller (`source`, else the relay) owns the room before mutating
// the set, so a non-owner cannot pollute it. With a wallet `source`, returns the unsigned set_eligible_root
// XDR for the owner to sign; otherwise the server relay signs (demo rooms it owns).
app.post("/dataroom/enroll/approve", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string;
  let commitmentHex: string;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    commitmentHex = toHex(hex32(req.body?.commitment, "commitment"));
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const source = userSource(req);
    const owner = source ?? ADMIN_ADDRESS;
    // Only the room owner may change the eligible set / root — verify ownership on-chain before touching it.
    const { value: roomVal } = await readContract(DATAROOM_ID, "get_room", [scBytes(roomIdHex)]);
    const room = roomVal ? (jsonSafe(roomVal) as { owner?: string }) : null;
    if (!room) return res.status(404).json({ error: "room not found" });
    if (room.owner !== owner) return res.status(403).json({ error: "only the room owner may approve members" });

    addEligible(roomIdHex, commitmentHex);
    removeRequest(roomIdHex, commitmentHex);
    const commitments = getEligible(roomIdHex).map((h) => fromHex(h));
    const { root } = buildEligibleTree(commitments);
    const rootHex = toHex(root);
    const idField = { roomId: roomIdHex, commitment: commitmentHex, eligibleRoot: rootHex, memberCount: String(commitments.length) };
    if (source) {
      if (await maybeXdr(req, res, DATAROOM_ID, "set_eligible_root", [scBytes(roomIdHex), scBytes(rootHex)], idField)) return;
    }
    const out = await invokeContract(DATAROOM_ID, "set_eligible_root", [scBytes(roomIdHex), scBytes(rootHex)]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, ...idField });
  } catch (e) {
    res.json({ ok: false, error: err(e), roomId: roomIdHex });
  }
});

// Owner: approve MANY pending requests in ONE root re-pin (M7 timing defense #2). Appends the new commitments
// in RANDOMIZED order (existing leaves keep their index) and re-pins the root once, so the eligible_root jumps
// by a batch instead of by a member — it stops acting as a per-member "enrolled-by" marker the owner could
// correlate with the exact wallet they just approved (see addEligibleBatch). Body: { roomId, commitments? };
// commitments omitted => approve ALL currently-pending. Only commitments that are actually pending are admitted.
app.post("/dataroom/enroll/approve-batch", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string;
  let requested: string[] | null;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    if (req.body?.commitments === undefined) {
      requested = null; // approve all pending
    } else {
      if (!Array.isArray(req.body.commitments)) throw new Error("commitments must be an array of hex commitments");
      requested = req.body.commitments.map((c: unknown) => toHex(hex32(c, "commitment")));
    }
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const source = userSource(req);
    const owner = source ?? ADMIN_ADDRESS;
    const { value: roomVal } = await readContract(DATAROOM_ID, "get_room", [scBytes(roomIdHex)]);
    const room = roomVal ? (jsonSafe(roomVal) as { owner?: string }) : null;
    if (!room) return res.status(404).json({ error: "room not found" });
    if (room.owner !== owner) return res.status(403).json({ error: "only the room owner may approve members" });

    // Only admit commitments that are actually pending for this room (an owner cannot append arbitrary
    // commitments). Default (no list) = every pending request.
    const pending = new Set(listRequests(roomIdHex).map((r) => r.commitment.toLowerCase()));
    const toAdmit = (requested ?? [...pending]).map((c) => c.toLowerCase()).filter((c) => pending.has(c));
    if (toAdmit.length === 0) return res.status(400).json({ error: "no matching pending requests to approve" });

    const { added } = addEligibleBatch(roomIdHex, toAdmit); // randomized order, single set-root
    for (const a of added) removeRequest(roomIdHex, a.commitment);
    const commitments = getEligible(roomIdHex).map((h) => fromHex(h));
    const { root } = buildEligibleTree(commitments);
    const rootHex = toHex(root);
    const idField = { roomId: roomIdHex, approved: String(added.length), eligibleRoot: rootHex, memberCount: String(commitments.length) };
    if (source) {
      if (await maybeXdr(req, res, DATAROOM_ID, "set_eligible_root", [scBytes(roomIdHex), scBytes(rootHex)], idField)) return;
    }
    const out = await invokeContract(DATAROOM_ID, "set_eligible_root", [scBytes(roomIdHex), scBytes(rootHex)]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, ...idField, approvedCommitments: added.map((a) => a.commitment) });
  } catch (e) {
    res.json({ ok: false, error: err(e), roomId: roomIdHex });
  }
});

// ---- M5: discovery tiers + public directory ----
// Visibility is an OFF-CHAIN, NON-security discovery flag (rooms-store): anonymity + access control stay
// enforced by the membership proof + the k=5 floor + the keepers, so a wrong listing can never grant access
// or deanonymize anyone. Tiers: private (no metadata leak by id) / unlisted (resolvable by EXACT id) /
// listed (in the public directory, opt-in). Counts are COARSE BUCKETS only — the exact member count never
// crosses the wire here — and there is NO public access feed (we never expose who/when accessed).

// Short TTL cache for the directory payload: it is identical for every caller and the route fans out one
// on-chain get_room per listed room, so caching the resolved list bounds RPC load under traffic. A
// just-listed/unlisted room appears/disappears within the TTL (and a visibility change busts it immediately
// below), which is fine for a discovery directory. Module-scoped; invalidated on POST /room/visibility.
const DIRECTORY_TTL_MS = 15_000;
let directoryCache: { at: number; rooms: unknown[] } | null = null;

// PUBLIC directory: only rooms the owner opted into ("listed"). Coarse counts, no exact numbers, no access
// feed. Each listing is re-verified on-chain (drop phantoms whose recorded owner no longer matches).
app.get("/dataroom/directory", async (_req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const now = Date.now();
    if (!directoryCache || now - directoryCache.at >= DIRECTORY_TTL_MS) {
      const listed = listListedRooms();
      const resolved = await Promise.all(
        listed.map(async (r) => {
          const { value: room } = await readContract(DATAROOM_ID, "get_room", [scBytes(r.roomId)]);
          const chain = room ? (jsonSafe(room) as { owner?: string }) : null;
          if (!chain || chain.owner !== r.owner) return null; // chain authoritative; drop stale/unsubmitted
          const n = getEligible(r.roomId).length;
          return {
            roomId: r.roomId,
            name: r.name ?? null,
            description: r.description ?? null,
            memberBucket: memberBucket(n),
            anonTier: bucketTier(n),
            listedAt: r.listedAt ?? null,
          };
        }),
      );
      const rooms = resolved
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => (b.listedAt ?? 0) - (a.listedAt ?? 0)); // newest listings first
      directoryCache = { at: now, rooms };
    }
    res.json({ count: directoryCache.rooms.length, rooms: directoryCache.rooms, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Resolve ONE room by exact id. private -> reveal nothing (the room is still reachable by anyone the owner
// hands the id to, via the join flow; we just do not confirm it or leak metadata to a browser). unlisted /
// listed -> confirm it exists on-chain + return opt-in name/desc + a coarse count.
app.get("/dataroom/room-meta/:roomId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string;
  try {
    roomIdHex = toBytes32(req.params.roomId);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const rec = getRoom(roomIdHex);
    const visibility: RoomVisibility = rec?.visibility ?? "private";
    if (visibility === "private") {
      // No metadata, no count, no existence confirmation — a private room is dark to discovery.
      return res.json({ roomId: roomIdHex, visibility: "private", discoverable: false });
    }
    const { value: room } = await readContract(DATAROOM_ID, "get_room", [scBytes(roomIdHex)]);
    if (!room) return res.json({ roomId: roomIdHex, visibility, discoverable: false, exists: false });
    const n = getEligible(roomIdHex).length;
    res.json({
      roomId: roomIdHex,
      visibility,
      discoverable: true,
      listed: visibility === "listed",
      name: rec?.name ?? null,
      description: rec?.description ?? null,
      memberBucket: memberBucket(n),
      anonTier: bucketTier(n),
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Owner: set a room's discovery tier + opt-in public name/description. Off-chain write (no tx). Gated by the
// on-chain get_room.owner == source check. NOTE (demo): like the other DR enroll endpoints, `source` is an
// unauthenticated request claim; because visibility is a non-security discovery flag, a forged source can at
// worst toggle a discovery hint, never grant access or deanonymize. Production would require the owner to
// sign the change (SEP-53). name/description are sanitized + length-capped in the store.
app.post("/dataroom/room/visibility", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  if (!ADMIN_ADDRESS) return res.status(503).json({ error: "ADMIN_ADDRESS not configured" });
  let roomIdHex: string;
  let visibility: RoomVisibility;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    const v = String(req.body?.visibility ?? "");
    if (v !== "private" && v !== "unlisted" && v !== "listed") {
      throw new Error("visibility must be private, unlisted, or listed");
    }
    visibility = v;
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const source = userSource(req);
    const owner = source ?? ADMIN_ADDRESS;
    const { value: roomVal } = await readContract(DATAROOM_ID, "get_room", [scBytes(roomIdHex)]);
    const room = roomVal ? (jsonSafe(roomVal) as { owner?: string }) : null;
    if (!room) return res.status(404).json({ error: "room not found" });
    if (room.owner !== owner) return res.status(403).json({ error: "only the room owner may change visibility" });
    const rec = setRoomVisibility(roomIdHex, owner, {
      visibility,
      name: req.body?.name,
      description: req.body?.description,
      nowMs: Date.now(),
    });
    directoryCache = null; // a listing changed -> the owner sees it in the directory immediately
    res.json({
      ok: true,
      roomId: roomIdHex,
      visibility: rec.visibility,
      name: rec.name ?? null,
      description: rec.description ?? null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: err(e) });
  }
});

// Build the membership witness (from the room's eligible set) + the NEW-5 holder signature, then enqueue
// the membership proof (kind=membership) worker-first via the gateway. Poll the generic /prove-status/:id;
// on done, POST /dataroom/membership/request-access. The private witness goes only to the trusted prover.
app.post("/dataroom/membership/prove-access", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, idSecret: Uint8Array, idTrapdoor: Uint8Array, recipientPubHex: string;
  let holderSeed: Uint8Array | undefined;
  let signature: { accessor: Uint8Array; sig: Uint8Array } | undefined;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    idSecret = hex32(req.body?.idSecret, "idSecret");
    idTrapdoor = hex32(req.body?.idTrapdoor, "idTrapdoor");
    recipientPubHex = toX25519PubHex(req.body?.recipientPub, () => toHex(recipientPublicKey()));
    // NEW-5 consent: prefer a CLIENT-supplied signature (so accessor_seed never leaves the member's device);
    // fall back to a holder seed (server-minted demo identities). Exactly one path. A client-supplied sig is
    // re-verified in buildMembershipJob against (room_id, accessor, recipient_pub).
    if (req.body?.holderSig !== undefined || req.body?.accessor !== undefined) {
      const sig = fromHex(String(req.body?.holderSig ?? ""));
      if (sig.length !== 64) throw new Error("holderSig must be 64-byte hex (128 hex chars)");
      signature = { accessor: hex32(req.body?.accessor, "accessor"), sig };
    } else {
      holderSeed = hex32(req.body?.holderSeed, "holderSeed");
    }
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    // The member must be in the room's eligible set (derive the index from the commitment — never trust a
    // client-supplied index).
    const commitmentHex = toHex(idCommitment(idSecret, idTrapdoor));
    const memberIndex = indexOfCommitment(roomIdHex, commitmentHex);
    if (memberIndex < 0) return res.status(400).json({ error: "not in the room's eligible set — register first", idCommitment: commitmentHex });
    const commitments = getEligible(roomIdHex).map((h) => fromHex(h));
    // Model B anonymity floor (k): a caller (the Model B reader) may require a minimum eligible-set size, so a
    // member cannot record an on-chain access (request_access) in a room too small to be anonymous. Legacy
    // callers (e.g. the DR2 set-of-2 teaching demo) OMIT minAnonSet and are unaffected. A present-but-malformed
    // value is an error (fail closed), never a silently skipped floor. NOTE: the count is the off-chain
    // eligible-set size (kept in sync with the pinned root by the enroll/approve flow), so the floor is a
    // service-level guardrail, not an on-chain invariant (the member count is not stored on-chain).
    if (req.body?.minAnonSet !== undefined) {
      const minAnonSet = Number(req.body.minAnonSet);
      if (!Number.isInteger(minAnonSet) || minAnonSet <= 0) {
        return res.status(400).json({ error: "minAnonSet must be a positive integer" });
      }
      if (commitments.length < minAnonSet) {
        return res.status(400).json({ error: `anonymity set too small: ${commitments.length} of ${minAnonSet} members`, anonSetSize: commitments.length, minAnonSet });
      }
    }
    // Build the witness (client-input errors here -> 400, NOT 5xx: a bad signature / mismatched witness is the
    // caller's fault, and Cloudflare masks 5xx origin responses with its own HTML error page, so the client
    // would never see the real reason). Genuine upstream/prover failures below stay 502.
    let built: ReturnType<typeof buildMembershipJob>;
    try {
      built = buildMembershipJob({
        idSecret, idTrapdoor, roomId: fromHex(roomIdHex),
        recipientPub: fromHex(recipientPubHex), commitments, memberIndex,
        ...(signature ? { signature } : { holderSeed }),
      });
    } catch (e) {
      return res.status(400).json({ error: err(e) });
    }
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(built.job),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    res.json({
      jobId: j.job_id,
      roomId: roomIdHex,
      eligibleRoot: built.eligibleRoot,
      nullifier: built.nullifier,
      accessor: built.accessor,
      recipientPub: recipientPubHex,
      note: "poll /prove-status/<jobId>; on done, POST /dataroom/membership/request-access {seal,image_id,journal}",
    });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// Submit a membership proof to the contract: request_access (PERMISSIONLESS — the in-guest NEW-5 holder
// sig carries the accessor's consent; the server is just the relayer/fee-payer). Grant or #NullifierUsed.
app.post("/dataroom/membership/request-access", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  const b = req.body as Bundle;
  if (!b?.seal || !b?.image_id || !b?.journal) {
    return res.status(400).json({ error: "seal, image_id, journal (raw) required" });
  }
  try {
    const out = await invokeContract(DATAROOM_ID, "request_access", [scBytes(b.seal), scBytes(b.image_id), scBytes(b.journal)]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, grant: jsonSafe(out.returnValue), dataroomId: DATAROOM_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), dataroomId: DATAROOM_ID });
  }
});

// M7 — submit ONE proven request_access bundle (used by both the immediate route above and the batch flusher).
// request_access is permissionless (the in-guest NEW-5 holder sig is the authorization), so the relay just
// pays fees. Bounded by a timeout so a stalled RPC cannot wedge the whole flush (the overlap guard would
// otherwise stay held forever). Returns the tx hash or throws.
const SUBMIT_TIMEOUT_MS = 90_000;
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms).unref?.()),
  ]);
}
async function submitOneAccess(bundle: QueuedBundle): Promise<{ txHash: string }> {
  const out = await withTimeout(
    invokeContract(DATAROOM_ID, "request_access", [scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(bundle.journal)]),
    SUBMIT_TIMEOUT_MS,
    "request_access submit",
  );
  return { txHash: out.hash };
}

// M7 — per-IP throttle on queue-access. Batching amplifies a spray (a valid-image but invalid-proof bundle
// still costs the relay a fee + a serial verify at flush), and an unthrottled (room,nullifier) probe is a weak
// queue-occupancy oracle. This blunts both. Best-effort (CF-Connecting-IP authoritative behind Cloudflare; a
// direct caller can spoof). A stronger option is to simulateTransaction each bundle at enqueue and reject
// non-simulating ones (no fee), deferred. Mirrors the M5 enroll limiter shape.
const QUEUE_RL_WINDOW_MS = 10 * 60_000;
const QUEUE_RL_MAX = Math.max(1, Number(process.env.DR_BATCH_RL_MAX || 30));
const QUEUE_RL_MAX_IPS = 10_000;
const queueHits = new Map<string, number[]>();
function queueRateLimited(ip: string, nowMs: number): boolean {
  if (queueHits.size > QUEUE_RL_MAX_IPS) {
    for (const [k, ts] of queueHits) {
      const live = ts.filter((t) => nowMs - t < QUEUE_RL_WINDOW_MS);
      if (live.length === 0) queueHits.delete(k);
      else queueHits.set(k, live);
    }
    if (queueHits.size > QUEUE_RL_MAX_IPS) {
      let toEvict = queueHits.size - QUEUE_RL_MAX_IPS;
      for (const k of queueHits.keys()) { if (toEvict-- <= 0) break; queueHits.delete(k); }
    }
  }
  const hits = (queueHits.get(ip) ?? []).filter((t) => nowMs - t < QUEUE_RL_WINDOW_MS);
  hits.push(nowMs);
  queueHits.set(ip, hits);
  return hits.length > QUEUE_RL_MAX;
}

// M7 — flush the batch queue NOW: shuffle every queued bundle and submit each request_access in shuffled order
// through the single relay account (serial seq numbers => the on-chain grant index order is the shuffled
// order). Guarded so two flushes never overlap. Wired to a fixed epoch-aligned timer in startBatchFlusher().
let batchFlushing = false;
async function runBatchFlush(reason: string): Promise<{ flushed: number; submitted: number; failed: number; order: string[] } | null> {
  if (batchFlushing) return null;
  if (!DATAROOM_ID) return null;
  if (listBatchQueued().length === 0) return { flushed: 0, submitted: 0, failed: 0, order: [] };
  batchFlushing = true;
  try {
    const summary = await flushBatch({ submit: (b) => submitOneAccess(b), now: Date.now() });
    if (summary.flushed > 0) {
      console.log(`[dr-batch] flush (${reason}): ${summary.submitted} submitted, ${summary.failed} failed of ${summary.flushed} shuffled`);
    }
    purgeBatchTerminal(DR_BATCH_PURGE_MS, Date.now()); // keep the store file bounded
    return summary;
  } finally {
    batchFlushing = false;
  }
}

// M7 — queue an anonymous access for batched, shuffled on-chain submission (the timing defense). The member
// has already proven membership (the self-authenticating bundle) and hands it here instead of submitting it
// themselves; the relay flushes it at the next fixed window boundary. The relay learns nothing it could
// deanonymize with: the journal carries only per-room pseudonyms (accessor/nullifier), never the wallet.
// Idempotent on (room, nullifier) while queued. Body: { seal, image_id, journal, roomId, accessor, nullifier }.
app.post("/dataroom/membership/queue-access", (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, accessorHex: string, nullifierHex: string;
  let bundle: QueuedBundle;
  try {
    const b = req.body as Partial<Bundle> & { roomId?: string; accessor?: string; nullifier?: string };
    if (!b?.seal || !b?.image_id || !b?.journal) throw new Error("seal, image_id, journal (raw hex) required");
    if (!/^[0-9a-fA-F]+$/.test(b.seal) || !/^[0-9a-fA-F]+$/.test(b.image_id) || !/^[0-9a-fA-F]+$/.test(b.journal)) {
      throw new Error("seal, image_id, journal must be hex");
    }
    bundle = { seal: b.seal, image_id: b.image_id, journal: b.journal };
    // Cheap pre-filter: a membership bundle MUST carry the pinned membership image_id (the contract checks it
    // too, but rejecting the wrong circuit here keeps obvious junk out of the relay queue). Not a full verify —
    // the chain does that at flush — just a guard against a junk-bundle spray amplifying through the batch.
    if (bundle.image_id.toLowerCase() !== MEMBERSHIP_IMAGE_ID.toLowerCase()) {
      throw new Error("bundle image_id is not the pinned membership image");
    }
    roomIdHex = toBytes32(b.roomId);
    accessorHex = toHex(hex32(b.accessor, "accessor"));
    nullifierHex = toHex(hex32(b.nullifier, "nullifier"));
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const now = Date.now();
    // Cap the queue (a full queue is the amplification backstop) + throttle per IP. Idempotent re-queues of an
    // already-queued (room, nullifier) are still allowed (they do not grow the queue or count against the IP),
    // so a member can re-poll/re-submit their own access freely.
    const existing = findQueuedBatch(roomIdHex, nullifierHex);
    if (!existing) {
      if (queueRateLimited(clientIp(req), now)) {
        return res.status(429).json({ error: "too many queued accesses; please try again shortly" });
      }
      if (batchQueuedCount() >= DR_BATCH_MAX_QUEUE) {
        return res.status(429).json({ error: "the batch queue is full; please try again shortly" });
      }
    }
    const entry = enqueueBatch({ roomId: roomIdHex, accessor: accessorHex, nullifier: nullifierHex, bundle, now, windowMs: DR_BATCH_WINDOW_MS });
    res.json({
      ok: true,
      ticket: entry.ticket,
      status: entry.status,
      flushAt: entry.flushAt,
      nextFlushAt: nextFlushAt(now, DR_BATCH_WINDOW_MS),
      windowMs: DR_BATCH_WINDOW_MS,
      queued: listBatchQueued().length,
      note: "your access is batched: it lands on-chain at the next window boundary, shuffled with the others in that window. Poll /dataroom/membership/queue-status/<ticket>, then open once it is submitted.",
    });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// M7 — poll a queued access by its (unlinkable) ticket. Reports queued | submitted (txHash) | error.
app.get("/dataroom/membership/queue-status/:ticket", (req, res) => {
  const ticket = String(req.params.ticket || "");
  if (!/^[0-9a-f]{32}$/.test(ticket)) return res.status(400).json({ error: "ticket must be 32 hex chars" });
  const entry = getBatchTicket(ticket);
  if (!entry) return res.status(404).json({ error: "no such ticket" });
  // Deliberately does NOT echo the accessor/room (a leaked ticket should not disclose the pseudonym it queues);
  // the member already knows their own access. Status + the window ETA + the landed tx is all the poll needs.
  res.json({
    ticket: entry.ticket,
    status: entry.status,
    flushAt: entry.flushAt,
    nextFlushAt: nextFlushAt(Date.now(), DR_BATCH_WINDOW_MS),
    windowMs: DR_BATCH_WINDOW_MS,
    txHash: entry.txHash ?? null,
    error: entry.error ?? null,
  });
});

// M7 — force a flush NOW (test/e2e only; OFF unless DR_BATCH_ALLOW_MANUAL_FLUSH=1). The production path is the
// fixed-interval timer; this exists so the e2e can demonstrate the shuffled batch landing without waiting a
// full window. Never enabled in production (a forced flush only submits already-proven, already-queued
// bundles, so the worst a caller could do is collapse the window early, but we gate it anyway).
app.post("/dataroom/membership/flush-now", async (_req, res) => {
  if (process.env.DR_BATCH_ALLOW_MANUAL_FLUSH !== "1") return res.status(403).json({ error: "manual flush disabled" });
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const summary = await runBatchFlush("manual");
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/dataroom/membership/is-granted/:roomId/:accessor", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const accessorHex = toHex(hex32(req.params.accessor, "accessor"));
    const { value } = await readContract(DATAROOM_ID, "is_granted", [scBytes(roomIdHex), scBytes(accessorHex)]);
    res.json({ roomId: roomIdHex, accessor: accessorHex, isGranted: Boolean(value) });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

app.get("/dataroom/membership/nullifier/:roomId/:nullifier", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const nullifierHex = toHex(hex32(req.params.nullifier, "nullifier"));
    const { value } = await readContract(DATAROOM_ID, "is_nullifier_used", [scBytes(roomIdHex), scBytes(nullifierHex)]);
    res.json({ roomId: roomIdHex, nullifier: nullifierHex, used: Boolean(value) });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

app.get("/dataroom/membership/grant/:roomId/:accessor", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const accessorHex = toHex(hex32(req.params.accessor, "accessor"));
    const { value } = await readContract(DATAROOM_ID, "get_grant", [scBytes(roomIdHex), scBytes(accessorHex)]);
    res.json({ roomId: roomIdHex, accessor: accessorHex, grant: value ? jsonSafe(value) : null });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// M7 — the room's append-only grant log (PUBLIC on-chain data: every grant's index, accessor pseudonym, and
// ledger timestamp). This is what shows the timing defense working: accesses recorded in one flush window land
// clustered in time and shuffled in order, so the grant log reveals the window, not who acted when. Read-only,
// no wallet. Optional `limit` (default 24, max 100) returns the most RECENT grants (highest indices). Nothing
// here deanonymizes anyone: the accessor + nullifier + timestamp are already on-chain by design.
app.get("/dataroom/membership/grants/:roomId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string;
  try {
    roomIdHex = toBytes32(req.params.roomId);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 24) || 24));
  try {
    const { value: countVal } = await readContract(DATAROOM_ID, "get_grant_count", [scBytes(roomIdHex)]);
    const count = Number(countVal ?? 0);
    const start = Math.max(0, count - limit);
    const idxs = Array.from({ length: count - start }, (_, k) => start + k);
    const grants = (
      await Promise.all(
        idxs.map(async (index) => {
          const { value } = await readContract(DATAROOM_ID, "get_grant_by_index", [scBytes(roomIdHex), scU32(index)]);
          if (!value) return null;
          const g = jsonSafe(value) as Record<string, unknown>;
          return {
            index: Number(g.index ?? index),
            accessor: String(g.accessor ?? ""),
            nullifier: String(g.nullifier ?? ""),
            eligibleRoot: String(g.eligible_root ?? ""),
            ledger: Number(g.ledger ?? 0),
            timestamp: Number(g.timestamp ?? 0),
          };
        }),
      )
    ).filter((x): x is NonNullable<typeof x> => x !== null);
    res.json({ roomId: roomIdHex, count, grants, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// ═══════════════════════════ DR3 — threshold-ECIES committee (key release) ═══════════════════════════
//   GET  /dataroom/committee/info                              -> keypers + threshold + live health
//   POST /dataroom/committee/seal-doc {roomId,docId,content}   -> DEALER: split K to keypers + anchor doc
//   GET  /dataroom/committee/document/:roomId/:docId           -> on-chain committee doc (content_hash,k_commitment,pointer)
//   POST /dataroom/committee/collect/:roomId/:docId {accessor} -> collect SEALED shares (no secret; for the SDK opener)
//   POST /dataroom/committee/open/:roomId/:docId {accessor}    -> DEMO opener (server-side reconstruct + decrypt)

/** Collect sealed shares from every keyper for a (room,doc,accessor). Each keyper independently gates on the
 *  on-chain grant; a non-granted accessor yields zero shares. Never throws on a single keyper being down. */
async function collectSealedShares(
  roomIdHex: string,
  docIdHex: string,
  accessorHex: string,
): Promise<{ shares: SealedShare[]; recipientPub: string; errors: string[] }> {
  const shares: SealedShare[] = [];
  const recipients = new Set<string>();
  const errors: string[] = [];
  await Promise.all(
    KEYPER_ENDPOINTS.map(async (ep) => {
      try {
        const r = await fetch(`${ep}/share`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ room_id: roomIdHex, doc_id: docIdHex, accessor: accessorHex }),
        });
        const j = (await r.json().catch(() => ({}))) as Record<string, string>;
        if (!r.ok) {
          errors.push(`${ep}: ${j.error || r.status}`);
          return;
        }
        shares.push({ keyperIndex: Number(j.keyper_index), ephPub: fromHex(j.eph_pub), ct: fromHex(j.ct), tag: fromHex(j.tag) });
        recipients.add(j.recipient_pub);
      } catch (e) {
        errors.push(`${ep}: ${err(e)}`);
      }
    }),
  );
  if (recipients.size > 1) throw new Error(`keypers disagree on recipient_pub: ${[...recipients].join(",")}`);
  return { shares, recipientPub: [...recipients][0] || "", errors };
}

app.get("/dataroom/committee/info", async (_req, res) => {
  const keypers = await Promise.all(
    KEYPER_ENDPOINTS.map(async (ep) => {
      try {
        const r = await fetch(`${ep}/health`, { signal: AbortSignal.timeout(4000) });
        const h = (await r.json()) as Record<string, unknown>;
        return { endpoint: ep, ok: h.ok === true, keyperIndex: h.keyper_index, shares: h.shares, rpc: h.rpc, sealPub: h.seal_pub };
      } catch (e) {
        return { endpoint: ep, ok: false, error: err(e) };
      }
    }),
  );
  res.json({
    threshold: COMMITTEE_THRESHOLD,
    n: KEYPER_ENDPOINTS.length,
    online: keypers.filter((k) => k.ok).length,
    keypers,
    dataroomId: DATAROOM_ID,
    note: "the document key K is Shamir-split across the keypers; >= threshold sealed shares reconstruct it; no single keyper holds K",
  });
});

// DEALER: encrypt the doc (fresh K), upload the ciphertext, Shamir-split K, distribute one share per keyper
// (bearer-token /deal), DELETE K, then anchor the committee document on-chain (content_hash + sha256(K) +
// pointer). After this returns, no single party holds K — only the keyper committee, t-of-n.
app.post("/dataroom/committee/seal-doc", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  if (!ADMIN_ADDRESS) return res.status(503).json({ error: "ADMIN_ADDRESS not configured" });
  const n = KEYPER_ENDPOINTS.length;
  let roomIdHex: string, docIdHex: string, plaintext: Uint8Array;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    docIdHex = toBytes32(req.body?.docId, { random: true });
    const { content, contentB64 } = req.body ?? {};
    if (typeof contentB64 === "string" && contentB64) plaintext = new Uint8Array(Buffer.from(contentB64, "base64"));
    else if (typeof content === "string" && content) plaintext = new TextEncoder().encode(content);
    else throw new Error("content or contentB64 required");
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    // 0) fast-fail if the room doesn't exist — anchoring reverts RoomNotFound anyway, so don't burn a blob
    //    upload + strand shares on the keypers (mirrors the DR1 prove-seal room check).
    const { value: roomRaw } = await readContract(DATAROOM_ID, "get_room", [scBytes(roomIdHex)]);
    if (!roomRaw) return res.status(404).json({ error: "room not found — create it before sealing a committee doc", roomId: roomIdHex });

    // 1) fresh K → AES-256-GCM blob → upload (content-addressed) → commitments.
    const k = randomKey();
    const blob = aeadSeal(plaintext, k);
    const { contentHash, blobPointer: pointer } = await getBlobStore().put(blob);
    const kCommitment = toHex(sha256(k));

    // 2) Shamir-split K and distribute one share per keyper (bearer-gated /deal). Abort the anchor if any
    //    keyper rejects the deal (the encrypted blob is harmless without K, which we drop). allSettled so a
    //    network throw on one keyper doesn't lose the per-keyper status of the others.
    const shares = shamirSplit(k, COMMITTEE_THRESHOLD, n); // x = 1..n
    const settled = await Promise.allSettled(
      shares.map(async (sh, i) => {
        const ep = KEYPER_ENDPOINTS[i];
        const r = await fetch(`${ep}/deal`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${KEYPER_DEAL_TOKEN}` },
          body: JSON.stringify({ room_id: roomIdHex, doc_id: docIdHex, keyper_index: sh.x, share_y: toHex(sh.y) }),
          signal: AbortSignal.timeout(8000),
        });
        return { ep, idx: sh.x, ok: r.ok, status: r.status };
      }),
    );
    // K goes out of scope here — the dealer no longer holds it (trusted-dealer-at-split caveat documented).
    const dealResults = settled.map((s, i) =>
      s.status === "fulfilled" ? s.value : { ep: KEYPER_ENDPOINTS[i], idx: shares[i].x, ok: false, status: 0, error: String((s.reason as Error)?.message ?? s.reason) },
    );
    const failed = dealResults.filter((d) => !d.ok);
    if (failed.length > 0) {
      // We do NOT anchor → the doc is never readable, so any shares that DID land are inert (an unanchored
      // doc returns null from get_committee_document, and < t honest shares reveal nothing). Log for the
      // operator to reconcile; a retry with the same (room,doc) re-deals a fresh K, overwriting the orphans.
      const dealt = dealResults.filter((d) => d.ok).map((d) => d.idx);
      if (dealt.length > 0) console.warn(`[committee] partial deal for ${roomIdHex.slice(0, 8)}…/${docIdHex.slice(0, 8)}…: shares dealt to keypers [${dealt.join(",")}] are orphaned (doc NOT anchored, K dropped) — retry to overwrite`);
      return res.status(502).json({ error: "share distribution failed — document NOT anchored", failed: failed.map((f) => ({ ep: f.ep, keyper: f.idx, status: f.status })) });
    }

    // 3) anchor the committee document on-chain (room owner = admin).
    const out = await invokeContract(DATAROOM_ID, "put_committee_document", [
      scBytes(roomIdHex), scBytes(docIdHex), scBytes(contentHash), scBytes(kCommitment), scBytesUtf8(pointer),
    ]);
    res.json({
      ok: true,
      roomId: roomIdHex,
      docId: docIdHex,
      contentHash,
      kCommitment,
      blobPointer: pointer,
      dealt: dealResults.length,
      threshold: COMMITTEE_THRESHOLD,
      txHash: out.hash,
      cost: out.cost,
      note: "K was split across the keypers and dropped by the dealer; reconstruct needs >= threshold shares released to a granted recipient",
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// ---- M2: BROWSER DEALER relay (Model B, Option B) ----
// The OWNER's browser is the dealer: it generates K, AES-encrypts the document, Shamir-splits K, ECIES-seals
// each share to a keeper's static seal key, and seals an owner-escrow copy. This relay only ever sees the
// CIPHERTEXT and the SEALED shares — never K or the plaintext. It stores the blob, forwards each sealed share
// to its keeper, and stashes the escrow copy. The owner then anchors put_committee_document (next endpoint).
app.post("/dataroom/committee/deal-sealed", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  const n = KEYPER_ENDPOINTS.length;
  let roomIdHex: string, docIdHex: string, blob: Uint8Array, kCommitmentHex: string;
  let sealedShares: Array<Record<string, unknown>>;
  let escrow: Record<string, unknown> | undefined;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    docIdHex = toBytes32(req.body?.docId); // browser-chosen (binds the share + escrow tags)
    kCommitmentHex = toHex(hex32(req.body?.kCommitment, "kCommitment"));
    const b64 = req.body?.blobB64;
    if (typeof b64 !== "string" || !b64) throw new Error("blobB64 (ciphertext) required");
    blob = new Uint8Array(Buffer.from(b64, "base64"));
    const ss = req.body?.sealedShares;
    if (!Array.isArray(ss) || ss.length !== n) throw new Error(`sealedShares must have ${n} entries`);
    sealedShares = ss as Array<Record<string, unknown>>;
    // Each keeper index 1..n must appear exactly once; otherwise a malformed client could deal two shares to
    // one keeper (overwriting) and leave the document unreadable (< t keepers hold a share).
    const idxs = sealedShares.map((s) => Number(s.keyperIndex));
    if (new Set(idxs).size !== n || idxs.some((i) => !Number.isInteger(i) || i < 1 || i > n)) {
      throw new Error(`sealedShares must cover keeper indices 1..${n} exactly once`);
    }
    escrow = req.body?.escrow && typeof req.body.escrow === "object" ? (req.body.escrow as Record<string, unknown>) : undefined;
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const { value: roomRaw } = await readContract(DATAROOM_ID, "get_room", [scBytes(roomIdHex)]);
    if (!roomRaw) return res.status(404).json({ error: "room not found — create it first", roomId: roomIdHex });
    // Refuse dealing to an already-anchored (room, doc): the doc_id is public on-chain once anchored, so a
    // re-deal of garbage shares would overwrite the keepers' shares and make the real document unreadable
    // (a targeted DoS). Shares are immutable once anchored; pre-anchor retries (doc_id still secret) are fine.
    const { value: existingDoc } = await readContract(DATAROOM_ID, "get_committee_document", [scBytes(roomIdHex), scBytes(docIdHex)]);
    if (existingDoc) return res.status(409).json({ error: "a committee document already exists for this (room, doc); re-dealing would overwrite its shares", roomId: roomIdHex, docId: docIdHex });

    // Persist the (already-encrypted) blob; content-addressed → contentHash + pointer.
    const { contentHash, blobPointer } = await getBlobStore().put(blob);

    // Forward each SEALED share to its keeper's /deal (bearer-gated). The relay never holds K or a raw share.
    const settled = await Promise.allSettled(
      sealedShares.map(async (sh) => {
        const idx = Number(sh.keyperIndex);
        if (!(idx >= 1 && idx <= n)) throw new Error(`bad keyperIndex ${idx}`);
        const ep = KEYPER_ENDPOINTS[idx - 1];
        const r = await fetch(`${ep}/deal`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${KEYPER_DEAL_TOKEN}` },
          body: JSON.stringify({ room_id: roomIdHex, doc_id: docIdHex, keyper_index: idx, sealed: { eph_pub: sh.eph_pub, ct: sh.ct, tag: sh.tag } }),
          signal: AbortSignal.timeout(8000),
        });
        return { idx, ok: r.ok, status: r.status };
      }),
    );
    const results = settled.map((s, i) =>
      s.status === "fulfilled" ? s.value : { idx: i + 1, ok: false, status: 0, error: String((s.reason as Error)?.message ?? s.reason) },
    );
    const failed = results.filter((d) => !d.ok);
    if (failed.length > 0) {
      return res.status(502).json({ error: "sealed-share distribution failed — document NOT dealt (anchor not attempted)", failed });
    }

    // Stash the owner-escrow copy (sealed to the owner's own key) so the owner can reopen without the keepers.
    if (escrow) {
      try {
        putEscrow(roomIdHex, docIdHex, {
          ephPub: toHex(hex32(escrow.ephPub, "escrow.ephPub")),
          ct: toHex(hex32(escrow.ct, "escrow.ct")),
          tag: toHex(hex32(escrow.tag, "escrow.tag")),
          contentHash,
          roomId: roomIdHex,
          docId: docIdHex,
          recipientPub: toHex(hex32(escrow.recipientPub, "escrow.recipientPub")),
        });
      } catch (e) {
        return res.status(400).json({ error: `bad escrow copy: ${err(e)}` });
      }
    }

    res.json({
      ok: true,
      roomId: roomIdHex,
      docId: docIdHex,
      contentHash,
      blobPointer,
      kCommitment: kCommitmentHex,
      dealt: results.length,
      threshold: COMMITTEE_THRESHOLD,
      note: "K never reached the server; now anchor via POST /dataroom/committee/anchor (owner signs put_committee_document)",
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Anchor a (browser-dealt) committee document on-chain. The room OWNER signs put_committee_document via the
// wallet XDR path (membership-only needs no set_doc_policy: is_doc_admitted falls back to bare membership).
app.post("/dataroom/committee/anchor", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, docIdHex: string, contentHashHex: string, kCommitmentHex: string, blobPointer: string;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    docIdHex = toBytes32(req.body?.docId);
    contentHashHex = toHex(hex32(req.body?.contentHash, "contentHash"));
    kCommitmentHex = toHex(hex32(req.body?.kCommitment, "kCommitment"));
    blobPointer = String(req.body?.blobPointer ?? "");
    if (!blobPointer) throw new Error("blobPointer required");
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  const args = [scBytes(roomIdHex), scBytes(docIdHex), scBytes(contentHashHex), scBytes(kCommitmentHex), scBytesUtf8(blobPointer)];
  const idField = { roomId: roomIdHex, docId: docIdHex, contentHash: contentHashHex, kCommitment: kCommitmentHex };
  try {
    if (userSource(req)) {
      if (await maybeXdr(req, res, DATAROOM_ID, "put_committee_document", args, idField)) return;
    }
    const out = await invokeContract(DATAROOM_ID, "put_committee_document", args);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, ...idField });
  } catch (e) {
    res.json({ ok: false, error: err(e), roomId: roomIdHex, docId: docIdHex });
  }
});

// The owner-escrow copy for a document (sealed to the owner's key). The owner opens it client-side with their
// sign-to-derive secret (recoverDocumentKey) to reopen the document without the keeper committee.
app.get("/dataroom/committee/escrow/:roomId/:docId", (req, res) => {
  let roomIdHex: string, docIdHex: string;
  try {
    roomIdHex = toBytes32(req.params.roomId);
    docIdHex = toBytes32(req.params.docId);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  res.json({ roomId: roomIdHex, docId: docIdHex, escrow: getEscrow(roomIdHex, docIdHex) });
});

app.get("/dataroom/committee/document/:roomId/:docId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const docIdHex = toBytes32(req.params.docId);
    const { value } = await readContract(DATAROOM_ID, "get_committee_document", [scBytes(roomIdHex), scBytes(docIdHex)]);
    res.json({ roomId: roomIdHex, docId: docIdHex, document: value ? dataroomDocView(value) : null, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Collect the SEALED shares for a granted accessor (no secret involved). The SDK/frontend opens these in the
// browser with the recipient x25519 secret — this route never sees a key. A non-granted accessor → 403.
app.post("/dataroom/committee/collect/:roomId/:docId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, docIdHex: string, accessorHex: string;
  try {
    roomIdHex = toBytes32(req.params.roomId);
    docIdHex = toBytes32(req.params.docId);
    accessorHex = toHex(hex32(req.body?.accessor, "accessor"));
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  // Model B anonymity floor (k): the Model B reader passes minAnonSet so this aggregator does NOT release the
  // key in a room too small to be anonymous, even if the accessor was granted earlier (a room can shrink after
  // a grant). Legacy callers OMIT minAnonSet and are unaffected; a present-but-malformed value is an error
  // (fail closed). SCOPE: this is enforced here (the relay aggregator the app uses) and on prove-access, NOT at
  // the keypers themselves (they gate only on is_doc_admitted and are size-unaware, since the member count is
  // off-chain). So the floor protects the accessing member's own anonymity on the sanctioned path; it is a
  // service-level guardrail, not a non-bypassable on-chain invariant.
  if (req.body?.minAnonSet !== undefined) {
    const minAnonSet = Number(req.body.minAnonSet);
    if (!Number.isInteger(minAnonSet) || minAnonSet <= 0) {
      return res.status(400).json({ error: "minAnonSet must be a positive integer" });
    }
    const n = getEligible(roomIdHex).length;
    if (n < minAnonSet) {
      return res.status(403).json({ error: `anonymity set too small: ${n} of ${minAnonSet} members`, anonSetSize: n, minAnonSet });
    }
  }
  try {
    const { shares, recipientPub, errors } = await collectSealedShares(roomIdHex, docIdHex, accessorHex);
    if (shares.length < COMMITTEE_THRESHOLD) {
      return res.status(403).json({ error: "fewer than threshold shares released (accessor not granted, or keypers down)", collected: shares.length, threshold: COMMITTEE_THRESHOLD, errors });
    }
    res.json({
      roomId: roomIdHex,
      docId: docIdHex,
      accessor: accessorHex,
      recipientPub,
      threshold: COMMITTEE_THRESHOLD,
      shares: shares.map((s) => ({ keyperIndex: s.keyperIndex, ephPub: toHex(s.ephPub), ct: toHex(s.ct), tag: toHex(s.tag) })),
      errors,
    });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// DEMO server-side opener (the trust-minimized KEY-FREE path is the SDK's committee opener — Ch4). Collects
// sealed shares, ECIES-opens each with the recipient secret, reconstructs K (commitment-gated, robust to 1
// bad share), fetches the blob, and AES-GCM-decrypts. Uses the demo recipient secret unless one is supplied.
app.post("/dataroom/committee/open/:roomId/:docId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, docIdHex: string, accessorHex: string, recipientSecret: Uint8Array;
  try {
    roomIdHex = toBytes32(req.params.roomId);
    docIdHex = toBytes32(req.params.docId);
    accessorHex = toHex(hex32(req.body?.accessor, "accessor"));
    recipientSecret = resolveRecipientSecret(req.body?.recipientKey);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    // on-chain committee doc → content_hash + k_commitment.
    const { value: docRaw } = await readContract(DATAROOM_ID, "get_committee_document", [scBytes(roomIdHex), scBytes(docIdHex)]);
    if (!docRaw) return res.status(404).json({ error: "committee document not found" });
    const d = docRaw as { content_hash: Uint8Array; k_commitment: Uint8Array };
    const contentHash = toHex(new Uint8Array(d.content_hash));
    const kCommitment = new Uint8Array(d.k_commitment);

    // the AUTHORITATIVE recipient_pub is from the on-chain DR2 grant (proof-bound) — read it ourselves, not
    // from the share aggregator (defense-in-depth: a wrong reported key can only yield a failed open).
    const { value: grantRaw } = await readContract(DATAROOM_ID, "get_grant", [scBytes(roomIdHex), scBytes(accessorHex)]);
    const grantRecipient = grantRaw ? toHex(new Uint8Array((grantRaw as { recipient_pub: Uint8Array }).recipient_pub)) : "";

    // collect sealed shares (gated on the live grant by each keyper).
    const { shares, errors } = await collectSealedShares(roomIdHex, docIdHex, accessorHex);
    if (shares.length < COMMITTEE_THRESHOLD || !grantRecipient) {
      return res.status(403).json({ error: "fewer than threshold shares released (accessor not granted, or keypers down)", collected: shares.length, threshold: COMMITTEE_THRESHOLD, errors });
    }

    // open each share, keep the faithful ones, reconstruct K (commitment-gated), then AES-GCM-decrypt.
    const recipientPubBytes = fromHex(grantRecipient);
    const opened = shares
      .map((s) => shareEciesOpen(s, recipientSecret, fromHex(roomIdHex), fromHex(docIdHex), recipientPubBytes))
      .filter((o) => o.faithful)
      .map((o) => ({ keyperIndex: o.keyperIndex, shareY: o.shareY }));
    if (opened.length < COMMITTEE_THRESHOLD) {
      return res.json({ ok: false, faithful: false, reason: "fewer than threshold shares opened faithfully (wrong recipient key?)", opened: opened.length, threshold: COMMITTEE_THRESHOLD, roomId: roomIdHex, docId: docIdHex });
    }
    const { k, pair } = reconstructWithCommitment(opened, kCommitment);
    const blob = await getBlobStore().get(contentHash);
    if (!blob) return res.status(502).json({ error: "blob not found for content_hash", contentHash });
    if (toHex(sha256(blob)) !== contentHash) return res.status(502).json({ error: "stored blob hash mismatch", contentHash });
    const plaintext = aeadOpen(blob, k);
    res.json({
      ok: true,
      faithful: true,
      roomId: roomIdHex,
      docId: docIdHex,
      accessor: accessorHex,
      reconstructedFromPair: pair,
      contentHash,
      content: Buffer.from(plaintext).toString("utf8"),
      contentB64: Buffer.from(plaintext).toString("base64"),
      dataroomId: DATAROOM_ID,
      note: "reconstructed K from >= threshold committee shares (commitment-verified) and AES-GCM-decrypted",
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// ═══════════════════════════ DR4 — document-authenticity (zkPDF: third-party truth) ═══════════════════════════
//   GET  /dataroom/docauth/info                                  -> contract + image + mock-bank issuer + allowlist
//   POST /dataroom/docauth/allowlist-issuer                      -> set_docauth_issuer(bank key hash, true) [admin]
//   POST /dataroom/docauth/prove-fact  {roomId,value,threshold}  -> mock-bank signs a statement → enqueue worker-first
//   POST /dataroom/docauth/attest      {seal,image_id,journal}   -> attest_document_fact → DocumentFact (owner=admin)
//   GET  /dataroom/docauth/fact/:roomId/:msgDigest               -> the proven fact (value>=threshold), if any
//   GET  /dataroom/docauth/facts/:roomId                         -> enumerate a room's facts
// The mock bank is the THIRD PARTY: it RSA-signs a private statement; the guest re-verifies that signature
// in-zkVM and proves value>=threshold WITHOUT revealing the statement. A self-minted key is rejected on-chain.

app.get("/dataroom/docauth/info", async (_req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const issuer = bankIssuer();
    const { value: onchainImage } = await readContract(DATAROOM_ID, "get_docauth_image_id");
    const { value: allowed } = await readContract(DATAROOM_ID, "is_docauth_issuer_allowed", [
      scBytes(issuer.issuerKeyHash),
    ]);
    res.json({
      dataroomId: DATAROOM_ID,
      docauthImageId: DOCAUTH_IMAGE_ID,
      docauthImageOnchain: onchainImage ? toHex(new Uint8Array(onchainImage as Uint8Array)) : null,
      claimType: 10,
      issuerKeyHash: issuer.issuerKeyHash,
      issuerAllowlisted: Boolean(allowed),
      note: "attest_document_fact(seal,image_id,journal): verifies a real RSA-2048 third-party signature in-zkVM + value>=threshold, bound to a room/document; the statement/account/exact value stay private.",
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// One-time setup: allowlist the mock-bank issuer key on-chain (admin/deployer signs). In production this
// pins a real bank/authority's public key; only facts signed by an allowlisted issuer are accepted.
app.post("/dataroom/docauth/allowlist-issuer", async (_req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const issuer = bankIssuer();
    const out = await invokeContract(DATAROOM_ID, "set_docauth_issuer", [
      scBytes(issuer.issuerKeyHash),
      scBool(true),
    ]);
    res.json({ ok: true, txHash: out.hash, issuerKeyHash: issuer.issuerKeyHash, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), dataroomId: DATAROOM_ID });
  }
});

// The mock bank signs a fixed-layout statement attesting `value`; we enqueue a worker-first proof of
// `value >= threshold`. The PRIVATE statement reaches only the self-hosted prover (which already sees
// plaintext per the project rule); confidentiality is vs the on-chain verifier + public, not the prover.
app.post("/dataroom/docauth/prove-fact", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, value: bigint, threshold: bigint;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    value = BigInt(req.body?.value ?? 0);
    threshold = BigInt(req.body?.threshold ?? 0);
    if (value < 0n || threshold < 0n) throw new Error("value/threshold must be non-negative");
    if (value < threshold) throw new Error("value < threshold: the proof would not be producible");
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const built = buildDocauthJob({ roomIdHex, value, threshold });
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(built.job),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    res.json({
      jobId: j.job_id,
      roomId: roomIdHex,
      threshold: threshold.toString(),
      msgDigest: built.msgDigest,
      issuerKeyHash: built.issuerKeyHash,
      note: "poll /prove-status/<jobId>; on done, POST /dataroom/docauth/attest {seal,image_id,journal}. ~22 segments → multi-minute proof (pre-prove for the demo).",
    });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// Submit a docauth proof to the contract: attest_document_fact (the room owner — the demo admin — signs).
app.post("/dataroom/docauth/attest", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  const b = req.body as Bundle;
  if (!b?.seal || !b?.image_id || !b?.journal) {
    return res.status(400).json({ error: "seal, image_id, journal (raw) required" });
  }
  try {
    const out = await invokeContract(DATAROOM_ID, "attest_document_fact", [
      scBytes(b.seal),
      scBytes(b.image_id),
      scBytes(b.journal),
    ]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, fact: jsonSafe(out.returnValue), dataroomId: DATAROOM_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), dataroomId: DATAROOM_ID });
  }
});

app.get("/dataroom/docauth/fact/:roomId/:msgDigest", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const msgDigestHex = toHex(hex32(req.params.msgDigest, "msgDigest"));
    const { value } = await readContract(DATAROOM_ID, "get_document_fact", [
      scBytes(roomIdHex),
      scBytes(msgDigestHex),
    ]);
    res.json({ roomId: roomIdHex, msgDigest: msgDigestHex, fact: value ? jsonSafe(value) : null });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

app.get("/dataroom/docauth/facts/:roomId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const { value: countRaw } = await readContract(DATAROOM_ID, "get_doc_fact_count", [scBytes(roomIdHex)]);
    const count = Number(countRaw ?? 0);
    const facts: unknown[] = [];
    for (let i = 0; i < count; i++) {
      const { value } = await readContract(DATAROOM_ID, "get_doc_fact_by_index", [scBytes(roomIdHex), scU32(i)]);
      if (value) facts.push(jsonSafe(value));
    }
    res.json({ roomId: roomIdHex, count, facts });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// ===========================================================================================
// DR5 — faithful disclosure / auditor redacted view + data-side teaser. NO new guest: the teaser reuses
// the generic value>=threshold guest (reserves kind, claim_type 11, vouched by the allowlisted data-room
// appraiser attester); the auditor redacted view reuses the seal guest (dataroom_seal kind) sealing a
// REDACTED blob's key to the auditor's x25519 key (integrity-faithful: content_hash + faithful tag).
//   GET  /dataroom/teaser/info
//   POST /dataroom/teaser/prove   {roomId, docId, figure?, fieldTag?, threshold}  -> appraiser sign + enqueue (reserves)
//   POST /dataroom/teaser/attest  {seal,image_id,journal, roomId, docId}          -> attest_teaser
//   GET  /dataroom/teaser/:roomId/:docId                                          -> the proven teaser, if any
//   GET  /dataroom/teasers/:roomId                                                -> enumerate a room's teasers
//   POST /dataroom/disclose/prove {roomId, docId?, auditorPub?, doc?, policy?}    -> redact + seal to auditor (dataroom_seal)
//   POST /dataroom/disclose/open/:roomId/:docId {viewKey?}                        -> auditor opener (redacted view + log)
// ===========================================================================================

app.get("/dataroom/teaser/info", async (_req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const appraiser = toHex(teaserAttesterPubkey());
    const [imgRes, allowRes] = await Promise.all([
      readContract(DATAROOM_ID, "get_teaser_image_id"),
      readContract(DATAROOM_ID, "is_teaser_attester_allowed", [scBytes(appraiser)]),
    ]);
    res.json({
      dataroomId: DATAROOM_ID,
      verifierId: VERIFIER_ID,
      teaserImageId: TEASER_IMAGE_ID,
      teaserImageOnchain: imgRes.value ? toHex(new Uint8Array(imgRes.value as Uint8Array)) : null,
      claimType: 11,
      appraiserAttester: appraiser,
      appraiserAllowed: !!allowRes.value,
      auditorPub: toHex(auditorPublicKey()),
      demoDocPublicView: publicView(DEMO_FINANCIAL_DOC, DEMO_FINANCIAL_POLICY),
      teaserField: DEMO_TEASER_FIELD,
      note: "Teaser = a public ZK fact (sealed doc's figure >= X) vouched by the allowlisted appraiser, doc unseen. Auditor redacted view = a field-level disclosure policy (public/auditor/private; PCI/HIPAA/GDPR masking) sealed to the auditor's key, integrity-faithful.",
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Appraiser signs a teaser envelope (claim_type 11, value = the PRIVATE figure, nonce = fieldTag) and the
// generic value>=threshold guest proves `figure >= threshold` worker-first. The figure stays private; only
// the boolean + the public threshold are revealed. The referenced doc MUST already be anchored (attest_teaser
// binds the teaser to the doc's on-chain content_hash).
app.post("/dataroom/teaser/prove", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, docIdHex: string, figure: bigint, threshold: bigint, fieldTag: number;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    docIdHex = toBytes32(req.body?.docId);
    figure = req.body?.figure != null
      ? BigInt(req.body.figure)
      : teaserFigure(DEMO_FINANCIAL_DOC, DEMO_FINANCIAL_POLICY, DEMO_TEASER_FIELD);
    threshold = BigInt(req.body?.threshold ?? 1_000_000);
    fieldTag = Number(req.body?.fieldTag ?? FIELD_TAG_REVENUE);
    if (figure < 0n || threshold < 0n) throw new Error("figure/threshold must be non-negative");
    if (!Number.isInteger(fieldTag) || fieldTag < 0 || fieldTag > 0xffffffff) throw new Error("fieldTag must be a u32");
    if (figure < threshold) throw new Error("figure < threshold: the proof would not be producible");
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  // Fail fast: the referenced document must exist (attest_teaser requires it → binds the teaser to its hash).
  try {
    const { value: doc } = await readContract(DATAROOM_ID, "get_document", [scBytes(roomIdHex), scBytes(docIdHex)]);
    if (!doc) return res.status(404).json({ error: "document not found — anchor it first (put_document)", roomId: roomIdHex, docId: docIdHex });
  } catch (e) {
    return res.status(502).json({ error: err(e) });
  }
  try {
    const a = attestTeaser({ figure, fieldTag });
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "reserves",
        envelope_hex: a.envelope,
        signature_hex: a.signature,
        issuer_pubkey_hex: a.issuer_pubkey,
        threshold: threshold.toString(),
      }),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    res.json({
      jobId: j.job_id,
      roomId: roomIdHex,
      docId: docIdHex,
      threshold: threshold.toString(),
      fieldTag,
      appraiser: a.issuer_pubkey,
      note: "poll /prove-status/<jobId>; on done, POST /dataroom/teaser/attest {seal,image_id,journal,roomId,docId}. The figure stays PRIVATE.",
    });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// Submit a teaser proof to the contract: attest_teaser (the room owner — the demo admin — signs). room_id and
// doc_id are call args (the generic journal carries neither); the contract binds the teaser to the doc's hash.
app.post("/dataroom/teaser/attest", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  const b = req.body as Bundle & { roomId?: string; docId?: string };
  if (!b?.seal || !b?.image_id || !b?.journal) {
    return res.status(400).json({ error: "seal, image_id, journal (raw) required" });
  }
  let roomIdHex: string, docIdHex: string;
  try {
    roomIdHex = toBytes32(b.roomId);
    docIdHex = toBytes32(b.docId);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const out = await invokeContract(DATAROOM_ID, "attest_teaser", [
      scBytes(b.seal),
      scBytes(b.image_id),
      scBytes(b.journal),
      scBytes(roomIdHex),
      scBytes(docIdHex),
    ]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, teaser: jsonSafe(out.returnValue), dataroomId: DATAROOM_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), dataroomId: DATAROOM_ID });
  }
});

app.get("/dataroom/teaser/:roomId/:docId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, docIdHex: string;
  try { roomIdHex = toBytes32(req.params.roomId); docIdHex = toBytes32(req.params.docId); }
  catch (e) { return res.status(400).json({ error: err(e) }); }
  try {
    const [tRes, validRes] = await Promise.all([
      readContract(DATAROOM_ID, "get_teaser", [scBytes(roomIdHex), scBytes(docIdHex)]),
      readContract(DATAROOM_ID, "is_teaser_valid", [scBytes(roomIdHex), scBytes(docIdHex)]),
    ]);
    res.json({ roomId: roomIdHex, docId: docIdHex, teaser: tRes.value ? jsonSafe(tRes.value) : null, valid: !!validRes.value, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/dataroom/teasers/:roomId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string;
  try { roomIdHex = toBytes32(req.params.roomId); } catch (e) { return res.status(400).json({ error: err(e) }); }
  try {
    const { value: countRaw } = await readContract(DATAROOM_ID, "get_teaser_count", [scBytes(roomIdHex)]);
    const count = Number(countRaw ?? 0);
    const idxs: number[] = [];
    for (let i = 0; i < count; i++) idxs.push(i);
    const rows = await Promise.all(idxs.map((i) => readContract(DATAROOM_ID, "get_teaser_by_index", [scBytes(roomIdHex), scU32(i)])));
    const teasers = rows.map((r) => r.value).filter(Boolean).map((t) => jsonSafe(t));
    res.json({ roomId: roomIdHex, count, teasers, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Redact the document per the field-level disclosure policy → seal the REDACTED blob's key to the auditor's
// x25519 key (dataroom_seal guest), worker-first. The auditor receives the redacted view INTEGRITY-FAITHFULLY
// (content_hash + faithful tag = the exact bytes the owner committed). The redacted view is its OWN document
// (a fresh doc_id); anchor it via the existing POST /dataroom/submit-document, then open via /disclose/open.
app.post("/dataroom/disclose/prove", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, docIdHex: string, auditorPubHex: string;
  let blobPlain: Uint8Array, log: ReturnType<typeof redact>["log"], pub: StructuredDoc;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    docIdHex = toBytes32(req.body?.docId, { random: true }); // the redacted view is its OWN document
    auditorPubHex = toX25519PubHex(req.body?.auditorPub, () => toHex(auditorPublicKey()));
    const doc: StructuredDoc =
      req.body?.doc && typeof req.body.doc === "object" && !Array.isArray(req.body.doc) ? req.body.doc : DEMO_FINANCIAL_DOC;
    const policy: DisclosurePolicy =
      req.body?.policy && typeof req.body.policy === "object" && !Array.isArray(req.body.policy) ? req.body.policy : DEMO_FINANCIAL_POLICY;
    const redacted = redact(doc, policy);
    log = redacted.log;
    pub = publicView(doc, policy);
    const disclosure = {
      kind: "zkorage-dr5-redacted-disclosure",
      generated_for: "auditor",
      policy_basis: "field-level disclosure policy (HIPAA Safe Harbor / PCI-DSS Req 3.4 / GDPR Art.5(1)(c) / FOIA §552(b))",
      document: redacted.view,
      redaction_log: redacted.log,
    };
    blobPlain = new TextEncoder().encode(JSON.stringify(disclosure));
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  // Fail fast: the room must exist (put_document later requires the room owner's auth).
  try {
    const { value: room } = await readContract(DATAROOM_ID, "get_room", [scBytes(roomIdHex)]);
    if (!room) return res.status(404).json({ error: "room not found — create it first", roomId: roomIdHex });
  } catch (e) {
    return res.status(502).json({ error: err(e) });
  }
  try {
    const k = randomKey();
    const blob = aeadSeal(blobPlain, k);
    const contentHash = toHex(sha256(blob));
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "dataroom_seal",
        doc_key_hex: toHex(k),
        recipient_pubkey_hex: auditorPubHex,
        content_hash_hex: contentHash,
        room_id_hex: roomIdHex,
        doc_id_hex: docIdHex,
      }),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    const put = await getBlobStore().put(blob);
    res.json({
      jobId: j.job_id,
      roomId: roomIdHex,
      docId: docIdHex,
      auditorPub: auditorPubHex,
      contentHash: put.contentHash,
      blobPointer: put.blobPointer,
      storage: getBlobStore().backend,
      publicView: pub,
      redactionLog: log,
      note: "poll /prove-status/<jobId>; on done, POST /dataroom/submit-document {seal,image_id,journal,blobPointer}. The auditor opens the redacted view via POST /dataroom/disclose/open (or the key-free SDK openDocument).",
    });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// AUDITOR OPENER (DEMO convenience — the trust-minimized KEY-FREE path is the SDK's openDocument). Reads the
// on-chain Document (the redacted view sealed to the auditor), recovers K with the auditor's view secret,
// verifies the faithful tag, fetches the blob by content_hash, AES-256-GCM-decrypts → the redacted disclosure
// JSON (document + redaction log). Defaults to the demo auditor secret when `viewKey` is omitted.
app.post("/dataroom/disclose/open/:roomId/:docId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, docIdHex: string, viewSecret: Uint8Array;
  try {
    roomIdHex = toBytes32(req.params.roomId);
    docIdHex = toBytes32(req.params.docId);
    const s = String(req.body?.viewKey ?? "").trim();
    if (!s) viewSecret = auditorViewSecret();
    else {
      const h = s.replace(/^0x/i, "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("viewKey must be 32-byte hex");
      viewSecret = fromHex(h);
    }
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const { value: docRaw } = await readContract(DATAROOM_ID, "get_document", [scBytes(roomIdHex), scBytes(docIdHex)]);
    if (!docRaw) return res.status(404).json({ error: "document not found", roomId: roomIdHex, docId: docIdHex });
    const d = docRaw as { recipient_pub: Uint8Array; content_hash: Uint8Array; eph_pub: Uint8Array; ct: Uint8Array; tag: Uint8Array; room_id: Uint8Array; doc_id: Uint8Array };
    const contentHash = new Uint8Array(d.content_hash);
    const opened = dataroomEciesOpen(
      new Uint8Array(d.eph_pub), new Uint8Array(d.ct), new Uint8Array(d.tag),
      contentHash, new Uint8Array(d.room_id), new Uint8Array(d.doc_id), viewSecret,
    );
    if (!opened.faithful) {
      return res.json({ roomId: roomIdHex, docId: docIdHex, faithful: false, recipientPub: toHex(new Uint8Array(d.recipient_pub)), contentHash: toHex(contentHash), dataroomId: DATAROOM_ID });
    }
    const blob = await getBlobStore().get(toHex(contentHash));
    if (!blob) return res.status(404).json({ error: "blob not found for content_hash", contentHash: toHex(contentHash) });
    if (toHex(sha256(blob)) !== toHex(contentHash)) return res.status(502).json({ error: "fetched blob hash mismatch", contentHash: toHex(contentHash) });
    const plaintext = aeadOpen(blob, opened.k);
    const utf8 = safe(() => new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) ?? null;
    const disclosure = utf8 ? safe(() => JSON.parse(utf8)) : undefined;
    res.json({
      roomId: roomIdHex,
      docId: docIdHex,
      faithful: true,
      contentHashVerified: true,
      recipientPub: toHex(new Uint8Array(d.recipient_pub)),
      contentHash: toHex(contentHash),
      disclosure: disclosure ?? null,
      plaintextUtf8: disclosure ? undefined : utf8,
      dataroomId: DATAROOM_ID,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// ═══════════════════════════ DR6 — private-policy composition + revocation/rotation ═══════════════════════════
//   GET  /dataroom/admission/info
//   POST /dataroom/policy/set {roomId, requireMembership?, complianceGate?, accreditedGate?}   (room-owner=admin)
//   GET  /dataroom/policy/:roomId
//   POST /dataroom/admission/request {roomId, accessor}            -> request_room_admission (composite AND)
//   GET  /dataroom/admission/is-admitted/:roomId/:accessor         -> live composed AND
//   GET  /dataroom/admission/:roomId/:accessor                     -> get_admission (audit record)
//   GET  /dataroom/admissions/:roomId?start&limit                  -> list admissions
//   POST /dataroom/revoke {roomId, accessor, revoked?}             (room-owner=admin; default revoked=true)
//   GET  /dataroom/revoked/:roomId/:accessor                       -> is_access_revoked
//   POST /dataroom/committee/rotate-doc {roomId, docId, content}   -> re-split K' + re-encrypt + rotate
//   GET  /dataroom/committee/key-epoch/:roomId/:docId              -> get_committee_key_epoch

// A DR6 gate-policy arg: `true`/omitted -> use the configured gate (ON, the default); `false`/null -> OFF;
// a C-address string -> that gate explicitly.
function parseGateArg(input: unknown, defaultId: string, legName?: string): string | null {
  if (input === false || input === null) return null;
  if (input === true || input === undefined) {
    // requested ON (or defaulting ON) but the gate id is unconfigured → leg is silently OFF. Warn loudly so a
    // misconfigured backend doesn't quietly set a weaker policy than the operator intends (it stays fail-closed).
    if (!defaultId) console.warn(`[dr6] policy leg "${legName ?? "gate"}" requested ON but no gate id is configured — leg left OFF`);
    return defaultId || null;
  }
  if (typeof input === "string") {
    const g = input.trim();
    if (g === "") return null;
    // Validate the Soroban contract-address shape up front so a malformed gate fails with 400 at the boundary
    // (rather than a later 200 {ok:false} from the invoke). C-address = 'C' + 55 base32 chars.
    if (!/^C[A-Z2-7]{55}$/.test(g)) throw new Error(`invalid gate address "${g}" (expected a C… contract address)`);
    return g;
  }
  return null;
}

app.get("/dataroom/admission/info", async (_req, res) => {
  res.json({
    dataroomId: DATAROOM_ID || null,
    complianceGate: COMPLIANCE_ID || null,
    accreditedGate: ACCREDITED_ID || null,
    composition: "membership (DR2 anonymous eligibility) ∧ compliance.is_granted ∧ accredited.is_granted — AND'd on-chain",
    note: "Each leg is an independent ZK proof bound to ONE pseudonymous accessor; the AND is the on-chain cross-call (W8 pattern). Anonymous: subject_id absent in every leg; the membership leg hides which member.",
  });
});

app.post("/dataroom/policy/set", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, requireMembership: boolean, complianceGate: string | null, accreditedGate: string | null;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    requireMembership = req.body?.requireMembership !== false; // default true (the anonymity spine)
    complianceGate = parseGateArg(req.body?.complianceGate, COMPLIANCE_ID, "compliance");
    accreditedGate = parseGateArg(req.body?.accreditedGate, ACCREDITED_ID, "accredited");
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const out = await invokeContract(DATAROOM_ID, "set_room_policy", [
      scBytes(roomIdHex), scBool(requireMembership), scOptAddress(complianceGate), scOptAddress(accreditedGate),
    ]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, roomId: roomIdHex, requireMembership, complianceGate, accreditedGate, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), dataroomId: DATAROOM_ID });
  }
});

app.get("/dataroom/policy/:roomId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const { value } = await readContract(DATAROOM_ID, "get_room_policy", [scBytes(roomIdHex)]);
    res.json({ roomId: roomIdHex, policy: value ? jsonSafe(value) : null, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// ── Pattern 2: PER-DOCUMENT access policy (prove-a-policy self-serve committee-key release) ──
// The owner attaches a policy to a committee document; a reader who proves it (anonymously) gets the doc key
// released by the keypers (which gate on is_doc_admitted). set_doc_policy is a room-owner op, relay-signed
// like set_room_policy (the demo rooms are deployer-owned). The committee doc must already exist. A reader
// discovers the policy with GET /dataroom/doc-policy/:room/:doc and checks their live admission (the exact
// keyper share-release gate) with GET /dataroom/doc-admitted/:room/:doc/:accessor.
app.post("/dataroom/doc-policy/set", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, docIdHex: string, requireMembership: boolean, complianceGate: string | null, accreditedGate: string | null;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    docIdHex = toBytes32(req.body?.docId);
    requireMembership = req.body?.requireMembership !== false; // default true (key release needs a recipient_pub)
    complianceGate = parseGateArg(req.body?.complianceGate, COMPLIANCE_ID, "compliance");
    accreditedGate = parseGateArg(req.body?.accreditedGate, ACCREDITED_ID, "accredited");
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  // A committee document's key is ECIES-sealed to the proof-bound recipient_pub carried by the DR2 membership
  // grant, so a key-release policy MUST require membership: a gate-only policy would admit a reader who then
  // has no recipient_pub for the keepers to seal to (admittable but un-openable). Enforce it here (the
  // contract permits gate-only policies for generality; the demo's key-release path requires membership).
  if (!requireMembership) {
    return res.status(400).json({ error: "a document policy must require membership (the key is sealed to the member's proof-bound recipient key)" });
  }
  try {
    const out = await invokeContract(DATAROOM_ID, "set_doc_policy", [
      scBytes(roomIdHex), scBytes(docIdHex), scBool(requireMembership), scOptAddress(complianceGate), scOptAddress(accreditedGate),
    ]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, roomId: roomIdHex, docId: docIdHex, requireMembership, complianceGate, accreditedGate, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), roomId: roomIdHex, docId: docIdHex, dataroomId: DATAROOM_ID });
  }
});

app.get("/dataroom/doc-policy/:roomId/:docId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const docIdHex = toBytes32(req.params.docId);
    const { value } = await readContract(DATAROOM_ID, "get_doc_policy", [scBytes(roomIdHex), scBytes(docIdHex)]);
    res.json({ roomId: roomIdHex, docId: docIdHex, policy: value ? jsonSafe(value) : null, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

app.get("/dataroom/doc-admitted/:roomId/:docId/:accessor", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const docIdHex = toBytes32(req.params.docId);
    const accessorHex = accessorToHex(req.params.accessor);
    const { value } = await readContract(DATAROOM_ID, "is_doc_admitted", [scBytes(roomIdHex), scBytes(docIdHex), scBytes(accessorHex)]);
    res.json({ roomId: roomIdHex, docId: docIdHex, accessor: accessorHex, isDocAdmitted: Boolean(value) });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Submit the composite-policy admission (PERMISSIONLESS — each leg was already gated on a verified proof;
// the membership leg's NEW-5 holder sig carries the accessor's consent). Admit, or a specific leg error
// (#21 RoomPolicyNotSet / #22 MembershipRequired / #23 NotCompliant / #24 NotAccredited / #25 AccessRevoked).
app.post("/dataroom/admission/request", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, accessorHex: string;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    accessorHex = accessorToHex(req.body?.accessor);
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const out = await invokeContract(DATAROOM_ID, "request_room_admission", [scBytes(roomIdHex), scBytes(accessorHex)]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, admission: jsonSafe(out.returnValue), roomId: roomIdHex, accessor: accessorHex, dataroomId: DATAROOM_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), roomId: roomIdHex, accessor: accessorHex, dataroomId: DATAROOM_ID });
  }
});

app.get("/dataroom/admission/is-admitted/:roomId/:accessor", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const accessorHex = accessorToHex(req.params.accessor);
    const { value } = await readContract(DATAROOM_ID, "is_admitted", [scBytes(roomIdHex), scBytes(accessorHex)]);
    res.json({ roomId: roomIdHex, accessor: accessorHex, isAdmitted: Boolean(value) });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

app.get("/dataroom/admission/:roomId/:accessor", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const accessorHex = accessorToHex(req.params.accessor);
    const { value } = await readContract(DATAROOM_ID, "get_admission", [scBytes(roomIdHex), scBytes(accessorHex)]);
    res.json({ roomId: roomIdHex, accessor: accessorHex, admission: value ? jsonSafe(value) : null });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

app.get("/dataroom/admissions/:roomId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const { value: cntRaw } = await readContract(DATAROOM_ID, "get_admission_count", [scBytes(roomIdHex)]);
    const count = Number(cntRaw ?? 0);
    const start = Math.max(0, Number(req.query.start ?? 0) | 0);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 50) | 0));
    const idxs = [];
    for (let i = start; i < Math.min(count, start + limit); i++) idxs.push(i);
    const rows = await Promise.all(
      idxs.map(async (i) => {
        const { value } = await readContract(DATAROOM_ID, "get_admission_by_index", [scBytes(roomIdHex), scU32(i)]);
        return value ? jsonSafe(value) : null;
      }),
    );
    res.json({ roomId: roomIdHex, count, admissions: rows.filter(Boolean) });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Surgically revoke (or restore) an accessor in a room (room-owner = admin signs). Revoking makes is_granted
// false at once -> the DR3 keypers refuse shares, is_admitted drops. The member can't re-enter (nullifier spent).
app.post("/dataroom/revoke", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  let roomIdHex: string, accessorHex: string, revoked: boolean;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    accessorHex = accessorToHex(req.body?.accessor);
    revoked = req.body?.revoked !== false; // default true
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const out = await invokeContract(DATAROOM_ID, "revoke_access", [scBytes(roomIdHex), scBytes(accessorHex), scBool(revoked)]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, roomId: roomIdHex, accessor: accessorHex, revoked });
  } catch (e) {
    res.json({ ok: false, error: err(e), roomId: roomIdHex, accessor: accessorHex });
  }
});

app.get("/dataroom/revoked/:roomId/:accessor", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const accessorHex = accessorToHex(req.params.accessor);
    const { value } = await readContract(DATAROOM_ID, "is_access_revoked", [scBytes(roomIdHex), scBytes(accessorHex)]);
    res.json({ roomId: roomIdHex, accessor: accessorHex, revoked: Boolean(value) });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// DR6 committee KEY ROTATION: re-split a FRESH K' to the keypers, re-encrypt the blob under K', and
// rotate the on-chain record (+bump key_epoch). Honest members re-collect new shares (grant still valid)
// and decrypt with K'; a revoked member's is_granted is false so keypers refuse, and the old K is useless
// against the re-encrypted blob. Mirrors /committee/seal-doc but UPDATES an existing committee doc.
app.post("/dataroom/committee/rotate-doc", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  const n = KEYPER_ENDPOINTS.length;
  let roomIdHex: string, docIdHex: string, plaintext: Uint8Array;
  try {
    roomIdHex = toBytes32(req.body?.roomId);
    docIdHex = toBytes32(req.body?.docId); // required (rotation targets an existing doc)
    const { content, contentB64 } = req.body ?? {};
    if (typeof contentB64 === "string" && contentB64) plaintext = new Uint8Array(Buffer.from(contentB64, "base64"));
    else if (typeof content === "string" && content) plaintext = new TextEncoder().encode(content);
    else throw new Error("content or contentB64 required");
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    // 0) the committee doc must already exist (else rotate_committee_document reverts CommitteeDocNotFound).
    const { value: existing } = await readContract(DATAROOM_ID, "get_committee_document", [scBytes(roomIdHex), scBytes(docIdHex)]);
    if (!existing) return res.status(404).json({ error: "committee doc not found — seal it first (POST /dataroom/committee/seal-doc)", roomId: roomIdHex, docId: docIdHex });

    // 1) fresh K' → AES-256-GCM blob → upload → commitments.
    const k = randomKey();
    const blob = aeadSeal(plaintext, k);
    const { contentHash, blobPointer: pointer } = await getBlobStore().put(blob);
    const kCommitment = toHex(sha256(k));

    // 2) re-split K' and re-deal one share per keyper (overwrites their stored share for this (room,doc)).
    const shares = shamirSplit(k, COMMITTEE_THRESHOLD, n);
    const settled = await Promise.allSettled(
      shares.map(async (sh, i) => {
        const ep = KEYPER_ENDPOINTS[i];
        const r = await fetch(`${ep}/deal`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${KEYPER_DEAL_TOKEN}` },
          body: JSON.stringify({ room_id: roomIdHex, doc_id: docIdHex, keyper_index: sh.x, share_y: toHex(sh.y) }),
          signal: AbortSignal.timeout(8000),
        });
        return { ep, idx: sh.x, ok: r.ok, status: r.status };
      }),
    );
    const dealResults = settled.map((s, i) =>
      s.status === "fulfilled" ? s.value : { ep: KEYPER_ENDPOINTS[i], idx: shares[i].x, ok: false, status: 0, error: String((s.reason as Error)?.message ?? s.reason) },
    );
    const failed = dealResults.filter((d) => !d.ok);
    if (failed.length > 0) {
      // Do NOT rotate on-chain if re-deal failed — on-chain stays consistent (old blob ↔ old commitment, no
      // rotate). CAVEAT: /deal overwrites in place, so a PARTIAL re-deal can leave keypers holding a mix of
      // old-K and new-K′ shares; until a FULL successful re-deal, recovery may be degraded (< threshold
      // mutually-consistent shares). Retrying rotate-doc with a clean re-deal restores a consistent set.
      const dealt = dealResults.filter((d) => d.ok).map((d) => d.idx);
      if (dealt.length > 0) console.warn(`[committee] partial RE-deal ${roomIdHex.slice(0, 8)}…/${docIdHex.slice(0, 8)}…: keypers [${dealt.join(",")}] took the new share; recovery may be degraded until a full retry (doc NOT rotated on-chain)`);
      return res.status(502).json({ error: "share re-distribution failed — document NOT rotated on-chain; retry to restore a consistent share set", failed: failed.map((f) => ({ ep: f.ep, keyper: f.idx, status: f.status })) });
    }

    // 3) rotate the committee document on-chain (room owner = admin) + bump key_epoch.
    const out = await invokeContract(DATAROOM_ID, "rotate_committee_document", [
      scBytes(roomIdHex), scBytes(docIdHex), scBytes(contentHash), scBytes(kCommitment), scBytesUtf8(pointer),
    ]);
    const { value: epochRaw } = await readContract(DATAROOM_ID, "get_committee_key_epoch", [scBytes(roomIdHex), scBytes(docIdHex)]);
    res.json({
      ok: true,
      roomId: roomIdHex,
      docId: docIdHex,
      contentHash,
      kCommitment,
      blobPointer: pointer,
      reDealt: dealResults.length,
      keyEpoch: Number(epochRaw ?? 0),
      threshold: COMMITTEE_THRESHOLD,
      txHash: out.hash,
      cost: out.cost,
      note: "K' was re-split + dropped; the old K is useless against the re-encrypted blob. Only granted (non-revoked) accessors get the new shares.",
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.get("/dataroom/committee/key-epoch/:roomId/:docId", async (req, res) => {
  if (!DATAROOM_ID) return res.status(503).json({ error: "DATAROOM_CONTRACT_ID not configured" });
  try {
    const roomIdHex = toBytes32(req.params.roomId);
    const docIdHex = toBytes32(req.params.docId);
    const { value } = await readContract(DATAROOM_ID, "get_committee_key_epoch", [scBytes(roomIdHex), scBytes(docIdHex)]);
    res.json({ roomId: roomIdHex, docId: docIdHex, keyEpoch: Number(value ?? 0) });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Bonded Proofs (BP1/BP2) — Soroban-native time-locked escrow. Reads + dual-path writes (user-signed
// XDR when `source` is present, else the server relay). No ZK here; this is the escrow + "my balances".
// ───────────────────────────────────────────────────────────────────────────────────────────────
const ESCROW_ZERO32 = "0".repeat(64);
// Demo faucet: the relay signer is the bond-token admin, so it can mint test zkUSD to any address. Capped
// + lightly rate-limited so a fresh wallet can try a deposit without an out-of-band mint.
const FAUCET_AMOUNT = process.env.ESCROW_FAUCET_AMOUNT || "10000000000"; // 1000 zkUSD (7 dp)
const faucetSeen = new Map<string, number>();

app.get("/escrow/info", (_req, res) => res.json({ escrowId: ESCROW_ID, bondTokenId: BOND_TOKEN_ID }));

app.get("/escrow/balance", async (req, res) => {
  const owner = String(req.query.owner ?? "");
  if (!StrKey.isValidEd25519PublicKey(owner)) return res.status(400).json({ error: "owner (G-address) required" });
  try {
    const balance = await escrowBondBalance(owner);
    res.json({ owner, balance, bondTokenId: BOND_TOKEN_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.post("/escrow/faucet", async (req, res) => {
  const to = String((req.body as { to?: string })?.to ?? "");
  if (!StrKey.isValidEd25519PublicKey(to)) return res.status(400).json({ error: "to (G-address) required" });
  const now = Date.now();
  if (now - (faucetSeen.get(to) ?? 0) < 60_000) {
    return res.status(429).json({ ok: false, error: "faucet rate-limited; try again in a minute" });
  }
  faucetSeen.set(to, now);
  try {
    const out = await invokeContract(BOND_TOKEN_ID, "mint", [scAddress(to), scI128(FAUCET_AMOUNT)]);
    res.json({ ok: true, txHash: out.hash, minted: FAUCET_AMOUNT, bondTokenId: BOND_TOKEN_ID });
  } catch (e) {
    faucetSeen.delete(to); // a failed mint shouldn't burn the cooldown
    res.json({ ok: false, error: err(e) });
  }
});

app.get("/escrow/lock/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "id must be a positive integer" });
  try {
    const [lock, locked] = await Promise.all([escrowGetLock(id), escrowIsLocked(id)]);
    res.json({ id, lock, is_locked: locked, escrowId: ESCROW_ID });
  } catch (e) {
    res.status(404).json({ error: err(e) });
  }
});

app.get("/escrow/locks", async (req, res) => {
  const owner = String(req.query.owner ?? "");
  if (!StrKey.isValidEd25519PublicKey(owner)) return res.status(400).json({ error: "owner (G-address) required" });
  try {
    const locks = await listLocks(owner);
    res.json({ owner, count: locks.length, locks, escrowId: ESCROW_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

app.post("/escrow/deposit", async (req, res) => {
  const b = req.body as {
    source?: string; from?: string; token?: string; amount?: string | number;
    unlock_time?: number; claimant?: string; commitment?: string; revocable?: boolean;
  };
  const from = b.from || b.source || "";
  const token = b.token || BOND_TOKEN_ID;
  const claimant = b.claimant || from;
  const commitment = String(b.commitment || ESCROW_ZERO32).toLowerCase();
  const amount = String(b.amount ?? "");
  const unlock = Number(b.unlock_time);
  if (!StrKey.isValidEd25519PublicKey(from)) return res.status(400).json({ error: "from/source (G-address) required" });
  if (!StrKey.isValidContract(token)) return res.status(400).json({ error: "token (C-address) invalid" });
  if (!StrKey.isValidEd25519PublicKey(claimant)) return res.status(400).json({ error: "claimant (G-address) invalid" });
  if (!/^[1-9]\d*$/.test(amount)) return res.status(400).json({ error: "amount must be a positive integer (base units)" });
  if (!Number.isInteger(unlock) || unlock <= Math.floor(Date.now() / 1000)) return res.status(400).json({ error: "unlock_time must be a future unix timestamp" });
  if (!/^[0-9a-f]{64}$/.test(commitment)) return res.status(400).json({ error: "commitment must be 32-byte hex" });
  // On the user-signed path the wallet only authorises its own address, so `from` must be the signer —
  // fail fast with a clean 400 rather than a confusing signing error later.
  const src = userSource(req);
  if (src && from !== src) return res.status(400).json({ error: "from must equal the signing source" });
  // A revocable lock must be a self-bond (the contract enforces this too).
  if (b.revocable && claimant !== from) return res.status(400).json({ error: "a revocable lock must be a self-bond (claimant == from)" });
  try {
    const args = [scAddress(from), scAddress(token), scI128(amount), scU64(unlock), scAddress(claimant), scBytes(commitment), scBool(Boolean(b.revocable))];
    if (await maybeXdr(req, res, ESCROW_ID, "deposit", args, { escrowId: ESCROW_ID })) return;
    const out = await invokeContract(ESCROW_ID, "deposit", args);
    // out.returnValue is the new lock_id (u64 -> BigInt); jsonSafe stringifies it so res.json never throws.
    res.json({ ok: true, txHash: out.hash, lockId: jsonSafe(out.returnValue), cost: out.cost, escrowId: ESCROW_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e) });
  }
});

// withdraw / claim / unbond: a single u64 lock_id, user-signed by the rightful party.
for (const method of ["withdraw", "claim", "unbond"] as const) {
  app.post(`/escrow/${method}`, async (req, res) => {
    const id = Number((req.body as { lock_id?: number })?.lock_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "lock_id must be a positive integer" });
    try {
      const args = [scU64(id)];
      if (await maybeXdr(req, res, ESCROW_ID, method, args, { escrowId: ESCROW_ID })) return;
      const out = await invokeContract(ESCROW_ID, method, args);
      res.json({ ok: true, txHash: out.hash, cost: out.cost, escrowId: ESCROW_ID });
    } catch (e) {
      res.json({ ok: false, error: err(e) });
    }
  });
}

app.post("/escrow/set-timelock", async (req, res) => {
  const b = req.body as { lock_id?: number; new_unlock_time?: number };
  const id = Number(b?.lock_id);
  const newUnlock = Number(b?.new_unlock_time);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "lock_id must be a positive integer" });
  if (!Number.isInteger(newUnlock) || newUnlock <= 0) return res.status(400).json({ error: "new_unlock_time must be a unix timestamp" });
  try {
    const args = [scU64(id), scU64(newUnlock)];
    if (await maybeXdr(req, res, ESCROW_ID, "set_timelock", args, { escrowId: ESCROW_ID })) return;
    const out = await invokeContract(ESCROW_ID, "set_timelock", args);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, escrowId: ESCROW_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e) });
  }
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Bonded Proofs (BP3) — a solvency proof that dies when you pull your collateral. A `reserves >= supply`
// Groth16 proof (reserves PRIVATE) is bound to a revocable escrow lock; the gate reads that lock LIVE, so
// `is_granted` flips false the instant the issuer unbonds. prove (worker-first) → poll /prove-status →
// submit (dual-path, lock-owner-signed) → status (live).
// ───────────────────────────────────────────────────────────────────────────────────────────────
app.get("/bonded/solvency/info", async (_req, res) => {
  try {
    res.json({
      solvencyGateId: SOLVENCY_GATE_ID,
      solvencyImageId: SOLVENCY_IMAGE_ID,
      auditorPub: toHex(solvencyAuditorPubkey()),
      escrowId: ESCROW_ID,
      bondTokenId: BOND_TOKEN_ID,
      supplyTokenId: SOLVENCY_SUPPLY_TOKEN_ID,
      claimType: 12,
      config: await getSolvencyConfig().catch(() => null),
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Read the supply token's live supply, bind it as the threshold, attest reserves (>= supply, PRIVATE),
// and enqueue a worker-first proving job that binds the chosen escrow lock. Poll /prove-status/:id.
app.post("/bonded/solvency/prove", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  const b = req.body as { lock_id?: number; min_amount?: string | number; reserves?: string | number; expiry?: number; nonce?: number };
  const lockId = Number(b?.lock_id);
  if (!Number.isInteger(lockId) || lockId <= 0) return res.status(400).json({ error: "lock_id must be a positive integer" });
  try {
    // 1) the lock must be a live, revocable, bond-token lock (else the gate rejects the proof).
    const guard = await guardLock(lockId);
    if (!guard.ok) return res.status(400).json({ error: guard.reason });
    // 2) the proven liability = the supply token's REAL circulating supply.
    const supply = await supplyTokenSupply();
    // 3) min_amount the proof asserts the lock meets (default = the lock's full amount).
    const minAmount = BigInt(String(b.min_amount ?? guard.amount ?? "0"));
    if (minAmount <= 0n) return res.status(400).json({ error: "min_amount must be positive" });
    if (BigInt(guard.amount ?? "0") < minAmount) return res.status(400).json({ error: "lock amount is below the requested min_amount" });
    // 4) reserves (PRIVATE) must clear the supply (default = exactly solvent). reserves < supply => no proof.
    const reserves = BigInt(String(b.reserves ?? supply));
    if (reserves < supply) return res.status(400).json({ error: "reserves below supply — an insolvent claim produces no proof" });
    const a = attestSolvency({ reserves, nonce: BigInt(b.nonce ?? 1), expiry: BigInt(b.expiry ?? 9_999_999_999) });
    const job = buildSolvencyJob({
      envelope_hex: a.envelope,
      signature_hex: a.signature,
      issuer_pubkey_hex: a.issuer_pubkey,
      supply,
      lockId,
      minAmount,
    });
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    res.json({ jobId: j.job_id, supply: supply.toString(), lockId, minAmount: minAmount.toString(), issuerId: a.issuer_pubkey });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Submit the bonded-solvency proof to the gate (verify + supply binding + live lock read + owner auth).
// Dual-path: the lock owner's wallet signs (source present) or the server relays (only valid when the
// lock's depositor == the relay signer). The owner's auth is required by the gate (the ownership binding).
app.post("/bonded/solvency/submit", async (req, res) => {
  const b = req.body as Bundle;
  if (!b?.seal || !b?.image_id || !b?.journal) {
    return res.status(400).json({ error: "seal, image_id, journal (raw hex) required" });
  }
  try {
    const args = [scBytes(b.seal), scBytes(b.image_id), scBytes(b.journal)];
    if (await maybeXdr(req, res, SOLVENCY_GATE_ID, "submit_solvency_proof", args, { solvencyGateId: SOLVENCY_GATE_ID })) return;
    const out = await invokeContract(SOLVENCY_GATE_ID, "submit_solvency_proof", args);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, result: jsonSafe(out.returnValue), solvencyGateId: SOLVENCY_GATE_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), solvencyGateId: SOLVENCY_GATE_ID });
  }
});

// The live self-void read: is the depositor's solvency proof STILL valid (bond still locked)? Re-reads the
// escrow + supply on every call — this is what the UI polls so the badge flips ACTIVE -> VOID on unbond.
app.get("/bonded/solvency/status", async (req, res) => {
  const depositor = String(req.query.depositor ?? "");
  if (!StrKey.isValidEd25519PublicKey(depositor)) return res.status(400).json({ error: "depositor (G-address) required" });
  try {
    const [granted, record] = await Promise.all([isSolvencyGranted(depositor), getSolvencyRecord(depositor)]);
    res.json({ depositor, is_granted: granted, record, solvencyGateId: SOLVENCY_GATE_ID });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Bonded Proofs (BP5) — an anonymous bonded tier / membership expiring at X. A member proves, WITHOUT
// revealing which wallet / which lock / the exact amount, that they are enrolled AND control a qualifying
// non-revocable bonded lock (amount >= threshold, unlock_time >= X), with a per-context nullifier (one
// unlinkable grant per identity per context). Freshness is deadline-encoded (now < X), sound because the
// qualifying locks are non-revocable. The qual_root is published from the escrow's PUBLIC state and is
// publicly recomputable. enroll → set-member-root → (deposit anon lock via /escrow/deposit) → qual-root →
// prove (worker-first) → poll /prove-status → submit → status. The id_secret/id_trapdoor are PRIVATE
// witness; they reach the self-hosted (trusted) prover, never the chain.
// ───────────────────────────────────────────────────────────────────────────────────────────────
const TIER_DEFAULT_CONTEXT = "07".repeat(32); // demo "gold tier" nullifier context (matches host_tier demo)

// Serialize the tier admin-relay writes (set_member_root / set_qual_root). They all sign from the SAME
// relay key, and invokeContract reads the signer's sequence number per call — concurrent provers would
// otherwise fetch the same sequence and one tx would fail txBadSeq. A single-process promise chain is
// enough (this backend is the only writer); each queued write runs after the previous settles.
let tierAdminChain: Promise<unknown> = Promise.resolve();
function withTierAdminLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tierAdminChain.then(fn, fn);
  tierAdminChain = run.catch(() => {});
  return run as Promise<T>;
}

app.get("/bonded/tier/info", async (_req, res) => {
  try {
    const memberCommitments = getEligible(TIER_MEMBER_SET_ID).map((h) => fromHex(h));
    const memberRoot = memberCommitments.length ? toHex(buildEligibleTree(memberCommitments).root) : null;
    res.json({
      tierGateId: TIER_GATE_ID || null,
      tierImageId: TIER_IMAGE_ID,
      claimType: 13,
      treeDepth: 20,
      minAnonSet: TIER_MIN_ANON_SET,
      memberSetId: TIER_MEMBER_SET_ID,
      enrolledCount: memberCommitments.length,
      computedMemberRoot: memberRoot,
      pinnedMemberRoot: TIER_GATE_ID ? await getTierMemberRoot().catch(() => null) : null,
      grantCount: TIER_GATE_ID ? await getTierGrantCount().catch(() => 0) : 0,
      escrowId: ESCROW_ID,
      bondTokenId: BOND_TOKEN_ID,
      qualCommitmentScheme: "sha256(0x03 ‖ id_secret ‖ 'escrow') — store this in the escrow lock's commitment",
      config: TIER_GATE_ID ? await getTierConfig().catch(() => null) : null,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Enroll a member in the tier system. Body: { idCommitment?, mint? }. With `mint` (or no commitment) the
// DEMO backend mints a fresh identity and RETURNS its secrets (id_secret/id_trapdoor/holderSeed) PLUS the
// qual commitment to store in an escrow lock. In production the member generates these client-side.
app.post("/bonded/tier/enroll", (req, res) => {
  try {
    let memberCommitmentHex: string;
    let minted: Record<string, string> | undefined;
    if (req.body?.idCommitment && !req.body?.mint) {
      memberCommitmentHex = toHex(hex32(req.body.idCommitment, "idCommitment"));
    } else {
      const id = freshTierIdentity();
      memberCommitmentHex = toHex(id.memberCommitment);
      minted = {
        idSecret: toHex(id.idSecret),
        idTrapdoor: toHex(id.idTrapdoor),
        holderSeed: toHex(id.holderSeed),
        accessor: toHex(id.accessor),
        qualCommitment: toHex(id.qualCommitment),
        note: "DEMO ONLY — in production the member holds these client-side. Store `qualCommitment` in an escrow lock's commitment field (non-revocable, amount >= threshold, unlock_time >= X).",
      };
    }
    const { index, added, total } = addEligible(TIER_MEMBER_SET_ID, memberCommitmentHex);
    const commitments = getEligible(TIER_MEMBER_SET_ID).map((h) => fromHex(h));
    const { root } = buildEligibleTree(commitments);
    res.json({
      ok: true,
      memberIndex: index,
      added,
      memberCount: total,
      memberCommitment: memberCommitmentHex,
      memberRoot: toHex(root),
      minted,
      note: "call POST /bonded/tier/set-member-root to pin this root on-chain.",
    });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// Pin the enrolled-member root on-chain (set_member_root, admin relay).
app.post("/bonded/tier/set-member-root", async (_req, res) => {
  if (!TIER_GATE_ID) return res.status(503).json({ error: "TIER_GATE_ID not configured" });
  try {
    const commitments = getEligible(TIER_MEMBER_SET_ID).map((h) => fromHex(h));
    if (commitments.length === 0) return res.status(400).json({ error: "no members enrolled" });
    const { root } = buildEligibleTree(commitments);
    const rootHex = toHex(root);
    const out = await withTierAdminLock(() => invokeContract(TIER_GATE_ID, "set_member_root", [scBytes(rootHex)]));
    res.json({ ok: true, txHash: out.hash, cost: out.cost, memberRoot: rootHex, memberCount: commitments.length });
  } catch (e) {
    res.json({ ok: false, error: err(e) });
  }
});

// The live qualifying set for a tier (anonymity-set size + the gate's accepted-root ring). Used by the UI
// to surface the anon-set-size warning before proving.
app.get("/bonded/tier/qual-set", async (req, res) => {
  try {
    const threshold = BigInt(String(req.query.threshold ?? "0"));
    const unlockAfter = Number(req.query.unlock_after ?? 0);
    if (threshold <= 0n) return res.status(400).json({ error: "threshold (positive integer) required" });
    if (!Number.isInteger(unlockAfter) || unlockAfter <= 0) return res.status(400).json({ error: "unlock_after (unix timestamp) required" });
    const qual = await buildQualSet(threshold, unlockAfter);
    const ring = TIER_GATE_ID ? await getTierQualRing(threshold, unlockAfter).catch(() => [] as string[]) : [];
    res.json({
      threshold: threshold.toString(),
      unlockAfter,
      anonSetSize: qual.size,
      minAnonSet: TIER_MIN_ANON_SET,
      belowMin: qual.size < TIER_MIN_ANON_SET,
      computedRoot: qual.root,
      published: ring.includes(qual.root),
      ringLen: ring.length,
      locks: qual.locks,
    });
  } catch (e) {
    res.status(500).json({ error: err(e) });
  }
});

// Rebuild the current qualifying root from the escrow's public state and publish it on-chain (set_qual_root,
// admin relay). Idempotent (no-op if it is already the gate's head root).
app.post("/bonded/tier/qual-root", async (req, res) => {
  if (!TIER_GATE_ID) return res.status(503).json({ error: "TIER_GATE_ID not configured" });
  try {
    const threshold = BigInt(String(req.body?.threshold ?? "0"));
    const unlockAfter = Number(req.body?.unlock_after);
    if (threshold <= 0n) return res.status(400).json({ error: "threshold (positive integer) required" });
    if (!Number.isInteger(unlockAfter) || unlockAfter <= 0) return res.status(400).json({ error: "unlock_after (unix timestamp) required" });
    const qual = await buildQualSet(threshold, unlockAfter);
    // Refuse to publish a root below the minimum anonymity-set size. The gate accepts ANY root in its ring,
    // so publishing a sub-N root would let a size-1 (de-anonymizing) grant through. By never publishing one,
    // the minimum is enforced one layer above the (count-blind) gate. This is the on-chain-adjacent half of
    // the defense in depth (the backend prove path already refuses below N via buildTierJob).
    if (qual.size < TIER_MIN_ANON_SET) {
      return res.status(400).json({
        error: `qualifying set too small (${qual.size} < ${TIER_MIN_ANON_SET}); publishing it would weaken anonymity`,
        anonSetSize: qual.size,
        minAnonSet: TIER_MIN_ANON_SET,
      });
    }
    const out = await withTierAdminLock(() => invokeContract(TIER_GATE_ID, "set_qual_root", [scU64(threshold), scU64(unlockAfter), scBytes(qual.root)]));
    res.json({ ok: true, txHash: out.hash, cost: out.cost, threshold: threshold.toString(), unlockAfter, qualRoot: qual.root, anonSetSize: qual.size });
  } catch (e) {
    res.json({ ok: false, error: err(e) });
  }
});

// Build the tier witness (enrolled-member path + live qualifying-lock path) + the NEW-5 holder signature,
// then enqueue the tier proof (kind=tier) worker-first. Auto-ensures the member root + qual root are pinned
// on-chain so the later submit passes. Enforces the minimum anonymity-set size. Poll /prove-status/:id.
app.post("/bonded/tier/prove", async (req, res) => {
  if (!PROVER_URL) return res.status(503).json({ error: "PROVER_URL not configured" });
  if (!TIER_GATE_ID) return res.status(503).json({ error: "TIER_GATE_ID not configured" });
  let idSecret: Uint8Array, idTrapdoor: Uint8Array, holderSeed: Uint8Array, contextHex: string, threshold: bigint, unlockAfter: number;
  try {
    idSecret = hex32(req.body?.idSecret, "idSecret");
    idTrapdoor = hex32(req.body?.idTrapdoor, "idTrapdoor");
    holderSeed = hex32(req.body?.holderSeed, "holderSeed");
    contextHex = req.body?.context ? toBytes32(req.body.context) : TIER_DEFAULT_CONTEXT;
    threshold = BigInt(String(req.body?.threshold ?? "0"));
    unlockAfter = Number(req.body?.unlock_after);
    if (threshold <= 0n) throw new Error("threshold (positive integer) required");
    if (!Number.isInteger(unlockAfter) || unlockAfter <= 0) throw new Error("unlock_after (unix timestamp) required");
  } catch (e) {
    return res.status(400).json({ error: err(e) });
  }
  try {
    const memberCommitmentHex = toHex(idCommitment(idSecret, idTrapdoor));
    const memberIndex = indexOfCommitment(TIER_MEMBER_SET_ID, memberCommitmentHex);
    if (memberIndex < 0) return res.status(400).json({ error: "not enrolled — call /bonded/tier/enroll first", memberCommitment: memberCommitmentHex });
    const memberCommitments = getEligible(TIER_MEMBER_SET_ID).map((h) => fromHex(h));
    const built = await buildTierJob({
      idSecret, idTrapdoor, holderSeed, context: fromHex(contextHex), threshold, unlockAfter, memberCommitments, memberIndex,
    });
    // Auto-ensure the on-chain bindings match (idempotent + serialized): member root pinned + qual root in
    // the ring. Both roots are computed by the backend (the member root from its own eligible-store, the
    // qual root from the live escrow scan) — never caller-controlled — so a caller can only force a re-pin of
    // the HONEST current roots, not inject a forged one. buildTierJob already refused below the min anon set,
    // so the published qual root here always reflects a set >= TIER_MIN_ANON_SET. Writes go through the admin
    // lock so concurrent provers don't collide on the relay key's sequence number.
    const pinnedMember = await getTierMemberRoot().catch(() => null);
    if (pinnedMember !== built.memberRoot) {
      await withTierAdminLock(() => invokeContract(TIER_GATE_ID, "set_member_root", [scBytes(built.memberRoot)]));
    }
    const ring = await getTierQualRing(threshold, unlockAfter).catch(() => [] as string[]);
    if (!ring.includes(built.qualRoot)) {
      await withTierAdminLock(() => invokeContract(TIER_GATE_ID, "set_qual_root", [scU64(threshold), scU64(unlockAfter), scBytes(built.qualRoot)]));
    }
    const r = await fetch(`${PROVER_URL}/prove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(built.job),
    });
    const j = (await r.json()) as { job_id?: string; error?: string };
    if (!r.ok || !j.job_id) return res.status(502).json({ error: j.error || "prover submit failed" });
    res.json({
      jobId: j.job_id,
      memberRoot: built.memberRoot,
      qualRoot: built.qualRoot,
      nullifier: built.nullifier,
      accessor: built.accessor,
      context: contextHex,
      threshold: threshold.toString(),
      unlockAfter,
      anonSetSize: built.qualSize,
      note: "poll /prove-status/<jobId>; on done, POST /bonded/tier/submit {seal,image_id,journal}",
    });
  } catch (e) {
    res.status(502).json({ error: err(e) });
  }
});

// Submit a tier proof to the gate: submit_tier_proof (PERMISSIONLESS — the in-guest NEW-5 holder sig carries
// the accessor's consent; the server is just the relayer/fee-payer). Grant or #NullifierUsed.
app.post("/bonded/tier/submit", async (req, res) => {
  if (!TIER_GATE_ID) return res.status(503).json({ error: "TIER_GATE_ID not configured" });
  const b = req.body as Bundle;
  if (!b?.seal || !b?.image_id || !b?.journal) {
    return res.status(400).json({ error: "seal, image_id, journal (raw hex) required" });
  }
  // Shape pre-check (defense in depth — the gate re-validates everything on-chain, but fail fast with a
  // clear message rather than a contract revert): hex fields, the 181-byte journal, the pinned tier image.
  const isHex = (s: string) => /^[0-9a-fA-F]*$/.test(s) && s.length % 2 === 0;
  if (!isHex(b.seal) || !isHex(b.image_id) || !isHex(b.journal)) {
    return res.status(400).json({ error: "seal/image_id/journal must be raw hex" });
  }
  if (b.journal.length !== 362) {
    return res.status(400).json({ error: "journal must be the 181-byte tier journal (362 hex chars)" });
  }
  if (b.image_id.toLowerCase() !== TIER_IMAGE_ID.toLowerCase()) {
    return res.status(400).json({ error: "image_id is not the pinned tier guest image" });
  }
  try {
    const out = await invokeContract(TIER_GATE_ID, "submit_tier_proof", [scBytes(b.seal), scBytes(b.image_id), scBytes(b.journal)]);
    res.json({ ok: true, txHash: out.hash, cost: out.cost, grant: jsonSafe(out.returnValue), tierGateId: TIER_GATE_ID });
  } catch (e) {
    res.json({ ok: false, error: err(e), tierGateId: TIER_GATE_ID });
  }
});

// The live tier decision for an accessor (is_granted = grant exists AND now < X). Plus the raw grant.
app.get("/bonded/tier/status", async (req, res) => {
  if (!TIER_GATE_ID) return res.status(503).json({ error: "TIER_GATE_ID not configured" });
  try {
    const accessorHex = toHex(hex32(req.query.accessor, "accessor"));
    const [granted, grant] = await Promise.all([isTierGranted(accessorHex), getTierGrant(accessorHex)]);
    res.json({ accessor: accessorHex, is_granted: granted, grant, tierGateId: TIER_GATE_ID });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

app.get("/bonded/tier/nullifier/:nullifier", async (req, res) => {
  if (!TIER_GATE_ID) return res.status(503).json({ error: "TIER_GATE_ID not configured" });
  try {
    const nullifierHex = toHex(hex32(req.params.nullifier, "nullifier"));
    const used = await isTierNullifierUsed(nullifierHex);
    res.json({ nullifier: nullifierHex, used, tierGateId: TIER_GATE_ID });
  } catch (e) {
    res.status(400).json({ error: err(e) });
  }
});

// M7 — the fixed-interval batch flusher. Flushes the access queue at epoch-aligned boundaries every
// DR_BATCH_WINDOW_MS, regardless of when bundles arrived (arrival-independent = the on-chain time reveals the
// window, not the action). Self-rescheduling to the next exact boundary so it does not drift. A flush with an
// empty queue is a cheap no-op. Only armed when the DataRoom contract is configured.
function startBatchFlusher(): void {
  if (!DATAROOM_ID) return;
  const tick = () => {
    void runBatchFlush("window").catch((e) => console.error(`[dr-batch] flush error: ${err(e)}`));
    scheduleNext();
  };
  const scheduleNext = () => {
    const now = Date.now();
    const delay = Math.max(250, nextFlushAt(now, DR_BATCH_WINDOW_MS) - now);
    setTimeout(tick, delay).unref?.();
  };
  scheduleNext();
  console.log(`[dr-batch] access-batching flusher armed | window ${DR_BATCH_WINDOW_MS} ms${process.env.DR_BATCH_ALLOW_MANUAL_FLUSH === "1" ? " | manual-flush ENABLED" : ""}`);
}

app.listen(PORT, () => {
  console.log(`zkorage backend :${PORT} | token=${TOKEN_ID || "-"} policy=${POLICY_ID || "-"}`);
  startBatchFlusher();
});
