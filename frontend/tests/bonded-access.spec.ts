import { test, expect } from "@playwright/test";
import { deriveDataRoomIdentity, bondAccessCommitment } from "zkorage-sdk";

// Bonded Access (BA4 owner + BA5 reader). The owner sets a per-room bond requirement; a reader opening a
// bonded document deposits a qualifying bond, then proves it anonymously. These tests mock Freighter and stub
// the off-chain reads. The SDK chain read (canOpenDocument) hits real testnet, where a fresh accessor is
// never admitted (admitted=false), so the bonded branches are deterministic. The full prove->submit->open
// crypto path is covered by the live demo seed (backend/scripts/ba1-bond-anchor-demo.mjs).

const ADDR = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const SIG_BYTES = new Uint8Array(64).fill(0x07);
const SIG_B64 = Buffer.from(SIG_BYTES).toString("base64");
// The seeded Model B demo room/doc (real on testnet, so canOpenDocument resolves).
const ROOM = "9cec7bcada8b0666c59f0b0e435b3a2359960e647204c6dba95f8037631e8fd0";
const DOC = "dc4a61c504f4f528a1bb7fed7f0bfb613e1b85f1053afc32d308f20903e4ac0d";
const TOKEN = "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5"; // zkUSD (real C-address)
const MIN = "1000000000"; // 100 (1e9 base units, 7 decimals)
const DEADLINE = 9999999999;

// The reader's deterministic bond commitment for the fixed identity (so the stubbed qualifying set can include
// or exclude "this member" exactly the way the live qual-set indexer would).
const READER_COMMITMENT = bondAccessCommitment(deriveDataRoomIdentity(SIG_BYTES, ROOM).idSecret).toLowerCase();

const mock = `
  localStorage.setItem("zkorage.wallet.connected", "1");
  window.__freighterMock = {
    isConnected: async () => ({ isConnected: true }),
    isAllowed: async () => ({ isAllowed: true }),
    requestAccess: async () => ({ address: "${ADDR}" }),
    getAddress: async () => ({ address: "${ADDR}" }),
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: "${ADDR}" }),
    signMessage: async () => ({ signedMessage: "${SIG_B64}", signerAddress: "${ADDR}" }),
  };
`;
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

type QualLock = { id: number; commitment: string; amount: string; unlock_time: number; depositor: string };
function qualSet(anonSetSize: number, locks: QualLock[]) {
  return {
    token: TOKEN, minAmount: MIN, deadline: DEADLINE, reqId: "ab".repeat(32),
    anonSetSize, minAnonSet: 3, belowMin: anonSetSize < 3, computedRoot: "cd".repeat(32),
    published: true, ringLen: 1, locks,
  };
}
const decoy = (id: number): QualLock => ({ id, commitment: String(id).repeat(64).slice(0, 64), amount: MIN, unlock_time: DEADLINE, depositor: ADDR });
const mine = (id: number): QualLock => ({ id, commitment: READER_COMMITMENT, amount: MIN, unlock_time: DEADLINE, depositor: ADDR });

// Stub the reads the reader Open page makes (besides bond-requirement + qual-set, set per test).
async function stubReaderCommon(page: import("@playwright/test").Page, enrollState: "none" | "pending" | "eligible") {
  await page.route("**/dataroom/committee/info", (r) => r.fulfill(json({
    threshold: 2, n: 3, online: 3, dataroomId: "CID",
    keypers: [1, 2, 3].map((i) => ({ endpoint: `k${i}`, ok: true, keyperIndex: i, shares: 1, sealPub: String(i).repeat(64).slice(0, 64) })),
  })));
  await page.route("**/dataroom/enroll/status/**", (r) => r.fulfill(json({ state: enrollState })));
  await page.route("**/dataroom/membership/eligible/**", (r) => r.fulfill(json({
    roomId: ROOM, memberCount: 5, commitments: [], computedRoot: "00".repeat(32), pinnedRoot: "00".repeat(32), inSync: true,
  })));
  await page.route("**/dataroom/documents/**", (r) => r.fulfill(json({
    roomId: ROOM, count: 1, start: 0, limit: 50, dataroomId: "CID",
    documents: [{ index: 0, room_id: ROOM, doc_id: DOC, content_hash: "cd".repeat(32), blob_pointer: "blob://x", ledger: 1, timestamp: "t", kind: "committee", k_commitment: "ef".repeat(32) }],
  })));
  await page.route("**/dataroom/rooms?owner=**", (r) => r.fulfill(json({ owner: ADDR, count: 0, rooms: [], dataroomId: "" })));
  await page.route("**/dataroom/directory", (r) => r.fulfill(json({ count: 0, rooms: [], dataroomId: "" })));
  await page.route("**/dataroom/rooms-vault/**", (r) =>
    r.fulfill(json(r.request().method() === "GET" ? { found: false, blob: null } : { ok: true })),
  );
  await page.route("**/escrow/token-balance**", (r) => r.fulfill(json({ owner: ADDR, token: TOKEN, balance: "5000000000", decimals: 7, symbol: "TUSD" })));
}

