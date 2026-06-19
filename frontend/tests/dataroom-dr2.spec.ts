import { test, expect } from "@playwright/test";

// DR2 — anonymous eligibility (membership + nullifier), the marquee load-bearing ZK. A requester gains
// room access only by proving sha256-Merkle membership + a per-room nullifier (anonymously, once per room).
// This test drives the READ/STATUS path (in-browser SDK reads against the LIVE Ch2 demo grant) — it does
// NOT trigger the multi-minute proof (mirrors the DR1 spec, which also skips the slow path).
const DEMO_ROOM = "c1c33201dad189af07b344cc6b20a9a3e6b75601f04344e618d5281cefa46d75";
const GRANTED_ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1"; // granted in Ch2
const UNGRANTED_ACCESSOR = "00".repeat(32); // a never-granted accessor → not granted
const MEMBERSHIP_IMAGE_SHORT = "9550a12e"; // canonical membership guest image (pinned on-chain; v5 re-pin)
const ELIGIBLE_ROOT_SHORT = "8be67872"; // the demo room's pinned eligible-set Merkle root

test("dataroom DR2: anonymous-eligibility engine renders; in-browser status read confirms the live grant; ungranted accessor not granted; identity never shown", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/dataroom/eligibility");

  // the DR2 card renders; the cryptographic engine (image + root) is demoted behind a "Verify details"
  // expander (UX pass) — expand it, then assert the pinned membership guest image (✓ == on-chain) + root
  const card = page.getByTestId("dr2-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("dr2-engine-details").click();
  await expect(page.getByTestId("dr2-image")).toContainText(MEMBERSHIP_IMAGE_SHORT, { timeout: 30_000 });
  await expect(page.getByTestId("dr2-image")).toContainText("✓");
  await expect(page.getByTestId("dr2-root")).toContainText(ELIGIBLE_ROOT_SHORT, { timeout: 30_000 });
  // the full-ZK-flow control is present (we do NOT run the ~minutes-long proof in a UI test)
  await expect(page.getByTestId("dr2-request")).toBeVisible();

  // --- in-browser SDK status read: the live Ch2 grant (accessor ed4928c6) → GRANTED + pseudonymous record ---
  await page.getByTestId("dr2-status-room").fill(DEMO_ROOM);
  await page.getByTestId("dr2-status-accessor").fill(GRANTED_ACCESSOR);
  await page.getByTestId("dr2-status-btn").click();
  const result = page.getByTestId("dr2-status-result");
  await expect(result).toBeVisible({ timeout: 60_000 });
  await expect(result).toHaveAttribute("data-granted", "true", { timeout: 60_000 });
  // the record is pseudonymous — the member's identity is ABSENT
  await expect(result).toContainText("absent");

  // --- an ungranted accessor → NOT granted ---
  await page.getByTestId("dr2-status-accessor").fill(UNGRANTED_ACCESSOR);
  await page.getByTestId("dr2-status-btn").click();
  await expect(result).toHaveAttribute("data-granted", "false", { timeout: 60_000 });

  await page.screenshot({ path: "tests/dataroom-dr2-page.png", fullPage: true });

  const appErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  if (appErrors.length) console.log("CONSOLE ERRORS:", appErrors);
  expect(appErrors, appErrors.join("\n")).toHaveLength(0);
});
