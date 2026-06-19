import { test, expect } from "@playwright/test";

// Pattern 2 — "Open a shared document": a committee document carries a per-document policy (member / KYC /
// accredited); whoever proves it (anonymously) has the key released by the 2-of-3 keepers and decrypts
// in-browser. Uses the seeded demo doc (room/doc/accessor already admitted on testnet); needs the 3 keepers
// running for the open step (skipped gracefully if a part can't be collected).
test("dataroom access: an admitted reader sees the policy met and opens the document; identity hidden", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/dataroom/access");
  await expect(page.getByTestId("access-card")).toBeVisible({ timeout: 30_000 });

  // STEP 1 — the document's policy + the reader's live per-leg admission load on their own (on-chain reads,
  // no keepers needed). The demo accessor meets every leg, and identity is never revealed.
  const result = page.getByTestId("access-result");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toHaveAttribute("data-admitted", "true", { timeout: 30_000 });
  await expect(page.getByTestId("access-leg-membership")).toContainText("✓");
  await expect(page.getByTestId("access-leg-compliance")).toContainText("✓");
  await expect(page.getByTestId("access-leg-accredited")).toContainText("✓");

  // STEP 2 — the keepers release the key to the admitted reader; reconstruct (any 2 of 3) + decrypt in-browser.
  await page.getByTestId("access-open-btn").click();
  const opened = page.getByTestId("access-open-result");
  await expect(opened).toBeVisible({ timeout: 60_000 });
  await expect(opened).toHaveAttribute("data-reconstructed", "true", { timeout: 60_000 });
  await expect(page.getByTestId("access-plaintext")).toBeVisible();

  await page.screenshot({ path: "tests/dataroom-access-page.png", fullPage: true });

  const appErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  if (appErrors.length) console.log("CONSOLE ERRORS:", appErrors);
  expect(appErrors, appErrors.join("\n")).toHaveLength(0);
});

test("dataroom access tab replaces the separate Policy + Release tabs (folded reader flow)", async ({ page }) => {
  await page.goto("/app/dataroom");
  // The Overview surfaces the folded reader task...
  await expect(page.getByTestId("task-access")).toBeVisible();
  // ...and the old separate "Meet all conditions" / "Release the key" tasks are gone from the overview.
  await expect(page.getByTestId("task-policy")).toHaveCount(0);
  await expect(page.getByTestId("task-release")).toHaveCount(0);
  // The tab routes to the folded flow.
  await page.getByTestId("task-access").click();
  await expect(page).toHaveURL(/\/dataroom\/access$/);
  await expect(page.getByTestId("access-card")).toBeVisible({ timeout: 30_000 });
});
