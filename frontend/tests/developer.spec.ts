import { test, expect } from "@playwright/test";

const CHECKS = [
  "journalWellFormed", "digestMatches", "imagePinned", "resultTrue", "claimTypeOk",
  "issuerAllowed", "notExpired", "proofValidOnChain", "supplyBoundMatches",
];

// /developer page dogfoods zkorage-sdk in the browser: it runs isReservesGteSupply() + verifyBundle()
// directly against the public RPC (the SDK the MCP server and any dev uses).
test("developer page: live SDK demo verifies on-chain", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/docs/developers");
  await page.getByTestId("dev-run").click();

  const answer = page.getByTestId("dev-answer");
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await expect(answer).toHaveAttribute("data-answer", "true");

  for (const k of CHECKS) {
    await expect(page.getByTestId(`dev-check-${k}`)).toHaveAttribute("data-ok", "true", { timeout: 30_000 });
  }

  await page.screenshot({ path: "tests/developer-page.png", fullPage: true });
  if (consoleErrors.length) console.log("CONSOLE ERRORS:", consoleErrors);
});
