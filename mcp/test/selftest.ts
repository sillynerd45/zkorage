// Programmatic MCP self-test: spawn the read-only server over stdio, list tools, and call each —
// asserting the on-chain answers. This is the Week-4 acceptance harness (no Claude Desktop needed).
//   cd mcp && npm run build && npm run selftest      (backend on :8787 for the audit-bundle tools)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { DEMO_ISSUER_ID, DEMO_KYC_ISSUER_ID, DEMO_USER, DEMO_DATAROOM, DEMO_DATAROOM_COMMITTEE, DEMO_DATAROOM_DOCAUTH, DEMO_RECIPIENT_PUB, DOCAUTH_IMAGE_ID, DEMO_DATAROOM_TEASER, DEMO_TEASER_ATTESTER_ID, DEMO_DATAROOM_POLICY } from "zkorage-sdk";

const serverPath = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  env: { ...process.env, ZKORAGE_API_BASE: process.env.ZKORAGE_API_BASE ?? "http://localhost:8787" },
});
const client = new Client({ name: "zkorage-selftest", version: "0.4.0" });
await client.connect(transport);

let failures = 0;
const ok = (c: boolean, label: string, extra = "") => {
  console.log(`${c ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!c) failures++;
};
const parse = (r: { content?: { type: string; text?: string }[]; isError?: boolean }) =>
  ({ data: JSON.parse(r.content?.[0]?.text ?? "null"), isError: !!r.isError });

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
ok(names.length >= 30, "tools/list", names.join(", "));

// headline tool — no keys, on-chain answer
{
  const { data, isError } = parse(await client.callTool({ name: "is_reserves_ge_supply", arguments: {} }));
  ok(!isError && data?.answer === true, "is_reserves_ge_supply", `answer=${data?.answer} fresh=${data?.fresh} bound=${data?.boundSupply}`);
}
{
  const { data } = parse(await client.callTool({ name: "get_count", arguments: {} }));
  ok(data?.count >= 3, "get_count", `${data?.count}`);
}
{
  const { data } = parse(await client.callTool({ name: "get_history", arguments: { start: 0, limit: 10 } }));
  ok(Array.isArray(data) && data.length >= 3, "get_history", `${data?.length} entries`);
}
{
  const { data } = parse(await client.callTool({ name: "get_result_by_issuer", arguments: { issuer: DEMO_ISSUER_ID } }));
  ok(data && data.result === true, "get_result_by_issuer", `supply=${data?.supply}`);
}
{
  const { data, isError } = parse(await client.callTool({ name: "verify_proof_bundle", arguments: {} }));
  ok(!isError && data?.verdict === true, "verify_proof_bundle (full Groth16 re-verify)", `verdict=${data?.verdict}`);
}
{
  const { data } = parse(await client.callTool({ name: "get_audit_bundle", arguments: {} }));
  ok(!!data?.proof?.seal, "get_audit_bundle", `policy=${data?.contracts?.policy?.slice(0, 8)}…`);
}

// ---- Week 5: identity / KYC gate tools ----
{
  const { data, isError } = parse(await client.callTool({ name: "is_kyc_verified", arguments: { accessor: DEMO_USER.accessorHex } }));
  ok(!isError && data?.answer === true, "is_kyc_verified(demo user)", `answer=${data?.answer}`);
}
{
  const { data, isError } = parse(await client.callTool({ name: "is_kyc_verified", arguments: { accessor: "00".repeat(32) } }));
  ok(!isError && data?.answer === false, "is_kyc_verified(unknown) denied", `answer=${data?.answer}`);
}
{
  const { data } = parse(await client.callTool({ name: "get_access_history", arguments: { start: 0, limit: 10 } }));
  ok(Array.isArray(data) && data.length >= 1, "get_access_history", `${data?.length} grants`);
}
{
  const path = process.env.ZKORAGE_IDENTITY_BUNDLE;
  if (path) {
    const b = JSON.parse(readFileSync(path, "utf8"));
    const { data, isError } = parse(await client.callTool({ name: "verify_identity_bundle", arguments: b }));
    ok(!isError && data?.verdict === true, "verify_identity_bundle (full Groth16 re-verify)", `verdict=${data?.verdict}`);
  } else {
    console.log("• verify_identity_bundle skipped (set ZKORAGE_IDENTITY_BUNDLE to a bundle file)");
  }
}

// ---- Week 6: compliance (KYC ∧ not-sanctioned) gate tools ----
ok(["is_compliant", "get_compliance_access", "get_compliance_history", "verify_compliance_bundle"].every((n) => names.includes(n)),
  "compliance tools registered");
{
  // demo user is compliant once the on-chain acceptance test has run; otherwise the record is null.
  const { data, isError } = parse(await client.callTool({ name: "is_compliant", arguments: { accessor: DEMO_USER.accessorHex } }));
  ok(!isError && (data?.answer === true || data?.record === null), "is_compliant(demo user)", `answer=${data?.answer} record=${data?.record ? "present" : "none"}`);
}
{
  const { data, isError } = parse(await client.callTool({ name: "is_compliant", arguments: { accessor: "00".repeat(32) } }));
  ok(!isError && data?.answer === false, "is_compliant(unknown) denied", `answer=${data?.answer}`);
}
{
  const path = process.env.ZKORAGE_COMPLIANCE_BUNDLE;
  if (path) {
    const b = JSON.parse(readFileSync(path, "utf8"));
    const { data, isError } = parse(await client.callTool({ name: "verify_compliance_bundle", arguments: b }));
    ok(!isError && data?.verdict === true, "verify_compliance_bundle (full Groth16 re-verify)", `verdict=${data?.verdict} denyRootMatches=${data?.checklist?.denyRootMatches}`);
  } else {
    console.log("• verify_compliance_bundle skipped (set ZKORAGE_COMPLIANCE_BUNDLE to a bundle file)");
  }
}

// ---- Week 7: confidential payroll (proof-of-income + auditor view-key) tools ----
ok(["is_income_verified", "get_payroll_access", "get_payroll_history", "verify_payroll_bundle"].every((n) => names.includes(n)),
  "payroll tools registered");
{
  // demo user is income-verified once the on-chain acceptance test has run; otherwise the record is null.
  const { data, isError } = parse(await client.callTool({ name: "is_income_verified", arguments: { accessor: DEMO_USER.accessorHex } }));
  ok(!isError && (data?.answer === true || data?.record === null), "is_income_verified(demo user)", `answer=${data?.answer} threshold=${data?.record?.threshold ?? "-"} salary_hidden=${data?.record ? !("salary" in data.record) : "n/a"}`);
}
{
  const { data, isError } = parse(await client.callTool({ name: "is_income_verified", arguments: { accessor: "00".repeat(32) } }));
  ok(!isError && data?.answer === false, "is_income_verified(unknown) denied", `answer=${data?.answer}`);
}
{
  const path = process.env.ZKORAGE_PAYROLL_BUNDLE;
  if (path) {
    const b = JSON.parse(readFileSync(path, "utf8"));
    const { data, isError } = parse(await client.callTool({ name: "verify_payroll_bundle", arguments: b }));
    ok(!isError && data?.verdict === true, "verify_payroll_bundle (full Groth16 re-verify)", `verdict=${data?.verdict} auditorAllowed=${data?.checklist?.auditorAllowed} salary_hidden=${!("salary" in (data?.decodedJournal ?? {}))}`);
  } else {
    console.log("• verify_payroll_bundle skipped (set ZKORAGE_PAYROLL_BUNDLE to a bundle file)");
  }
}

// ── Week 8: fundraising (composition) ──
console.log("\n--- fundraising (composition: accredited ∧ revenue ≥ X) ---");
ok(["can_access_fundraise", "is_accredited", "get_fundraise_info", "get_fundraise_history", "verify_accredited_bundle", "verify_revenue_bundle"].every((n) => names.includes(n)),
  "fundraise tools registered");
{
  const { data, isError } = parse(await client.callTool({ name: "is_accredited", arguments: { accessor: DEMO_USER.accessorHex } }));
  ok(!isError && (data?.answer === true || data?.record === null), "is_accredited(demo user)", `answer=${data?.answer} identity_hidden=${data?.record ? !("subject_id" in data.record) : "n/a"}`);
}
{
  // THE composition decision. The demo user was admitted on-chain (accredited ∧ revenue).
  const { data, isError } = parse(await client.callTool({ name: "can_access_fundraise", arguments: { accessor: DEMO_USER.accessorHex } }));
  ok(!isError && (data?.answer === true || (data?.revenueVerified && !data?.accredited)), "can_access_fundraise(demo user)", `canAccess=${data?.answer} revenueVerified=${data?.revenueVerified} accredited=${data?.accredited}`);
}
{
  // unknown accessor: revenue verified but NOT accredited → the AND fails.
  const { data, isError } = parse(await client.callTool({ name: "can_access_fundraise", arguments: { accessor: "00".repeat(32) } }));
  ok(!isError && data?.answer === false && data?.accredited === false, "can_access_fundraise(unknown) denied", `canAccess=${data?.answer} accredited=${data?.accredited}`);
}
{
  const { data, isError } = parse(await client.callTool({ name: "get_fundraise_info", arguments: {} }));
  ok(!isError && data?.revenueVerified === true && data?.config?.revenue_claim_type === 6, "get_fundraise_info", `revenueVerified=${data?.revenueVerified} X=${data?.config?.revenue_threshold}`);
}
{
  const path = process.env.ZKORAGE_ACCREDITED_BUNDLE;
  if (path) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const b = raw.bundle ?? raw;
    const { data, isError } = parse(await client.callTool({ name: "verify_accredited_bundle", arguments: b }));
    ok(!isError && data?.verdict === true, "verify_accredited_bundle (full Groth16 re-verify)", `verdict=${data?.verdict} claim_type=${data?.decodedJournal?.claimType}`);
  } else {
    console.log("• verify_accredited_bundle skipped (set ZKORAGE_ACCREDITED_BUNDLE to a bundle file)");
  }
}
{
  const path = process.env.ZKORAGE_REVENUE_BUNDLE;
  if (path) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const b = raw.bundle ?? raw;
    const { data, isError } = parse(await client.callTool({ name: "verify_revenue_bundle", arguments: b }));
    ok(!isError && data?.verdict === true, "verify_revenue_bundle (full Groth16 re-verify)", `verdict=${data?.verdict} thresholdX=${data?.thresholdX} revenue_hidden=${!("value" in (data?.decodedJournal ?? {}))}`);
  } else {
    console.log("• verify_revenue_bundle skipped (set ZKORAGE_REVENUE_BUNDLE to a bundle file)");
  }
}

// ── DR1: Confidential Data Room (read-only — no key custody, no document open) ──
console.log("\n--- dataroom (DR1: read-only data plane; NO key custody) ---");
ok(["get_dataroom_info", "get_dataroom_room", "get_dataroom_document", "list_dataroom_documents", "verify_dataroom_bundle"].every((n) => names.includes(n)),
  "dataroom tools registered");
// the server must NOT expose any document-open / key tool (the opener is SDK-only — caller holds the key).
ok(!names.some((n) => /open|decrypt|recipient.*secret|private.*key/i.test(n)), "no key-custody / open tool exposed");
{
  const { data, isError } = parse(await client.callTool({ name: "get_dataroom_info", arguments: {} }));
  ok(!isError && data?.config?.claim_type === 8 && data?.roomCount >= 1, "get_dataroom_info", `claim_type=${data?.config?.claim_type} rooms=${data?.roomCount}`);
}
{
  const { data, isError } = parse(await client.callTool({ name: "get_dataroom_room", arguments: { roomId: DEMO_DATAROOM.roomId } }));
  ok(!isError && data?.room_id === DEMO_DATAROOM.roomId, "get_dataroom_room(demo room)", `owner=${data?.owner?.slice(0, 8)}…`);
}
{
  const { data, isError } = parse(await client.callTool({ name: "get_dataroom_document", arguments: { roomId: DEMO_DATAROOM.roomId, docId: DEMO_DATAROOM.docId } }));
  ok(!isError && data?.recipient_pub === DEMO_RECIPIENT_PUB && /^[0-9a-f]{64}$/.test(data?.content_hash ?? "") && !("plaintext" in (data ?? {})),
    "get_dataroom_document(demo doc) — ciphertext metadata only (no plaintext)", `content_hash=${data?.content_hash?.slice(0, 10)}…`);
}
{
  const { data, isError } = parse(await client.callTool({ name: "list_dataroom_documents", arguments: { roomId: DEMO_DATAROOM.roomId } }));
  ok(!isError && Array.isArray(data) && data.some((d: { doc_id: string }) => d.doc_id === DEMO_DATAROOM.docId), "list_dataroom_documents(demo room)", `${data?.length} doc(s)`);
}
{
  const path = process.env.ZKORAGE_DATAROOM_BUNDLE;
  if (path) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const b = raw.bundle ?? raw;
    const { data, isError } = parse(await client.callTool({ name: "verify_dataroom_bundle", arguments: b }));
    ok(!isError && data?.verdict === true, "verify_dataroom_bundle (full Groth16 re-verify)", `verdict=${data?.verdict} claim_type=${data?.decodedJournal?.claimType} doc_key_hidden=${!("k" in (data?.decodedJournal ?? {}))}`);
  } else {
    console.log("• verify_dataroom_bundle skipped (set ZKORAGE_DATAROOM_BUNDLE to a bundle file)");
  }
}

// ── DR2: anonymous eligibility (membership + nullifier) — read-only, still NO key custody ──
console.log("\n--- dataroom DR2 (anonymous eligibility: read-only; NO key custody) ---");
const DR2_ROOM = "c1c33201dad189af07b344cc6b20a9a3e6b75601f04344e618d5281cefa46d75";
const DR2_ROOT = "8be678722c84e8bf478cd0c2a8e257bcc599f80d56ad2839e0188a1cace651da";
const DR2_ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";
const DR2_NULLIFIER = "2d6ee934d52d01f00c08992963a4ca07c73badd57307f9c445c2c625e7b1bf25";
ok(["get_membership_status", "is_room_granted", "is_nullifier_used", "get_membership_grant", "verify_membership_bundle"].every((n) => names.includes(n)),
  "DR2 membership tools registered");
// still NO prove / witness / key / open tool (membership proving needs private secrets — backend-only).
ok(!names.some((n) => /prove|witness|id_secret|trapdoor|sign|open|decrypt|private.*key/i.test(n)), "no prove/key-custody tool exposed (DR2)");
{
  const { data, isError } = parse(await client.callTool({ name: "get_membership_status", arguments: { roomId: DR2_ROOM } }));
  ok(!isError && data?.membershipImageId === "9550a12e84a9b26bc3926e79e271dc0f1a740f45d86f88c19d3e3e438939011c" && data?.eligibleRoot === DR2_ROOT && data?.grantCount >= 1,
    "get_membership_status(demo room)", `root=${data?.eligibleRoot?.slice(0, 10)}… grants=${data?.grantCount}`);
}
{
  const { data, isError } = parse(await client.callTool({ name: "is_room_granted", arguments: { roomId: DR2_ROOM, accessor: DR2_ACCESSOR } }));
  ok(!isError && data?.isGranted === true, "is_room_granted(demo accessor) = true");
}
{
  const { data, isError } = parse(await client.callTool({ name: "is_nullifier_used", arguments: { roomId: DR2_ROOM, nullifier: DR2_NULLIFIER } }));
  ok(!isError && data?.used === true, "is_nullifier_used(demo nullifier) = true");
}
{
  const { data, isError } = parse(await client.callTool({ name: "get_membership_grant", arguments: { roomId: DR2_ROOM, accessor: DR2_ACCESSOR } }));
  ok(!isError && data?.accessor === DR2_ACCESSOR && data?.nullifier === DR2_NULLIFIER && !("idSecret" in (data ?? {})),
    "get_membership_grant(demo) — pseudonymous record (no identity)", `index=${data?.index}`);
}
{
  const path = process.env.ZKORAGE_MEMBERSHIP_BUNDLE;
  if (path) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const b = raw.bundle ?? raw;
    const { data, isError } = parse(await client.callTool({ name: "verify_membership_bundle", arguments: b }));
    ok(!isError && data?.verdict === true, "verify_membership_bundle (full Groth16 re-verify)",
      `verdict=${data?.verdict} claim_type=${data?.decodedJournal?.claimType} identity_absent=${!("idSecret" in (data?.decodedJournal ?? {}))}`);
  } else {
    console.log("• verify_membership_bundle skipped (set ZKORAGE_MEMBERSHIP_BUNDLE to a bundle file)");
  }
}

// ── DR3: threshold-ECIES committee documents — read-only, NO key custody (no collect/open/reconstruct) ──
console.log("\n--- dataroom DR3 (threshold committee: read-only; NO key custody) ---");
ok(["get_committee_document", "get_committee_doc_count"].every((n) => names.includes(n)), "DR3 committee tools registered");
// NO collect / open / reconstruct / share-secret tool (releasing + reconstructing K needs the recipient
// secret — SDK-only). The DR1 `open|decrypt` guard above already blocks "open"; reinforce for DR3 verbs.
ok(!names.some((n) => /collect|reconstruct|share.*secret|committee.*open|release.*key/i.test(n)), "no collect/reconstruct/key tool exposed (DR3)");
{
  const { data, isError } = parse(await client.callTool({ name: "get_committee_document", arguments: { roomId: DEMO_DATAROOM_COMMITTEE.roomId, docId: DEMO_DATAROOM_COMMITTEE.docId } }));
  ok(!isError && /^[0-9a-f]{64}$/.test(data?.content_hash ?? "") && /^[0-9a-f]{64}$/.test(data?.k_commitment ?? "") && !("k" in (data ?? {})) && !("plaintext" in (data ?? {})),
    "get_committee_document(demo) — content_hash + k_commitment only (no key/plaintext)", `content_hash=${data?.content_hash?.slice(0, 10)}… k_commitment=${data?.k_commitment?.slice(0, 10)}…`);
}
{
  const { data, isError } = parse(await client.callTool({ name: "get_committee_doc_count", arguments: { roomId: DEMO_DATAROOM_COMMITTEE.roomId } }));
  ok(!isError && data?.count >= 1, "get_committee_doc_count(demo room) >= 1", `count=${data?.count}`);
}

// ── DR4: document-authenticity (signed-PDF / zkPDF fact) — read-only, NO key custody (no prove/sign) ──
console.log("\n--- dataroom DR4 (document-authenticity: read-only; NO key custody) ---");
ok(["get_docauth_info", "get_document_fact", "list_document_facts", "is_docauth_issuer_allowed", "verify_docauth_bundle"].every((n) => names.includes(n)),
  "DR4 docauth tools registered");
// NO prove/sign tool (proving needs the private statement + the bank's RSA key — backend-only).
// Match prove/sign/attest only as whole `_`-delimited verb segments — so a READ tool like
// `is_teaser_attester_allowed` (the noun "attester") is not a false positive, but `attest_*`/`*_prove` is.
ok(!names.some((n) => /(^|_)(prove|sign|attest)(_|$)|statement|private.*key/i.test(n)), "no prove/sign/attest tool exposed (DR4)");
{
  const { data, isError } = parse(await client.callTool({ name: "get_docauth_info", arguments: {} }));
  ok(!isError && data?.docauthImageId === DOCAUTH_IMAGE_ID && data?.claimType === 10,
    "get_docauth_info (image pinned == canonical)", `image=${data?.docauthImageId?.slice(0, 12)}…`);
}
{
  const { data, isError } = parse(await client.callTool({ name: "is_docauth_issuer_allowed", arguments: { issuerKeyHash: DEMO_DATAROOM_DOCAUTH.issuerKeyHash } }));
  ok(!isError && data?.allowed === true, "is_docauth_issuer_allowed(demo bank key) → true");
  const { data: d2 } = parse(await client.callTool({ name: "is_docauth_issuer_allowed", arguments: { issuerKeyHash: "ff".repeat(32) } }));
  ok(d2?.allowed === false, "is_docauth_issuer_allowed(self-minted key) → false (third-party truth)");
}
{
  const { data, isError } = parse(await client.callTool({ name: "get_document_fact", arguments: { roomId: DEMO_DATAROOM_DOCAUTH.roomId, msgDigest: DEMO_DATAROOM_DOCAUTH.msgDigest } }));
  if (!isError && data) {
    ok(data?.threshold === DEMO_DATAROOM_DOCAUTH.threshold && !("value" in data) && !("statement" in data),
      "get_document_fact(demo) — predicate only (no statement/value)", `threshold=${data?.threshold} issuer=${data?.issuer_key_hash?.slice(0, 10)}…`);
  } else {
    console.log("• get_document_fact(demo) pending (the DR4 e2e attest hasn't landed yet)");
  }
}
if (process.env.ZKORAGE_DOCAUTH_BUNDLE) {
  try {
    const raw = JSON.parse(readFileSync(process.env.ZKORAGE_DOCAUTH_BUNDLE, "utf8"));
    const b = raw.bundle ?? raw;
    const { data, isError } = parse(await client.callTool({ name: "verify_docauth_bundle", arguments: b }));
    ok(!isError && data?.verdict === true, "verify_docauth_bundle (full Groth16 re-verify + issuer allowlist)",
      `verdict=${data?.verdict} claim_type=${data?.decodedJournal?.claimType} value_hidden=${!("value" in (data?.decodedJournal ?? {}))}`);
  } catch (e) {
    console.log("• verify_docauth_bundle skipped (bad ZKORAGE_DOCAUTH_BUNDLE):", String((e as Error).message ?? e));
  }
} else {
  console.log("• verify_docauth_bundle skipped (set ZKORAGE_DOCAUTH_BUNDLE to a bundle file)");
}

// ── DR5: data-side teaser + auditor redacted view — read-only, still NO key custody ──
console.log("\n--- dataroom DR5 (data-side teaser: read-only; NO key custody) ---");
ok(["get_dataroom_teaser", "list_dataroom_teasers", "is_teaser_attester_allowed", "verify_teaser_bundle"].every((n) => names.includes(n)),
  "DR5 teaser tools registered");
// still NO open/decrypt/key tool — the auditor opener is SDK-only (caller holds the view key).
{
  const { data, isError } = parse(await client.callTool({ name: "is_teaser_attester_allowed", arguments: { attester: DEMO_TEASER_ATTESTER_ID } }));
  ok(!isError && data?.allowed === true, "is_teaser_attester_allowed(demo appraiser) → true");
}
{
  const { data, isError } = parse(await client.callTool({ name: "is_teaser_attester_allowed", arguments: { attester: "ff".repeat(32) } }));
  ok(!isError && data?.allowed === false, "is_teaser_attester_allowed(self-minted) → false (third-party truth)");
}
{
  const { data, isError } = parse(await client.callTool({ name: "get_dataroom_teaser", arguments: { roomId: DEMO_DATAROOM_TEASER.roomId, docId: DEMO_DATAROOM_TEASER.fullDocId } }));
  if (!isError && data?.teaser) {
    ok(
      data.teaser.threshold === DEMO_DATAROOM_TEASER.threshold && data.teaser.attester === DEMO_TEASER_ATTESTER_ID &&
        data.valid === true && !("figure" in data.teaser) && !("value" in data.teaser),
      "get_dataroom_teaser(demo) — figure≥threshold proven; figure absent", `threshold=${data.teaser.threshold} valid=${data.valid}`,
    );
  } else {
    console.log("• get_dataroom_teaser(demo) pending (run backend/scripts/dr5-anchor-demo.mjs)");
  }
}
{
  const { data, isError } = parse(await client.callTool({ name: "list_dataroom_teasers", arguments: { roomId: DEMO_DATAROOM_TEASER.roomId } }));
  ok(!isError && Array.isArray(data) && data.some((t: { doc_id: string }) => t.doc_id === DEMO_DATAROOM_TEASER.fullDocId), "list_dataroom_teasers(demo room)", `${data?.length} teaser(s)`);
}

// ── DR6: private-policy composition + revocation/rotation — read-only, still NO key custody ──
console.log("\n--- dataroom DR6 (private-policy composition: read-only; NO key custody) ---");
ok(["get_room_policy", "can_access_room", "is_access_revoked", "get_committee_key_epoch"].every((n) => names.includes(n)),
  "DR6 composition tools registered");
// NO admit / revoke / rotate / policy-set tool — every DR6 write is backend-only (the MCP is read-only).
ok(!["request_room_admission", "revoke_access", "unrevoke_access", "rotate_committee_document", "set_room_policy"].some((n) => names.includes(n)),
  "no admit/revoke/rotate/policy-set tool exposed (DR6 writes are backend-only)");
{
  const { data, isError } = parse(await client.callTool({ name: "get_room_policy", arguments: { roomId: DEMO_DATAROOM_POLICY.roomId } }));
  if (!isError && data?.policy) {
    ok(
      data.policy.require_membership === true && !!data.policy.compliance_gate && !!data.policy.accredited_gate,
      "get_room_policy(demo) — member ∧ compliance ∧ accredited", `comp=${data.policy.compliance_gate?.slice(0, 8)}…`,
    );
    const { data: ca } = parse(await client.callTool({ name: "can_access_room", arguments: { roomId: DEMO_DATAROOM_POLICY.roomId, accessor: DEMO_DATAROOM_POLICY.accessor } }));
    ok(ca?.admitted === true && ca?.membership === true && ca?.compliance === true && ca?.accredited === true && ca?.revoked === false,
      "can_access_room(demo accessor) — all legs ✓ (anonymous composite)", `admitted=${ca?.admitted}`);
    const { data: rv } = parse(await client.callTool({ name: "is_access_revoked", arguments: { roomId: DEMO_DATAROOM_POLICY.roomId, accessor: DEMO_DATAROOM_POLICY.accessor } }));
    ok(rv?.revoked === false, "is_access_revoked(demo accessor) → false");
    const { data: ke } = parse(await client.callTool({ name: "get_committee_key_epoch", arguments: { roomId: DEMO_DATAROOM_POLICY.roomId, docId: DEMO_DATAROOM_POLICY.docId } }));
    ok(typeof ke?.keyEpoch === "number" && ke.keyEpoch >= 0, "get_committee_key_epoch(demo doc) → number", `epoch=${ke?.keyEpoch}`);
  } else {
    console.log("• get_room_policy(demo) pending (run backend/scripts/dr6-anchor-demo.mjs)");
  }
}

// ── Pattern 2: prove-a-policy self-serve, PER-DOCUMENT access — read-only, NO key custody ──
console.log("\n--- Pattern 2 (per-document policy: read-only; NO key custody) ---");
ok(["get_doc_policy", "is_doc_admitted", "can_access_document"].every((n) => names.includes(n)),
  "Pattern-2 per-document tools registered");
// NO set-doc-policy tool — the policy WRITE is backend-only (room-owner auth); the keyper key release is SDK-only.
ok(!["set_doc_policy"].some((n) => names.includes(n)), "no set_doc_policy tool exposed (write is backend-only)");
{
  const { data, isError } = parse(await client.callTool({ name: "get_doc_policy", arguments: { roomId: DEMO_DATAROOM_POLICY.roomId, docId: DEMO_DATAROOM_POLICY.docId } }));
  if (!isError && data?.policy) {
    ok(data.policy.require_membership === true && !!data.policy.compliance_gate && !!data.policy.accredited_gate,
      "get_doc_policy(demo doc) — member ∧ compliance ∧ accredited", `comp=${data.policy.compliance_gate?.slice(0, 8)}…`);
    const { data: cd } = parse(await client.callTool({ name: "can_access_document", arguments: { roomId: DEMO_DATAROOM_POLICY.roomId, docId: DEMO_DATAROOM_POLICY.docId, accessor: DEMO_DATAROOM_POLICY.accessor } }));
    ok(cd?.admitted === true && cd?.membership === true && cd?.compliance === true && cd?.accredited === true,
      "can_access_document(demo accessor) — all legs ✓ (the keyper share-release gate)", `admitted=${cd?.admitted}`);
    const { data: na } = parse(await client.callTool({ name: "is_doc_admitted", arguments: { roomId: DEMO_DATAROOM_POLICY.roomId, docId: DEMO_DATAROOM_POLICY.docId, accessor: "11".repeat(32) } }));
    ok(na?.isDocAdmitted === false, "is_doc_admitted(random accessor) → false");
  } else {
    console.log("• get_doc_policy(demo) pending (set a per-document policy on the demo committee doc)");
  }
}

await client.close();
console.log(failures === 0 ? "\nMCP SELFTEST OK" : `\nMCP SELFTEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
