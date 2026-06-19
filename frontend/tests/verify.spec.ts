import { test, expect } from "@playwright/test";

const CHECKS = [
  "journalWellFormed", "digestMatches", "imagePinned", "resultTrue", "claimTypeOk",
  "issuerAllowed", "notExpired", "proofValidOnChain", "supplyBoundMatches",
];

// Public "verify it yourself" page: loads the audit bundle, re-verifies against the chain, and
// renders a checklist. This also probes whether the browser can reach the public RPC directly
// (trustless path) or must fall back to the backend (C7).
test("verify page: independent re-verify → VERIFIED + full checklist", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/verify");

  const verdict = page.getByTestId("verify-verdict");
  await expect(verdict).toHaveAttribute("data-state", /verified|rejected/, { timeout: 90_000 });

  const state = await verdict.getAttribute("data-state");
  const trust = (await page.getByTestId("trust-mode").textContent())?.trim();
  console.log("VERDICT STATE:", state);
  console.log("TRUST MODE:", trust);

  for (const k of CHECKS) {
    const ok = await page.getByTestId(`check-${k}`).getAttribute("data-ok");
    console.log(`  check ${k}: ${ok}`);
  }

  // CLI recipe + badge present
  await expect(page.getByTestId("cli-recipe")).toBeVisible();
  await expect(page.getByTestId("badge-img")).toBeVisible();

  await page.screenshot({ path: "tests/verify-page.png", fullPage: true });
  if (consoleErrors.length) console.log("CONSOLE ERRORS:", consoleErrors);

  // every check should pass for the seeded valid claim
  for (const k of CHECKS) {
    await expect(page.getByTestId(`check-${k}`)).toHaveAttribute("data-ok", "true");
  }
  expect(state).toBe("verified");
});
