import { test, expect } from "@playwright/test";

// End-to-end UI test of the Proof-of-Reserves demo against the live testnet stack.
// Uses the preloaded proof bundle (real proving is ~minutes and validated separately),
// then exercises the on-chain verify + the supply-binding rejection live in the browser.
test("PoR: verify ✓ → mint breaks binding → ✗ supply mismatch → burn restores → verify ✓", async ({ page }) => {
  await page.goto("/app/reserves");

  // supply + proof claim load
  await expect(page.getByTestId("supply")).not.toHaveText("…");
  const baseline = (await page.getByTestId("supply").textContent())!.trim();
  await expect(page.getByTestId("reserves-private")).toContainText("private");

  // 1) verify the preloaded proof on-chain -> VERIFIED
  await page.getByTestId("verify").click();
  await expect(page.getByTestId("proof-status")).toHaveAttribute("data-state", "verified");
  await expect(page.getByTestId("verdict-card")).toContainText("verified on Stellar");

  // 2) mint -> on-chain supply changes (the mint is gated by a ConfirmModal — UX pass — so confirm it)
  await page.getByTestId("mint").click();
  await page.getByTestId("confirm-go").click();
  await expect(page.getByTestId("supply")).not.toHaveText(baseline, { timeout: 40_000 });

  // 3) re-verify the SAME proof -> rejected with supply mismatch (the binding catches it)
  // Reject copy is the shared meaning-first humanError (reserves #10), not the raw "Supply mismatch".
  await page.getByTestId("verify").click();
  await expect(page.getByTestId("proof-status")).toHaveAttribute("data-state", "rejected");
  await expect(page.getByTestId("reject-reason")).toContainText("no longer match the current supply on the public record");

  // 4) burn back -> supply restored to baseline (confirm the gated burn)
  await page.getByTestId("burn").click();
  await page.getByTestId("confirm-go").click();
  await expect(page.getByTestId("supply")).toHaveText(baseline, { timeout: 40_000 });

  // 5) verify again -> VERIFIED
  await page.getByTestId("verify").click();
  await expect(page.getByTestId("proof-status")).toHaveAttribute("data-state", "verified");
  await expect(page.getByTestId("verdict-card")).toContainText("verified on Stellar");

  await page.screenshot({ path: "tests/por-verified.png", fullPage: true });
});
