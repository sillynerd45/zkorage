import { test, expect } from "@playwright/test";

// Switching the ACTIVE account in the Freighter extension while this tab stays focused must propagate into the
// app. Freighter emits no change event, so WalletContext polls getAddress/getNetwork; these tests drive the
// mock's returned address/network at runtime and assert the app follows. (Regression for: stale My Balances,
// the missing "you already hold this bond" warning, and a stale sync toggle after an account switch.)

const A = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";
const B = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

// short(addr, 4) in the wallet pill: first4…last4.
const sh = (h: string) => `${h.slice(0, 4)}…${h.slice(-4)}`;

// A connected testnet mock whose address + network are read live from window flags, so a test can flip either
// mid-run to simulate an in-extension switch. dontAsk is seeded so the consent dialog stays out of the way.
function mock(addr: string) {
  return `
    window.__mockAddr = "${addr}";
    window.__mockNet = "TESTNET";
    localStorage.setItem("zkorage.wallet.connected", "1");
    localStorage.setItem("zkorage.sync.dontAsk", "1");
    window.__freighterMock = {
      isConnected: async () => ({ isConnected: true }),
      isAllowed: async () => ({ isAllowed: true }),
      requestAccess: async () => ({ address: window.__mockAddr }),
      getAddress: async () => ({ address: window.__mockAddr }),
      getNetwork: async () => ({ network: window.__mockNet, networkPassphrase: "Test SDF Network ; September 2015" }),
      signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: window.__mockAddr }),
      signMessage: async () => ({ signedMessage: btoa(String.fromCharCode.apply(null, new Array(64).fill(7))), signerAddress: window.__mockAddr }),
    };
  `;
}

// The connected wallet pill triggers a Horizon balance fetch; stub it so neither test touches the network.
test.beforeEach(async ({ page }) => {
  await page.route("**/horizon-testnet.stellar.org/accounts/**", (route) =>
    route.fulfill({ json: { balances: [{ asset_type: "native", balance: "10000.0000000" }] } }),
  );
});

test("an in-tab Freighter account switch updates the connected address", async ({ page }) => {
  await page.addInitScript(mock(A));
  await page.goto("/app");
  await expect(page.getByTestId("wallet-address")).toHaveText(sh(A));

  // Switch the active account in the extension, with the tab still focused (no blur/focus cycle).
  await page.evaluate((b) => {
    (window as unknown as { __mockAddr: string }).__mockAddr = b;
  }, B);

  // The poll picks it up within a couple of seconds; the wallet pill follows the new account.
  await expect(page.getByTestId("wallet-address")).toHaveText(sh(B), { timeout: 15_000 });
});

test("an account switch to a wrong-network wallet is caught live", async ({ page }) => {
  await page.addInitScript(mock(A));
  await page.goto("/app");
  await expect(page.getByTestId("wallet-address")).toHaveText(sh(A));

  await page.evaluate(() => {
    (window as unknown as { __mockNet: string }).__mockNet = "PUBLIC";
  });

  // The pill shows the wrong-network state without needing a tab refocus.
  await expect(page.getByTestId("wallet-address")).toHaveText("Wrong network", { timeout: 15_000 });
});

test("a locked extension recovers to connected when unlocked, without a reload", async ({ page }) => {
  await page.addInitScript(mock(A));
  await page.goto("/app");
  await expect(page.getByTestId("wallet-address")).toHaveText(sh(A));

  // The extension locks: getAddress returns no address. The app drops to disconnected (the pill goes away).
  await page.evaluate(() => {
    (window as unknown as { __mockAddr: string }).__mockAddr = "";
  });
  await expect(page.getByTestId("wallet-address")).toHaveCount(0, { timeout: 15_000 });

  // It unlocks. Because the user never disconnected, the poll keeps running and promotes back to connected,
  // instead of stranding the app in "disconnected" until a reload.
  await page.evaluate((a) => {
    (window as unknown as { __mockAddr: string }).__mockAddr = a;
  }, A);
  await expect(page.getByTestId("wallet-address")).toHaveText(sh(A), { timeout: 15_000 });
});
