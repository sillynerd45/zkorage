import { test, expect } from "@playwright/test";

// Demo "user wallet" — granted compliance access by the seeded proof. A never-granted account is denied.
const DEMO_USER_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";
const UNKNOWN_ACCESSOR = "11".repeat(32); // 32-byte hex, never granted

// Compliance (KYC ∧ not-sanctioned) gate: a relying party verifies an account is KYC'd & not-sanctioned
// (without learning who it is); an un-granted account is denied; and a SANCTIONED subject cannot produce
// a proof at all (the ✗ case, short-circuited by the deny-list authority — no ~15-min proof needed).
test("compliance: relying party grant/deny + sanctioned subject is rejected", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/compliance");

  // engine card resolves the compliance gate + the sanctions deny-list root
  await expect(page.getByText("Compliance gate")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("deny-root")).toContainText("entries");

  // prover panel renders the controls, incl. the sanctioned "Mallory" option
  await expect(page.getByTestId("subject")).toBeVisible();
  await expect(page.getByTestId("kyc-status")).toBeVisible();
  await expect(page.getByTestId("prove")).toBeVisible();

  // --- relying party: the compliant demo user is granted ---
  const check = page.getByTestId("check-accessor");
  await check.fill(DEMO_USER_G);
  await page.getByTestId("check-access").click();
  const verdict = page.getByTestId("access-verdict");
  await expect(verdict).toBeVisible({ timeout: 30_000 });
  await expect(verdict).toHaveAttribute("data-granted", "true");
  await expect(verdict).toContainText("ACCESS GRANTED");

  // --- relying party: an un-granted account is denied ---
  await check.fill(UNKNOWN_ACCESSOR);
  await page.getByTestId("check-access").click();
  await expect(verdict).toHaveAttribute("data-granted", "false", { timeout: 30_000 });
  await expect(verdict).toContainText("ACCESS DENIED");

  // --- the ✗ case: a SANCTIONED subject cannot generate a non-membership proof (short-circuit) ---
  await page.getByTestId("subject").selectOption("mallory");
  await page.getByTestId("prove").click();
  const reason = page.getByTestId("grant-reject-reason");
  await expect(reason).toBeVisible({ timeout: 30_000 });
  await expect(reason).toContainText("deny-list");

  // compliance grants history lists at least the seeded grant
  await expect(page.getByTestId("access-history")).toBeVisible();

  await page.screenshot({ path: "tests/compliance-page.png", fullPage: true });
  if (consoleErrors.length) console.log("CONSOLE ERRORS:", consoleErrors);
});
