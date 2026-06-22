import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// "Open a document" (redesigned). The member lands on the rooms they are approved for, picks a document, and
// clicks one "Open" button that orchestrates everything. These tests mock Freighter (connected + signMessage)
// and stub the off-chain reads the hook makes. The SDK's chain read (canOpenDocument) hits the real testnet,
// where a freshly-derived accessor is never granted for the demo room (admitted=false), so the
// approved-but-not-proven / below-floor / not-member branches are deterministic. The full granted->open crypto
// path is covered by the live e2e (backend/scripts/m3-live-e2e.mjs).

const ADDR = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const SIG_B64 = Buffer.from(new Uint8Array(64).fill(0x07)).toString("base64");
// The seeded Model B demo room/doc (sdk defaults): a REAL room on testnet, so canOpenDocument resolves.
const ROOM = "9cec7bcada8b0666c59f0b0e435b3a2359960e647204c6dba95f8037631e8fd0";
const DOC = "dc4a61c504f4f528a1bb7fed7f0bfb613e1b85f1053afc32d308f20903e4ac0d";

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

async function stubReads(
  page: import("@playwright/test").Page,
  enrollState: "none" | "pending" | "eligible",
  memberCount: number,
) {
  await page.route("**/dataroom/committee/info", (r) => r.fulfill(json({
    threshold: 2, n: 3, online: 3, dataroomId: "CID", note: "",
    keypers: [1, 2, 3].map((i) => ({ endpoint: `k${i}`, ok: true, keyperIndex: i, shares: 1, sealPub: String(i).repeat(64).slice(0, 64) })),
  })));
  await page.route("**/dataroom/committee/document/**", (r) => r.fulfill(json({
    document: { content_hash: "ab".repeat(32), k_commitment: "cd".repeat(32), pointer: "blob://x" }, dataroomId: "CID",
  })));
  await page.route("**/dataroom/enroll/status/**", (r) => r.fulfill(json({ state: enrollState })));
  await page.route("**/dataroom/membership/eligible/**", (r) => r.fulfill(json({
    roomId: ROOM, memberCount, commitments: [], computedRoot: "00".repeat(32), pinnedRoot: "00".repeat(32), inSync: true,
  })));
  await page.route("**/dataroom/documents/**", (r) => r.fulfill(json({
    roomId: ROOM, count: 1, start: 0, limit: 50, dataroomId: "CID",
    documents: [{ index: 0, room_id: ROOM, doc_id: DOC, content_hash: "cd".repeat(32), blob_pointer: "blob://x", ledger: 1, timestamp: "t", kind: "committee", k_commitment: "ef".repeat(32) }],
  })));
  // The member open is now embedded in the Documents page, so Anchor (getMyRooms) + the directory load too.
  await page.route("**/dataroom/rooms?owner=**", (r) => r.fulfill(json({ owner: ADDR, count: 0, rooms: [], dataroomId: "" })));
  await page.route("**/dataroom/directory", (r) => r.fulfill(json({ count: 0, rooms: [], dataroomId: "" })));
}

