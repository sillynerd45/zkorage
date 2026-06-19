#!/usr/bin/env node
// zkorage MCP server — READ-ONLY, NO KEY CUSTODY.
//
// Exposes the zkorage Proof-of-Reserves engine as MCP tools so an AI agent (Claude Desktop / Claude
// Code) can query and re-verify claims. Every tool is a read: it simulates calls against a PUBLIC
// Soroban RPC + the public contracts via `zkorage-sdk`. The server never holds a secret key and can
// never sign or mutate anything.
//
// Transport: stdio. Config via env (all optional; default to live testnet):
//   ZKORAGE_RPC_URL, ZKORAGE_VERIFIER, ZKORAGE_TOKEN, ZKORAGE_POLICY, ZKORAGE_GATE, ZKORAGE_COMPLIANCE,
//   ZKORAGE_PAYROLL, ZKORAGE_ACCREDITED, ZKORAGE_FUNDRAISE, ZKORAGE_DATAROOM, ZKORAGE_API_BASE
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ZkorageClient, TESTNET, type Bundle } from "zkorage-sdk";

const client = new ZkorageClient({
  rpcUrl: process.env.ZKORAGE_RPC_URL ?? TESTNET.rpcUrl,
  contracts: {
    verifier: process.env.ZKORAGE_VERIFIER ?? TESTNET.contracts.verifier,
    token: process.env.ZKORAGE_TOKEN ?? TESTNET.contracts.token,
    policy: process.env.ZKORAGE_POLICY ?? TESTNET.contracts.policy,
    gate: process.env.ZKORAGE_GATE ?? TESTNET.contracts.gate,
    compliance: process.env.ZKORAGE_COMPLIANCE ?? TESTNET.contracts.compliance,
    payroll: process.env.ZKORAGE_PAYROLL ?? TESTNET.contracts.payroll,
    accredited: process.env.ZKORAGE_ACCREDITED ?? TESTNET.contracts.accredited,
    fundraise: process.env.ZKORAGE_FUNDRAISE ?? TESTNET.contracts.fundraise,
    dataroom: process.env.ZKORAGE_DATAROOM ?? TESTNET.contracts.dataroom,
  },
  apiBaseUrl: process.env.ZKORAGE_API_BASE, // only needed for audit-bundle / by-issuer re-verify
});

const server = new McpServer({ name: "zkorage", version: "0.14.0" });

// 32-byte hex issuer_id — validate the format, not just the length (agents may pass arbitrary strings).
const issuerHex = z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 32-byte hex (64 hex chars)");
// 32-byte hex accessor (a Stellar account's raw ed25519 key).
const accessorHex = z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 32-byte hex (64 hex chars)");
// 32-byte hex room_id / doc_id (the data-room identifiers).
const bytes32Hex = z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 32-byte hex (64 hex chars)");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (obj: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const err = (e: unknown): ToolResult => ({ content: [{ type: "text", text: "error: " + String((e as Error)?.message ?? e) }], isError: true });

