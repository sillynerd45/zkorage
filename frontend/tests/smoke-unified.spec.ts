import { test, expect } from "@playwright/test";

// Smoke test for the unified marketing-site + sidebar-app structure (U0).
// Verifies both shells mount and the key routes render without runtime errors.

test("landing renders + Open app navigates to /app", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await expect(page.getByTestId("overview")).toBeVisible();
  // marketing top-bar present
  await expect(page.getByTestId("open-app")).toBeVisible();
  await page.getByTestId("open-app").click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByTestId("dashboard")).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("app shell routes render", async ({ page }) => {
  await page.goto("/app/reserves");
  await expect(page.getByTestId("app-page-title")).toContainText("Proof-of-Reserves");
  await expect(page.getByTestId("freighter-connect")).toBeVisible();

  await page.goto("/app/dataroom");
  await expect(page.getByTestId("dataroom-overview")).toBeVisible();

  await page.goto("/app/dataroom/eligibility");
  await expect(page.getByTestId("dr2-card")).toBeVisible();
});

test("public marketing routes render", async ({ page }) => {
  await page.goto("/verify");
  await expect(page.getByText("Verify it yourself").first()).toBeVisible();
  await page.goto("/explorer");
  await expect(page.getByRole("heading", { name: "Explorer" })).toBeVisible();
  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "Documentation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What zkorage is", exact: true })).toBeVisible();
});

test("docs side-rail navigates to developers + glossary", async ({ page }) => {
  await page.goto("/docs");
  await page.getByRole("link", { name: "Developers" }).click();
  await expect(page).toHaveURL(/\/docs\/developers$/);
  await expect(page.getByTestId("dev-demo")).toBeVisible();
  await expect(page.getByTestId("dev-run")).toBeVisible();
  await page.getByRole("link", { name: "Glossary" }).click();
  await expect(page).toHaveURL(/\/docs\/glossary$/);
  await expect(page.getByText("Plain-language glossary")).toBeVisible();
});

test("landing → docs and verify CTAs work", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("hero-open-app")).toBeVisible();
  await expect(page.getByText("What you can prove")).toBeVisible();
  await expect(page.getByText("Don't trust — verify")).toBeVisible();
  await page.getByRole("link", { name: "Verify a proof" }).click();
  await expect(page).toHaveURL(/\/verify$/);
});

// ── Freighter wallet ────────────────────────────────────────────────────────────────────────
// Headless Chrome can't load the real extension, so we inject window.__freighterMock (the seam in
// lib/wallet/client.ts) before the app mounts to drive each connection state.
const DEMO_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";

function freighterMock(opts: { network?: string } = {}) {
  const network = opts.network ?? "TESTNET";
  return `
    localStorage.setItem("zkorage.wallet.connected", "1");
    window.__freighterMock = {
      isConnected: async () => ({ isConnected: true }),
      isAllowed: async () => ({ isAllowed: true }),
      requestAccess: async () => ({ address: "${DEMO_G}" }),
      getAddress: async () => ({ address: "${DEMO_G}" }),
      getNetwork: async () => ({ network: "${network}", networkPassphrase: "Test SDF Network ; September 2015" }),
      signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: "${DEMO_G}" }),
    };
  `;
}

test("wallet shows a connect button when no extension is present", async ({ page }) => {
  await page.goto("/app");
  // No mock + no extension → the control offers to install Freighter (still testid freighter-connect).
  await expect(page.getByTestId("freighter-connect")).toBeVisible();
  await expect(page.getByTestId("freighter-connect")).toContainText(/Install|Connect/);
});

test("wallet silently reconnects and shows the address + menu (testnet)", async ({ page }) => {
  await page.addInitScript(freighterMock());
  await page.goto("/app");
  await expect(page.getByTestId("wallet-address")).toContainText("GABF", { timeout: 5000 });
  await page.getByTestId("freighter-connect").click();
  await expect(page.getByTestId("wallet-menu")).toBeVisible();
  await expect(page.getByTestId("wallet-network")).toHaveText("TESTNET");
  await expect(page.getByTestId("wallet-disconnect")).toBeVisible();
  // disconnect returns to the connect button
  await page.getByTestId("wallet-disconnect").click();
  await expect(page.getByTestId("freighter-connect")).toContainText("Connect");
});

test("wallet flags a wrong network", async ({ page }) => {
  await page.addInitScript(freighterMock({ network: "PUBLIC" }));
  await page.goto("/app");
  await expect(page.getByTestId("wallet-address")).toContainText("Wrong network", { timeout: 5000 });
  await page.getByTestId("freighter-connect").click();
  await expect(page.getByTestId("wallet-network")).toHaveText("PUBLIC");
});
