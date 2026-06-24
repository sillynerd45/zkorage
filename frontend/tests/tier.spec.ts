import { test, expect } from "@playwright/test";

// Standalone Bonded Access (multi-token). The page lets a connected wallet pick ANY token + amount + deadline
// as the requirement, mint an anonymous handle, and (when the anonymity set is large enough) prove. These are
// render-level checks against the live backend's bond reads; the full prove flow is exercised on-chain in the
// backend e2e. A fresh requirement (the stubbed TUSD here) has no qualifying bonds yet, so proving is gated.
const DEPLOYER = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const TUSD_ISSUER = "GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM";
const mock = (addr: string) => `
  localStorage.setItem("zkorage.wallet.connected", "1");
  window.__freighterMock = {
    isConnected: async () => ({ isConnected: true }),
    isAllowed: async () => ({ isAllowed: true }),
    requestAccess: async () => ({ address: "${addr}" }),
    getAddress: async () => ({ address: "${addr}" }),
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: "${addr}" }),
  };
`;
const DARK = `localStorage.setItem("zkorage-theme","dark");`;
const stubHorizon = (page: import("@playwright/test").Page) =>
  page.route("**/horizon-testnet.stellar.org/accounts/**", (route) =>
    route.fulfill({
      json: {
        balances: [
          { asset_type: "credit_alphanum4", asset_code: "TUSD", asset_issuer: TUSD_ISSUER, balance: "207116.0000000" },
          { asset_type: "native", balance: "10000.0000000" },
        ],
      },
    }),
  );

test("tier: the Bonded Access tab is present in the bonded group", async ({ page }) => {
  await page.goto("/app/bonded");
  await expect(page.getByTestId("bonded-overview")).toBeVisible();
  await expect(page.getByRole("link", { name: "Bonded Access", exact: true })).toBeVisible();
});

test("tier: multi-token requirement, handle mints, anonymity-set gating (light + dark)", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text());
  });
  await page.addInitScript(mock(DEPLOYER));
  await stubHorizon(page);

  // The qual-set lands from the live escrow scan for the current requirement (TUSD by default here).
  const waitQual = () => page.waitForResponse((r) => r.url().includes("/bonded/bond/qual-set") && r.status() === 200, { timeout: 30_000 });
  let qualResp = waitQual();
  await page.goto("/app/bonded/tier");
  await expect(page.getByTestId("bonded-tier")).toBeVisible();

  // The requirement is built from the wallet's tokens: the picker lists TUSD + XLM, with an amount + a
  // picker-only deadline trigger (the calendar icon at the right edge, no manual typing).
  const picker = page.getByTestId("tier-token");
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("option", { name: /TUSD/ })).toBeAttached();
  await expect(page.getByRole("option", { name: /XLM/ })).toBeAttached();
  await expect(page.getByTestId("tier-amount")).toBeVisible();
  await expect(page.getByTestId("tier-deadline-trigger")).toBeVisible();
  await expect(page.getByTestId("tier-deadline-trigger")).not.toBeEmpty();

  // The live numbers panel renders.
  await expect(page.getByTestId("tier-numbers")).toBeVisible();
  await expect(page.getByTestId("tier-stat-grants")).toBeVisible();

  const size = (await (await qualResp).json()).anonSetSize ?? 0;

  // Mint an anonymous handle (idempotent: an already-stored handle shows in the panel).
  const create = page.getByTestId("tier-create-identity");
  if (await create.isVisible().catch(() => false)) {
    await create.click();
  }
  await expect(page.getByTestId("tier-identity")).toBeVisible({ timeout: 15_000 });
  // A recovery affordance (re-mint + re-enrol) is offered once a handle exists.
  await expect(page.getByTestId("tier-regen-identity")).toBeVisible();

  // A fresh requirement (stubbed TUSD) has no qualifying bonds, so the small-set warning shows and proving is
  // gated. (If the set has somehow reached the floor, proving is enabled and the warning is absent.)
  await expect(page.getByTestId("tier-anonset")).toBeVisible({ timeout: 30_000 });
  if (size < 3) {
    await expect(page.getByTestId("tier-anonset-warning")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("tier-prove")).toBeDisabled();
  } else {
    await expect(page.getByTestId("tier-anonset-warning")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("tier-prove")).toBeEnabled({ timeout: 30_000 });
  }

  await page.screenshot({ path: "tests/bonded-tier.png", fullPage: true });

  await page.addInitScript(DARK);
  qualResp = waitQual();
  await page.reload();
  await expect(page.getByTestId("bonded-tier")).toBeVisible();
  await expect(page.getByTestId("tier-prove")).toBeVisible({ timeout: 30_000 });
  await (await qualResp).json();
  await page.screenshot({ path: "tests/bonded-tier-dark.png", fullPage: true });

  expect(errs, errs.join("\n")).toHaveLength(0);
});
