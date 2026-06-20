import { test, expect } from "@playwright/test";

// DR1 — Confidential Data Room (data plane): a document is encrypted (fresh K, AES-256-GCM), the key is
// sealed to a recipient + bound to the ciphertext's content hash (faithful disclosure), and only a
// sha256(ciphertext) commitment + the sealed-key disclosure go on-chain. The recipient opens it KEY-FREE
// in the browser (the SDK opener recovers K with their x25519 secret + AES-decrypts; it custodies nothing).
// Uses the SEEDED demo document (room/doc already anchored on testnet) to avoid the multi-minute proof.
// The page is now a Store / Open / Browse submenu (one sub-tab at a time); Browse shows the rooms YOU own.
const DEMO_CONTENT_SNIPPET = "opened faithfully"; // appears in the seeded demo document's plaintext
const WRONG_KEY = "11".repeat(32); // a non-recipient secret → the faithful tag won't match

// A connected-wallet seam (headless Chrome can't load the real extension). This address owns no rooms.
const DEMO_G = "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC";
const freighterMock = () => `
  localStorage.setItem("zkorage.wallet.connected", "1");
  window.__freighterMock = {
    isConnected: async () => ({ isConnected: true }),
    isAllowed: async () => ({ isAllowed: true }),
    requestAccess: async () => ({ address: "${DEMO_G}" }),
    getAddress: async () => ({ address: "${DEMO_G}" }),
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: "${DEMO_G}" }),
  };
`;

test("dataroom: recipient opens the sealed doc in-browser (faithful); wrong key not faithful; plaintext hidden on-chain", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("/app/dataroom/documents");

  // STORE sub-tab is the default. The seal guest + demo recipient are demoted behind a "Verify details" expander.
  await expect(page.getByTestId("room-label")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("anchor-engine-details").click();
  await expect(page.getByTestId("recipient-pub")).toContainText("x25519");
  await expect(page.getByTestId("seal-image")).toBeVisible();
  // upload controls render (we do NOT trigger the ~minutes-long proof in a UI test)
  await expect(page.getByTestId("doc-content")).toBeVisible();
  await expect(page.getByTestId("doc-file")).toBeVisible(); // store a file (PDF/image/any) too, not just text
  await expect(page.getByTestId("upload")).toBeVisible();

  // BROWSE sub-tab: with no wallet, it asks you to connect — Browse shows the rooms YOU own, so a fresh
  // visitor sees nothing they didn't store (no auto-loaded seeded room). There is no "contents" column
  // either: every document is encrypted by default (the subtitle says so).
  await page.getByTestId("doc-subtab-browse").click();
  await expect(page.getByTestId("browse-connect-prompt")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Contents stay encrypted")).toBeVisible();

  // OPEN sub-tab — RECIPIENT OPEN (prefilled demo doc + demo recipient secret) → faithful + decrypted plaintext
  await page.getByTestId("doc-subtab-open").click();
  await page.getByTestId("open-btn").click();
  const result = page.getByTestId("open-result");
  await expect(result).toBeVisible({ timeout: 60_000 });
  await expect(result).toHaveAttribute("data-faithful", "true", { timeout: 60_000 });
  await expect(page.getByTestId("open-plaintext")).toContainText(DEMO_CONTENT_SNIPPET);
  // the decrypted document offers a download, and the text demo doc renders as a text preview
  await expect(page.getByTestId("download-decrypted")).toBeVisible();
  await expect(page.getByTestId("decrypted-text")).toContainText(DEMO_CONTENT_SNIPPET);

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

test("dataroom store: choosing a file shows a chip and disables the text box", async ({ page }) => {
  // The file path (PDF/image/any) is exercised without the multi-minute proof: pick a file, assert the UI
  // state, then remove it. setInputFiles takes an in-memory buffer, so no fixture file is needed.
  await page.goto("/app/dataroom/documents#store");
  await expect(page.getByTestId("doc-content")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("doc-file").setInputFiles({
    name: "sample.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%demo small pdf\n"),
  });
  await expect(page.getByTestId("doc-file-chip")).toContainText("sample.pdf");
  await expect(page.getByTestId("doc-content")).toBeDisabled(); // a chosen file overrides the text box

  await page.getByTestId("doc-file-clear").click();
  await expect(page.getByTestId("doc-file-chip")).toHaveCount(0);
  await expect(page.getByTestId("doc-content")).toBeEnabled();
});

test("dataroom Browse: a fresh connected wallet sees only its own rooms (empty), not a seeded doc", async ({ page }) => {
  // THE original complaint: a brand-new connected address should NOT see a document it never stored.
  await page.addInitScript(freighterMock());
  await page.goto("/app/dataroom/documents");
  await page.getByTestId("doc-subtab-browse").click();
  // Connected, but this address owns no rooms on-chain → the empty state (no auto-loaded seeded room).
  await expect(page.getByTestId("browse-empty")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("dataroom-docs")).toHaveCount(0);
});

test("dataroom overview: task-oriented cards route to the right place; guided-demo tab removed", async ({ page }) => {
  await page.goto("/app/dataroom");
  // the landing is a featured "Store a document" hero card + an "All tasks" grid (no duplicate "what do you
  // want to do?" description; the one-line lead lives in the header)
  await expect(page.getByTestId("dataroom-overview")).toBeVisible();
  await expect(page.getByText("Start here")).toBeVisible();
  await expect(page.getByText("All tasks")).toBeVisible();

  // the document tasks that used to be buried under "Store a document" are now first-class + discoverable
  await expect(page.getByTestId("task-store")).toBeVisible();
  await expect(page.getByTestId("task-open")).toBeVisible();
  await expect(page.getByTestId("task-browse")).toBeVisible();
  await expect(page.getByTestId("task-eligibility")).toBeVisible();

  // the live key-release readiness pill is shown so a visitor sees the keepers are up before they try the
  // "Open a shared document" path (count is environment-dependent; assert the format, not a fixed number)
  const committee = page.getByTestId("overview-committee");
  await expect(committee).toBeVisible({ timeout: 30_000 });
  await expect(committee).toContainText(/of \d+ keepers online/);

  // the passive "Guided demo" is no longer a dataroom tab
  await expect(page.getByRole("link", { name: "Guided demo" })).toHaveCount(0);

  // the on-chain trust anchor lives here once (explained, collapsed), not unexplained on every tab
  await page.getByTestId("overview-onchain").click();
  await expect(page.getByText("DataRoom contract")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("storage")).toContainText(/Cloudflare R2|local/);

  // "Open a document" deep-links straight into the Documents page's Open sub-tab
  await page.getByTestId("task-open").click();
  await expect(page).toHaveURL(/\/dataroom\/documents#open$/);
  await expect(page.getByRole("heading", { name: "Open a document" })).toBeVisible();

  // and that one page exposes Store / Open / Browse as a submenu
  await expect(page.getByTestId("doc-subtab-store")).toBeVisible();
  await expect(page.getByTestId("doc-subtab-open")).toBeVisible();
  await expect(page.getByTestId("doc-subtab-browse")).toBeVisible();
});