const bondReqFound = json({ found: true, scope: "room", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: DEADLINE });

async function openTheDoc(page: import("@playwright/test").Page) {
  await page.goto(`/app/dataroom/documents?room=${ROOM}#open`);
  await expect(page.getByTestId("access-room-detail")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("access-open").first().click();
}

// A TRUE bond-only room has no per-document Open while locked (the docs are a read-only preview). Access is
// driven by the ONE room-level "Set up access" action, so the bond-only reader flow starts there.
async function openBondOnlyRoom(page: import("@playwright/test").Page) {
  await page.goto(`/app/dataroom/documents?room=${ROOM}#open`);
  await expect(page.getByTestId("access-bond-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("access-bond-setup").click();
}

test("BA5: a bonded doc with no qualifying bond shows the inline deposit step", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(mock);
  await stubReaderCommon(page, "eligible");
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(bondReqFound) : r.continue()));
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(2, [decoy(1), decoy(2)])))); // no reader lock

  await openTheDoc(page);
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "bond-deposit", { timeout: 30_000 });
  await expect(page.getByTestId("access-bond-deposit")).toContainText("This room requires a bond");
  await expect(page.getByTestId("access-bond-amount")).toHaveValue("100");
  await expect(page.getByTestId("access-bond-lock")).toBeVisible();
  await expect(page.getByTestId("access-bond-deposit")).toContainText("Locking is public");
  await page.screenshot({ path: "tests/bonded-access-deposit.png", fullPage: true });
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("BA5: a qualifying bond at/above the floor offers a one-time prove", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReaderCommon(page, "eligible");
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(bondReqFound) : r.continue()));
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(5, [mine(1), decoy(2), decoy(3), decoy(4), decoy(5)]))));

  await openTheDoc(page);
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "bond-ready", { timeout: 30_000 });
  await expect(page.getByTestId("access-bond-ready")).toContainText("You qualify");
  await expect(page.getByTestId("access-bond-prove")).toBeVisible();
  await expect(page.getByTestId("bond-count")).toHaveAttribute("data-tier", "ok");
});

test("BA5: a qualifying bond below the floor waits for more bonders", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReaderCommon(page, "eligible");
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(bondReqFound) : r.continue()));
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(2, [mine(1), decoy(2)]))));

  await openTheDoc(page);
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "bond-below-floor", { timeout: 30_000 });
  await expect(page.getByTestId("access-bond-below-floor")).toContainText("at least 3 qualifying bonders");
  await expect(page.getByTestId("bond-count")).toHaveAttribute("data-tier", "low");
});

test("BA5: a bonded doc and a non-member is pointed to request to join", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReaderCommon(page, "none");
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(bondReqFound) : r.continue()));
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(3, [decoy(1), decoy(2), decoy(3)]))));

  await openTheDoc(page);
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "bond-not-member", { timeout: 30_000 });
  await expect(page.getByTestId("access-go-membership")).toBeVisible();
});

