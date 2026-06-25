import { test, expect } from "@playwright/test";

// Room Management — per-room owner settings: the access model (Membership XOR Bonded Access) + discovery
// visibility. Headless Chrome can't load the real extension, so we inject the connected-wallet seam and stub
// the off-chain reads. Visibility moved here from the Membership > Approve tab.
const ADDR = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const SIG_B64 = Buffer.from(new Uint8Array(64).fill(0x07)).toString("base64");
const OWNER_ROOM = "b".repeat(64);
const TOKEN = "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5";
const MIN = "1000000000";
const DEADLINE = 9999999999;

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
const DARK = `localStorage.setItem("zkorage-theme","dark");`;
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

// The reads the Room Management page makes, EXCEPT the bond-requirement GET (each test sets that, since it
// drives the access-model marker).
async function stubsCommon(page: import("@playwright/test").Page) {
  await page.route("**/dataroom/committee/info", (r) => r.fulfill(json({ online: 3, n: 3, threshold: 2 })));
  await page.route("**/dataroom/rooms?owner=**", (r) =>
    r.fulfill(json({ owner: ADDR, count: 1, dataroomId: "", rooms: [{ roomId: OWNER_ROOM, label: "Acme board", owner: ADDR, docCount: 0, ledger: 1, visibility: "private", name: null, description: null }] })));
  await page.route("**/dataroom/enroll/requests/**", (r) => r.fulfill(json({ roomId: OWNER_ROOM, pending: [], memberCount: 0 })));
  await page.route("**/dataroom/enroll/status/**", (r) => r.fulfill(json({ state: "none" })));
  await page.route("**/dataroom/room/visibility", (r) =>
    r.fulfill(json({ ok: true, roomId: OWNER_ROOM, visibility: "listed", name: "Acme board", description: null })));
  await page.route("**/dataroom/rooms-vault/**", (r) => r.fulfill(json({ found: false, blob: null })));
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json({ token: TOKEN, minAmount: MIN, deadline: DEADLINE, reqId: "ab".repeat(32), anonSetSize: 0, minAnonSet: 3, belowMin: true, computedRoot: "cd".repeat(32), published: false, ringLen: 0, locks: [] })));
  await page.route("**/escrow/token-balance**", (r) => r.fulfill(json({ owner: ADDR, token: TOKEN, balance: "0", decimals: 7, symbol: "TUSD" })));
}

// stubsCommon + a STATIC bond-requirement GET (bond-only or membership), for tests that don't toggle it.
async function stubs(page: import("@playwright/test").Page, bondOpen: boolean) {
  await stubsCommon(page);
  await page.route("**/dataroom/bond-requirement/**", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    return r.fulfill(bondOpen
      ? json({ found: true, scope: "room", bondOpen: true, mode: "open", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: DEADLINE })
      : json({ found: false, bondOpen: false }));
  });
}

test("manage: requires a wallet", async ({ page }) => {
  await page.goto("/app/dataroom/manage");
  await expect(page.getByTestId("manage-connect-prompt")).toBeVisible();
});

test("manage: pick a room, see the access model, save visibility", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(mock);
  await stubs(page, false);
  await page.goto("/app/dataroom/manage");

  await expect(page.getByTestId("manage-my-rooms")).toBeVisible();
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 15_000 });
  // Membership is the current model (no bond requirement) -> the membership card is marked current.
  await expect(page.getByTestId("manage-model-current-membership")).toBeVisible();
  await expect(page.getByTestId("manage-membership-panel")).toBeVisible();

  // Visibility (moved here): dirty-gated Save.
  await expect(page.getByTestId("manage-visibility")).toBeVisible();
  await expect(page.getByTestId("vis-save")).toBeDisabled(); // Private selected, room is Private -> nothing changed
  await page.getByTestId("vis-listed").click();
  await page.getByTestId("vis-name").fill("Acme board");
  await expect(page.getByTestId("vis-save")).toBeEnabled();
  await page.getByTestId("vis-save").click();
  await expect(page.getByTestId("vis-saved")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("vis-save")).toBeDisabled();

  await page.screenshot({ path: "tests/manage.png", fullPage: true });
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("manage: picking Bonded Access reveals the requirement editor", async ({ page }) => {
  await page.addInitScript(mock);
  await stubs(page, false);
  await page.goto("/app/dataroom/manage");
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("manage-model-bond").click();
  await expect(page.getByTestId("manage-bond-panel")).toBeVisible();
  await expect(page.getByTestId("bond-section")).toBeVisible();
});

