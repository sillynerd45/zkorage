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

test("BA4: the owner Bond-to-enter section warns + blocks when no members are approved", async ({ page }) => {
  await page.addInitScript(mock);
  await stubOwnerCommon(page, 0);
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(json({ found: false })) : r.continue()));
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(0, []))));

  await page.goto("/app/dataroom/membership#approve");
  await page.getByTestId("enroll-owner-room").first().click();
  await expect(page.getByTestId("bond-section")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("bond-need-members")).toContainText("Approve at least one member");
  await expect(page.getByTestId("bond-set")).toBeDisabled();
});

test("BA4: the owner sets a bond requirement via a classic asset", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(mock);
  await stubOwnerCommon(page, 3);
  let set = false;
  await page.route("**/dataroom/bond-requirement/**", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    return r.fulfill(set
      ? json({ found: true, scope: "room", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: DEADLINE })
      : json({ found: false }));
  });
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json(qualSet(0, []))));
  await page.route("**/dataroom/bond-requirement", (r) => r.fulfill(json({ ok: true, mode: "xdr", xdr: "AAAA", source: ADDR, reqId: "ab".repeat(32) })));
  await page.route("**/tx/submit", (r) => { set = true; return r.fulfill(json({ ok: true, txHash: "ab".repeat(8) })); });
  await page.route("**/bonded/bond/qual-root", (r) => r.fulfill(json({ ok: true, txHash: "cd".repeat(8) })));

  await page.goto("/app/dataroom/membership#approve");
  await page.getByTestId("enroll-owner-room").first().click();
  await expect(page.getByTestId("bond-section")).toBeVisible({ timeout: 30_000 });

  // Use the classic-asset path (no Horizon dependency): code + issuer -> SAC derived client-side.
  await page.getByTestId("bond-token-source").selectOption("classic");
  await page.getByTestId("bond-token-code").fill("TUSD");
  await page.getByTestId("bond-token-issuer").fill(ADDR);
  await page.getByTestId("bond-token-classic-resolve").click();
  await expect(page.getByTestId("bond-section")).toContainText("Resolved to SAC");

  await page.getByTestId("bond-set").click();
  await expect(page.getByTestId("bond-set-done")).toContainText("Bond requirement set", { timeout: 30_000 });
  await expect(page.getByTestId("bond-current")).toBeVisible();
  expect(errs, errs.join("\n")).toHaveLength(0);
});