test("Open: an approved member is invited to set up access, not told they don't qualify", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(mock);
  await stubReads(page, "eligible", 8); // above the floor

  await page.goto(`/app/dataroom/documents?room=${ROOM}#open`);
  await expect(page.getByTestId("access-room-detail")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("access-open").first().click();

  const status = page.getByTestId("access-status");
  await expect(status).toHaveAttribute("data-phase", "approved", { timeout: 30_000 });
  await expect(page.getByTestId("access-approved")).toContainText("You're approved");
  await expect(page.getByTestId("access-setup-btn")).toBeVisible();
  await expect(page.getByTestId("access-dismiss")).toBeVisible();
  // the old confusing denial wording must be gone
  await expect(status).not.toContainText(/don't qualify/i);

  await page.screenshot({ path: "tests/dataroom-access-approved.png", fullPage: true });
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("Open: setting up access proves once then waits for the batch window (not submitted instantly)", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReads(page, "eligible", 8);
  let queued = 0;
  let requested = 0;
  await page.route("**/dataroom/membership/prove-access", (r) => r.fulfill(json({
    jobId: "job-1", roomId: ROOM, eligibleRoot: "00".repeat(32), nullifier: "ab".repeat(32), accessor: "cd".repeat(32), recipientPub: "ef".repeat(32),
  })));
  await page.route("**/prove-status/**", (r) => r.fulfill(json({
    status: "done", bundle: { seal: "00".repeat(8), image_id: "11".repeat(32), journal: "22".repeat(32) },
  })));
  await page.route("**/dataroom/membership/request-access", (r) => { requested++; return r.fulfill(json({ ok: true })); });
  await page.route("**/dataroom/membership/queue-access", (r) => { queued++; return r.fulfill(json({ ok: true, ticket: "aa".repeat(16), status: "queued", flushAt: Date.now() + 60_000, nextFlushAt: Date.now() + 60_000, windowMs: 60_000 })); });
  await page.route("**/dataroom/membership/queue-status/**", (r) => r.fulfill(json({ ticket: "aa".repeat(16), status: "queued", roomId: ROOM, accessor: "cd".repeat(32), flushAt: Date.now() + 60_000, nextFlushAt: Date.now() + 60_000, windowMs: 60_000, txHash: null, error: null })));

  await page.goto(`/app/dataroom/documents?room=${ROOM}#open`);
  await page.getByTestId("access-open").first().click();
  await expect(page.getByTestId("access-setup-btn")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("access-setup-btn").click();

  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "waiting", { timeout: 30_000 });
  await expect(page.getByTestId("access-waiting")).toContainText("batch window");
  expect(queued).toBe(1);
  expect(requested).toBe(0); // the immediate request-access route is NOT used by the Model B reader
});

test("Open: a room below the anonymity floor blocks opening (red meter)", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReads(page, "eligible", 2); // below the floor

  await page.goto(`/app/dataroom/documents?room=${ROOM}#open`);
  await page.getByTestId("access-open").first().click();
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "below-floor", { timeout: 30_000 });
  await expect(page.getByTestId("anon-meter")).toHaveAttribute("data-tier", "red");
  await expect(page.getByTestId("access-below-floor")).toContainText("5 members");
});

test("Open: a non-member is pointed to request to join", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReads(page, "none", 8);

  await page.goto(`/app/dataroom/documents?room=${ROOM}#open`);
  await page.getByTestId("access-open").first().click();
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "not-member", { timeout: 30_000 });
  await expect(page.getByTestId("access-go-membership")).toHaveAttribute("href", "/app/dataroom/membership");
});

test("Open: lands on approved rooms with directory names + a Refresh; empty state otherwise", async ({ page }) => {
  await page.addInitScript(mock);
  await page.addInitScript(`localStorage.setItem("zkorage.dr.requests.${ADDR}", JSON.stringify([
    { roomId: "${ROOM}", label: "Acme board", state: "eligible", ts: 2 },
    { roomId: "${"7".repeat(64)}", label: "Pending co", state: "pending", ts: 1 },
  ]));`);
  await stubReads(page, "eligible", 8);
  // the public directory gives the approved room a human name + description (like the Discover tab)
  await page.route("**/dataroom/directory", (r) => r.fulfill(json({
    count: 1, rooms: [{ roomId: ROOM, name: "Series A data room", description: "Diligence pack for the round.", memberBucket: "5-19", anonTier: "ok", listedAt: 1 }],
  })));

  await page.goto("/app/dataroom/documents#open");
  // only the APPROVED room appears (not the pending one), shown with its directory name + description
  await expect(page.getByTestId("access-room-row")).toHaveCount(1);
  const row = page.getByTestId("access-room-row").first();
  await expect(row).toContainText("Series A data room");
  await expect(row).toContainText("Diligence pack for the round.");
  await expect(page.getByTestId("access-refresh")).toBeVisible();
  // selecting it loads the room's documents
  await row.click();
  await expect(page.getByTestId("access-room-detail")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("access-doc-row").first()).toBeVisible({ timeout: 30_000 });
});

test("Open: Refresh promotes a newly-approved room into the list", async ({ page }) => {
  await page.addInitScript(mock);
  // local history still says pending; the live enroll status now reports eligible (owner approved since).
  await page.addInitScript(`localStorage.setItem("zkorage.dr.requests.${ADDR}", JSON.stringify([
    { roomId: "${ROOM}", label: "Acme board", state: "pending", ts: 1 },
  ]));`);
  await stubReads(page, "eligible", 8);

  await page.goto("/app/dataroom/documents#open");
  await expect(page.getByTestId("access-rooms-empty")).toBeVisible(); // nothing approved locally yet
  await page.getByTestId("access-refresh").click();
  await expect(page.getByTestId("access-room-row")).toHaveCount(1, { timeout: 30_000 }); // promoted after re-check
});

test("Open: empty state when there are no approved rooms", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReads(page, "none", 0);
  await page.goto("/app/dataroom/documents#open");
  await expect(page.getByTestId("access-rooms-empty")).toBeVisible();
});

