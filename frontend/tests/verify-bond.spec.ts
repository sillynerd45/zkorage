import { test, expect } from "@playwright/test";

// The public /verify/bond page live-reads is_granted from the bond gate (no wallet) and renders a verdict.
const ACCESSOR = "04".repeat(32);
const REQ = "cd".repeat(32);
const GATE = "CCKX6B7QIE42YA27Y4KTB6CTXRB3OBGR5EW7N2BLAG4AB3V6CFDKXCZU";
const DEADLINE = Math.floor(Date.UTC(2030, 6, 1, 12, 0, 0) / 1000);
const LINK = `/verify/bond?accessor=${ACCESSOR}&req=${REQ}&amount=25000000000&decimals=7&deadline=${DEADLINE}&symbol=TUSD`;

const stubStatus = (page: import("@playwright/test").Page, body: object) =>
  page.route("**/bonded/bond/status**", (route) => route.fulfill({ json: body }));

test("verify/bond: a live grant verifies on-chain with the claim + gate link", async ({ page }) => {
  await stubStatus(page, { accessor: ACCESSOR, reqId: REQ, is_granted: true, grant: { index: 0 }, bondGateId: GATE });
  await page.goto(LINK);
  const verdict = page.getByTestId("verify-bond-verdict");
  await expect(verdict).toBeVisible({ timeout: 15_000 });
  await expect(verdict).toHaveAttribute("data-state", "verified");
  await expect(verdict).toContainText("confirmed on-chain");
  // The claim card reads the requirement from the link (the chain has no token/amount label).
  await expect(page.getByTestId("bond-amount")).toContainText("2,500 TUSD");
  await expect(page.getByText("valid until")).toBeVisible();
  // The gate contract is shown and links out.
  await expect(page.getByText("bond gate", { exact: true })).toBeVisible();
  // The honest scope note is present.
  await expect(page.getByTestId("verify-bond-scope")).toContainText("does not reveal which wallet");
});

test("verify/bond: no live grant reads as not found", async ({ page }) => {
  await stubStatus(page, { accessor: ACCESSOR, reqId: REQ, is_granted: false, grant: null, bondGateId: GATE });
  await page.goto(LINK);
  const verdict = page.getByTestId("verify-bond-verdict");
  await expect(verdict).toBeVisible({ timeout: 15_000 });
  await expect(verdict).toHaveAttribute("data-state", "not-found");
});

test("verify/bond: a malformed link reads as invalid", async ({ page }) => {
  await page.goto("/verify/bond");
  const verdict = page.getByTestId("verify-bond-verdict");
  await expect(verdict).toBeVisible({ timeout: 15_000 });
  await expect(verdict).toHaveAttribute("data-state", "invalid");
});
