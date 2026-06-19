import { test, expect } from "@playwright/test";

// A seeded ~2-minute GUIDED DEMO to the anonymous-eligibility "aha", driven by the LIVE read path against
// the seeded DR2 grant (no multi-minute proof). Steps the visitor: scenario → live on-chain read → the aha
// (admitted, yet identity ABSENT, with a one-time nullifier) → verify-it-yourself + hands-on handoff.
test("dataroom guided demo: Overview CTA → 4-step tour reads the live grant (admitted, identity absent)", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  // the guided demo is no longer linked from the overview (it will move to a dedicated Tutorial); the
  // route still exists and works, so reach it directly.
  await page.goto("/app/dataroom/demo");
  await expect(page).toHaveURL(/\/dataroom\/demo$/);

  // step 1 (the scenario) → start
  await expect(page.getByTestId("demo-step-1")).toBeVisible();
  await page.getByTestId("demo-next-1").click();

  // step 2: read the live grant on-chain (read-only; no wallet)
  await expect(page.getByTestId("demo-step-2")).toBeVisible();
  await page.getByTestId("demo-check").click();

  // step 3 (the aha): ADMITTED + the chain shows only a pseudonym, identity ABSENT
  const verdict = page.getByTestId("demo-verdict");
  await expect(verdict).toBeVisible({ timeout: 60_000 });
  await expect(verdict).toHaveAttribute("data-granted", "true", { timeout: 60_000 });
  await expect(page.getByTestId("demo-identity-absent")).toContainText("absent");

  // step 3 → 4: the "check it yourself" + hands-on handoffs are present
  await page.getByTestId("demo-next-3").click();
  await expect(page.getByTestId("demo-verify")).toBeVisible();
  await expect(page.getByTestId("demo-handoff")).toBeVisible();

  await page.screenshot({ path: "tests/dataroom-demo-page.png", fullPage: true });

  const appErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  if (appErrors.length) console.log("CONSOLE ERRORS:", appErrors);
  expect(appErrors, appErrors.join("\n")).toHaveLength(0);
});