test("BA5: locking a bond advances from deposit to the prove step", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReaderCommon(page, "eligible");
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(bondReqFound) : r.continue()));
  // Before the deposit: the reader has no qualifying lock. After /tx/submit: they do (and the set hits the floor).
  let deposited = false;
  await page.route("**/bonded/bond/qual-set**", (r) =>
    r.fulfill(json(deposited ? qualSet(3, [mine(9), decoy(2), decoy(3)]) : qualSet(2, [decoy(1), decoy(2)]))),
  );
  await page.route("**/escrow/deposit", (r) => r.fulfill(json({ ok: true, mode: "xdr", xdr: "AAAA", source: ADDR })));
  await page.route("**/tx/submit", (r) => { deposited = true; return r.fulfill(json({ ok: true, txHash: "ab".repeat(8) })); });

  await openTheDoc(page);
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "bond-deposit", { timeout: 30_000 });
  await page.getByTestId("access-bond-lock").click();
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "bond-ready", { timeout: 30_000 });
  await expect(page.getByTestId("access-bond-prove")).toBeVisible();
});

test("BA5: Prove access runs BOTH the membership proof (for the key) and the bond proof (for admission)", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReaderCommon(page, "eligible");
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(bondReqFound) : r.continue()));
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(3, [mine(1), decoy(2), decoy(3)]))));
  let memberProve = 0, bondProve = 0, memberSubmit = 0, bondSubmit = 0;
  await page.route("**/dataroom/membership/prove-access", (r) => { memberProve++; return r.fulfill(json({ jobId: "mem-job", roomId: ROOM, eligibleRoot: "00".repeat(32), nullifier: "ab".repeat(32), accessor: "cd".repeat(32), recipientPub: "ef".repeat(32) })); });
  await page.route("**/bonded/bond/prove", (r) => { bondProve++; return r.fulfill(json({ jobId: "bond-job", roomId: ROOM, reqId: "ab".repeat(32), memberRoot: "00".repeat(32), qualRoot: "11".repeat(32), nullifier: "22".repeat(32), accessor: "cd".repeat(32), anonSetSize: 3 })); });
  await page.route("**/prove-status/**", (r) => r.fulfill(json({ status: "done", bundle: { seal: "00".repeat(8), image_id: "11".repeat(32), journal: "22".repeat(32) } })));
  await page.route("**/dataroom/membership/request-access", (r) => { memberSubmit++; return r.fulfill(json({ ok: true, txHash: "aa".repeat(8), dataroomId: "CID" })); });
  await page.route("**/bonded/bond/submit", (r) => { bondSubmit++; return r.fulfill(json({ ok: true, txHash: "bb".repeat(8) })); });

  await openTheDoc(page);
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "bond-ready", { timeout: 30_000 });
  await page.getByTestId("access-bond-prove").click();
  // The fix: a bonded room needs BOTH a membership grant (recipient_pub -> the keepers seal to it) and a bond
  // grant (is_doc_admitted). Assert both proofs fire and both are recorded directly.
  await expect.poll(() => memberProve, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => bondProve, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => memberSubmit, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => bondSubmit, { timeout: 30_000 }).toBeGreaterThan(0);
});

test("BA5: a bonded doc whose deadline has passed surfaces a clear message, not a failing deposit", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReaderCommon(page, "eligible");
  const past = Math.floor(Date.now() / 1000) - 3600; // an hour ago
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET"
    ? r.fulfill(json({ found: true, scope: "room", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: past }))
    : r.continue()));
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(0, []))));

  await openTheDoc(page);
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "error", { timeout: 30_000 });
  await expect(page.getByTestId("access-error")).toContainText("bond deadline has passed");
});

// ── BA4 owner ──
async function stubOwnerCommon(page: import("@playwright/test").Page, memberCount: number) {
  await page.route("**/dataroom/rooms?owner=**", (r) => r.fulfill(json({
    owner: ADDR, count: 1, dataroomId: "CID",
    rooms: [{ roomId: ROOM, label: "My room", owner: ADDR, docCount: 1, ledger: 1, visibility: "private", name: null, description: null }],
  })));
  await page.route("**/dataroom/enroll/requests/**", (r) => r.fulfill(json({ roomId: ROOM, pending: [], memberCount })));
  await page.route("**/dataroom/rooms-vault/**", (r) => r.fulfill(json({ found: false, blob: null })));
  await page.route("**/escrow/token-balance**", (r) => r.fulfill(json({ owner: ADDR, token: TOKEN, balance: "0", decimals: 7, symbol: "TUSD" })));
}

