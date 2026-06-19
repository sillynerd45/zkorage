import { test, expect } from "@playwright/test";

// Validates the internet-exposure deploy concerns (version badge + SPA deep-link fallback + shell),
// all backend-independent so this passes against the production `serve` build on :4173 even before the
// Cloudflare Tunnel to the backend (apizk.wazowsky.id) is live. Run with BASE_URL pointed at either the
// dev server (5174) or the prod serve build (4173).

test("deploy: version badge renders as `vX.Y.Z · <sha>` and is copyable", async ({ page }) => {
  await page.goto("/");
  const badge = page.getByTestId("version-badge");
  await expect(badge).toBeVisible();
  // Visible chip uses non-breaking spaces around the middot; normalize before matching.
  const text = (await badge.innerText()).replace(/ /g, " ").trim();
  expect(text, `badge text was "${text}"`).toMatch(/^v\d+\.\d+\.\d+\s*·\s*\S+$/);
  // Full build stamp (with ISO build time) lives in the title for diagnostics.
  const title = await badge.getAttribute("title");
  expect(title).toMatch(/zkorage v\d+\.\d+\.\d+ · \S+/);
});

test("deploy: SPA deep-link fallback — hard-loading a nested route renders the app, not a 404", async ({ page }) => {
  // one public (marketing shell) + two app-shell routes
  for (const route of ["/verify", "/app/dataroom/eligibility", "/app/fundraise"]) {
    const resp = await page.goto(route);
    expect(resp?.status(), `status for ${route}`).toBe(200);
    // The shell (brand link + primary nav) must be present → index.html was served, React Router took over.
    await expect(page.getByRole("link", { name: /zkorage home/i }).first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: /primary/i }).first()).toBeVisible();
  }
});

test("deploy: shell renders with no fatal page error (badge present after route change)", async ({ page }) => {
  const fatal: string[] = [];
  page.on("pageerror", (e) => fatal.push(String(e)));
  await page.goto("/");
  await expect(page.getByTestId("version-badge")).toBeVisible();
  // Client-side nav across marketing routes; the badge persists (each shell mounts it once).
  for (const link of ["Documentation", "Explorer"]) {
    await page.getByRole("link", { name: link, exact: false }).first().click();
    await expect(page.getByTestId("version-badge")).toBeVisible();
  }
  // Cross into the app shell via the "Open app" CTA; badge still present.
  await page.getByTestId("open-app").click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByTestId("version-badge")).toBeVisible();
  expect(fatal, `uncaught page errors: ${fatal.join("\n")}`).toHaveLength(0);
});
