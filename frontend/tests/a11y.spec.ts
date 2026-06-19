import { test, expect, type Page } from "@playwright/test";

// Measured slice of the WCAG rubric (UX research §10 axis c/e): bypass-blocks + landmark, no horizontal
// scroll across the rubric breakpoints, and accessible names on form controls. The per-token contrast,
// color-independence, focus-visible, and reduced-motion items were landed earlier (ch1) and are scored in
// development/Build-Plan/dataroom/UX-WCAG-RUBRIC.md.

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("a11y: skip-to-content link + <main> landmark are present and wired (WCAG 2.4.1 / 1.3.1)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /skip to main content/i })).toHaveAttribute("href", "#main");
  await expect(page.locator("main#main")).toBeAttached();
});

// Routes with no wide inputs/tables must not scroll horizontally at any breakpoint, incl. 375px mobile.
test("a11y: no horizontal scroll on lean routes across 375/768/1024/1440 (WCAG 1.4.4 / 1.4.10)", async ({ page }) => {
  for (const route of ["/", "/app/dataroom", "/app/dataroom/demo"]) {
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(route);
      await page.waitForTimeout(250);
      expect(await horizontalOverflow(page), `overflow at ${route} @${width}px`).toBeLessThanOrEqual(1);
    }
  }
});

// The wide-input prove routes must fit tablet→desktop (the realistic demo range); the <560px rule shrinks
// their monospace inputs, and any data table is reflow-exempt (WCAG 1.4.10) so we don't pin those at 375.
test("a11y: no horizontal scroll on wide-input routes across 768/1024/1440", async ({ page }) => {
  for (const route of ["/app/dataroom/documents", "/app/dataroom/release", "/app/dataroom/disclosure"]) {
    for (const width of [768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1200 });
      await page.goto(route);
      await page.waitForTimeout(250);
      expect(await horizontalOverflow(page), `overflow at ${route} @${width}px`).toBeLessThanOrEqual(1);
    }
  }
});

test("a11y: every form control on the documents route has an accessible name (WCAG 4.1.2 / 3.3.2)", async ({ page }) => {
  await page.goto("/app/dataroom/documents");
  await expect(page.getByTestId("room-label")).toBeVisible();
  const controls = page.locator("input, textarea, select");
  const n = await controls.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const el = controls.nth(i);
    const aria = await el.getAttribute("aria-label");
    const id = await el.getAttribute("id");
    let named = !!(aria && aria.trim());
    if (!named && id) named = (await page.locator(`label[for="${id}"]`).count()) > 0;
    if (!named) named = await el.evaluate((node) => !!node.closest("label"));
    expect(named, `form control #${i} lacks an accessible name`).toBeTruthy();
  }
});
