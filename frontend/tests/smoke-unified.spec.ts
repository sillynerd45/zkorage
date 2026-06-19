import { test, expect } from "@playwright/test";

// Smoke test for the unified marketing-site + sidebar-app structure (U0).
// Verifies both shells mount and the key routes render without runtime errors.

test("landing renders + Open app navigates to /app", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await expect(page.getByTestId("overview")).toBeVisible();
  // marketing top-bar present
  await expect(page.getByTestId("open-app")).toBeVisible();
  await page.getByTestId("open-app").click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByTestId("dashboard")).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("app shell routes render", async ({ page }) => {
  await page.goto("/app/reserves");
  await expect(page.getByTestId("app-page-title")).toContainText("Proof-of-Reserves");
  await expect(page.getByTestId("freighter-connect")).toBeVisible();

  await page.goto("/app/dataroom");
  await expect(page.getByTestId("dataroom-overview")).toBeVisible();

  await page.goto("/app/dataroom/eligibility");
  await expect(page.getByTestId("dr2-card")).toBeVisible();
});

test("public marketing routes render", async ({ page }) => {
  await page.goto("/verify");
  await expect(page.getByText("Verify it yourself").first()).toBeVisible();
  await page.goto("/explorer");
  await expect(page.getByRole("heading", { name: "Explorer" })).toBeVisible();
  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "Documentation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What zkorage is", exact: true })).toBeVisible();
});

test("docs side-rail navigates to developers + glossary", async ({ page }) => {
  await page.goto("/docs");
  await page.getByRole("link", { name: "Developers" }).click();
  await expect(page).toHaveURL(/\/docs\/developers$/);
  await expect(page.getByTestId("dev-demo")).toBeVisible();
  await expect(page.getByTestId("dev-run")).toBeVisible();
  await page.getByRole("link", { name: "Glossary" }).click();
  await expect(page).toHaveURL(/\/docs\/glossary$/);
  await expect(page.getByText("Plain-language glossary")).toBeVisible();
});

test("landing → docs and verify CTAs work", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("hero-open-app")).toBeVisible();
  await expect(page.getByText("What you can prove")).toBeVisible();
  await expect(page.getByText("Don't trust — verify")).toBeVisible();
  await page.getByRole("link", { name: "Verify a proof" }).click();
  await expect(page).toHaveURL(/\/verify$/);
});

test("freighter placeholder opens coming-soon popover", async ({ page }) => {
  await page.goto("/app");
  await page.getByTestId("freighter-connect").click();
  await expect(page.getByText("Wallet connection — coming soon")).toBeVisible();
});
