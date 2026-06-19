// Node smoke test — runs the SDK against the LIVE testnet contracts (public RPC, no keys).
//   cd sdk && npm install && npm run smoke
// Optional: ZKORAGE_IDENTITY_BUNDLE / ZKORAGE_COMPLIANCE_BUNDLE = <bundle.json> to also re-verify fully.
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import { ZkorageClient, DEMO_ISSUER_ID, DEMO_KYC_ISSUER_ID, DEMO_USER, DENY_ROOT, DEMO_PAYROLL_ATTESTER_ID, DEMO_AUDITOR_PUB, toHex, auditorPublicKeyFromSecret, CLAIM_TYPE_DATAROOM_SEAL, DEMO_DATAROOM, DEMO_DATAROOM_COMMITTEE, DEMO_RECIPIENT_PUB, recipientPublicKeyFromSecret, MEMBERSHIP_IMAGE_ID, CLAIM_TYPE_MEMBERSHIP, decodeMembershipJournal, assertCommitteeFrozenVectors, DOCAUTH_IMAGE_ID, CLAIM_TYPE_DOCAUTH, DEMO_DATAROOM_DOCAUTH, decodeDocauthJournal, TEASER_IMAGE_ID, CLAIM_TYPE_TEASER, DEMO_TEASER_ATTESTER_ID, DEMO_DATAROOM_TEASER, decodeJournal, DEMO_DATAROOM_POLICY } from "../src/index.js";