server.registerTool(
  "is_reserves_ge_supply",
  {
    title: "Is reserves ≥ supply?",
    description:
      "The headline check. Returns the on-chain-verified answer to 'are issuer X's reserves ≥ circulating supply?' " +
      "(latest claim if no issuer). Reads the persisted result and confirms its bound supply still equals the live " +
      "token total_supply (freshness). Reserves stay private. No keys.",
    inputSchema: { issuer: issuerHex.optional().describe("32-byte hex issuer_id; omit for the latest claim") },
  },
  async ({ issuer }) => {
    try { return ok(await client.isReservesGteSupply(issuer)); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "get_latest_result",
  { title: "Latest verified result", description: "The most recent verified-claim result persisted on-chain." },
  async () => { try { return ok(await client.getLatestResult()); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_result_by_issuer",
  {
    title: "Result by issuer",
    description: "The persisted verified-claim result for a specific 32-byte hex issuer_id.",
    inputSchema: { issuer: issuerHex.describe("32-byte hex issuer_id") },
  },
  async ({ issuer }) => { try { return ok(await client.getResult(issuer)); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_count",
  { title: "History size", description: "Number of verified results in the on-chain append-only history log." },
  async () => { try { return ok({ count: await client.getCount() }); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_history",
  {
    title: "Verified-results history",
    description: "A page of the on-chain append-only verified-results history.",
    inputSchema: {
      start: z.number().int().min(0).optional().describe("0-based start index (default 0)"),
      limit: z.number().int().min(1).max(50).optional().describe("page size, max 50 (default 50)"),
    },
  },
  async ({ start, limit }) => {
    try { return ok(await client.getHistory(start ?? 0, limit ?? 50)); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "verify_proof_bundle",
  {
    title: "Re-verify a proof bundle",
    description:
      "Independently re-verify a RISC Zero → Groth16 proof bundle against the PUBLIC chain: recompute the journal " +
      "digest, check the image-id pin, confirm the Groth16 proof on the verifier contract, and check the supply " +
      "binding. Pass a bundle {seal,image_id,journal}, or omit it to fetch the latest (or an issuer's) bundle via " +
      "the REST API. Returns a per-check checklist + verdict.",
    inputSchema: {
      issuer: issuerHex.optional().describe("fetch this issuer's bundle (needs ZKORAGE_API_BASE)"),
      seal: z.string().optional(),
      image_id: z.string().optional(),
      journal: z.string().optional(),
      journal_digest: z.string().optional(),
    },
  },
  async ({ issuer, seal, image_id, journal, journal_digest }) => {
    try {
      let bundle: Bundle;
      if (seal && image_id && journal) {
        bundle = { seal, image_id, journal, journal_digest };
      } else {
        const audit = await client.getAuditBundle(issuer);
        if (!audit.proof) return err("no proof bundle available for this claim");
        bundle = audit.proof;
      }
      return ok(await client.verifyBundle(bundle));
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "get_audit_bundle",
  {
    title: "Shareable audit bundle",
    description:
      "The shareable audit bundle for a claim: the proof, the on-chain result, contract IDs, and a copy-paste " +
      "stellar-CLI recipe to reproduce the checks. Requires ZKORAGE_API_BASE (the proof bundle is not on-chain).",
    inputSchema: { issuer: issuerHex.optional() },
  },
  async ({ issuer }) => { try { return ok(await client.getAuditBundle(issuer)); } catch (e) { return err(e); } },
);

// ---- Week 5: identity (KYC selective-disclosure gate) ----

server.registerTool(
  "is_kyc_verified",
  {
    title: "Is this account KYC-verified?",
    description:
      "The headline identity check. Returns whether a given accessor (a Stellar account's 32-byte hex " +
      "ed25519 key) holds a valid, non-expired KYC access grant on the gate — proving an allow-listed KYC " +
      "provider attested 'kyc = passed' for its (hidden) owner. The subject's identity is never revealed. No keys.",
    inputSchema: { accessor: accessorHex.describe("32-byte hex accessor (Stellar account key)") },
  },
  async ({ accessor }) => { try { return ok(await client.isKycVerified(accessor)); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_access",
  {
    title: "Access grant by accessor",
    description: "The persisted KYC access-grant record for a specific 32-byte hex accessor (or null if not granted).",
    inputSchema: { accessor: accessorHex.describe("32-byte hex accessor (Stellar account key)") },
  },
  async ({ accessor }) => { try { return ok(await client.getAccess(accessor)); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_access_history",
  {
    title: "KYC access-grant history",
    description: "A page of the on-chain append-only KYC access-grant history (no identities — only accessors + issuers).",
    inputSchema: {
      start: z.number().int().min(0).optional().describe("0-based start index (default 0)"),
      limit: z.number().int().min(1).max(50).optional().describe("page size, max 50 (default 50)"),
    },
  },
  async ({ start, limit }) => {
    try { return ok(await client.getAccessHistory(start ?? 0, limit ?? 50)); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "verify_identity_bundle",
  {
    title: "Re-verify a KYC identity proof bundle",
    description:
      "Independently re-verify a RISC Zero → Groth16 IDENTITY proof bundle against the PUBLIC chain: recompute the " +
      "journal digest, check the gate's image-id pin, confirm the Groth16 proof on the verifier contract, and check " +
      "the identity policy (result, claim_type=3, allow-listed KYC issuer, freshness). The subject stays hidden — " +
      "the journal commits only the KYC provider + the public accessor. Pass a bundle {seal,image_id,journal}. " +
      "Returns a per-check checklist + verdict.",
    inputSchema: {
      seal: z.string(),
      image_id: z.string(),
      journal: z.string(),
      journal_digest: z.string().optional(),
    },
  },
  async ({ seal, image_id, journal, journal_digest }) => {
    try { return ok(await client.verifyIdentityBundle({ seal, image_id, journal, journal_digest })); }
    catch (e) { return err(e); }
  },
);

// ---- Week 6: compliance (KYC ∧ not-sanctioned gate) ----

server.registerTool(
  "is_compliant",
  {
    title: "Is this account KYC'd AND not-sanctioned?",
    description:
      "The headline compliance check. Returns whether a given accessor (a Stellar account's 32-byte hex " +
      "ed25519 key) holds a valid, non-expired 'KYC'd & not-sanctioned' access grant on the compliance gate — " +
      "proving an allow-listed KYC provider attested 'kyc = passed' for its (hidden) owner AND that owner is not " +
      "in the sanctions deny-list (the proof's committed deny-list root equals the gate's pinned root). The " +
      "subject's identity is never revealed. No keys.",
    inputSchema: { accessor: accessorHex.describe("32-byte hex accessor (Stellar account key)") },
  },
  async ({ accessor }) => { try { return ok(await client.isCompliant(accessor)); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_compliance_access",
  {
    title: "Compliance grant by accessor",
    description:
      "The persisted compliance access-grant record for a specific 32-byte hex accessor (or null if not granted). " +
      "Includes the sanctions deny-list root the grant was verified against.",
    inputSchema: { accessor: accessorHex.describe("32-byte hex accessor (Stellar account key)") },
  },
  async ({ accessor }) => { try { return ok(await client.getComplianceAccess(accessor)); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_compliance_history",
  {
    title: "Compliance access-grant history",
    description: "A page of the on-chain append-only compliance access-grant history (no identities — only accessors + issuers + deny-roots).",
    inputSchema: {
      start: z.number().int().min(0).optional().describe("0-based start index (default 0)"),
      limit: z.number().int().min(1).max(50).optional().describe("page size, max 50 (default 50)"),
    },
  },
  async ({ start, limit }) => {
    try { return ok(await client.getComplianceHistory(start ?? 0, limit ?? 50)); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "verify_compliance_bundle",
  {
    title: "Re-verify a compliance (KYC ∧ not-sanctioned) proof bundle",
    description:
      "Independently re-verify a RISC Zero → Groth16 COMPLIANCE proof bundle against the PUBLIC chain: recompute " +
      "the journal digest, check the compliance gate's image-id pin, confirm the Groth16 proof on the verifier " +
      "contract, and check the policy (result, claim_type=4, the committed deny_root equals the gate's pinned " +
      "sanctions root, allow-listed KYC issuer, freshness). The subject stays hidden. Pass a bundle " +
      "{seal,image_id,journal}. Returns a per-check checklist + verdict.",
    inputSchema: {
      seal: z.string(),
      image_id: z.string(),
      journal: z.string(),
      journal_digest: z.string().optional(),
    },
  },
  async ({ seal, image_id, journal, journal_digest }) => {
    try { return ok(await client.verifyComplianceBundle({ seal, image_id, journal, journal_digest })); }
    catch (e) { return err(e); }
  },
);

// ---- Week 7: confidential payroll (proof-of-income + auditor view-key) ----

server.registerTool(
  "is_income_verified",
  {
    title: "Is this account income-verified (paid ≥ a threshold)?",
    description:
      "The headline payroll check. Returns whether a given accessor (a Stellar account's 32-byte hex " +
      "ed25519 key) holds a valid, non-expired income-verified grant on the payroll gate — proving an " +
      "allow-listed payroll attester signed a salary ≥ the recorded public threshold for its (hidden) owner. " +
      "The exact salary is NEVER revealed here (it is encrypted in-guest to the auditor's view key). Returns the " +
      "cleared threshold + the opaque disclosure. No keys.",
    inputSchema: { accessor: accessorHex.describe("32-byte hex accessor (Stellar account key)") },
  },
  async ({ accessor }) => { try { return ok(await client.isIncomeVerified(accessor)); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_payroll_access",
  {
    title: "Income-verified grant by accessor",
    description:
      "The persisted income-verified grant for a specific 32-byte hex accessor (or null if not granted). " +
      "Includes the cleared threshold and the opaque auditor disclosure (eph_pub/ct/tag) — the salary itself " +
      "is only recoverable with the auditor's view key (not via this read).",
    inputSchema: { accessor: accessorHex.describe("32-byte hex accessor (Stellar account key)") },
  },
  async ({ accessor }) => { try { return ok(await client.getPayrollAccess(accessor)); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_payroll_history",
  {
    title: "Income-verified grant history",
    description: "A page of the on-chain append-only payroll grant history (accessors + thresholds + opaque disclosures — no salaries).",
    inputSchema: {
      start: z.number().int().min(0).optional().describe("0-based start index (default 0)"),
      limit: z.number().int().min(1).max(50).optional().describe("page size, max 50 (default 50)"),
    },
  },
  async ({ start, limit }) => {
    try { return ok(await client.getPayrollHistory(start ?? 0, limit ?? 50)); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "verify_payroll_bundle",
  {
    title: "Re-verify a payroll (proof-of-income) proof bundle",
    description:
      "Independently re-verify a RISC Zero → Groth16 PAYROLL proof bundle against the PUBLIC chain: recompute the " +
      "journal digest, check the payroll gate's image-id pin, confirm the Groth16 proof on the verifier contract, " +
      "and check the policy (result, claim_type=5, allow-listed attester, allow-listed auditor target, freshness). " +
      "The salary stays hidden — the journal commits only the public threshold + the encrypted disclosure. Pass a " +
      "bundle {seal,image_id,journal}. Returns a per-check checklist + verdict.",
    inputSchema: {
      seal: z.string(),
      image_id: z.string(),
      journal: z.string(),
      journal_digest: z.string().optional(),
    },
  },
  async ({ seal, image_id, journal, journal_digest }) => {
    try { return ok(await client.verifyPayrollBundle({ seal, image_id, journal, journal_digest })); }
    catch (e) { return err(e); }
  },
);

// ---- Week 8: fundraising (composition: accredited ∧ revenue ≥ X) ----

server.registerTool(
  "can_access_fundraise",
  {
    title: "Can this investor access the fundraise? (the composition)",
    description:
      "THE composition check. Returns whether a given accessor (a Stellar account's 32-byte hex ed25519 key) can " +
      "access the fundraise — TRUE only when BOTH legs hold on-chain: (a) the investor is a currently-accredited " +
      "investor (the accredited gate's is_granted, identity hidden) AND (b) the fundraise has a currently-valid " +
      "'revenue ≥ X' proof (is_revenue_verified). Always-live (drops if either leg expires). Also returns each leg " +
      "separately (revenueVerified / accredited) so you can see which is missing, plus the admission record. No keys.",
    inputSchema: { accessor: accessorHex.describe("32-byte hex accessor (Stellar account key)") },
  },
  async ({ accessor }) => { try { return ok(await client.canAccessFundraise(accessor)); } catch (e) { return err(e); } },
);

server.registerTool(
  "is_accredited",
  {
    title: "Is this account a verified accredited investor?",
    description:
      "Returns whether a given accessor holds a valid, non-expired accredited-investor access grant on the " +
      "accredited gate — proving an allow-listed accreditation provider attested 'accredited = yes' for its " +
      "(hidden) owner. The investor's identity is never revealed (selective disclosure). No keys.",
    inputSchema: { accessor: accessorHex.describe("32-byte hex accessor (Stellar account key)") },
  },
  async ({ accessor }) => { try { return ok(await client.isAccredited(accessor)); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_fundraise_info",
  {
    title: "Fundraise status (revenue leg + config)",
    description:
      "The fundraise's on-chain status: its config (revenue floor X, claim_type, the accredited gate it AND's " +
      "against), whether revenue ≥ X is currently verified, the verified revenue record (the real revenue is " +
      "hidden — only the proven floor X), and the number of investor admissions. No keys.",
    inputSchema: {},
  },
  async () => {
    try {
      const [config, revenueVerified, revenueRecord, admissions] = await Promise.all([
        client.getFundraiseConfig(), client.isFundraiseRevenueVerified(), client.getRevenueRecord(), client.getFundraiseCount(),
      ]);
      return ok({ config, revenueVerified, revenueRecord, admissions });
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "get_fundraise_history",
  {
    title: "Investor admission history",
    description: "A page of the on-chain append-only investor-admission history (accessors + the revenue floor in force — no identities).",
    inputSchema: {
      start: z.number().int().min(0).optional().describe("0-based start index (default 0)"),
      limit: z.number().int().min(1).max(50).optional().describe("page size, max 50 (default 50)"),
    },
  },
  async ({ start, limit }) => {
    try { return ok(await client.getFundraiseHistory(start ?? 0, limit ?? 50)); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "verify_accredited_bundle",
  {
    title: "Re-verify an accredited-investor proof bundle",
    description:
      "Independently re-verify a RISC Zero → Groth16 ACCREDITED-INVESTOR proof bundle against the PUBLIC chain: " +
      "recompute the journal digest, check the accredited gate's image-id pin, confirm the Groth16 proof on the " +
      "verifier contract, and check the policy (result, claim_type=7, allow-listed accreditation provider, " +
      "freshness). The investor's identity stays hidden. Pass {seal,image_id,journal}. Returns a checklist + verdict.",
    inputSchema: { seal: z.string(), image_id: z.string(), journal: z.string(), journal_digest: z.string().optional() },
  },
  async ({ seal, image_id, journal, journal_digest }) => {
    try { return ok(await client.verifyAccreditedBundle({ seal, image_id, journal, journal_digest })); }
    catch (e) { return err(e); }
  },
);

server.registerTool(
  "verify_revenue_bundle",
  {
    title: "Re-verify a revenue (value ≥ X) proof bundle",
    description:
      "Independently re-verify a RISC Zero → Groth16 REVENUE proof bundle against the PUBLIC chain: recompute the " +
      "journal digest, check the fundraise's revenue image-id pin, confirm the Groth16 proof on the verifier " +
      "contract, and check the policy (result, claim_type=6, allow-listed revenue auditor, the proven floor equals " +
      "the fundraise's pinned X, freshness). The revenue itself stays hidden — only '≥ X'. Pass {seal,image_id," +
      "journal}. Returns a checklist + verdict.",
    inputSchema: { seal: z.string(), image_id: z.string(), journal: z.string(), journal_digest: z.string().optional() },
  },
  async ({ seal, image_id, journal, journal_digest }) => {
    try { return ok(await client.verifyRevenueBundle({ seal, image_id, journal, journal_digest })); }
    catch (e) { return err(e); }
  },
);

// ---- DR1: Confidential Data Room (data plane — reads only; NO key custody, NO document open) ----

server.registerTool(
  "get_dataroom_info",
  {
    title: "Data-room status (config + room count)",
    description:
      "The DataRoom contract's on-chain status: its config (admin, verifier, the pinned seal-guest image, " +
      "claim_type=8) and the number of rooms created. The data room anchors ENCRYPTED documents " +
      "(content_hash + an ECIES disclosure); the ciphertext lives off-chain. No keys.",
    inputSchema: {},
  },
  async () => {
    try {
      const [config, roomCount] = await Promise.all([client.getDataroomConfig(), client.getRoomCount()]);
      return ok({ config, roomCount });
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "get_dataroom_room",
  {
    title: "Data-room room by id",
    description: "The room registered under a 32-byte hex room_id (owner + creation order), or null if it doesn't exist.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id") },
  },
  async ({ roomId }) => { try { return ok(await client.getRoom(roomId)); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_dataroom_document",
  {
    title: "Anchored document by (room, doc)",
    description:
      "The anchored document under (room_id, doc_id): its content_hash (sha256 of the off-chain ciphertext), " +
      "the recipient x25519 disclosure target, the opaque ECIES disclosure (eph_pub/ct/tag), and the off-chain " +
      "blob pointer. The document key + plaintext are NEVER returned — they are recoverable only by the recipient " +
      "(holding the matching x25519 secret) via the SDK opener, not this server. No keys.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id"), docId: bytes32Hex.describe("32-byte hex doc_id") },
  },
  async ({ roomId, docId }) => { try { return ok(await client.getDocument(roomId, docId)); } catch (e) { return err(e); } },
);

server.registerTool(
  "list_dataroom_documents",
  {
    title: "Documents anchored in a room",
    description: "A page of a room's append-only document log (content hashes + ECIES disclosures + pointers — never plaintext).",
    inputSchema: {
      roomId: bytes32Hex.describe("32-byte hex room_id"),
      start: z.number().int().min(0).optional().describe("0-based start index (default 0)"),
      limit: z.number().int().min(1).max(50).optional().describe("page size, max 50 (default 50)"),
    },
  },
  async ({ roomId, start, limit }) => {
    try { return ok(await client.listDocuments(roomId, start ?? 0, limit ?? 50)); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "verify_dataroom_bundle",
  {
    title: "Re-verify a data-room seal proof bundle",
    description:
      "Independently re-verify a RISC Zero → Groth16 DATA-ROOM SEAL proof bundle against the PUBLIC chain: " +
      "recompute the journal digest, check the DataRoom's image-id pin, confirm the Groth16 proof on the verifier " +
      "contract, and check the policy (result, claim_type=8). DR1 is commitment-only (no attester). The document " +
      "key K stays hidden (ECIES-sealed). Pass {seal,image_id,journal}. Returns a per-check checklist + verdict.",
    inputSchema: { seal: z.string(), image_id: z.string(), journal: z.string(), journal_digest: z.string().optional() },
  },
  async ({ seal, image_id, journal, journal_digest }) => {
    try { return ok(await client.verifyDataroomBundle({ seal, image_id, journal, journal_digest })); }
    catch (e) { return err(e); }
  },
);

// ── DR2 — anonymous eligibility (membership + nullifier). READ-ONLY, NO key custody (no prove/witness/
// open tool — membership proving needs private secrets + the eligible set, which live in the backend). ──

server.registerTool(
  "get_membership_status",
  {
    title: "Room anonymous-eligibility status (DR2)",
    description:
      "The DR2 anonymous-eligibility status for a room: the pinned canonical membership guest image_id " +
      "(claim_type 9), the room's pinned eligible-set Merkle root (or null), and the number of access grants. " +
      "Access is gained by proving sha256-Merkle membership + a per-room nullifier — anonymously, once per " +
      "identity per room. The chain reveals neither the identity nor which eligible member. No keys.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id") },
  },
  async ({ roomId }) => {
    try {
      const [membershipImageId, eligibleRoot, grantCount] = await Promise.all([
        client.getMembershipImageId(), client.getEligibleRoot(roomId), client.getGrantCount(roomId),
      ]);
      return ok({ roomId, membershipImageId, eligibleRoot, grantCount });
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "is_room_granted",
  {
    title: "Is an accessor granted anonymous-eligibility access? (DR2)",
    description:
      "True iff the (pseudonymous) accessor holds a currently-valid access grant in the room — i.e. a grant " +
      "exists AND was proven against the room's CURRENT eligible root (re-pinning the root revokes stale grants). " +
      "The live access decision a relying party / the DR3 keypers gate on. No keys.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id"), accessor: bytes32Hex.describe("32-byte hex ed25519 accessor") },
  },
  async ({ roomId, accessor }) => { try { return ok({ isGranted: await client.isRoomGranted(roomId, accessor) }); } catch (e) { return err(e); } },
);

server.registerTool(
  "is_nullifier_used",
  {
    title: "Is a nullifier spent in a room? (DR2)",
    description:
      "True iff the nullifier has already been spent in the room — a repeat access from the same identity is " +
      "rejected (#NullifierUsed). The nullifier is unlinkable to the identity and to other rooms. No keys.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id"), nullifier: bytes32Hex.describe("32-byte hex nullifier") },
  },
  async ({ roomId, nullifier }) => { try { return ok({ used: await client.isNullifierUsed(roomId, nullifier) }); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_membership_grant",
  {
    title: "Anonymous-eligibility grant record (DR2)",
    description:
      "The stored access grant for (room_id, accessor): the pseudonymous accessor, the x25519 recipient key (for " +
      "the DR3 keypers), the eligible-set root it was proven against, and the spent nullifier — or null. Reveals " +
      "NEITHER the member's identity NOR which eligible member it is. No keys.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id"), accessor: bytes32Hex.describe("32-byte hex ed25519 accessor") },
  },
  async ({ roomId, accessor }) => { try { return ok(await client.getGrant(roomId, accessor)); } catch (e) { return err(e); } },
);

server.registerTool(
  "verify_membership_bundle",
  {
    title: "Re-verify an anonymous-eligibility membership proof bundle (DR2)",
    description:
      "Independently re-verify a RISC Zero → Groth16 MEMBERSHIP proof bundle against the PUBLIC chain: decode the " +
      "165-byte journal, recompute the digest, check the DataRoom's membership-image pin, confirm the Groth16 proof " +
      "on the verifier, then check policy (result, claim_type=9), that the committed eligible_root equals the room's " +
      "pinned root, and whether the nullifier is still fresh (a fresh proof would grant). The member's identity is " +
      "ABSENT from the journal. Pass {seal,image_id,journal}. Returns a per-check checklist + verdict. No keys.",
    inputSchema: { seal: z.string(), image_id: z.string(), journal: z.string(), journal_digest: z.string().optional() },
  },
  async ({ seal, image_id, journal, journal_digest }) => {
    try { return ok(await client.verifyMembershipBundle({ seal, image_id, journal, journal_digest })); }
    catch (e) { return err(e); }
  },
);

// ── DR3 — threshold-ECIES committee documents. READ-ONLY, NO key custody (no collect/open/reconstruct
// tool — releasing + reconstructing K needs the recipient's x25519 SECRET, which lives only with the
// recipient via the SDK opener, never this server). These tools only read the on-chain committee anchor. ──

server.registerTool(
  "get_committee_document",
  {
    title: "Threshold-committee document by (room, doc) (DR3)",
    description:
      "The on-chain committee document under (room_id, doc_id): its content_hash (sha256 of the off-chain " +
      "ciphertext), a sha256(K) commitment to the document key, and the off-chain blob pointer. The key K is " +
      "Shamir-split across the keyper committee (no on-chain key material); it is released only to whoever wins " +
      "the DR2 grant, then reconstructed client-side by the recipient. The key + plaintext are NEVER returned " +
      "by this server. No keys.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id"), docId: bytes32Hex.describe("32-byte hex doc_id") },
  },
  async ({ roomId, docId }) => { try { return ok(await client.getCommitteeDocument(roomId, docId)); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_committee_doc_count",
  {
    title: "Number of committee documents in a room (DR3)",
    description: "The count of threshold-committee documents anchored in a room's append-only committee-doc log. No keys.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id") },
  },
  async ({ roomId }) => { try { return ok({ count: await client.getCommitteeDocCount(roomId) }); } catch (e) { return err(e); } },
);

// ── DR4 — document-authenticity (signed-PDF / zkPDF: third-party truth). READ-ONLY, NO key custody (no
// prove/sign tool — proving needs the private statement + the bank's key, which live in the backend). ──

server.registerTool(
  "get_docauth_info",
  {
    title: "Data-room document-authenticity status (DR4)",
    description:
      "The DR4 document-authenticity status: the pinned canonical docauth guest image_id (claim_type 10) and " +
      "the number of proven document facts in a room (if a roomId is given). DR4 proves a fact about a " +
      "THIRD-PARTY-SIGNED document (a bank's RSA-2048 signature, re-verified in-zkVM) — e.g. 'balance >= X' — " +
      "WITHOUT revealing the statement. Only allowlisted issuer keys are accepted (third-party truth). No keys.",
    inputSchema: { roomId: bytes32Hex.optional().describe("optional 32-byte hex room_id to also return its fact count") },
  },
  async ({ roomId }) => {
    try {
      const docauthImageId = await client.getDocauthImageId();
      const out: Record<string, unknown> = { docauthImageId, claimType: 10 };
      if (roomId) out.factCount = await client.getDocFactCount(roomId);
      return ok(out);
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "get_document_fact",
  {
    title: "Proven document fact by (room, msg_digest) (DR4)",
    description:
      "The proven document-authenticity fact under (room_id, msg_digest): the field_tag (1=balance), the public " +
      "threshold X (value >= X proven), the allowlisted issuer key hash that signed, and the attester. The " +
      "statement, the account, and the EXACT value are never on-chain — only the proven predicate. No keys.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id"), msgDigest: bytes32Hex.describe("32-byte hex msg_digest = sha256(statement)") },
  },
  async ({ roomId, msgDigest }) => { try { return ok(await client.getDocumentFact(roomId, msgDigest)); } catch (e) { return err(e); } },
);

server.registerTool(
  "list_document_facts",
  {
    title: "Document facts proven in a room (DR4)",
    description: "A page of a room's append-only document-fact log (each: field_tag, threshold, issuer key hash — never the statement or value).",
    inputSchema: {
      roomId: bytes32Hex.describe("32-byte hex room_id"),
      start: z.number().int().min(0).optional().describe("0-based start index (default 0)"),
      limit: z.number().int().min(1).max(50).optional().describe("page size, max 50 (default 50)"),
    },
  },
  async ({ roomId, start, limit }) => {
    try { return ok(await client.listDocumentFacts(roomId, start ?? 0, limit ?? 50)); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "is_docauth_issuer_allowed",
  {
    title: "Is a third-party docauth issuer allowlisted? (DR4)",
    description:
      "True iff issuerKeyHash (= sha256 of a third-party RSA modulus) is an allowlisted issuer. This is the DR4 " +
      "trust anchor: only facts signed by a KNOWN bank/authority key are accepted, so a self-minted key is rejected.",
    inputSchema: { issuerKeyHash: bytes32Hex.describe("32-byte hex sha256(RSA modulus n)") },
  },
  async ({ issuerKeyHash }) => { try { return ok({ allowed: await client.isDocauthIssuerAllowed(issuerKeyHash) }); } catch (e) { return err(e); } },
);

server.registerTool(
  "verify_docauth_bundle",
  {
    title: "Re-verify a document-authenticity proof bundle (DR4)",
    description:
      "Independently re-verify a RISC Zero → Groth16 DOCUMENT-AUTHENTICITY proof bundle against the PUBLIC chain: " +
      "recompute the journal digest, check the DataRoom's docauth image-id pin, confirm the Groth16 proof on the " +
      "verifier contract, check the policy (result, claim_type=10), AND confirm the committed issuer_key_hash is " +
      "on-chain allowlisted (third-party truth — a self-minted RSA key fails this). The statement + exact value " +
      "stay hidden. Pass {seal,image_id,journal}. Returns a per-check checklist + verdict.",
    inputSchema: { seal: z.string(), image_id: z.string(), journal: z.string(), journal_digest: z.string().optional() },
  },
  async ({ seal, image_id, journal, journal_digest }) => {
    try { return ok(await client.verifyDocauthBundle({ seal, image_id, journal, journal_digest })); }
    catch (e) { return err(e); }
  },
);

// ── DR5 — data-side teaser + auditor redacted view (READ-ONLY; the auditor opener is SDK-only, no key here) ──

server.registerTool(
  "get_dataroom_teaser",
  {
    title: "Public teaser about a sealed document (DR5)",
    description:
      "The public, ZK-verified teaser under (room_id, doc_id): a fact that the SEALED document's figure >= a public " +
      "threshold X, vouched by an allowlisted appraiser — the document is never revealed and the EXACT figure is " +
      "never on-chain. Returns the teaser (field_tag, threshold, appraiser key, the bound content_hash) + `valid` " +
      "(exists AND not expired). No keys.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id"), docId: bytes32Hex.describe("32-byte hex doc_id (the sealed document)") },
  },
  async ({ roomId, docId }) => {
    try { return ok({ teaser: await client.getTeaser(roomId, docId), valid: await client.isTeaserValid(roomId, docId) }); }
    catch (e) { return err(e); }
  },
);

server.registerTool(
  "list_dataroom_teasers",
  {
    title: "Teasers advertised in a room (DR5)",
    description: "A page of a room's append-only teaser log (each: field_tag, threshold, appraiser key, the bound content_hash — never the figure).",
    inputSchema: {
      roomId: bytes32Hex.describe("32-byte hex room_id"),
      start: z.number().int().min(0).optional().describe("0-based start index (default 0)"),
      limit: z.number().int().min(1).max(50).optional().describe("page size, max 50 (default 50)"),
    },
  },
  async ({ roomId, start, limit }) => {
    try { return ok(await client.listTeasers(roomId, start ?? 0, limit ?? 50)); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "is_teaser_attester_allowed",
  {
    title: "Is a data-room appraiser allowlisted? (DR5)",
    description:
      "True iff `attester` (an ed25519 public key) is an allowlisted teaser appraiser. This is the DR5 trust anchor: " +
      "only figures vouched by a KNOWN appraiser are accepted, so a self-minted key is rejected (the public fact is " +
      "appraiser truth, not the owner's word).",
    inputSchema: { attester: bytes32Hex.describe("32-byte hex ed25519 appraiser public key") },
  },
  async ({ attester }) => { try { return ok({ allowed: await client.isTeaserAttesterAllowed(attester) }); } catch (e) { return err(e); } },
);

server.registerTool(
  "verify_teaser_bundle",
  {
    title: "Re-verify a data-side teaser proof bundle (DR5)",
    description:
      "Independently re-verify a RISC Zero → Groth16 TEASER proof bundle against the PUBLIC chain: recompute the " +
      "journal digest, check the DataRoom's teaser image-id pin (the generic value>=threshold guest), confirm the " +
      "Groth16 proof on the verifier contract, check the policy (result, claim_type=11), AND confirm the committed " +
      "appraiser key is on-chain allowlisted (a self-minted appraiser fails this). The exact figure stays hidden. " +
      "Pass {seal,image_id,journal}. Returns a per-check checklist + verdict.",
    inputSchema: { seal: z.string(), image_id: z.string(), journal: z.string(), journal_digest: z.string().optional() },
  },
  async ({ seal, image_id, journal, journal_digest }) => {
    try { return ok(await client.verifyTeaserBundle({ seal, image_id, journal, journal_digest })); }
    catch (e) { return err(e); }
  },
);

// ── DR6 — private-policy composition + revocation/rotation (read-only; no key custody, no admit/revoke/rotate) ──

server.registerTool(
  "get_room_policy",
  {
    title: "A room's composite-admission policy (DR6)",
    description:
      "The DR6 composite-admission policy for a room: which legs apply (require_membership + the compliance / " +
      "accredited gate addresses, or null when a leg is not required). The policy is PUBLIC config; the privacy is " +
      "that a requester satisfies it WITHOUT revealing which member they are or any attribute. Returns null if unset.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id") },
  },
  async ({ roomId }) => { try { return ok({ policy: await client.getRoomPolicy(roomId) }); } catch (e) { return err(e); } },
);

server.registerTool(
  "can_access_room",
  {
    title: "Live composed admission decision, per leg (DR6)",
    description:
      "The live DR6 admission decision for (room, accessor), broken out by leg: `admitted` (the on-chain is_admitted " +
      "AND) + membership / compliance / accredited (each read live; null when the policy doesn't require it) + " +
      "`revoked` + the `policy`. Drops the moment any leg is revoked or expires. Reveals only the pseudonymous accessor.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id"), accessor: bytes32Hex.describe("32-byte hex pseudonymous accessor") },
  },
  async ({ roomId, accessor }) => { try { return ok(await client.canAccessRoom(roomId, accessor)); } catch (e) { return err(e); } },
);

server.registerTool(
  "is_access_revoked",
  {
    title: "Is an accessor surgically revoked? (DR6)",
    description:
      "True iff `accessor` has been surgically revoked in this room (DR6 revoke_access). A revoked accessor's DR2 " +
      "is_granted returns false at once (the keypers refuse shares) and is_admitted drops — without re-pinning the " +
      "eligible root (other members are unaffected).",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id"), accessor: bytes32Hex.describe("32-byte hex accessor") },
  },
  async ({ roomId, accessor }) => { try { return ok({ revoked: await client.isAccessRevoked(roomId, accessor) }); } catch (e) { return err(e); } },
);

server.registerTool(
  "get_committee_key_epoch",
  {
    title: "A committee document's key-rotation epoch (DR6)",
    description:
      "The current key-rotation epoch of a committee document (0 = original key; bumped on each DR6 " +
      "rotate_committee_document). Lets a recipient know whether cached shares are stale after a rotation.",
    inputSchema: { roomId: bytes32Hex.describe("32-byte hex room_id"), docId: bytes32Hex.describe("32-byte hex doc_id") },
  },
  async ({ roomId, docId }) => { try { return ok({ keyEpoch: await client.getCommitteeKeyEpoch(roomId, docId) }); } catch (e) { return err(e); } },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the MCP channel — log only to stderr.
console.error(`zkorage MCP server ready (read-only) | policy=${client.cfg.contracts.policy} gate=${client.cfg.contracts.gate} compliance=${client.cfg.contracts.compliance} payroll=${client.cfg.contracts.payroll} accredited=${client.cfg.contracts.accredited} fundraise=${client.cfg.contracts.fundraise} dataroom=${client.cfg.contracts.dataroom} rpc=${client.cfg.rpcUrl}`);
