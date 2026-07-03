import { test, expect, type Page } from "@playwright/test";

// The connect-time cross-device sync consent dialog. Unlike the other specs (which seed
// zkorage.sync.noPrompt to skip the dialog), these DO NOT seed it, so the dialog appears, and the mock
// provides signMessage + the vault endpoints are stubbed so the one-signature restore runs offline.

const G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";

// A connected testnet mock WITH signMessage. signMessage returns a 64-byte base64 signature (the HKDF input
// keying material). No dontAsk seed, so the dialog shows on connect.
function mock() {
  return `
    localStorage.setItem("zkorage.wallet.connected", "1");
    window.__freighterMock = {
      isConnected: async () => ({ isConnected: true }),
      isAllowed: async () => ({ isAllowed: true }),
      requestAccess: async () => ({ address: "${G}" }),
      getAddress: async () => ({ address: "${G}" }),
      getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
      signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: "${G}" }),
      signMessage: async () => ({ signedMessage: btoa(String.fromCharCode.apply(null, new Array(64).fill(7))), signerAddress: "${G}" }),
    };
  `;
}

// Stub the three encrypted vault endpoints so the restore's network calls succeed with empty vaults.
async function stubVaults(page: Page) {
  for (const p of [
    "**/dataroom/rooms-vault/**",
    "**/bonded/bond/handle-vault/**",
    "**/bonded/bond/grants-vault/**",
  ]) {
    await page.route(p, (route) => {
      const m = route.request().method();
      if (m === "GET")
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ found: false, blob: null }) });
      if (m === "DELETE")
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, removed: true }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
  }
}

test("the consent dialog appears on connect and can be dismissed", async ({ page }) => {
  await page.addInitScript(mock());
  await stubVaults(page);
  await page.goto("/app");
  await expect(page.getByTestId("sync-consent-dialog")).toBeVisible();
  await expect(page.getByTestId("sync-consent-title")).toContainText("Sync across your devices");
  // the points list names both pillars, so the dialog reads as covering Bonded Access too, not only the Data Room
  await expect(page.getByTestId("sync-consent-point-devices")).toContainText("Bonded Access");
  // initial focus is the non-signing action, so Enter never starts a signature
  await expect(page.getByTestId("sync-consent-dismiss")).toBeFocused();
  await page.getByTestId("sync-consent-dismiss").click();
  await expect(page.getByTestId("sync-consent-dialog")).toHaveCount(0);
  // the app is fully usable after dismiss
  await expect(page.getByTestId("dashboard")).toBeVisible();
});

test("Turn on sync signs once and reads On in the wallet menu", async ({ page }) => {
  await page.addInitScript(mock());
  await stubVaults(page);
  await page.goto("/app");
  await page.getByTestId("sync-consent-enable").click();
  await expect(page.getByTestId("sync-consent-dialog")).toHaveCount(0);
  await page.getByTestId("freighter-connect").click();
  await expect(page.getByTestId("wallet-sync-state")).toHaveText("On");
});

test("Don't ask again means the answer is always Turn on sync", async ({ page }) => {
  await page.addInitScript(mock());
  await stubVaults(page);
  await page.goto("/app");
  // Ticking "don't ask again" disables "Not now": the standing answer becomes Turn on sync.
  await page.getByTestId("sync-consent-dontask").check();
  await expect(page.getByTestId("sync-consent-dismiss")).toBeDisabled();
  await expect(page.getByTestId("sync-consent-dontask-note")).toBeVisible();
  await page.getByTestId("sync-consent-enable").click();
  await expect(page.getByTestId("sync-consent-dialog")).toHaveCount(0);
  // a fresh load (new session) must NOT re-show the dialog, and sync is on (we committed to it)
  await page.reload();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.getByTestId("sync-consent-dialog")).toHaveCount(0);
  await page.getByTestId("freighter-connect").click();
  await expect(page.getByTestId("wallet-sync-state")).toHaveText("On");
});

test("the wallet menu can turn sync on for a user who dismissed the dialog", async ({ page }) => {
  await page.addInitScript(mock());
  await stubVaults(page);
  await page.goto("/app");
  await page.getByTestId("sync-consent-dismiss").click();
  await page.getByTestId("freighter-connect").click();
  await expect(page.getByTestId("wallet-sync-state")).toHaveText("Off");
  await page.getByTestId("wallet-sync").click();
  await expect(page.getByTestId("wallet-sync-state")).toHaveText("On");
});

// Consent is PER WALLET: ticking "don't ask again" on one wallet must NOT silence the prompt for a different
// wallet the user has never decided on. (Regression: a device-wide opt-out was suppressing the dialog for a
// freshly-connected wallet, leaving its sync silently off with no way to choose.)
test("a 'don't ask again' device still prompts for a wallet with no saved preference", async ({ page }) => {
  const PRIOR = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
  await page.addInitScript(mock()); // connects wallet G, which has no saved sync preference
  await page.addInitScript(`
    localStorage.setItem("zkorage.sync.dontAsk", "1");       // device opted out via the checkbox, on a prior wallet
    localStorage.setItem("zkorage.sync.pref.${PRIOR}", "1"); // ...which was decided: sync on
  `);
  await stubVaults(page);
  await page.goto("/app");
  // Wallet G has no saved preference, so despite the device-level "don't ask again", the dialog appears.
  await expect(page.getByTestId("sync-consent-dialog")).toBeVisible();
});

// Login sync must restore BOTH pillars, not just the Data Room. This rounds-trips the REAL backend bond
// handle-vault (no stub): create + back up a handle, simulate a fresh device, then turn on sync from the
// connect dialog and confirm the Bonded Access handle comes back (the user no longer sees "Create a handle").
test("Turn on sync restores the Bonded Access handle, not only Data Room rooms", async ({ page }) => {
  await page.addInitScript(mock());
  await page.route("**/horizon-testnet.stellar.org/accounts/**", (route) =>
    route.fulfill({ json: { balances: [{ asset_type: "native", balance: "10000.0000000" }] } }),
  );

  await page.goto("/app/bonded/tier");
  await page.getByTestId("sync-consent-dismiss").click();
  await page.getByTestId("tier-create-identity").click();
  await expect(page.getByTestId("tier-identity")).toBeVisible({ timeout: 15_000 });
  const handle = (await page.getByTestId("tier-identity").innerText()).match(/[0-9a-f]{6}…[0-9a-f]{6}/)?.[0] ?? "";
  expect(handle).not.toBe("");

  // Fresh device on the same wallet: drop the local handle + the in-memory signature (reload).
  await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith("zkorage-bond-identity"))
      .forEach((k) => localStorage.removeItem(k)),
  );
  await page.reload();
  await expect(page.getByTestId("tier-create-identity")).toBeVisible({ timeout: 15_000 });

  // Turn on sync from the connect dialog: one signature, and the handle is restored on this page.
  await page.getByTestId("sync-consent-enable").click();
  await expect(page.getByTestId("tier-identity")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("tier-identity")).toContainText(handle);
});
