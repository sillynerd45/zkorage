import { test, expect } from "@playwright/test";

// Bonded Proofs (BP2) — the escrow pillar: Overview, My Balances, Deposit. The connected-wallet seam
// (headless Chrome can't load the real extension) points at the DEPLOYER, who owns lock #1 (released)
// and lock #2 (active, revocable self-bond) on the live testnet escrow.
const DEPLOYER = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
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

test("bonded: overview renders, tabs present (light + dark)", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto("/app/bonded");
  await expect(page.getByTestId("bonded-overview")).toBeVisible();
  await expect(page.getByRole("link", { name: "Lock tokens" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "My Balances", exact: true })).toBeVisible();
  await page.screenshot({ path: "tests/bonded-overview.png", fullPage: true });

  await page.addInitScript(DARK);
  await page.reload();
  await expect(page.getByTestId("bonded-overview")).toBeVisible();
  await page.screenshot({ path: "tests/bonded-overview-dark.png", fullPage: true });

  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("bonded: my balances lists the wallet's locks with the right actions", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  await page.goto("/app/bonded/balances");
  await expect(page.getByTestId("bonded-balances")).toBeVisible({ timeout: 60_000 });
  // lock #2 is active (revocable self-bond) → Release + Extend; lock #1 is released (no actions).
  await expect(page.getByText("Lock #2")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("unbond-2")).toBeVisible();
  await expect(page.getByTestId("extend-2")).toBeVisible();
  await expect(page.getByText("Lock #1")).toBeVisible();
  await page.screenshot({ path: "tests/bonded-balances.png", fullPage: true });

  await page.addInitScript(DARK);
  await page.reload();
  await expect(page.getByText("Lock #2")).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "tests/bonded-balances-dark.png", fullPage: true });
});

test("bonded: deposit form, mode switcher reveals the recipient", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  await page.goto("/app/bonded/deposit");
  await expect(page.getByTestId("bonded-deposit")).toBeVisible();
  await expect(page.getByTestId("deposit-amount")).toBeVisible();
  await expect(page.getByTestId("deposit-unlock")).toBeVisible();
  await expect(page.getByTestId("deposit-revocable")).toBeVisible(); // bond mode default
  await expect(page.getByTestId("deposit-submit")).toBeVisible();

  await page.getByTestId("mode-send").click();
  await expect(page.getByTestId("deposit-recipient")).toBeVisible();
  await page.getByTestId("mode-bond").click();
  await expect(page.getByTestId("deposit-revocable")).toBeVisible();

  await page.screenshot({ path: "tests/bonded-deposit.png", fullPage: true });
});
