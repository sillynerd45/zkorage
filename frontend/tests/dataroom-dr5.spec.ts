import { test, expect } from "@playwright/test";

// DR5 — faithful disclosure / data-side teaser. A teaser proves a public fact about a SEALED document
// (revenue >= $1M) vouched by an allowlisted appraiser, WITHOUT revealing the document or the exact figure;
// a designated auditor separately opens a REDACTED view (PII masked PCI/HIPAA/GDPR), provably the bytes the
// owner committed. No new guest (teaser = generic value≥threshold guest; redacted view = W7 ECIES). Drives
// the stable demo (room e4fec337) seeded by dr5-anchor-demo: the page reads the teaser + re-verifies its
// provenance in-browser, then opens the redacted view KEY-FREE (the view key never leaves the browser).
const WRONG_KEY = "11".repeat(32);

test("dataroom DR5: teaser shows figure ≥ X with the exact figure hidden + provenance re-verifies; auditor opens the redacted view in-browser (faithful, PII masked); wrong key not faithful", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/dataroom/disclosure");

  // the DR5 card renders; the pinned teaser image + appraiser are demoted behind a "Verify details"
  // expander (UX pass) — expand it, then assert them
  const card = page.getByTestId("dr5-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("dr5-engine-details").click();
  await expect(page.getByTestId("dr5-image")).toContainText("value≥threshold");
  await expect(page.getByTestId("dr5-appraiser")).toContainText("allowlisted", { timeout: 30_000 });

  // the teaser: "revenue ≥ X" with the EXACT figure hidden (a fact about a sealed doc)
  await expect(page.getByTestId("dr5-teaser")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("dr5-teaser-claim")).toContainText("revenue ≥");
  await expect(page.getByTestId("dr5-teaser-valid")).toContainText("✓");
  await expect(page.getByTestId("dr5-figure-hidden")).toContainText("never on the public record");

  // --- re-verify the teaser's provenance entirely in-browser via the SDK (public RPC) ---
  await page.getByTestId("dr5-verify-btn").click();
  const verify = page.getByTestId("dr5-verify-result");
  await expect(verify).toBeVisible({ timeout: 30_000 });
  await expect(verify).toHaveAttribute("data-verdict", "true", { timeout: 30_000 });
  await expect(page.getByTestId("dr5-verdict-ok")).toBeVisible();

  // --- AUDITOR redacted-view open (prefilled demo view doc + demo auditor secret) → faithful + masked PII ---
  await page.getByTestId("dr5-open-btn").click();
  const redacted = page.getByTestId("dr5-redacted");
  await expect(redacted).toBeVisible({ timeout: 60_000 });
  await expect(redacted).toHaveAttribute("data-faithful", "true", { timeout: 60_000 });
  await expect(page.getByTestId("dr5-faithful")).toBeVisible();
  const json = page.getByTestId("dr5-redacted-json");
  await expect(json).toContainText("****1881");        // PCI: bank account masked to last 4
  await expect(json).toContainText("[REDACTED]");       // FOIA/HIPAA: SSN redacted
  await expect(json).not.toContainText("4012888888881881"); // the full PAN never appears

  // --- WRONG auditor key → NOT faithful, no plaintext released ---
  await page.getByTestId("dr5-auditor-secret").fill(WRONG_KEY);
  await page.getByTestId("dr5-open-btn").click();
  await expect(redacted).toHaveAttribute("data-faithful", "false", { timeout: 60_000 });
  await expect(page.getByTestId("dr5-not-faithful")).toBeVisible();

  await page.screenshot({ path: "tests/dataroom-dr5-page.png", fullPage: true });

  const appErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  if (appErrors.length) console.log("CONSOLE ERRORS:", appErrors);
  expect(appErrors, appErrors.join("\n")).toHaveLength(0);
});
