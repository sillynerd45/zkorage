import { test, expect } from "@playwright/test";

// Demo "user wallet" — granted access by the seeded KYC proof. A never-granted account is denied.
const DEMO_USER_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";
const UNKNOWN_ACCESSOR = "11".repeat(32); // 32-byte hex, never granted

// Identity / KYC gate: a relying party verifies an account is KYC-gated (without learning who it is),
// and an un-granted account is denied. (The ~8-min proof generation is validated out-of-band over SSH.)
test("identity: relying party — KYC'd account granted, unknown denied", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/identity");

  // engine card resolves the gate + KYC provider
  await expect(page.getByText("KYC gate")).toBeVisible({ timeout: 30_000 });

  // prover panel renders the controls (identity stays private)
  await expect(page.getByTestId("subject")).toBeVisible();
  await expect(page.getByTestId("kyc-status")).toBeVisible();
  await expect(page.getByTestId("prove")).toBeVisible();

  // --- relying party: the KYC'd demo user is granted ---
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

  // access history lists at least the seeded grant
  const history = page.getByTestId("access-history");
  await expect(history).toBeVisible();

  await page.screenshot({ path: "tests/identity-page.png", fullPage: true });
  if (consoleErrors.length) console.log("CONSOLE ERRORS:", consoleErrors);
});
