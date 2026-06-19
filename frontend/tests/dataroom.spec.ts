import { test, expect } from "@playwright/test";

// DR1 — Confidential Data Room (data plane): a document is encrypted (fresh K, AES-256-GCM), the key is
// sealed to a recipient + bound to the ciphertext's content hash (faithful disclosure), and only a
// sha256(ciphertext) commitment + the sealed-key disclosure go on-chain. The recipient opens it KEY-FREE
// in the browser (the SDK opener recovers K with their x25519 secret + AES-decrypts; it custodies nothing).
// Uses the SEEDED demo document (room/doc already anchored on testnet) to avoid the multi-minute proof.
const DEMO_CONTENT_SNIPPET = "opened faithfully"; // appears in the seeded demo document's plaintext
const WRONG_KEY = "11".repeat(32); // a non-recipient secret → the faithful tag won't match

test("dataroom: recipient opens the sealed doc in-browser (faithful); wrong key not faithful; plaintext hidden on-chain", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/dataroom/documents");

  // engine resolves the DataRoom contract + storage backend (shared layout Engine card)
  await expect(page.getByText("DataRoom contract")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("storage")).toContainText(/Cloudflare R2|local/);
  // the seal guest + demo recipient are demoted behind a "Verify details" expander (UX pass) — expand them
  await page.getByTestId("anchor-engine-details").click();
  await expect(page.getByTestId("recipient-pub")).toContainText("x25519");
  await expect(page.getByTestId("seal-image")).toBeVisible();

  // upload controls render (we do NOT trigger the ~minutes-long proof in a UI test)
  await expect(page.getByTestId("room-label")).toBeVisible();
  await expect(page.getByTestId("doc-content")).toBeVisible();
  await expect(page.getByTestId("upload")).toBeVisible();

  // public document browser lists the seeded demo doc — the plaintext is HIDDEN (encrypted)
  const docs = page.getByTestId("dataroom-docs");
  await expect(docs).toBeVisible({ timeout: 30_000 });
  await expect(docs).toContainText("encrypted");

  // --- RECIPIENT OPEN (prefilled demo doc + demo recipient secret) → faithful + decrypted plaintext ---
  await page.getByTestId("open-btn").click();
  const result = page.getByTestId("open-result");
  await expect(result).toBeVisible({ timeout: 60_000 });
  await expect(result).toHaveAttribute("data-faithful", "true", { timeout: 60_000 });
  await expect(page.getByTestId("open-plaintext")).toContainText(DEMO_CONTENT_SNIPPET);

  // --- WRONG recipient key → NOT faithful, no plaintext recovered ---
  await page.getByTestId("open-secret").fill(WRONG_KEY);
  await page.getByTestId("open-btn").click();
  await expect(result).toHaveAttribute("data-faithful", "false", { timeout: 60_000 });
  await expect(page.getByTestId("open-unfaithful")).toBeVisible();

  await page.screenshot({ path: "tests/dataroom-page.png", fullPage: true });

  // No app/page console errors (benign resource 404s like favicon are ignored, matching the other specs).
  const appErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  if (appErrors.length) console.log("CONSOLE ERRORS:", appErrors);
  expect(appErrors, appErrors.join("\n")).toHaveLength(0);
});

test("dataroom overview: task-oriented cards route to the right place; guided-demo tab removed", async ({ page }) => {
  await page.goto("/app/dataroom");
  await expect(page.getByRole("heading", { name: "What do you want to do?" })).toBeVisible();

  // the document tasks that used to be buried under "Store a document" are now first-class + discoverable
  await expect(page.getByTestId("task-store")).toBeVisible();
  await expect(page.getByTestId("task-open")).toBeVisible();
  await expect(page.getByTestId("task-browse")).toBeVisible();
  await expect(page.getByTestId("task-eligibility")).toBeVisible();

  // the passive "Guided demo" is no longer a dataroom tab
  await expect(page.getByRole("link", { name: "Guided demo" })).toHaveCount(0);

  // "Open a document" deep-links straight into the Documents page's open section
  await page.getByTestId("task-open").click();
  await expect(page).toHaveURL(/\/dataroom\/documents#open$/);
  await expect(page.getByRole("heading", { name: "Open a document" })).toBeVisible();

  // and that one page exposes all three document tasks as sections
  await expect(page.getByRole("heading", { name: "Store a document" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Browse documents" })).toBeVisible();
});