test("manage: a bond-only room can switch back to membership", async ({ page }) => {
  await page.addInitScript(mock);
  // The GET toggles: bond-only until the bond is cleared, then plain membership (mirrors the chain).
  let cleared = false;
  await stubsCommon(page);
  await page.route("**/dataroom/bond-requirement/**", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    return r.fulfill(cleared
      ? json({ found: false, bondOpen: false })
      : json({ found: true, scope: "room", bondOpen: true, mode: "open", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: DEADLINE }));
  });
  await page.route("**/dataroom/bond-requirement/clear", (r) => { cleared = true; return r.fulfill(json({ ok: true, mode: "xdr", xdr: "AAAA", source: ADDR })); });
  await page.route("**/tx/submit", (r) => r.fulfill(json({ ok: true, txHash: "ab".repeat(8) })));

  await page.goto("/app/dataroom/manage");
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 15_000 });
  // Bonded Access is the current model.
  await expect(page.getByTestId("manage-model-current-bond")).toBeVisible();
  // Switch to membership -> clears the bond requirement AND the UI lands on the membership model.
  await page.getByTestId("manage-model-membership").click();
  await page.getByTestId("manage-switch-membership").click();
  await expect.poll(() => cleared, { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId("manage-model-current-membership")).toBeVisible({ timeout: 15_000 });
});

test("manage: renders dark", async ({ page }) => {
  await page.addInitScript(mock + DARK);
  await stubs(page, false);
  await page.goto("/app/dataroom/manage");
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 15_000 });
});

// Loading + persistence: the room list and the selected-room detail show shimmer skeletons while their reads
// run (the stubs are delayed so the skeletons are observable), and the selection + its loaded data are
// restored at once when the owner leaves and returns to Room Management (a client-side tab switch keeps the
// in-memory cache; the data refreshes silently in the background, with no skeleton).
test("manage: skeletons while loading, then the selection persists across a tab switch", async ({ page }) => {
  await page.addInitScript(mock);
  await page.route("**/dataroom/committee/info", (r) => r.fulfill(json({ online: 3, n: 3, threshold: 2 })));
  await page.route("**/dataroom/rooms?owner=**", async (r) => {
    await new Promise((res) => setTimeout(res, 600));
    return r.fulfill(json({ owner: ADDR, count: 1, dataroomId: "", rooms: [{ roomId: OWNER_ROOM, label: "Acme board", owner: ADDR, docCount: 0, ledger: 1, visibility: "private", name: null, description: null }] }));
  });
  await page.route("**/dataroom/enroll/requests/**", async (r) => {
    await new Promise((res) => setTimeout(res, 600));
    return r.fulfill(json({ roomId: OWNER_ROOM, pending: [], memberCount: 2 }));
  });
  await page.route("**/dataroom/enroll/status/**", (r) => r.fulfill(json({ state: "none" })));
  await page.route("**/dataroom/room/visibility", (r) => r.fulfill(json({ ok: true, roomId: OWNER_ROOM, visibility: "private", name: null, description: null })));
  await page.route("**/dataroom/rooms-vault/**", (r) => r.fulfill(json({ found: false, blob: null })));
  await page.route("**/bonded/bond/qual-set**", (r) => r.fulfill(json({ token: TOKEN, minAmount: MIN, deadline: DEADLINE, reqId: "ab".repeat(32), anonSetSize: 0, minAnonSet: 3, belowMin: true, computedRoot: "cd".repeat(32), published: false, ringLen: 0, locks: [] })));
  await page.route("**/escrow/token-balance**", (r) => r.fulfill(json({ owner: ADDR, token: TOKEN, balance: "0", decimals: 7, symbol: "TUSD" })));
  await page.route("**/dataroom/bond-requirement/**", async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    await new Promise((res) => setTimeout(res, 600));
    return r.fulfill(json({ found: false, bondOpen: false }));
  });

  await page.goto("/app/dataroom/manage");
  // 1) the room-list skeleton shows while the owner rooms load, then the real chips replace it.
  await expect(page.getByTestId("manage-my-rooms-skeleton")).toBeVisible();
  await expect(page.getByTestId("manage-my-rooms")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("manage-my-rooms-skeleton")).toHaveCount(0);

  // 2) selecting a room shows the detail skeleton while its settings load, then the real cards.
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-detail-skeleton")).toBeVisible();
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("manage-detail-skeleton")).toHaveCount(0);

  // 3) leave Room Management (client-side nav) and come back: the selection and its loaded detail repaint at
  //    once from cache, with no skeleton.
  await page.getByRole("link", { name: "Overview", exact: true }).first().click();
  await expect(page.getByTestId("dataroom-overview")).toBeVisible();
  await page.getByRole("link", { name: "Room Management", exact: true }).first().click();
  await expect(page.getByTestId("manage-access-model")).toBeVisible();
  await expect(page.getByTestId("manage-detail-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("manage-owner-room").first()).toHaveAttribute("aria-pressed", "true");
});
