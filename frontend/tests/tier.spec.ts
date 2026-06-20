import { test, expect } from "@playwright/test";

// BP5 — anonymous bonded tier. The tab + page render, an identity can be minted (held in the browser),
// the anonymity-set size is surfaced with the small-set warning, and the prove control is gated until the
// set is large enough. The full prove flow is exercised on-chain in the backend e2e (it needs the gate +
// prover). These render-level checks run against the live backend's tier reads.
const DARK = `localStorage.setItem("zkorage-theme","dark");`;

test("tier: the Anonymous Tier tab is present in the bonded group", async ({ page }) => {
  await page.goto("/app/bonded");
  await expect(page.getByTestId("bonded-overview")).toBeVisible();
  await expect(page.getByRole("link", { name: "Anonymous Tier", exact: true })).toBeVisible();
});

test("tier: page renders, identity mints, anonymity-set size + state (light + dark)", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text());
  });

  // The anonymity-set count lands from the live escrow scan (the panel defaults to 0 until that fetch
  // resolves). Capture the AUTHORITATIVE size from the network response so the assertions + screenshot
  // reflect the loaded state, not the pre-fetch default. Robust to the live state (how many qualifying
  // bonds currently exist for the demo tier, which the on-chain e2e populates).
  const waitQual = () => page.waitForResponse((r) => r.url().includes("/bonded/tier/qual-set") && r.status() === 200, { timeout: 30_000 });
  let qualResp = waitQual();
  await page.goto("/app/bonded/tier");
  await expect(page.getByTestId("bonded-tier")).toBeVisible();
  await expect(page.getByTestId("tier-anonset")).toBeVisible({ timeout: 30_000 });
  const size = (await (await qualResp).json()).anonSetSize ?? 0;

  // Mint an anonymous identity (idempotent — if one is already stored, the panel is already showing it).
  const create = page.getByTestId("tier-create-identity");
  if (await create.isVisible().catch(() => false)) {
    await create.click();
  }
  await expect(page.getByTestId("tier-identity")).toBeVisible({ timeout: 15_000 });

  if (size < 3) {
    // Below the minimum anonymity set: the small-set warning shows + proving is gated.
    await expect(page.getByTestId("tier-anonset-warning")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("tier-prove")).toBeDisabled();
  } else {
    // A healthy anonymity set (>= 3 qualifying bonds): no small-set warning; proving is available.
    await expect(page.getByTestId("tier-anonset-warning")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("tier-prove")).toBeEnabled({ timeout: 30_000 });
  }

  await page.screenshot({ path: "tests/bonded-tier.png", fullPage: true });

  await page.addInitScript(DARK);
  qualResp = waitQual();
  await page.reload();
  await expect(page.getByTestId("bonded-tier")).toBeVisible();
  await expect(page.getByTestId("tier-anonset")).toBeVisible({ timeout: 30_000 });
  await qualResp; // let the dark-mode qual-set fetch land so the screenshot shows the real set
  await expect(page.getByTestId("tier-prove")).toBeVisible();
  if (size >= 3) await expect(page.getByTestId("tier-anonset-warning")).toHaveCount(0, { timeout: 30_000 });
  await page.screenshot({ path: "tests/bonded-tier-dark.png", fullPage: true });

  expect(errs, errs.join("\n")).toHaveLength(0);
});
