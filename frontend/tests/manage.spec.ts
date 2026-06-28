import { test, expect } from "@playwright/test";

// Room Management — per-room owner settings: the access model (Membership XOR Bonded Access) + discovery
// visibility. Headless Chrome can't load the real extension, so we inject the connected-wallet seam and stub
// the off-chain reads. Visibility moved here from the Membership > Approve tab.
const ADDR = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const SIG_B64 = Buffer.from(new Uint8Array(64).fill(0x07)).toString("base64");
const OWNER_ROOM = "b".repeat(64);
const TOKEN = "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5";
const ISSUER = "GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM";
const MIN = "1000000000";
const DEADLINE = 9999999999;

const mock = `
  localStorage.setItem("zkorage.wallet.connected", "1");
  localStorage.setItem("zkorage.sync.dontAsk", "1");
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
  await page.route("**/escrow/token-balance**", (r) => r.fulfill(json({ owner: ADDR, token: TOKEN, balance: "0", decimals: 7, symbol: "TUSD", issuer: ISSUER })));
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

  // Visibility (moved here): dirty-gated Save + a "Current" badge on the saved tier.
  await expect(page.getByTestId("manage-visibility")).toBeVisible();
  await expect(page.getByTestId("vis-current-private")).toBeVisible(); // the room is Private -> marked Current
  await expect(page.getByTestId("vis-save")).toBeDisabled(); // Private selected, room is Private -> nothing changed
  await page.getByTestId("vis-listed").click();
  // Selecting Listed (not yet saved) leaves Current on the saved tier (Private), like the access model.
  await expect(page.getByTestId("vis-current-private")).toBeVisible();
  await expect(page.getByTestId("vis-current-listed")).toHaveCount(0);
  await page.getByTestId("vis-name").fill("Acme board");
  await expect(page.getByTestId("vis-save")).toBeEnabled();
  await page.getByTestId("vis-save").click();
  await expect(page.getByTestId("vis-saved")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("vis-save")).toBeDisabled();
  // After saving, Current moves to the now-saved tier (Listed).
  await expect(page.getByTestId("vis-current-listed")).toBeVisible();
  await expect(page.getByTestId("vis-current-private")).toHaveCount(0);

  await page.screenshot({ path: "tests/manage.png", fullPage: true });
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("manage: a ?room= link (from Discover 'Your room') auto-selects that room", async ({ page }) => {
  await page.addInitScript(mock);
  await stubs(page, false);
  await page.goto(`/app/dataroom/manage?room=${OWNER_ROOM}`);
  // No chip click needed: the room from the URL is auto-selected once the owner's list loads.
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("manage-owner-room").first()).toHaveAttribute("aria-pressed", "true");
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
  // the deadline is a picker-style trigger (matches the standalone Bonded Access page), not a raw field.
  await expect(page.getByTestId("bond-deadline-trigger")).toBeVisible();
  // a selected token shows its details incl. the issuer for a classic asset.
  await page.getByTestId("bond-token-source").selectOption("classic");
  await page.getByTestId("bond-token-code").fill("TUSD");
  await page.getByTestId("bond-token-issuer").fill("GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM");
  await page.getByTestId("bond-token-classic-resolve").click();
  const detail = page.getByTestId("bond-token-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("TUSD");
  await expect(detail).not.toContainText("decimals"); // Stellar tokens are always 7 dp; not shown
  // the contract + issuer are Stellar Expert links.
  await expect(detail.locator("a").first()).toHaveAttribute("href", /stellar\.expert\/explorer\/testnet\/contract\/C[A-Z2-7]{55}/);
  await expect(detail.getByTestId("bond-token-issuer").locator("a")).toHaveAttribute(
    "href",
    "https://stellar.expert/explorer/testnet/account/GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM",
  );
  // the minimum-amount input and the deadline trigger line up at the top (the alignment fix).
  const minBox = await page.getByTestId("bond-min").boundingBox();
  const dlBox = await page.getByTestId("bond-deadline-trigger").boundingBox();
  expect(Math.abs((minBox?.y ?? 0) - (dlBox?.y ?? 0))).toBeLessThanOrEqual(1);
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

test("manage: switching to membership sticks even if the chain read lags (stale found:true)", async ({ page }) => {
  // Reproduces the bug: after a successful clear, the post-write GET briefly returned the OLD found:true (RPC
  // lag), which flipped the model back so "Switch to membership" reappeared. The reconcile must keep membership
  // and never commit a contradicting stale read. Here the GET stays bond-only for the first 2 reads AFTER the
  // clear, then reports membership.
  await page.addInitScript(mock);
  await stubsCommon(page);
  let cleared = false;
  let postClearReads = 0;
  await page.route("**/dataroom/bond-requirement/**", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    const bond = json({ found: true, scope: "room", bondOpen: true, mode: "open", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: DEADLINE });
    if (!cleared) return r.fulfill(bond);
    // First 2 reads after the clear are stale (still bond-only); later reads reflect the cleared state.
    postClearReads++;
    return r.fulfill(postClearReads <= 2 ? bond : json({ found: false, bondOpen: false }));
  });
  await page.route("**/dataroom/bond-requirement/clear", (r) => { cleared = true; return r.fulfill(json({ ok: true, mode: "xdr", xdr: "AAAA", source: ADDR })); });
  await page.route("**/tx/submit", (r) => r.fulfill(json({ ok: true, txHash: "ab".repeat(8) })));

  await page.goto("/app/dataroom/manage");
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-model-current-bond")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("manage-model-membership").click();
  await page.getByTestId("manage-switch-membership").click();
  await expect.poll(() => cleared, { timeout: 15_000 }).toBe(true);
  // Optimistically membership at once, and it must NOT flip back to the Switch button while the stale reads land.
  await expect(page.getByTestId("manage-switched")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("manage-switch-membership")).toHaveCount(0);
  await expect(page.getByTestId("manage-model-current-membership")).toBeVisible();
  // After the reconcile has polled past the stale window, it is still membership (no regression to bond).
  await expect.poll(() => postClearReads, { timeout: 15_000 }).toBeGreaterThan(2);
  await expect(page.getByTestId("manage-switch-membership")).toHaveCount(0);
  await expect(page.getByTestId("manage-model-current-membership")).toBeVisible();
});

test("manage: switching to membership holds even when the chain read NEVER catches up within the poll window", async ({ page }) => {
  // The harder variant: the post-clear GET keeps returning the OLD found:true for the WHOLE reconcile window
  // (testnet RPC lag exceeding the poll, which is what the user hit). The reconcile must give up by trusting
  // the confirmed clear, never committing the stale read, so the model stays membership without a reload.
  await page.addInitScript(mock);
  await stubsCommon(page);
  let cleared = false;
  let postClearReads = 0;
  const bond = { found: true, scope: "room", bondOpen: true, mode: "open", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: DEADLINE };
  await page.route("**/dataroom/bond-requirement/**", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    if (cleared) postClearReads++;
    return r.fulfill(json(bond)); // ALWAYS bond-only, even after the clear: the read never catches up
  });
  await page.route("**/dataroom/bond-requirement/clear", (r) => { cleared = true; return r.fulfill(json({ ok: true, mode: "xdr", xdr: "AAAA", source: ADDR })); });
  await page.route("**/tx/submit", (r) => r.fulfill(json({ ok: true, txHash: "ab".repeat(8) })));

  await page.goto("/app/dataroom/manage");
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-model-current-bond")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("manage-model-membership").click();
  await page.getByTestId("manage-switch-membership").click();
  await expect.poll(() => cleared, { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId("manage-switched")).toBeVisible({ timeout: 15_000 });
  // Let the reconcile run its full poll course (it stops after the give-up), then confirm it never reverted.
  await expect.poll(() => postClearReads, { timeout: 20_000 }).toBeGreaterThanOrEqual(5);
  await expect(page.getByTestId("manage-model-current-membership")).toBeVisible();
  await expect(page.getByTestId("manage-switch-membership")).toHaveCount(0);
  await expect(page.getByTestId("manage-model-current-bond")).toHaveCount(0);
});

test("manage: clearing from the Current card holds membership even when the read never catches up", async ({ page }) => {
  // Same sustained-lag stress, via the OwnerBondSection "Clear requirement" path, which fires reconcile(true)
  // then reconcile(false). The generation guard must drop the stale true-reconcile so it cannot commit
  // found:true at its give-up; the false-reconcile keeps membership despite the never-catching-up read.
  await page.addInitScript(mock);
  await stubsCommon(page);
  let cleared = false;
  let postClearReads = 0;
  const bond = { found: true, scope: "room", bondOpen: true, mode: "open", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: DEADLINE };
  await page.route("**/dataroom/bond-requirement/**", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    if (cleared) postClearReads++;
    return r.fulfill(json(bond)); // ALWAYS bond-only, even after the clear
  });
  await page.route("**/dataroom/bond-requirement/clear", (r) => { cleared = true; return r.fulfill(json({ ok: true, mode: "xdr", xdr: "AAAA", source: ADDR })); });
  await page.route("**/tx/submit", (r) => r.fulfill(json({ ok: true, txHash: "ab".repeat(8) })));

  await page.goto("/app/dataroom/manage");
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("bond-current")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("bond-clear").click();
  await expect.poll(() => cleared, { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId("manage-membership-panel")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => postClearReads, { timeout: 20_000 }).toBeGreaterThanOrEqual(5);
  await expect(page.getByTestId("manage-model-current-membership")).toBeVisible();
  await expect(page.getByTestId("bond-section")).toHaveCount(0);
  await expect(page.getByTestId("manage-model-current-bond")).toHaveCount(0);
});

test("manage: a bond-only room shows the Current requirement card (standout + contract/issuer links) + a submenu to edit", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(mock);
  await stubs(page, true); // a bond-only room is the current model
  await page.goto("/app/dataroom/manage");
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 15_000 });

  // Bonded Access is current -> the bond panel + requirement section render by default.
  await expect(page.getByTestId("manage-model-current-bond")).toBeVisible();
  await expect(page.getByTestId("bond-section")).toBeVisible();

  // A submenu (Current requirement | Set a new requirement) appears only when a requirement is set, and lands
  // on Current requirement (NOT the empty editor / "Set Bonded Access" button).
  await expect(page.getByTestId("bond-view-current")).toBeVisible();
  await expect(page.getByTestId("bond-view-new")).toBeVisible();
  const current = page.getByTestId("bond-current");
  await expect(current).toBeVisible();
  await expect(page.getByTestId("bond-editor")).toHaveCount(0); // editor hidden while viewing the current req
  await expect(page.getByTestId("bond-set")).toHaveCount(0);

  // The card is the standout (success-tinted) box with a CURRENT badge, the token symbol, and BOTH the
  // contract and the issuer as Stellar Expert links.
  await expect(current).toHaveClass(/bg-success/);
  await expect(page.getByTestId("bond-current-badge")).toBeVisible();
  await expect(page.getByTestId("bond-current-token")).toContainText("TUSD");
  await expect(current.locator(`a[href="https://stellar.expert/explorer/testnet/contract/${TOKEN}"]`)).toBeVisible();
  await expect(page.getByTestId("bond-current-issuer").locator(`a[href="https://stellar.expert/explorer/testnet/account/${ISSUER}"]`)).toBeVisible();
  await expect(page.getByTestId("bond-clear")).toBeVisible();
  await page.screenshot({ path: "tests/manage-bond-current.png", fullPage: true });

  // Switching to "Set a new requirement" reveals the editor (and the replace button); the current card hides.
  await page.getByTestId("bond-view-new").click();
  await expect(page.getByTestId("bond-editor")).toBeVisible();
  await expect(page.getByTestId("bond-set")).toBeVisible();
  await expect(page.getByTestId("bond-deadline-trigger")).toBeVisible();
  await expect(page.getByTestId("bond-current")).toHaveCount(0);

  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("manage: setting a requirement shows a blocking 'do not close this tab' dialog, then lands on Current requirement", async ({ page }) => {
  await page.addInitScript(mock);
  await stubsCommon(page);
  // The GET flips found=false -> found=true once the requirement is saved (mirrors the chain after the write).
  let saved = false;
  await page.route("**/dataroom/bond-requirement/**", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    return r.fulfill(saved
      ? json({ found: true, scope: "room", bondOpen: true, mode: "open", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: DEADLINE })
      : json({ found: false, bondOpen: false }));
  });
  // POST set -> wallet XDR; sign; /tx/submit is delayed so the progress dialog is observable; then qual-root.
  await page.route("**/dataroom/bond-requirement", (r) => { saved = true; return r.fulfill(json({ ok: true, mode: "xdr", xdr: "AAAA", source: ADDR, reqId: "ab".repeat(32) })); });
  await page.route("**/tx/submit", async (r) => { await new Promise((res) => setTimeout(res, 800)); return r.fulfill(json({ ok: true, txHash: "ab".repeat(8) })); });
  await page.route("**/bonded/bond/qual-root", (r) => r.fulfill(json({ ok: true, txHash: "cd".repeat(8), reqId: "ab".repeat(32), qualRoot: "ef".repeat(32) })));

  await page.goto("/app/dataroom/manage");
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 15_000 });
  // Pick Bonded Access (membership is current), then the editor (no requirement yet -> no submenu).
  await page.getByTestId("manage-model-bond").click();
  await expect(page.getByTestId("bond-editor")).toBeVisible();
  await expect(page.getByTestId("bond-view-current")).toHaveCount(0); // no submenu while no requirement is set

  // Resolve a classic token so the Set button enables (no network needed).
  await page.getByTestId("bond-token-source").selectOption("classic");
  await page.getByTestId("bond-token-code").fill("TUSD");
  await page.getByTestId("bond-token-issuer").fill(ISSUER);
  await page.getByTestId("bond-token-classic-resolve").click();
  await expect(page.getByTestId("bond-set")).toBeEnabled();
  await page.getByTestId("bond-set").click();

  // The blocking dialog appears (do not close this tab) while the write is in flight.
  const dialog = page.getByTestId("bond-progress");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Setting up Bonded Access");
  await expect(dialog).toContainText("Do not close this tab");
  await page.screenshot({ path: "tests/manage-bond-progress.png", fullPage: true });

  // When it finishes, the dialog closes, the success note shows, and the view lands on the Current requirement
  // card (the editor + its "Set Bonded Access" button are gone).
  await expect(page.getByTestId("bond-progress")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("bond-set-done")).toBeVisible();
  await expect(page.getByTestId("bond-current")).toBeVisible();
  await expect(page.getByTestId("bond-view-current")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("bond-editor")).toHaveCount(0);
});

test("manage: a bonded room shows the bond-section skeleton before its Current requirement (no editor flash)", async ({ page }) => {
  await page.addInitScript(mock);
  await stubsCommon(page);
  // Delay the bond-requirement GET so both the page-level detail load and the bond-section's own read are
  // observable; the bond section must show its skeleton, never the empty editor, for a room with a requirement.
  await page.route("**/dataroom/bond-requirement/**", async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    await new Promise((res) => setTimeout(res, 500));
    return r.fulfill(json({ found: true, scope: "room", bondOpen: true, mode: "open", gate: "C".repeat(56), reqId: "ab".repeat(32), token: TOKEN, minAmount: MIN, deadline: DEADLINE }));
  });
  await page.goto("/app/dataroom/manage");
  await page.getByTestId("manage-owner-room").first().click();
  await expect(page.getByTestId("bond-section-skeleton")).toBeVisible({ timeout: 15_000 });
  // The empty editor must NOT appear for a room that has a requirement.
  await expect(page.getByTestId("bond-set")).toHaveCount(0);
  await expect(page.getByTestId("bond-current")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("bond-section-skeleton")).toHaveCount(0);
});

test("manage: clearing from the Current card returns to the membership panel", async ({ page }) => {
  await page.addInitScript(mock);
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
  await expect(page.getByTestId("bond-current")).toBeVisible({ timeout: 15_000 });
  // Clear from the OwnerBondSection card -> the panel must land on membership, not the now-empty bond editor.
  await page.getByTestId("bond-clear").click();
  await expect.poll(() => cleared, { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId("manage-membership-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("manage-model-current-membership")).toBeVisible();
  await expect(page.getByTestId("bond-section")).toHaveCount(0);
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
  await page.route("**/escrow/token-balance**", (r) => r.fulfill(json({ owner: ADDR, token: TOKEN, balance: "0", decimals: 7, symbol: "TUSD", issuer: ISSUER })));
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

// Search + "Show more" over the owned-room picker, for an owner with many rooms. The search box appears past
// the threshold, the first page is capped, search filters the full set, and selecting a filtered room loads it.
test("manage: search + 'Show more' over many owned rooms; selecting a filtered room loads it", async ({ page }) => {
  await page.addInitScript(mock);
  await stubsCommon(page);
  await page.route("**/dataroom/bond-requirement/**", (r) => (r.request().method() === "GET" ? r.fulfill(json({ found: false, bondOpen: false })) : r.continue()));
  // 14 owned rooms; "Project Phoenix" sits past the first page so search must scan the whole set.
  const rooms = Array.from({ length: 14 }, (_, i) => ({
    roomId: (i + 1).toString(16).padStart(64, "0"),
    label: i === 13 ? "Project Phoenix" : `Board room ${i}`,
    owner: ADDR, docCount: 0, ledger: 1, visibility: "private", name: null, description: null,
  }));
  await page.route("**/dataroom/rooms?owner=**", (r) => r.fulfill(json({ owner: ADDR, count: rooms.length, dataroomId: "", rooms })));
  await page.goto("/app/dataroom/manage");

  // 14 rooms > threshold 6 -> the search box shows; the first page caps at 12, with a Show more for the rest.
  await expect(page.getByTestId("manage-search-input")).toBeVisible();
  await expect(page.getByTestId("manage-owner-room")).toHaveCount(12);
  await expect(page.getByTestId("manage-show-more-bar")).toContainText("Showing 12 of 14 rooms");

  // Search filters the whole set (Phoenix was on page 2), then selecting the match loads the room's settings.
  await page.getByTestId("manage-search-input").fill("phoenix");
  await expect(page.getByTestId("manage-owner-room")).toHaveCount(1);
  await expect(page.getByTestId("manage-owner-room")).toContainText("Project Phoenix");
  await page.getByTestId("manage-owner-room").click();
  await expect(page.getByTestId("manage-access-model")).toBeVisible({ timeout: 15_000 });

  // Clearing restores the capped first page; a no-match search shows the empty line.
  await page.getByTestId("manage-search-clear").click();
  await expect(page.getByTestId("manage-owner-room")).toHaveCount(12);
  await page.getByTestId("manage-search-input").fill("no-such-room-here");
  await expect(page.getByTestId("manage-search-empty")).toBeVisible();
  // The selected room's detail persists below even when the search hides its chip.
  await expect(page.getByTestId("manage-access-model")).toBeVisible();
});
