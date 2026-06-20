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

test("tier: page renders, identity mints, anonymity-set size + warning show (light + dark)", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text());
  });

  await page.goto("/app/bonded/tier");
  await expect(page.getByTestId("bonded-tier")).toBeVisible();

  // The anonymity-set count lands from the live escrow scan (no tier locks yet => 0 => the small-set warning).
  await expect(page.getByTestId("tier-anonset")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tier-anonset-warning")).toBeVisible({ timeout: 30_000 });
  // Proving is gated while the set is below the minimum.
  await expect(page.getByTestId("tier-prove")).toBeDisabled();

  // Mint an anonymous identity (idempotent — if one is already stored, the panel is already showing it).
  const create = page.getByTestId("tier-create-identity");
  if (await create.isVisible().catch(() => false)) {
    await create.click();
  }
  await expect(page.getByTestId("tier-identity")).toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: "tests/bonded-tier.png", fullPage: true });

  await page.addInitScript(DARK);
  await page.reload();
  await expect(page.getByTestId("bonded-tier")).toBeVisible();
  await expect(page.getByTestId("tier-anonset")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "tests/bonded-tier-dark.png", fullPage: true });

  expect(errs, errs.join("\n")).toHaveLength(0);
});
