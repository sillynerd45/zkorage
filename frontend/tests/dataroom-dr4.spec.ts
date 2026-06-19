import { test, expect } from "@playwright/test";

// DR4 — document-authenticity (zkPDF: third-party truth on self-uploaded data). A bank RSA-signs a private
// statement; the docauth guest re-verifies that REAL RSA-2048 signature in-zkVM and proves "balance >= X"
// WITHOUT revealing the statement or the exact value. Only an allowlisted issuer key is accepted (a
// self-minted key is rejected on-chain). This drives the live stable demo fact (room 7114b210, the mock
// bank issuer 3d181231) seeded by the DR4 e2e — the page reads it + re-verifies its provenance in-browser.

test("dataroom DR4: card renders the pinned image + allowlisted bank issuer; the proven fact shows balance ≥ X with the exact value hidden; on-chain provenance re-verifies", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/dataroom/authenticity");

  // the DR4 card renders; the pinned image + allowlisted issuer are demoted behind a "Verify details"
  // expander (UX pass) — expand it, then assert them
  const card = page.getByTestId("dr4-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("dr4-engine-details").click();
  await expect(page.getByTestId("dr4-image")).not.toHaveText("—", { timeout: 30_000 });
  await expect(page.getByTestId("dr4-image")).toContainText("✓"); // pinned == canonical
  await expect(page.getByTestId("dr4-issuer")).toContainText("allowlisted", { timeout: 30_000 });

  // the proven fact: "balance ≥ X" with the EXACT value hidden (third-party truth, document private)
  await expect(page.getByTestId("dr4-fact")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("dr4-fact-claim")).toContainText("balance ≥");
  await expect(page.getByTestId("dr4-fact-field")).toContainText("balance");
  await expect(page.getByTestId("dr4-value-hidden")).toContainText("never on the public record");

  // --- re-verify the fact's provenance entirely in-browser via the SDK (public RPC) ---
  await page.getByTestId("dr4-verify-btn").click();
  const result = page.getByTestId("dr4-verify-result");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toHaveAttribute("data-verdict", "true", { timeout: 30_000 });
  await expect(page.getByTestId("dr4-verdict-ok")).toBeVisible();

  await page.screenshot({ path: "tests/dataroom-dr4-page.png", fullPage: true });

  const appErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  if (appErrors.length) console.log("CONSOLE ERRORS:", appErrors);
  expect(appErrors, appErrors.join("\n")).toHaveLength(0);
});
