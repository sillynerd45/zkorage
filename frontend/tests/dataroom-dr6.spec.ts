import { test, expect } from "@playwright/test";

// DR6 — private-policy composition + revocation/rotation (the data-room finale). A requester is admitted
// only by satisfying a COMPOSITE policy — member ∧ KYC ∧ accredited ∧ not-sanctioned — each an independent
// ZK proof bound to one pseudonymous accessor, AND'd on-chain, with identity + which-member hidden. Drives
// the stable demo (room db16742c / accessor ed4928c6) seeded by dr6-anchor-demo: the page reads the live
// composed admission per leg in-browser via the SDK, then checks a stranger is denied.
const STRANGER = "ab".repeat(32);

test("dataroom DR6: composite policy shows all legs ✓ → ADMITTED (anonymous), per-leg breakdown + live numbers; a stranger is DENIED", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/dataroom/policy");

  // the DR6 card renders; the policy machinery (on-chain AND + gate addresses) is demoted behind a
  // "Verify details" expander (UX pass) — expand it, then assert the gates
  const card = page.getByTestId("dr6-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("dr6-engine-details").click();
  await expect(page.getByTestId("dr6-compliance-gate")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("dr6-accredited-gate")).toBeVisible();

  // the prefilled demo accessor is ADMITTED — all three legs hold, proven anonymously
  const access = page.getByTestId("dr6-access");
  await expect(access).toBeVisible({ timeout: 30_000 });
  await expect(access).toHaveAttribute("data-admitted", "true", { timeout: 30_000 });
  await expect(page.getByTestId("dr6-verdict-ok")).toBeVisible();
  await expect(page.getByTestId("dr6-leg-membership")).toContainText("✓");
  await expect(page.getByTestId("dr6-leg-compliance")).toContainText("✓");
  await expect(page.getByTestId("dr6-leg-accredited")).toContainText("✓");
  await expect(page.getByTestId("dr6-revoked")).toContainText("no");

  // live published numbers: the demo room has >=1 grant + >=1 admission; key epoch is a number
  await expect(page.getByTestId("dr6-counts")).toContainText("admission", { timeout: 30_000 });
  await expect(page.getByTestId("dr6-epoch")).not.toHaveText("…", { timeout: 30_000 });

  // --- a STRANGER (no membership/compliance/accredited) → DENIED, no identity revealed ---
  await page.getByTestId("dr6-accessor").fill(STRANGER);
  await page.getByTestId("dr6-check-btn").click();
  await expect(access).toHaveAttribute("data-admitted", "false", { timeout: 30_000 });
  await expect(page.getByTestId("dr6-verdict-deny")).toBeVisible();

  await page.screenshot({ path: "tests/dataroom-dr6-page.png", fullPage: true });

  const appErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  if (appErrors.length) console.log("CONSOLE ERRORS:", appErrors);
  expect(appErrors, appErrors.join("\n")).toHaveLength(0);
});