const z = new ZkorageClient({ apiBaseUrl: process.env.ZKORAGE_API ?? "http://localhost:8787" });
let failures = 0;
const ok = (c: boolean, label: string, extra = "") => {
  console.log(`${c ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!c) failures++;
};

const cfg = await z.getConfig();
ok(cfg.image_id.length === 64, "get_config", `image_id=${cfg.image_id.slice(0, 12)}… claim_type=${cfg.claim_type}`);

const supply = await z.getSupply();
ok(BigInt(supply) > 0n, "get_supply", `${supply}`);

const count = await z.getCount();
ok(count >= 1, "get_count", `${count}`);

const hist = await z.getHistory(0, 10);
ok(hist.length >= 1, "get_history", `${hist.length} entries: [${hist.map((h) => h.index).join(",")}]`);

ok(await z.isIssuerAllowed(DEMO_ISSUER_ID), "is_issuer_allowed(demo)");

const ans = await z.isReservesGteSupply();
ok(ans.answer === true, "isReservesGteSupply", `answer=${ans.answer} bound=${ans.boundSupply} live=${ans.liveSupply} fresh=${ans.fresh}`);

// full re-verify via the audit bundle (needs the REST API for the proof bundle)
try {
  const ab = await z.getAuditBundle();
  if (ab.proof) {
    const v = await z.verifyBundle(ab.proof);
    ok(v.verdict === true, "verifyBundle (full Groth16 re-verify)", `verdict=${v.verdict} checks=${Object.values(v.checklist).filter(Boolean).length}/10`);
    if (!v.verdict) console.log("  notes:", v.notes);
  } else {
    console.log("• no proof bundle in audit (skipping verifyBundle)");
  }
} catch (e) {
  console.log("• verifyBundle skipped (REST API not reachable at apiBaseUrl):", String((e as Error).message ?? e));
}

// ---- Week 5: identity / KYC gate ----
console.log("\n--- identity (KYC selective-disclosure gate) ---");

const gcfg = await z.getGateConfig();
ok(gcfg.image_id.length === 64 && gcfg.claim_type === 3, "gate get_config", `image_id=${gcfg.image_id.slice(0, 12)}… claim_type=${gcfg.claim_type}`);

ok(await z.isGateIssuerAllowed(DEMO_KYC_ISSUER_ID), "gate is_issuer_allowed(kyc demo)");

const acount = await z.getAccessCount();
ok(acount >= 1, "gate get_count", `${acount}`);

const kyc = await z.isKycVerified(DEMO_USER.accessorHex);
ok(kyc.answer === true, "isKycVerified(demo user)", `answer=${kyc.answer} accessor=${DEMO_USER.accessorHex.slice(0, 12)}… g=${DEMO_USER.g.slice(0, 8)}…`);

// a never-granted accessor must be denied
const denied = await z.isKycVerified("00".repeat(32));
ok(denied.answer === false, "isKycVerified(unknown accessor) denied", `answer=${denied.answer}`);

// optional full Groth16 re-verify of a local identity bundle
const idBundlePath = process.env.ZKORAGE_IDENTITY_BUNDLE;
if (idBundlePath) {
  try {
    const b = JSON.parse(readFileSync(idBundlePath, "utf8"));
    const v = await z.verifyIdentityBundle(b);
    ok(v.verdict === true, "verifyIdentityBundle (full Groth16 re-verify)", `verdict=${v.verdict} checks=${Object.values(v.checklist).filter(Boolean).length}/9 subject_hidden=${!("subject" in v.decodedJournal)}`);
    if (!v.verdict) console.log("  notes:", v.notes);
  } catch (e) {
    console.log("• verifyIdentityBundle skipped (bad ZKORAGE_IDENTITY_BUNDLE):", String((e as Error).message ?? e));
  }
} else {
  console.log("• verifyIdentityBundle skipped (set ZKORAGE_IDENTITY_BUNDLE to a bundle file)");
}

// ---- Week 6: compliance (KYC ∧ not-sanctioned) gate ----
console.log("\n--- compliance (KYC ∧ not-sanctioned gate) ---");

const ccfg = await z.getComplianceConfig();
ok(
  ccfg.image_id.length === 64 && ccfg.claim_type === 4 && ccfg.deny_root.length === 64,
  "compliance get_config",
  `image_id=${ccfg.image_id.slice(0, 12)}… claim_type=${ccfg.claim_type} deny_root=${ccfg.deny_root.slice(0, 12)}…`,
);

ok(await z.isComplianceIssuerAllowed(DEMO_KYC_ISSUER_ID), "compliance is_issuer_allowed(kyc demo)");

const droot = await z.getDenyRoot();
ok(droot === ccfg.deny_root && droot === DENY_ROOT, "get_deny_root matches config + SDK default", `${droot.slice(0, 12)}…`);

// compliance grant for the demo user (present once the on-chain acceptance test has run)
const comp = await z.isCompliant(DEMO_USER.accessorHex);
ok(comp.answer === true || comp.record === null, "isCompliant(demo user)", `answer=${comp.answer} record=${comp.record ? "present" : "none"}`);

const cdenied = await z.isCompliant("00".repeat(32));
ok(cdenied.answer === false, "isCompliant(unknown accessor) denied", `answer=${cdenied.answer}`);

// optional full Groth16 re-verify of a local compliance bundle
const compBundlePath = process.env.ZKORAGE_COMPLIANCE_BUNDLE;
if (compBundlePath) {
  try {
    const b = JSON.parse(readFileSync(compBundlePath, "utf8"));
    const v = await z.verifyComplianceBundle(b);
    ok(
      v.verdict === true,
      "verifyComplianceBundle (full Groth16 re-verify)",
      `verdict=${v.verdict} checks=${Object.values(v.checklist).filter(Boolean).length}/10 subject_hidden=${!("subject" in v.decodedJournal)} denyRootMatches=${v.checklist.denyRootMatches}`,
    );
    if (!v.verdict) console.log("  notes:", v.notes);
  } catch (e) {
    console.log("• verifyComplianceBundle skipped (bad ZKORAGE_COMPLIANCE_BUNDLE):", String((e as Error).message ?? e));
  }
} else {
  console.log("• verifyComplianceBundle skipped (set ZKORAGE_COMPLIANCE_BUNDLE to a bundle file)");
}

// ---- Week 7: confidential payroll (proof-of-income + auditor view-key) ----
console.log("\n--- payroll (confidential proof-of-income + auditor view-key) ---");

const pcfg = await z.getPayrollConfig();
ok(pcfg.image_id.length === 64 && pcfg.claim_type === 5, "payroll get_config", `image_id=${pcfg.image_id.slice(0, 12)}… claim_type=${pcfg.claim_type}`);

ok(await z.isPayrollIssuerAllowed(DEMO_PAYROLL_ATTESTER_ID), "payroll is_issuer_allowed(attester)");
ok(await z.isAuditorAllowed(DEMO_AUDITOR_PUB), "payroll is_auditor_allowed(demo auditor)");

const pcount = await z.getPayrollCount();
ok(pcount >= 1, "payroll get_count", `${pcount}`);

const inc = await z.isIncomeVerified(DEMO_USER.accessorHex);
ok(inc.answer === true || inc.record === null, "isIncomeVerified(demo user)", `answer=${inc.answer} threshold=${inc.record?.threshold ?? "-"} salary_hidden=${inc.record ? !("salary" in inc.record) : "n/a"}`);

const pdenied = await z.isIncomeVerified("00".repeat(32));
ok(pdenied.answer === false, "isIncomeVerified(unknown accessor) denied", `answer=${pdenied.answer}`);

// AUDITOR view-key: open the demo user's disclosure → exact salary + faithful. The demo view secret is
// derived the same way the backend derives it (NOT shipped in the SDK — the auditor holds their own key).
const viewSecretHex = toHex(sha256(new TextEncoder().encode("zkorage-demo-auditor-payroll-view-key")).slice(0, 32));
ok(auditorPublicKeyFromSecret(viewSecretHex) === DEMO_AUDITOR_PUB, "auditor view-key derives the allow-listed pubkey");
if (inc.record) {
  const opened = await z.openPayrollDisclosure(DEMO_USER.accessorHex, viewSecretHex);
  ok(!!opened && opened.faithful === true && BigInt(opened.salary) >= BigInt(inc.record.threshold),
    "openPayrollDisclosure (auditor recovers exact salary, faithful)", `salary=${opened?.salary} faithful=${opened?.faithful}`);
  // a WRONG view key must NOT be faithful
  const wrong = await z.openPayrollDisclosure(DEMO_USER.accessorHex, "11".repeat(32));
  ok(wrong !== null && wrong.faithful === false, "openPayrollDisclosure(wrong key) -> not faithful", `faithful=${wrong?.faithful}`);
} else {
  console.log("• openPayrollDisclosure skipped (no payroll grant yet — run the on-chain acceptance test first)");
}

// optional full Groth16 re-verify of a local payroll bundle
const payBundlePath = process.env.ZKORAGE_PAYROLL_BUNDLE;
if (payBundlePath) {
  try {
    const b = JSON.parse(readFileSync(payBundlePath, "utf8"));
    const v = await z.verifyPayrollBundle(b);
    ok(
      v.verdict === true,
      "verifyPayrollBundle (full Groth16 re-verify)",
      `verdict=${v.verdict} checks=${Object.values(v.checklist).filter(Boolean).length}/10 salary_hidden=${!("salary" in v.decodedJournal)} auditorAllowed=${v.checklist.auditorAllowed}`,
    );
    if (!v.verdict) console.log("  notes:", v.notes);
  } catch (e) {
    console.log("• verifyPayrollBundle skipped (bad ZKORAGE_PAYROLL_BUNDLE):", String((e as Error).message ?? e));
  }
} else {
  console.log("• verifyPayrollBundle skipped (set ZKORAGE_PAYROLL_BUNDLE to a bundle file)");
}

// ── Week 8 — Fundraising (composition) ──
console.log("\n--- fundraising (composition: accredited ∧ revenue ≥ X) ---");
const accCfg = await z.getAccreditedConfig();
ok(accCfg.claim_type === 7, "accredited gate config", `claim_type=${accCfg.claim_type} image=${accCfg.image_id.slice(0, 10)}…`);
const fCfg = await z.getFundraiseConfig();
ok(fCfg.revenue_claim_type === 6, "fundraise config", `claim_type=${fCfg.revenue_claim_type} X=${fCfg.revenue_threshold} gate=${fCfg.accredited_gate.slice(0, 8)}…`);

const revVerified = await z.isFundraiseRevenueVerified();
ok(revVerified === true, "isFundraiseRevenueVerified", `revenueVerified=${revVerified}`);

const acc = await z.isAccredited(DEMO_USER.accessorHex);
ok(acc.answer === true || acc.record === null, "isAccredited(demo user)", `answer=${acc.answer} identity_hidden=${acc.record ? !("subject_id" in acc.record) : "n/a"}`);

// THE composition decision: accredited ∧ revenue → access. The demo user was admitted on-chain.
const ca = await z.canAccessFundraise(DEMO_USER.accessorHex);
ok(ca.answer === true || (ca.revenueVerified && !ca.accredited), "canAccessFundraise(demo user)", `canAccess=${ca.answer} revenueVerified=${ca.revenueVerified} accredited=${ca.accredited}`);

// An unknown accessor: revenue is verified but it is NOT accredited → denied (the AND fails).
const caDenied = await z.canAccessFundraise("00".repeat(32));
ok(caDenied.answer === false && caDenied.accredited === false, "canAccessFundraise(unknown) denied", `canAccess=${caDenied.answer} accredited=${caDenied.accredited} (revenue ${caDenied.revenueVerified} but not accredited)`);

// Optional full Groth16 re-verify of each leg (set ZKORAGE_ACCREDITED_BUNDLE / ZKORAGE_REVENUE_BUNDLE).
const accBundlePath = process.env.ZKORAGE_ACCREDITED_BUNDLE;
if (accBundlePath) {
  try {
    const raw = JSON.parse(readFileSync(accBundlePath, "utf8"));
    const b = raw.bundle ?? raw;
    const v = await z.verifyAccreditedBundle(b);
    ok(v.verdict === true, "verifyAccreditedBundle (full Groth16 re-verify)", `verdict=${v.verdict} checks=${Object.values(v.checklist).filter(Boolean).length}/9 claim_type=${v.decodedJournal.claimType}`);
    if (!v.verdict) console.log("  notes:", v.notes);
  } catch (e) {
    console.log("• verifyAccreditedBundle skipped (bad ZKORAGE_ACCREDITED_BUNDLE):", String((e as Error).message ?? e));
  }
} else {
  console.log("• verifyAccreditedBundle skipped (set ZKORAGE_ACCREDITED_BUNDLE to a bundle file)");
}
const revBundlePath = process.env.ZKORAGE_REVENUE_BUNDLE;
if (revBundlePath) {
  try {
    const raw = JSON.parse(readFileSync(revBundlePath, "utf8"));
    const b = raw.bundle ?? raw;
    const v = await z.verifyRevenueBundle(b);
    ok(v.verdict === true, "verifyRevenueBundle (full Groth16 re-verify)", `verdict=${v.verdict} checks=${Object.values(v.checklist).filter(Boolean).length}/10 thresholdX=${v.thresholdX} revenue_hidden=${!("value" in v.decodedJournal)}`);
    if (!v.verdict) console.log("  notes:", v.notes);
  } catch (e) {
    console.log("• verifyRevenueBundle skipped (bad ZKORAGE_REVENUE_BUNDLE):", String((e as Error).message ?? e));
  }
} else {
  console.log("• verifyRevenueBundle skipped (set ZKORAGE_REVENUE_BUNDLE to a bundle file)");
}

// ── DR1 — Confidential Data Room (data plane: reads + key-free recipient opener) ──
console.log("\n--- dataroom (DR1: anchored documents + key-free recipient opener) ---");
const drCfg = await z.getDataroomConfig();
ok(drCfg.seal_image_id.length === 64 && drCfg.claim_type === CLAIM_TYPE_DATAROOM_SEAL, "dataroom get_config", `image=${drCfg.seal_image_id.slice(0, 10)}… claim_type=${drCfg.claim_type}`);

const roomCount = await z.getRoomCount();
ok(roomCount >= 1, "dataroom get_room_count", `${roomCount}`);

const demoRoom = await z.getRoom(DEMO_DATAROOM.roomId);
ok(demoRoom?.room_id === DEMO_DATAROOM.roomId, "getRoom(demo room)", `owner=${demoRoom?.owner?.slice(0, 8)}… index=${demoRoom?.index}`);

const demoDoc = await z.getDocument(DEMO_DATAROOM.roomId, DEMO_DATAROOM.docId);
ok(
  !!demoDoc && demoDoc.recipient_pub === DEMO_RECIPIENT_PUB && /^[0-9a-f]{64}$/.test(demoDoc.content_hash) && !("plaintext" in (demoDoc ?? {})),
  "getDocument(demo doc) — ciphertext metadata only",
  `content_hash=${demoDoc?.content_hash.slice(0, 10)}… recipient=${demoDoc?.recipient_pub.slice(0, 10)}… pointer=${demoDoc?.blob_pointer?.slice(0, 24)}…`,
);

const docs = await z.listDocuments(DEMO_DATAROOM.roomId, 0, 50);
ok(docs.some((d) => d.doc_id === DEMO_DATAROOM.docId), "listDocuments(demo room)", `${docs.length} doc(s)`);

// The demo recipient SECRET is derived exactly as the backend derives it (NOT shipped in the SDK — a real
// recipient holds their own key). Confirm it derives the on-chain disclosure target.
const recipientSecretHex = toHex(sha256(new TextEncoder().encode("zkorage-demo-dataroom-recipient-key")).slice(0, 32));
ok(recipientPublicKeyFromSecret(recipientSecretHex) === DEMO_RECIPIENT_PUB, "recipient secret derives the sealed-to pubkey");

// KEY-FREE recipient open: recover K, verify the faithful tag, fetch the blob (via the REST API), AEAD-decrypt.
try {
  const opened = await z.openDocument(DEMO_DATAROOM.roomId, DEMO_DATAROOM.docId, recipientSecretHex);
  ok(
    opened.found && opened.faithful && opened.contentHashVerified && opened.plaintextUtf8 === DEMO_DATAROOM.content,
    "openDocument (recover K + faithful tag + content_hash ✓ + AEAD-decrypt)",
    `faithful=${opened.faithful} contentHashVerified=${opened.contentHashVerified} bytes=${opened.plaintext?.length}`,
  );
  if (opened.plaintextUtf8 !== DEMO_DATAROOM.content) console.log("  got:", JSON.stringify(opened.plaintextUtf8));
} catch (e) {
  console.log("• openDocument plaintext skipped (blob source unreachable — set ZKORAGE_API):", String((e as Error).message ?? e));
}

// A WRONG recipient key must NOT be faithful (and must not decrypt) — needs only chain reads, no blob.
const wrongOpen = await z.openDocument(DEMO_DATAROOM.roomId, DEMO_DATAROOM.docId, "11".repeat(32));
ok(wrongOpen.found && wrongOpen.faithful === false && wrongOpen.plaintext === null, "openDocument(wrong key) → not faithful", `faithful=${wrongOpen.faithful}`);

// A never-anchored document → found=false.
const missingDoc = await z.openDocument(DEMO_DATAROOM.roomId, "00".repeat(32), recipientSecretHex);
ok(missingDoc.found === false, "openDocument(unknown doc) → not found", `found=${missingDoc.found}`);

// Optional full Groth16 re-verify of a local seal bundle.
const sealBundlePath = process.env.ZKORAGE_DATAROOM_BUNDLE;
if (sealBundlePath) {
  try {
    const raw = JSON.parse(readFileSync(sealBundlePath, "utf8"));
    const b = raw.bundle ?? raw;
    const v = await z.verifyDataroomBundle(b);
    ok(v.verdict === true, "verifyDataroomBundle (full Groth16 re-verify)", `verdict=${v.verdict} checks=${Object.values(v.checklist).filter(Boolean).length}/7 doc_key_hidden=${!("k" in v.decodedJournal)}`);
    if (!v.verdict) console.log("  notes:", v.notes);
  } catch (e) {
    console.log("• verifyDataroomBundle skipped (bad ZKORAGE_DATAROOM_BUNDLE):", String((e as Error).message ?? e));
  }
} else {
  console.log("• verifyDataroomBundle skipped (set ZKORAGE_DATAROOM_BUNDLE to a bundle file)");
}

// ── DR2 — anonymous eligibility (membership + nullifier) — READ-ONLY, NO key custody ──
console.log("\n--- dataroom DR2 (anonymous eligibility: membership + nullifier reads) ---");
// Stable on testnet from the DR2 Ch2 acceptance (room c1c33201; eligible_root 8be67872; granted accessor
// ed4928c6 with nullifier 2d6ee934). These reads reveal the pseudonymous handle + nullifier ONLY — never
// the identity or which member.
const DR2_ROOM = "c1c33201dad189af07b344cc6b20a9a3e6b75601f04344e618d5281cefa46d75";
const DR2_ROOT = "8be678722c84e8bf478cd0c2a8e257bcc599f80d56ad2839e0188a1cace651da";
const DR2_ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";
const DR2_NULLIFIER = "2d6ee934d52d01f00c08992963a4ca07c73badd57307f9c445c2c625e7b1bf25";

const memImage = await z.getMembershipImageId();
ok(memImage === MEMBERSHIP_IMAGE_ID, "getMembershipImageId (pinned == canonical)", `${memImage?.slice(0, 12)}…`);

const eligRoot = await z.getEligibleRoot(DR2_ROOM);
ok(eligRoot === DR2_ROOT, "getEligibleRoot(demo room)", `${eligRoot?.slice(0, 12)}…`);

const granted = await z.isRoomGranted(DR2_ROOM, DR2_ACCESSOR);
ok(granted === true, "isRoomGranted(demo accessor) = true");

const nfUsed = await z.isNullifierUsed(DR2_ROOM, DR2_NULLIFIER);
ok(nfUsed === true, "isNullifierUsed(demo nullifier) = true");

const grant = await z.getGrant(DR2_ROOM, DR2_ACCESSOR);
ok(grant?.accessor === DR2_ACCESSOR && grant?.nullifier === DR2_NULLIFIER && grant?.eligible_root === DR2_ROOT,
  "getGrant(demo) — pseudonymous record (no identity)", `index=${grant?.index} recipient=${grant?.recipient_pub.slice(0, 8)}…`);

ok((await z.getGrantCount(DR2_ROOM)) >= 1, "getGrantCount(demo room) >= 1");

// decodeMembershipJournal: build the demo proof-A journal from its known fields, decode, assert + verify
// the member's identity is ABSENT (anonymity).
const RECIP = "ad".repeat(32);
const demoJournal = "01" + "00000009" + DR2_ROOM + DR2_ROOT + DR2_NULLIFIER + DR2_ACCESSOR + RECIP;
const dj = decodeMembershipJournal(demoJournal);
ok(
  !!dj && dj.result && dj.claimType === CLAIM_TYPE_MEMBERSHIP && dj.roomId === DR2_ROOM && dj.eligibleRoot === DR2_ROOT &&
    dj.nullifier === DR2_NULLIFIER && dj.accessor === DR2_ACCESSOR && !("idSecret" in (dj as object)),
  "decodeMembershipJournal (165-B; identity ABSENT)", `claimType=${dj?.claimType}`,
);
ok(decodeMembershipJournal("00".repeat(100)) === null, "decodeMembershipJournal(wrong length) → null");

// Optional: full Groth16 re-verify of a membership bundle (set ZKORAGE_MEMBERSHIP_BUNDLE=<bundle.json>).
const memBundlePath = process.env.ZKORAGE_MEMBERSHIP_BUNDLE;
if (memBundlePath) {
  try {
    const b = JSON.parse(readFileSync(memBundlePath, "utf8"));
    const v = await z.verifyMembershipBundle(b);
    ok(v.verdict === true, "verifyMembershipBundle (full Groth16 re-verify)",
      `verdict=${v.verdict} root_pinned=${v.checklist.rootPinned} nullifier_fresh=${v.checklist.nullifierFresh} identity_absent=${!("idSecret" in v.decodedJournal)}`);
    if (!v.verdict) console.log("  notes:", v.notes);
  } catch (e) {
    console.log("• verifyMembershipBundle skipped (bad ZKORAGE_MEMBERSHIP_BUNDLE):", String((e as Error).message ?? e));
  }
} else {
  console.log("• verifyMembershipBundle skipped (set ZKORAGE_MEMBERSHIP_BUNDLE to a bundle file)");
}

// ── DR3 — threshold-ECIES committee (key-free reconstruct + open) ──
console.log("\n--- dataroom DR3 (threshold committee: collect → reconstruct → key-free open) ---");
// Byte-exactness across the SDK / backend / keyper crypto (Shamir + share-ECIES).
try { assertCommitteeFrozenVectors(); ok(true, "committee frozen vectors match (SDK ≡ backend ≡ keyper)"); }
catch (e) { ok(false, "committee frozen vectors match", String((e as Error).message ?? e)); }

const cdoc = await z.getCommitteeDocument(DEMO_DATAROOM_COMMITTEE.roomId, DEMO_DATAROOM_COMMITTEE.docId);
ok(!!cdoc && /^[0-9a-f]{64}$/.test(cdoc.content_hash) && /^[0-9a-f]{64}$/.test(cdoc.k_commitment) && !("k" in (cdoc as object)),
  "getCommitteeDocument(demo) — content_hash + k_commitment (no key)", `content_hash=${cdoc?.content_hash.slice(0, 10)}…`);

// KEY-FREE committee open: collect sealed shares (via the backend aggregator, which gates on the grant),
// open each with the recipient secret, reconstruct K (2-of-3, commitment-gated), fetch the blob, AEAD-decrypt.
try {
  const opened = await z.openCommitteeDocument(DEMO_DATAROOM_COMMITTEE.roomId, DEMO_DATAROOM_COMMITTEE.docId, DEMO_DATAROOM_COMMITTEE.accessor, recipientSecretHex);
  ok(
    opened.found && opened.released && opened.reconstructed && opened.contentHashVerified && !!opened.plaintextUtf8?.includes("committee-released"),
    "openCommitteeDocument (collect → reconstruct 2-of-3 → AEAD-decrypt)",
    `released=${opened.released} faithfulShares=${opened.faithfulShares} pair=${JSON.stringify(opened.reconstructedFromPair)} bytes=${opened.plaintext?.length}`,
  );
} catch (e) {
  console.log("• openCommitteeDocument skipped (backend/keypers unreachable — set ZKORAGE_API + run the committee):", String((e as Error).message ?? e));
}

// A WRONG recipient key → shares don't open faithfully → not reconstructed (no decrypt).
try {
  const wrong = await z.openCommitteeDocument(DEMO_DATAROOM_COMMITTEE.roomId, DEMO_DATAROOM_COMMITTEE.docId, DEMO_DATAROOM_COMMITTEE.accessor, "11".repeat(32));
  ok(wrong.released && wrong.reconstructed === false && wrong.plaintext === null, "openCommitteeDocument(wrong key) → not reconstructed", `faithfulShares=${wrong.faithfulShares}`);
} catch (e) {
  console.log("• openCommitteeDocument(wrong key) skipped:", String((e as Error).message ?? e));
}

// A NON-granted accessor → the committee releases nothing → released=false (no shares, no key).
try {
  const stranger = await z.openCommitteeDocument(DEMO_DATAROOM_COMMITTEE.roomId, DEMO_DATAROOM_COMMITTEE.docId, "ab".repeat(32), recipientSecretHex);
  ok(stranger.released === false && stranger.plaintext === null, "openCommitteeDocument(non-granted accessor) → released=false", `released=${stranger.released}`);
} catch (e) {
  console.log("• openCommitteeDocument(non-granted) skipped:", String((e as Error).message ?? e));
}

// ── DR4 — document-authenticity (signed-PDF / zkPDF fact) — READ-ONLY, NO key custody ──
console.log("\n--- dataroom DR4 (document-authenticity: third-party-signed fact reads) ---");

const docauthImage = await z.getDocauthImageId();
ok(docauthImage === DOCAUTH_IMAGE_ID, "getDocauthImageId (pinned == canonical)", `${docauthImage?.slice(0, 12)}…`);

ok(await z.isDocauthIssuerAllowed(DEMO_DATAROOM_DOCAUTH.issuerKeyHash), "isDocauthIssuerAllowed(demo bank key) → true");
ok((await z.isDocauthIssuerAllowed("ff".repeat(32))) === false, "isDocauthIssuerAllowed(self-minted key) → false (third-party truth)");

// decodeDocauthJournal: build the demo fact journal from its known fields, decode, assert the statement is absent.
const daBeU32 = (n: number) => n.toString(16).padStart(8, "0");
const daBeU64 = (n: bigint) => n.toString(16).padStart(16, "0");
const demoDocauthJournal =
  "01" + daBeU32(CLAIM_TYPE_DOCAUTH) + daBeU32(DEMO_DATAROOM_DOCAUTH.fieldTag) + daBeU64(BigInt(DEMO_DATAROOM_DOCAUTH.threshold)) +
  DEMO_DATAROOM_DOCAUTH.issuerKeyHash + DEMO_DATAROOM_DOCAUTH.roomId + DEMO_DATAROOM_DOCAUTH.msgDigest;
const ddj = decodeDocauthJournal(demoDocauthJournal);
ok(
  ddj !== null && ddj.result && ddj.claimType === 10 && ddj.threshold === DEMO_DATAROOM_DOCAUTH.threshold &&
    ddj.issuerKeyHash === DEMO_DATAROOM_DOCAUTH.issuerKeyHash && ddj.msgDigest === DEMO_DATAROOM_DOCAUTH.msgDigest &&
    !("value" in (ddj as object)) && !("statement" in (ddj as object)),
  "decodeDocauthJournal (113-B; statement + exact value ABSENT)", `claimType=${ddj?.claimType} threshold=${ddj?.threshold}`,
);
ok(decodeDocauthJournal("00".repeat(50)) === null, "decodeDocauthJournal(wrong length) → null");

// The on-chain demo fact (seeded by the DR4 e2e). Soft until the demo proof + attest land; a hard read otherwise.
const demoFact = await z.getDocumentFact(DEMO_DATAROOM_DOCAUTH.roomId, DEMO_DATAROOM_DOCAUTH.msgDigest);
if (demoFact) {
  ok(
    demoFact.threshold === DEMO_DATAROOM_DOCAUTH.threshold && demoFact.issuer_key_hash === DEMO_DATAROOM_DOCAUTH.issuerKeyHash && demoFact.field_tag === 1,
    "getDocumentFact(demo) (value≥threshold proven; statement absent)", `threshold=${demoFact.threshold} issuer=${demoFact.issuer_key_hash.slice(0, 12)}…`,
  );
} else {
  console.log("• getDocumentFact(demo) pending (the DR4 e2e attest hasn't landed yet)");
}

// Optional full Groth16 re-verify of a docauth bundle (set ZKORAGE_DOCAUTH_BUNDLE=<bundle.json>).
if (process.env.ZKORAGE_DOCAUTH_BUNDLE) {
  try {
    const raw = JSON.parse(readFileSync(process.env.ZKORAGE_DOCAUTH_BUNDLE, "utf8"));
    const b = raw.bundle ?? raw;
    const v = await z.verifyDocauthBundle(b);
    ok(v.verdict === true, "verifyDocauthBundle (full Groth16 re-verify + issuer allowlist)",
      `verdict=${v.verdict} checks=${Object.values(v.checklist).filter(Boolean).length}/8 value_hidden=${!("value" in v.decodedJournal)}`);
  } catch (e) {
    console.log("• verifyDocauthBundle skipped (bad ZKORAGE_DOCAUTH_BUNDLE):", String((e as Error).message ?? e));
  }
} else {
  console.log("• verifyDocauthBundle skipped (set ZKORAGE_DOCAUTH_BUNDLE to a bundle file)");
}

// ── DR5 — faithful disclosure / data-side teaser — READ-ONLY, NO key custody ──
console.log("\n--- dataroom DR5 (data-side teaser + auditor redacted view) ---");

const teaserImage = await z.getTeaserImageId();
ok(teaserImage === TEASER_IMAGE_ID, "getTeaserImageId (pinned == the generic value≥threshold guest)", `${teaserImage?.slice(0, 12)}…`);
ok(await z.isTeaserAttesterAllowed(DEMO_TEASER_ATTESTER_ID), "isTeaserAttesterAllowed(demo appraiser) → true");
ok((await z.isTeaserAttesterAllowed("ff".repeat(32))) === false, "isTeaserAttesterAllowed(self-minted key) → false (third-party truth)");

// decodeJournal on the generic 61-byte teaser journal: build from known fields, assert the figure is ABSENT.
const demoTeaserJournal =
  "01" + daBeU32(CLAIM_TYPE_TEASER) + DEMO_TEASER_ATTESTER_ID + daBeU64(BigInt(DEMO_DATAROOM_TEASER.threshold)) +
  daBeU64(BigInt(DEMO_DATAROOM_TEASER.fieldTag)) + daBeU64(9_999_999_999n);
const tdj = decodeJournal(demoTeaserJournal);
ok(
  tdj !== null && tdj.result && tdj.claimType === CLAIM_TYPE_TEASER && tdj.supply === DEMO_DATAROOM_TEASER.threshold &&
    tdj.issuerId === DEMO_TEASER_ATTESTER_ID && !("value" in (tdj as object)) && !("figure" in (tdj as object)),
  "decodeJournal (61-B teaser; figure ABSENT)", `claimType=${tdj?.claimType} threshold=${tdj?.supply} fieldTag(nonce)=${tdj?.nonce}`,
);

// The on-chain demo teaser (seeded by dr5-anchor-demo). Bound to the FULL doc's content_hash; figure private.
const demoTeaser = await z.getTeaser(DEMO_DATAROOM_TEASER.roomId, DEMO_DATAROOM_TEASER.fullDocId);
if (demoTeaser) {
  ok(
    demoTeaser.threshold === DEMO_DATAROOM_TEASER.threshold && demoTeaser.attester === DEMO_TEASER_ATTESTER_ID &&
      demoTeaser.field_tag === DEMO_DATAROOM_TEASER.fieldTag && demoTeaser.content_hash.length === 64,
    "getTeaser(demo) (figure≥threshold proven; figure absent)", `threshold=${demoTeaser.threshold} appraiser=${demoTeaser.attester.slice(0, 12)}… bound=${demoTeaser.content_hash.slice(0, 12)}…`,
  );
  ok(await z.isTeaserValid(DEMO_DATAROOM_TEASER.roomId, DEMO_DATAROOM_TEASER.fullDocId), "isTeaserValid(demo) → true (not expired)");
  ok((await z.getTeaserCount(DEMO_DATAROOM_TEASER.roomId)) >= 1, "getTeaserCount(demo room) ≥ 1");
  const list = await z.listTeasers(DEMO_DATAROOM_TEASER.roomId);
  ok(list.some((t) => t.doc_id === DEMO_DATAROOM_TEASER.fullDocId), "listTeasers(demo) contains the demo teaser");
} else {
  console.log("• getTeaser(demo) pending (run backend/scripts/dr5-anchor-demo.mjs)");
}

// Auditor KEY-FREE open of the redacted view (the SDK never custodies the secret; the demo secret is the
// payroll demo auditor's, derived in-test). Confirms PCI/HIPAA/GDPR masking + faithful binding; wrong key ✗.
const auditorSecretHex = toHex(sha256(new TextEncoder().encode("zkorage-demo-auditor-payroll-view-key")).slice(0, 32));
ok(auditorPublicKeyFromSecret(auditorSecretHex) === DEMO_AUDITOR_PUB, "demo auditor pubkey derives from the demo view secret");
try {
  const opened = await z.openDisclosure(DEMO_DATAROOM_TEASER.roomId, DEMO_DATAROOM_TEASER.viewDocId, auditorSecretHex);
  if (opened.found) {
    const doc = opened.disclosure?.document ?? {};
    ok(
      opened.faithful && opened.contentHashVerified && doc.bank_account === "****1881" && doc.ceo_ssn === "[REDACTED]" &&
        doc.signed_date === "2026" && doc.routing_number === undefined && doc.annual_revenue_usd === 4250000,
      "openDisclosure(demo auditor) → faithful redacted view (PCI/FOIA/HIPAA/GDPR)", `bank=${doc.bank_account} ssn=${doc.ceo_ssn} date=${doc.signed_date}`,
    );
    const wrong = await z.openDisclosure(DEMO_DATAROOM_TEASER.roomId, DEMO_DATAROOM_TEASER.viewDocId, "11".repeat(32));
    ok(wrong.faithful === false, "openDisclosure(wrong view key) → not faithful");
  } else {
    console.log("• openDisclosure(demo) pending (run backend/scripts/dr5-anchor-demo.mjs)");
  }
} catch (e) {
  console.log("• openDisclosure skipped (REST API not reachable for the blob):", String((e as Error).message ?? e));
}

// ── DR6 — private-policy composition + revocation/rotation — READ-ONLY, NO key custody ──
console.log("\n--- dataroom DR6 (private-policy composition + revocation/rotation) ---");
try {
  const pol = await z.getRoomPolicy(DEMO_DATAROOM_POLICY.roomId);
  if (pol) {
    ok(
      pol.require_membership === true && !!pol.compliance_gate && !!pol.accredited_gate,
      "getRoomPolicy(demo) → member ∧ compliance ∧ accredited",
      `comp=${pol.compliance_gate?.slice(0, 8)}… acc=${pol.accredited_gate?.slice(0, 8)}…`,
    );
    const admitted = await z.isAdmitted(DEMO_DATAROOM_POLICY.roomId, DEMO_DATAROOM_POLICY.accessor);
    ok(admitted === true, "isAdmitted(demo accessor) → true (the composite AND)");
    const acc = await z.canAccessRoom(DEMO_DATAROOM_POLICY.roomId, DEMO_DATAROOM_POLICY.accessor);
    ok(
      acc.admitted && acc.membership && acc.compliance === true && acc.accredited === true && acc.revoked === false,
      "canAccessRoom(demo) → all legs ✓ (member ∧ compliance ∧ accredited, not revoked)",
      `member=${acc.membership} comp=${acc.compliance} acc=${acc.accredited}`,
    );
    const epoch = await z.getCommitteeKeyEpoch(DEMO_DATAROOM_POLICY.roomId, DEMO_DATAROOM_POLICY.docId);
    ok(typeof epoch === "number" && epoch >= 0, "getCommitteeKeyEpoch(demo doc) → number", `epoch=${epoch}`);
    const stranger = "ab".repeat(32);
    const strangerAcc = await z.canAccessRoom(DEMO_DATAROOM_POLICY.roomId, stranger);
    ok(strangerAcc.admitted === false, "canAccessRoom(stranger) → not admitted");
  } else {
    console.log("• DR6 demo room pending (run backend/scripts/dr6-anchor-demo.mjs)");
  }
} catch (e) {
  console.log("• DR6 checks skipped:", String((e as Error).message ?? e));
}

console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
