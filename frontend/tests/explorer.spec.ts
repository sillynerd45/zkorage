import { test, expect } from "@playwright/test";

// Public explorer: lists the on-chain append-only verified-results history.
test("explorer: lists on-chain verified-results history", async ({ page }) => {
  await page.goto("/explorer");

  const table = page.getByTestId("history-table");
  await expect(table).toBeVisible({ timeout: 30_000 });

  const rows = page.getByTestId("history-row");
  const n = await rows.count();
  console.log("history rows:", n);
  expect(n).toBeGreaterThanOrEqual(1);

  // first row shows a bound supply in zUSD and a verify link
  await expect(rows.first()).toContainText("zUSD");
  await expect(rows.first().getByRole("link", { name: /verify/i })).toBeVisible();

  await page.screenshot({ path: "tests/explorer-page.png", fullPage: true });
});