test("Room Management: Bonded Access needs no approved members (no member gate)", async ({ page }) => {
  await page.addInitScript(mock);
  await stubOwnerCommon(page, 0); // ZERO approved members
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(json({ found: false, bondOpen: false })) : r.continue()));
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(0, []))));

  await page.goto("/app/dataroom/manage");
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 30_000 });
  // Pick the Bonded Access model -> the requirement editor shows, with NO "approve a member first" gate.
  await page.getByTestId("manage-model-bond").click();
  await expect(page.getByTestId("bond-section")).toBeVisible();
  await expect(page.getByTestId("bond-need-members")).toHaveCount(0); // the old member gate is gone
});

test("Room Management: the owner sets Bonded Access via a classic asset", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(mock);
  await stubOwnerCommon(page, 0); // bond-only needs no members
  let set = false;
  await page.route("**/dataroom/bond-requirement/**", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    return r.fulfill(set
      ? json({ found: true, scope: "room", bondOpen: true, mode: "open", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: DEADLINE })
      : json({ found: false, bondOpen: false }));
  });
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(0, []))));
  let setBody: Record<string, unknown> = {};
  await page.route("**/dataroom/bond-requirement", (r) => { setBody = (r.request().postDataJSON() ?? {}) as Record<string, unknown>; return r.fulfill(json({ ok: true, mode: "xdr", xdr: "AAAA", source: ADDR, reqId: "ab".repeat(32) })); });
  await page.route("**/tx/submit", (r) => { set = true; return r.fulfill(json({ ok: true, txHash: "ab".repeat(8) })); });
  await page.route("**/bonded/bond/qual-root", (r) => r.fulfill(json({ ok: true, txHash: "cd".repeat(8) })));

  await page.goto("/app/dataroom/manage");
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("manage-model-bond").click();
  await expect(page.getByTestId("bond-section")).toBeVisible();

  // Use the classic-asset path (no Horizon dependency): code + issuer -> SAC derived client-side.
  await page.getByTestId("bond-token-source").selectOption("classic");
  await page.getByTestId("bond-token-code").fill("TUSD");
  await page.getByTestId("bond-token-issuer").fill(ADDR);
  await page.getByTestId("bond-token-classic-resolve").click();
  await expect(page.getByTestId("bond-token-detail")).toContainText("TUSD"); // the resolved token's detail line

  await page.getByTestId("bond-set").click();
  await expect(page.getByTestId("bond-set-done")).toContainText("Bonded Access set", { timeout: 30_000 });
  await expect(page.getByTestId("bond-current")).toBeVisible();
  // The owner UI must request the TRUE bond-only mode (not the legacy membership-bond), or the room would
  // still need approval.
  expect(setBody.mode, "set-requirement must send mode 'open'").toBe("open");
  expect(errs, errs.join("\n")).toHaveLength(0);
});

// ── TRUE bond-only reader (no approval, no enrollment) ──
const bondReqOpen = json({ found: true, scope: "room", bondOpen: true, mode: "open", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: DEADLINE });

test("bond-only: a non-member reader goes straight to deposit (no approval needed)", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReaderCommon(page, "none"); // NOT enrolled, never asked to join
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(bondReqOpen) : r.continue()));
  // 3 other bonders (at the floor), reader not among them -> they must deposit.
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(3, [decoy(1), decoy(2), decoy(3)]))));

  await openBondOnlyRoom(page);
  // The key difference from the membership-bond path: a non-member is NOT dead-ended at "bond-not-member".
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "bond-deposit", { timeout: 30_000 });
  await expect(page.getByTestId("access-bond-deposit")).toBeVisible();
});

