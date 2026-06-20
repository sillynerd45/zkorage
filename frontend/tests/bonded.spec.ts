import { test, expect } from "@playwright/test";

// Bonded Proofs (BP2 escrow + BP3/BP4 solvency) — the connected-wallet seam (headless Chrome can't load
// the real extension) points at the DEPLOYER, who on the live testnet escrow owns released locks (#1, #2)
// and active revocable self-bonds (#3, #4). Lock #4 backs a LIVE solvency proof on the gate, so the Prove
// tab shows a SOLVENT badge for this wallet.
const DEPLOYER = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const ACTIVE_LOCK = 4; // revocable, still-locked, and bonded to the solvency proof
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

test("bonded: overview renders, tabs present incl. Prove Solvency (light + dark)", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => {
    // Keep this assertion for real app/JS errors. Ignore transient network resource loads (e.g. the
    // Google-Fonts woff2 the dev server may abort on a fast reload) — those are not app defects.
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text());
  });
  await page.goto("/app/bonded");
  await expect(page.getByTestId("bonded-overview")).toBeVisible();
  await expect(page.getByRole("link", { name: "Prove Solvency", exact: true })).toBeVisible();
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
  // lock #4 is active (revocable self-bond) → Release + Extend; lock #1 is released (no actions).
  await expect(page.getByText(`Lock #${ACTIVE_LOCK}`)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId(`unbond-${ACTIVE_LOCK}`)).toBeVisible();
  await expect(page.getByTestId(`extend-${ACTIVE_LOCK}`)).toBeVisible();
  await expect(page.getByText("Lock #1")).toBeVisible();
  await page.screenshot({ path: "tests/bonded-balances.png", fullPage: true });

  await page.addInitScript(DARK);
  await page.reload();
  await expect(page.getByText(`Lock #${ACTIVE_LOCK}`)).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "tests/bonded-balances-dark.png", fullPage: true });
});

test("bonded: deposit form, mode switcher reveals the recipient", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  await page.goto("/app/bonded/deposit");
  await expect(page.getByTestId("bonded-deposit")).toBeVisible();
  await expect(page.getByTestId("deposit-amount")).toBeVisible();
  // the async balance read must land (value drifts with demos, so don't pin a number)
  await expect(page.getByTestId("deposit-balance")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("bonded-faucet")).toBeVisible(); // demo faucet
  await expect(page.getByTestId("deposit-unlock")).toBeVisible();
  await expect(page.getByTestId("deposit-revocable")).toBeVisible(); // bond mode default
  await expect(page.getByTestId("deposit-submit")).toBeVisible();

  await page.getByTestId("mode-send").click();
  await expect(page.getByTestId("deposit-recipient")).toBeVisible();
  await page.getByTestId("mode-bond").click();
  await expect(page.getByTestId("deposit-revocable")).toBeVisible();

  await page.screenshot({ path: "tests/bonded-deposit.png", fullPage: true });
});

test("bonded: prove tab shows the LIVE solvency badge + the release control (the self-void)", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  await page.goto("/app/bonded/prove");
  await expect(page.getByTestId("bonded-prove")).toBeVisible({ timeout: 60_000 });
  // the live badge polls the gate's is_granted (which re-reads the escrow lock) -> SOLVENT while bonded
  const badge = page.getByTestId("solvency-badge");
  await expect(badge).toHaveAttribute("data-state", "active", { timeout: 60_000 });
  await expect(badge).toContainText("Solvent");
  // the money-shot control: pulling the bond voids the proof
  await expect(page.getByTestId(`release-collateral-${ACTIVE_LOCK}`)).toBeVisible();
  // at least one provable revocable lock is listed
  await expect(page.getByTestId(`prove-solvency-${ACTIVE_LOCK}`)).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "tests/bonded-prove.png", fullPage: true });

  await page.addInitScript(DARK);
  await page.reload();
  await expect(page.getByTestId("solvency-badge")).toHaveAttribute("data-state", "active", { timeout: 60_000 });
  await expect(page.getByTestId(`prove-solvency-${ACTIVE_LOCK}`)).toBeVisible({ timeout: 60_000 }); // let the lock list land
  await page.screenshot({ path: "tests/bonded-prove-dark.png", fullPage: true });
});
