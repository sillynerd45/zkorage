import { test, expect, type Page } from "@playwright/test";

// Faucet page: disconnected shows Connect; a connected + funded wallet shows the token list + claim. The
// backend /faucet/* is covered by an on-chain e2e (backend/scripts/faucet-e2e.mjs); here we stub /faucet/info
// + Horizon so the UI is deterministic and offline. Set SHOT_DIR to also capture screenshots.
const DEMO_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";
const SHOT = process.env.SHOT_DIR;

const ASSETS = [
  { code: "TUSD", name: "Test USD stablecoin", issuer: "GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM", sac: "CALISDUWPL24M3LWLOXIWYNRQ42YYMZJ4ZU6UYIVCCB4NH4DMV767NZX" },
  { code: "TGLD", name: "Test gold token", issuer: "GBDNBG6WDCKN4MZUITNRA7WVRMMIA6J6ILOJ76LYEEEOSSG6WT3ILSPA", sac: "CA3CH2YR5TY4IUYBYLCMFSDT2SDY34Q5GFZEDEZ5LOL7BCYY23XYUG57" },
  { code: "TBND", name: "Test bond token", issuer: "GDTZCXVKWTOM42LALZSOQPD2TMDTOIMLZLSRSDWFSX4R2XL77I5EIP2D", sac: "CAGZZDZ2ZKP7C4PXYTBVEN5Z7RVP3275OMHA7JFZK2X2Y4SMGNRZJZQK" },
  { code: "TBIL", name: "Test treasury-bill token", issuer: "GA36SK3SLDXCJJXOUJU3PWT4QWHMLU2GQUF6UQMNBVMISTUA7OVJMU64", sac: "CDOB2L6FVFOH3GFJDI6DD4VA5GW5MLRXPJFSNA3UF7W7EAOM5CA6C3YE" },
];

function freighterMock() {
  return `
    localStorage.setItem("zkorage.wallet.connected", "1");
    localStorage.setItem("zkorage.sync.dontAsk", "1");
    window.__freighterMock = {
      isConnected: async () => ({ isConnected: true }),
      isAllowed: async () => ({ isAllowed: true }),
      requestAccess: async () => ({ address: "${DEMO_G}" }),
      getAddress: async () => ({ address: "${DEMO_G}" }),
      getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
      signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: "${DEMO_G}" }),
    };
  `;
}

function stubFaucetInfo(page: Page) {
  return page.route("**/faucet/info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: true, amount: "10000", windowHours: 24, assets: ASSETS }),
    }),
  );
}

function stubHorizon(page: Page, opts: { funded: boolean; withTrustlines?: boolean }) {
  return page.route("**/horizon-testnet.stellar.org/accounts/**", (route) => {
    if (!opts.funded) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    const balances: unknown[] = [{ asset_type: "native", balance: "9999.5000000" }];
    if (opts.withTrustlines) {
      for (const a of ASSETS)
        balances.push({ asset_type: "credit_alphanum4", asset_code: a.code, asset_issuer: a.issuer, balance: "10000.0000000" });
    }
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balances }) });
  });
}

test("faucet: disconnected shows Connect", async ({ page }) => {
  await stubFaucetInfo(page);
  await page.goto("/faucet");
  await expect(page.getByTestId("faucet-connect")).toBeVisible();
  if (SHOT) await page.screenshot({ path: `${SHOT}/faucet-disconnected.png`, fullPage: true });
});

test("faucet: connected + funded shows the token list + claim", async ({ page }) => {
  await page.addInitScript(freighterMock());
  await stubFaucetInfo(page);
  await stubHorizon(page, { funded: true, withTrustlines: true });
  await page.goto("/faucet");
  await expect(page.getByTestId("faucet-claim")).toBeVisible({ timeout: 8000 });
  await expect(page.getByText("TUSD", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Test gold token")).toBeVisible();
  if (SHOT) await page.screenshot({ path: `${SHOT}/faucet-connected.png`, fullPage: true });
});

test("faucet: unfunded wallet offers friendbot", async ({ page }) => {
  await page.addInitScript(freighterMock());
  await stubFaucetInfo(page);
  await stubHorizon(page, { funded: false });
  await page.goto("/faucet");
  await expect(page.getByTestId("faucet-fund")).toBeVisible({ timeout: 8000 });
});