test("Open: the open-by-room-id fallback selects a room", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReads(page, "eligible", 8);
  await page.goto("/app/dataroom/documents#open");
  await page.getByTestId("access-manual-toggle").click();
  await page.getByTestId("access-manual-input").fill(ROOM);
  await page.getByTestId("access-manual-btn").click();
  await expect(page.getByTestId("access-room-detail")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("access-doc-row").first()).toBeVisible({ timeout: 30_000 });
});

test("Open: a persisted batch wait resumes after returning to the tab", async ({ page }) => {
  const now = Date.now();
  await page.addInitScript(mock);
  await page.addInitScript(`localStorage.setItem("zkorage.dr.openticket.${ADDR}.${ROOM}", JSON.stringify({
    roomId: "${ROOM}", docId: "${DOC}", ticket: "aa55aa55aa55aa55aa55aa55aa55aa55", flushAt: ${now + 60_000}, windowMs: 60000, ts: ${now}
  }));`);
  await stubReads(page, "eligible", 8);
  await page.route("**/dataroom/membership/queue-status/**", (r) => r.fulfill(json({ ticket: "aa55aa55aa55aa55aa55aa55aa55aa55", status: "queued", roomId: ROOM, accessor: "cd".repeat(32), flushAt: now + 60_000, nextFlushAt: now + 60_000, windowMs: 60_000, txHash: null, error: null })));

  await page.goto("/app/dataroom/documents#open");
  // the tab auto-resumes the queued wait (no need to re-pick the room)
  await expect(page.getByTestId("access-status")).toHaveAttribute("data-phase", "waiting", { timeout: 30_000 });
});

test("Open: renders dark; the approved state reads positive", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(mock);
  await stubReads(page, "eligible", 8);
  await page.goto(`/app/dataroom/documents?room=${ROOM}#open`);
  await page.getByTestId("access-open").first().click();
  await expect(page.getByTestId("access-approved")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "tests/dataroom-access-approved-dark.png", fullPage: true });
});

test("Open: wallet-gated, and the Overview card routes into Documents > Open", async ({ page }) => {
  // no wallet mock -> the embedded member open asks to connect first
  await page.goto("/app/dataroom");
  await expect(page.getByTestId("task-access")).toBeVisible();
  await page.getByTestId("task-access").click();
  await expect(page).toHaveURL(/\/dataroom\/documents#open$/);
  await expect(page.getByTestId("access-connect-prompt")).toBeVisible({ timeout: 30_000 });
});

test("Open: the legacy /access route redirects to Documents > Open, preserving ?room=", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReads(page, "eligible", 8);
  await page.goto(`/app/dataroom/access?room=${ROOM}`);
  // redirected into the consolidated location, room preserved
  await expect(page).toHaveURL(new RegExp(`/dataroom/documents\\?room=${ROOM}#open$`));
  await expect(page.getByTestId("access-room-detail")).toBeVisible({ timeout: 30_000 });
});

test("Open: rooms export to an encrypted file and re-import on another device", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(mock);
  await stubReads(page, "eligible", 8);

  await page.goto("/app/dataroom/documents#open");
  // seed this browser's approved-room history, then reload so the hook reads it
  await page.evaluate((a) => {
    localStorage.setItem(
      `zkorage.dr.requests.${a.addr}`,
      JSON.stringify([{ roomId: a.room, label: "Acme term sheet", state: "eligible", ts: 1 }]),
    );
  }, { addr: ADDR, room: ROOM });
  await page.reload();
  await expect(page.getByTestId("access-room-row").first()).toContainText("Acme term sheet", { timeout: 30_000 });

  // export -> capture the encrypted download
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("access-export").click(),
  ]);
  const dlPath = await download.path();
  expect(dlPath).toBeTruthy();
  const contents = readFileSync(dlPath!, "utf8");
  expect(contents).not.toContain(ROOM); // encrypted: the room id never appears in plaintext
  expect(contents).toContain("AES-256-GCM");
  await expect(page.getByTestId("access-backup-msg")).toContainText("Exported your room list (1)");

  // simulate a fresh device: drop the local history, confirm the list is empty
  await page.evaluate((addr) => localStorage.removeItem(`zkorage.dr.requests.${addr}`), ADDR);
  await page.reload();
  await expect(page.getByTestId("access-rooms-empty")).toBeVisible({ timeout: 30_000 });

  // import the file with the SAME wallet -> the room comes back
  await page.getByTestId("access-import-input").setInputFiles(dlPath!);
  await expect(page.getByTestId("access-backup-msg")).toContainText("Imported 1 room");
  await expect(page.getByTestId("access-room-row").first()).toContainText("Acme term sheet");

  expect(errs, errs.join("\n")).toHaveLength(0);
});
