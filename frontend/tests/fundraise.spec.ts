import { test, expect } from "@playwright/test";

// The composition finale: a fundraise admits an investor only when BOTH legs hold — (a) accredited
// investor (identity hidden) AND (b) revenue ≥ X (revenue hidden) — AND'd on-chain. The demo investor
// wallet is already admitted on-chain, so the composition banner reads GRANTED on load (this avoids the
// ~4-min proof in a UI test). An unknown accessor fails the accredited leg → DENIED.
const UNKNOWN = "00".repeat(32);

test("fundraise: access granted only when accredited ∧ revenue ≥ X (composition)", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/fundraise");

  // engine resolves the fundraise + accredited gate + the public revenue floor X
  await expect(page.getByText("Fundraise contract")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Accredited gate")).toBeVisible();
  await expect(page.getByText("Revenue floor (X, public)")).toBeVisible();

  // both prover panels render (company revenue + investor accredited)
  await expect(page.getByTestId("revenue")).toBeVisible();
  await expect(page.getByTestId("prove-revenue")).toBeVisible();
  await expect(page.getByTestId("accessor")).toBeVisible();
  await expect(page.getByTestId("prove-accredited")).toBeVisible();
  // the inputs themselves are hidden in the proof (private)
  await expect(page.getByTestId("identity-private")).toHaveCount(0); // only shown after a fresh proof

  // --- COMPOSITION (demo investor, already admitted): both legs ✓ → ACCESS GRANTED ---
  const verdict = page.getByTestId("access-verdict");
  await expect(verdict).toBeVisible({ timeout: 30_000 });
  await expect(verdict).toHaveAttribute("data-granted", "true", { timeout: 30_000 });
  await expect(verdict).toContainText("ACCESS GRANTED");
  await expect(page.getByTestId("leg-accredited")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("leg-revenue")).toHaveAttribute("data-ok", "true");

  // the on-chain admission history lists the admitted investor
  await expect(page.getByTestId("admission-history")).toBeVisible({ timeout: 30_000 });

  // --- DENY: an unknown accessor fails the accredited leg → ACCESS DENIED ---
  await page.getByTestId("check-accessor").fill(UNKNOWN);
  await page.getByTestId("check-access").click();
  await expect(verdict).toHaveAttribute("data-granted", "false", { timeout: 30_000 });
  await expect(verdict).toContainText("ACCESS DENIED");
  await expect(page.getByTestId("leg-accredited")).toHaveAttribute("data-ok", "false");
  // revenue is still verified (the financial leg holds) — only the identity leg fails
  await expect(page.getByTestId("leg-revenue")).toHaveAttribute("data-ok", "true");
  // request-access is disabled when a leg is missing
  await expect(page.getByTestId("request-access")).toBeDisabled();

  // No PAGE/app console errors (benign resource 404s — e.g. favicon — are ignored, matching the other specs).
  const appErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  if (appErrors.length) console.log("CONSOLE ERRORS:", appErrors);
  expect(appErrors, appErrors.join("\n")).toHaveLength(0);
});