test("bond-only: prove runs ONLY the bond-open proof, never a membership proof", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReaderCommon(page, "none");
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(bondReqOpen) : r.continue()));
  // The reader already holds a qualifying bond (their commitment is in the set), at the floor.
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(3, [mine(10), decoy(2), decoy(3)]))));
  let openProve = 0;
  let memberProve = 0;
  await page.route("**/bonded/bond-open/prove", (r) => { openProve++; return r.fulfill(json({ jobId: "bo-job", reqId: "ab".repeat(32), accessor: "cd".repeat(32), recipientPub: "ef".repeat(32) })); });
  await page.route("**/dataroom/membership/prove-access", (r) => { memberProve++; return r.fulfill(json({ jobId: "mem-job" })); });
  // Keep the prover job pending so the flow parks in "proving" after the prove call (we only assert routing).
  await page.route("**/prove-status/**", (r) => r.fulfill(json({ status: "pending" })));

  await openBondOnlyRoom(page);
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "bond-ready", { timeout: 30_000 });
  await page.getByTestId("access-bond-prove").click();
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "proving", { timeout: 30_000 });
  // Only the bond-open proof runs; the membership proof is never started (no enrollment for a bond-only room).
  await expect.poll(() => openProve, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(memberProve).toBe(0);
});

test("bond-only: the Open page shows a named bonded panel + a room-level Set up access", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  const ISSUER = "GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM";
  await page.addInitScript(mock);
  await stubReaderCommon(page, "none");
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(bondReqOpen) : r.continue()));
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(1, [decoy(1)])))); // 1 of 3, below the floor
  // a directory NAME for the room + an issuer for the token, so the panel can show both.
  await page.route("**/dataroom/directory", (r) => r.fulfill(json({ count: 1, dataroomId: "", rooms: [{ roomId: ROOM, name: "Acme bonded room", description: "deal", memberBucket: "under 5", anonTier: "forming", listedAt: 1 }] })));
  await page.route("**/escrow/token-balance**", (r) => r.fulfill(json({ owner: ADDR, token: TOKEN, balance: "5000000000", decimals: 7, symbol: "TUSD", issuer: ISSUER })));

  await page.goto(`/app/dataroom/documents?room=${ROOM}#open`);
  // The bonded panel NAMES the room (so it is not mistaken for one of your accessible rooms) and shows the
  // requirement in detail.
  const panel = page.getByTestId("access-bond-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("access-room-name")).toContainText("Bonded Access · Acme bonded room");
  const req = page.getByTestId("access-bond-req-detail");
  await expect(req).toContainText("TUSD");
  await expect(req).toContainText(/:\d{2}/); // the deadline includes the time
  await expect(req.locator(`a[href="https://stellar.expert/explorer/testnet/contract/${TOKEN}"]`)).toBeVisible();
  await expect(page.getByTestId("access-bond-req-issuer").locator(`a[href="https://stellar.expert/explorer/testnet/account/${ISSUER}"]`)).toBeVisible();
  // The set count + a single room-level "Set up access" action (not buried per-document).
  await expect(panel.getByTestId("bond-count")).toBeVisible();
  await expect(page.getByTestId("access-bond-setup")).toContainText("Set up access");
  // The privacy note is bond-aware (NOT the membership "approved members" copy).
  await expect(page.getByTestId("access-privacy")).toContainText("qualifying bond");
  await expect(page.getByTestId("access-privacy")).not.toContainText("members the owner approved");

  // While locked (no access yet) the documents are a read-only preview: a "Locked" pill, never a misleading
  // per-document "Open" button. A one-line note points to the single room-level action.
  await expect(page.getByTestId("access-docs-locked-note")).toContainText("Set up access to open");
  await expect(page.getByTestId("access-doc-locked").first()).toBeVisible();
  await expect(page.getByTestId("access-open")).toHaveCount(0);

  // Clicking the room-level "Set up access" drives the flow to the deposit step, shown at the room level.
  await page.getByTestId("access-bond-setup").click();
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "bond-deposit", { timeout: 30_000 });
  await expect(page.getByTestId("access-bond-deposit")).toBeVisible();
  await page.screenshot({ path: "tests/bonded-open-panel.png", fullPage: true });
  expect(errs, errs.join("\n")).toHaveLength(0);
});
