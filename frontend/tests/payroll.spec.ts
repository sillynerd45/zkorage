import { test, expect } from "@playwright/test";

// Demo "employee wallet" — income-verified by the seeded payroll proof (salary 6000 ≥ threshold 5000).
const WRONG_KEY = "11".repeat(32); // a non-auditor view key → decrypt is not faithful

// Confidential payroll (proof-of-income + auditor view-key): the public sees only "paid ≥ threshold"
// with the salary hidden; an allow-listed auditor's view key unlocks the exact figures (provably
// faithful), and a wrong key cannot. (The seeded grant avoids the ~5-min proof in this UI test.)
test("payroll: auditor view-key unlocks figures; public sees salaries hidden; wrong key not faithful", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/payroll");

  // engine card resolves the payroll gate + the allow-listed attester + auditor
  await expect(page.getByText("Payroll gate")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("auditor-pub")).toContainText("x25519");

  // prover controls render (salary/threshold/accessor + prove)
  await expect(page.getByTestId("salary")).toBeVisible();
  await expect(page.getByTestId("threshold")).toBeVisible();
  await expect(page.getByTestId("prove")).toBeVisible();

  // public history lists the seeded grant — and the salary column is HIDDEN
  const history = page.getByTestId("payroll-history");
  await expect(history).toBeVisible({ timeout: 30_000 });
  await expect(history).toContainText("hidden");

  // --- AUDITOR: unlock with the demo auditor key (blank field) → exact salaries + faithful ---
  await page.getByTestId("unlock").click();
  const auditTable = page.getByTestId("audit-table");
  await expect(auditTable).toBeVisible({ timeout: 30_000 });
  // the seeded employees decrypt to their exact salaries (deduped by accessor), all faithful ✓
  await expect(page.getByTestId("salary-0")).toHaveText("6000");
  await expect(page.getByTestId("salary-1")).toHaveText("8000");
  await expect(auditTable).toContainText("✓");
  // the auditor-summed payroll total = 6000 + 8000 over 2 distinct employees
  await expect(page.getByTestId("payroll-total")).toContainText("14000");
  await expect(page.getByTestId("payroll-total")).toContainText("2 employee");

  // --- AUDITOR with a WRONG view key → NOT faithful, salaries withheld ---
  await page.getByTestId("view-key").fill(WRONG_KEY);
  await page.getByTestId("unlock").click();
  await expect(page.getByTestId("salary-0")).toHaveText("—", { timeout: 30_000 });
  await expect(auditTable).toContainText("✗");

  await page.screenshot({ path: "tests/payroll-page.png", fullPage: true });
  if (consoleErrors.length) console.log("CONSOLE ERRORS:", consoleErrors);
});
