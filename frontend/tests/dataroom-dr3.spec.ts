import { test, expect } from "@playwright/test";

// DR3 — threshold-ECIES key release. A document key K is Shamir-split (2-of-3) across an independent keyper
// committee; each keyper releases its share only to whoever won the DR2 grant, sealed to the proof-bound
// recipient key. The recipient collects >= 2 shares, reconstructs K and decrypts — ENTIRELY IN THE BROWSER
// (the recipient secret never leaves it). This drives the live stable demo (room a17388e8 / doc 614664eb,
// granted accessor ed4928c6, sealed to the demo recipient whose secret the page prefills).
const UNGRANTED_ACCESSOR = "00".repeat(32); // never granted → the committee releases nothing
const WRONG_KEY = "11".repeat(32); // a wrong recipient secret → shares don't open faithfully
const DEMO_SNIPPET = "committee-released"; // appears in the seeded committee document plaintext

test("dataroom DR3: committee renders; granted accessor reconstructs K (2-of-3) + decrypts in-browser; ungranted releases nothing; wrong key can't reconstruct", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/dataroom/release");

  // the DR3 card renders; committee status + doc commitments are demoted behind a "Verify details"
  // expander (UX pass) — expand it, then assert the committee threshold + the commitments
  const card = page.getByTestId("dr3-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("dr3-engine-details").click();
  await expect(page.getByTestId("dr3-committee")).toContainText("threshold", { timeout: 30_000 });
  await expect(page.getByTestId("dr3-content-hash")).not.toHaveText("—", { timeout: 30_000 });
  await expect(page.getByTestId("dr3-k-commitment")).toContainText("sha256(K)", { timeout: 30_000 });

  // --- the headline: the granted accessor collects shares, reconstructs K (2-of-3) + decrypts in-browser ---
  // (room/doc/accessor/secret are prefilled with the live stable demo; just click).
  await page.getByTestId("dr3-open-btn").click();
  const result = page.getByTestId("dr3-open-result");
  await expect(result).toBeVisible({ timeout: 60_000 });
  await expect(result).toHaveAttribute("data-reconstructed", "true", { timeout: 60_000 });
  await expect(page.getByTestId("dr3-pair")).toContainText("#"); // which 2-of-3 keypers reconstructed
  await expect(page.getByTestId("dr3-plaintext")).toContainText(DEMO_SNIPPET);

  // --- an UNGRANTED accessor → the committee releases nothing (released=false) ---
  await page.getByTestId("dr3-accessor-input").fill(UNGRANTED_ACCESSOR);
  await page.getByTestId("dr3-open-btn").click();
  await expect(result).toHaveAttribute("data-released", "false", { timeout: 60_000 });
  await expect(page.getByTestId("dr3-not-released")).toBeVisible();

  // --- a WRONG recipient key (granted accessor again) → shares released but none open faithfully → no K ---
  await page.getByTestId("dr3-accessor-input").fill("ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1");
  await page.getByTestId("dr3-secret").fill(WRONG_KEY);
  await page.getByTestId("dr3-open-btn").click();
  await expect(result).toHaveAttribute("data-reconstructed", "false", { timeout: 60_000 });
  await expect(result).toHaveAttribute("data-released", "true", { timeout: 60_000 });
  await expect(page.getByTestId("dr3-unfaithful")).toBeVisible();

  await page.screenshot({ path: "tests/dataroom-dr3-page.png", fullPage: true });

  const appErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  if (appErrors.length) console.log("CONSOLE ERRORS:", appErrors);
  expect(appErrors, appErrors.join("\n")).toHaveLength(0);
});
