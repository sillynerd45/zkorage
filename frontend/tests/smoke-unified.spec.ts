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

test("docs pillar sections render, a diagram zooms, and under-the-hood expands", async ({ page }) => {
  await page.goto("/docs/data-room");
  await expect(page.getByRole("heading", { name: "How a document is stored" })).toBeVisible();

  // A flowchart opens a larger described copy in a dialog; Escape closes it.
  await page.getByTestId("diagram-trigger").first().click();
  const dialog = page.getByTestId("diagram-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The layered "Under the hood" reveals the technical detail.
  await page.getByTestId("under-the-hood").first().click();
  await expect(page.getByText("AES-256-GCM").first()).toBeVisible();

  // The Bonded Proofs section renders too.
  await page.goto("/docs/bonded-proofs");
  await expect(page.getByRole("heading", { name: "How a bond is created" })).toBeVisible();

  // The retired Capabilities slug redirects into the Data Room section.
  await page.goto("/docs/capabilities");
  await expect(page).toHaveURL(/\/docs\/data-room$/);
});

test("landing → sections + verify CTAs work", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("hero-open-app")).toBeVisible();
  // the redesigned sections are present
  for (const id of ["how-it-works", "pillars", "pillar-dataroom", "pillar-bonded", "verify-cta", "live-status", "faq", "closing-cta"]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.getByText("Don't trust. Verify.")).toBeVisible();
  // the "Don't trust. Verify." Explorer action navigates
  await page.getByTestId("verify-cta-explorer").click();
  await expect(page).toHaveURL(/\/explorer$/);
  // the smart-input forwards the pasted value to the Verify page as ?q=
  await page.goto("/");
  await page.getByTestId("verify-cta-input").fill("not-a-real-id");
  await page.getByTestId("verify-cta-input").press("Enter");
  await expect(page).toHaveURL(/\/verify\?q=not-a-real-id$/);
});

// ── Freighter wallet ────────────────────────────────────────────────────────────────────────
// Headless Chrome can't load the real extension, so we inject window.__freighterMock (the seam in
// lib/wallet/client.ts) before the app mounts to drive each connection state.
const DEMO_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";

function freighterMock(opts: { network?: string } = {}) {
  const network = opts.network ?? "TESTNET";
  return `
    localStorage.setItem("zkorage.wallet.connected", "1");
  localStorage.setItem("zkorage.sync.dontAsk", "1");
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

// Stub the testnet account lookup so the menu's balance/friendbot logic is deterministic + offline.
function routeHorizon(page: import("@playwright/test").Page, opts: { funded: boolean; balance?: string }) {
  return page.route("**/horizon-testnet.stellar.org/accounts/**", (route) =>
    opts.funded
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ balances: [{ asset_type: "native", balance: opts.balance ?? "10000.0000000" }] }),
        })
      : route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
}

test("wallet silently reconnects and shows the address + menu (testnet)", async ({ page }) => {
  await page.addInitScript(freighterMock());
  await routeHorizon(page, { funded: false });
  await page.goto("/app");
  await expect(page.getByTestId("wallet-address")).toContainText("GABF", { timeout: 5000 });
  await page.getByTestId("freighter-connect").click();
  await expect(page.getByTestId("wallet-menu")).toBeVisible();
  await expect(page.getByTestId("wallet-network")).toHaveText("TESTNET");
  await expect(page.getByTestId("wallet-disconnect")).toBeVisible();
  // disconnect leaves the app for the public landing page
  await page.getByTestId("wallet-disconnect").click();
  await expect(page.getByTestId("overview")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("wallet flags a wrong network", async ({ page }) => {
  await page.addInitScript(freighterMock({ network: "PUBLIC" }));
  await page.goto("/app");
  await expect(page.getByTestId("wallet-address")).toContainText("Wrong network", { timeout: 5000 });
  await page.getByTestId("freighter-connect").click();
  await expect(page.getByTestId("wallet-network")).toHaveText("PUBLIC");
});

test("wallet menu shows the balance when the account is funded (no friendbot)", async ({ page }) => {
  await page.addInitScript(freighterMock());
  await routeHorizon(page, { funded: true, balance: "9999.5000000" });
  await page.goto("/app");
  await page.getByTestId("wallet-address").waitFor({ timeout: 5000 });
  await page.getByTestId("freighter-connect").click();
  await expect(page.getByTestId("wallet-balance")).toContainText("9,999.5");
  await expect(page.getByTestId("wallet-fund")).toHaveCount(0); // no friendbot when already funded
});

test("wallet menu offers friendbot only when the account is unfunded", async ({ page }) => {
  await page.addInitScript(freighterMock());
  await routeHorizon(page, { funded: false });
  await page.goto("/app");
  await page.getByTestId("wallet-address").waitFor({ timeout: 5000 });
  await page.getByTestId("freighter-connect").click();
  await expect(page.getByTestId("wallet-fund")).toBeVisible();
  await expect(page.getByTestId("wallet-balance")).toHaveCount(0);
});
