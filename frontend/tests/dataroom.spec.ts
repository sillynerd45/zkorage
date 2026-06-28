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
  localStorage.setItem("zkorage.sync.dontAsk", "1");
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

  // The Documents default sub-tab is now the member Open; deep-link to Store for the store assertions. The
  // Data Room stores a document one way now: an anonymous, policy-gated committee document. The old "Shared /
  // Direct" access toggle is gone (Direct was dropped), so there is no access-mode switch and no recipient-key
  // field, just the shared-membership note.
  await page.goto("/app/dataroom/documents#store");
  await expect(page.getByTestId("room-label")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("access-mode-shared")).toHaveCount(0);
  await expect(page.getByTestId("access-mode-direct")).toHaveCount(0);
  await expect(page.getByTestId("recipient-input")).toHaveCount(0);
  await expect(page.getByTestId("shared-access-note")).toBeVisible();
  // the File/Text switcher picks ONE input at a time. File is the default: the drop zone shows, the
  // textarea is not rendered. (We do NOT trigger the ~minutes-long proof in a UI test.)
  await expect(page.getByTestId("store-mode-file")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("doc-file")).toBeVisible();
  await expect(page.getByTestId("doc-content")).toHaveCount(0);
  // switching to Text reveals the textarea (placeholder-guided, no prefilled default) and hides the drop zone
  await page.getByTestId("store-mode-text").click();
  await expect(page.getByTestId("doc-content")).toBeVisible();
  await expect(page.getByTestId("doc-content")).toHaveValue("");
  await expect(page.getByTestId("doc-file")).toHaveCount(0);
  await page.getByTestId("store-mode-file").click(); // back to the default for the rest of the test
  await expect(page.getByTestId("upload")).toBeVisible();

  // MY FILES sub-tab: with no wallet, it asks you to connect — it shows the rooms YOU own, so a fresh visitor
  // sees nothing they didn't store (no auto-loaded seeded room). There is no "contents" column either: every
  // document is encrypted by default (the subtitle says so).
  await page.getByTestId("doc-subtab-mine").click();
  await expect(page.getByTestId("browse-connect-prompt")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Contents stay encrypted")).toBeVisible();

  // OPEN WITH A KEY — RECIPIENT OPEN (prefilled demo doc + demo recipient secret) → faithful plaintext. The
  // submenu pill was retired, but the view is still reachable by its #bykey hash (and the My-files hand-off).
  await page.goto("/app/dataroom/documents#bykey");
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

test("dataroom store: the File/Text switcher shows one input at a time and preserves a picked file", async ({ page }) => {
  // The file path (PDF/image/any) is exercised without the multi-minute proof: pick a file, toggle the
  // switcher, assert the UI state. setInputFiles takes an in-memory buffer, so no fixture file is needed.
  await page.goto("/app/dataroom/documents#store");
  // Default mode = File: the drop zone shows and the textarea is not rendered.
  await expect(page.getByTestId("doc-file")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("doc-content")).toHaveCount(0);

  await page.getByTestId("doc-file").setInputFiles({
    name: "sample.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%demo small pdf\n"),
  });
  await expect(page.getByTestId("doc-file-chip")).toContainText("sample.pdf");

  // Switch to Text → the textarea shows, the drop zone (and its chip) are hidden. The file stays in state.
  await page.getByTestId("store-mode-text").click();
  await expect(page.getByTestId("doc-content")).toBeVisible();
  await expect(page.getByTestId("doc-file")).toHaveCount(0);

  // Switch back to File → the previously picked file is still there (switching preserves both inputs).
  await page.getByTestId("store-mode-file").click();
  await expect(page.getByTestId("doc-file-chip")).toContainText("sample.pdf");

  // Removing the file clears the chip but stays in File mode (an empty drop zone).
  await page.getByTestId("doc-file-clear").click();
  await expect(page.getByTestId("doc-file-chip")).toHaveCount(0);
  await expect(page.getByTestId("doc-file")).toBeVisible();
});

test("dataroom Browse: a fresh connected wallet sees only its own rooms (empty), not a seeded doc", async ({ page }) => {
  // THE original complaint: a brand-new connected address should NOT see a document it never stored.
  await page.addInitScript(freighterMock());
  await page.goto("/app/dataroom/documents#mine");
  // Connected, but this address owns no rooms on-chain → the empty state (no auto-loaded seeded room).
  await expect(page.getByTestId("browse-empty")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("dataroom-docs")).toHaveCount(0);
});

// Browse now lists COMMITTEE documents (the kind the Store form makes), which live in a separate on-chain
// keyspace from the legacy DR1 seals. Each row is tagged kind="committee" and opens INLINE via the owner
// escrow copy (no recipient-key hand-off). We mock the two backend reads (rooms + documents) so the row
// renders deterministically; clicking it derives the room key (signMessage) then reads the on-chain doc —
// which is absent for this mock room id, so the opener surfaces a clean "not found", proving the wiring.
const SIG_B64 = Buffer.from(new Uint8Array(64).fill(0x09)).toString("base64");
const ROOM_HEX = "ab".repeat(32);
const DOC_HEX = "cd".repeat(32);
const browseMock = () => `
  ${freighterMock()}
  window.__freighterMock.signMessage = async () => ({ signedMessage: "${SIG_B64}", signerAddress: "${DEMO_G}" });
`;
test("dataroom Browse: lists a committee doc and wires the owner-open", async ({ page }) => {
  await page.addInitScript(browseMock());
  await page.route("**/dataroom/rooms?owner=**", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ owner: DEMO_G, count: 1, dataroomId: "CID", rooms: [
      { roomId: ROOM_HEX, label: "acme-board-docs", owner: DEMO_G, docCount: 1, dr1DocCount: 0, committeeDocCount: 1, ledger: 5, visibility: "private", name: null, description: null },
    ] }),
  }));
  await page.route("**/dataroom/documents/**", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ roomId: ROOM_HEX, count: 1, dr1Count: 0, committeeCount: 1, start: 0, limit: 25, dataroomId: "CID", documents: [
      { kind: "committee", index: 0, room_id: ROOM_HEX, doc_id: DOC_HEX, content_hash: "ef".repeat(32), k_commitment: "12".repeat(32), blob_pointer: "local://x", ledger: 5, timestamp: "0" },
    ] }),
  }));

  await page.goto("/app/dataroom/documents#mine");
  await page.getByTestId("my-room").first().click({ timeout: 30_000 });
  // the committee doc renders (tagged kind=committee, anonymous keeper-released subtitle, not a recipient seal)
  const row = page.getByTestId("doc-row").first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute("data-kind", "committee");
  await expect(row).toContainText("anonymous");

  // clicking it runs the owner-open: derive the room key (signMessage), then read the on-chain doc. This mock
  // room id is not anchored on testnet, so the opener returns "not found" — a clean, wired error (not a crash).
  await row.click();
  await expect(page.getByTestId("owner-open-error")).toBeVisible({ timeout: 30_000 });
});

// Loading + persistence in My files: a room's documents load behind a shimmer skeleton (the documents read is
// delayed so the skeleton is observable), and a room opened before reopens at once from the in-memory cache
// (no skeleton, just a background refresh). Two rooms with distinct documents prove the per-room cache.
const ROOM_B = "ef".repeat(32);
const DOC_B = "98".repeat(32);
const twoRoomsMock = () => `
  ${freighterMock()}
  window.__freighterMock.signMessage = async () => ({ signedMessage: "${SIG_B64}", signerAddress: "${DEMO_G}" });
`;
const committeeDoc = (room: string, doc: string, ledger: number) => ({
  kind: "committee", index: 0, room_id: room, doc_id: doc, content_hash: "ab".repeat(32),
  k_commitment: "cd".repeat(32), blob_pointer: "local://x", ledger, timestamp: "0",
});

test("My files: a room's documents load behind a skeleton, then a re-opened room is instant (cached)", async ({ page }) => {
  await page.addInitScript(twoRoomsMock());
  const J = (b: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  await page.route("**/dataroom/committee/info", (r) => r.fulfill(J({ online: 3, n: 3, threshold: 2 })));
  await page.route("**/dataroom/rooms-vault/**", (r) => r.fulfill(J({ found: false, blob: null })));
  await page.route("**/dataroom/rooms?owner=**", (r) => r.fulfill(J({ owner: DEMO_G, count: 2, dataroomId: "CID", rooms: [
    { roomId: ROOM_HEX, label: "Room A", owner: DEMO_G, docCount: 1, committeeDocCount: 1, ledger: 5, visibility: "private", name: null, description: null },
    { roomId: ROOM_B, label: "Room B", owner: DEMO_G, docCount: 1, committeeDocCount: 1, ledger: 6, visibility: "private", name: null, description: null },
  ] })));
  await page.route("**/dataroom/documents/**", async (r) => {
    const isA = r.request().url().includes(ROOM_HEX);
    await new Promise((res) => setTimeout(res, 600));
    return r.fulfill(J({ roomId: isA ? ROOM_HEX : ROOM_B, count: 1, start: 0, limit: 25, dataroomId: "CID",
      documents: [committeeDoc(isA ? ROOM_HEX : ROOM_B, isA ? DOC_HEX : DOC_B, isA ? 5 : 6)] }));
  });

  await page.goto("/app/dataroom/documents#mine");
  // Room A: the doc-list skeleton shows while it loads, then A's document.
  await page.getByTestId("my-room").nth(0).click({ timeout: 30_000 });
  await expect(page.getByTestId("docs-skeleton")).toBeVisible();
  await expect(page.locator(`[title="${DOC_HEX}"]`)).toBeVisible({ timeout: 15_000 });

  // Room B: another cold load (its own skeleton), then B's document.
  await page.getByTestId("my-room").nth(1).click();
  await expect(page.getByTestId("docs-skeleton")).toBeVisible();
  await expect(page.locator(`[title="${DOC_B}"]`)).toBeVisible({ timeout: 15_000 });

  // Back to Room A: its documents are cached, so they reopen at once with NO skeleton (a background refresh
  // runs silently). This is the fix for "going back to a room makes me wait for it to reload".
  await page.getByTestId("my-room").nth(0).click();
  await expect(page.locator(`[title="${DOC_HEX}"]`)).toBeVisible();
  await expect(page.getByTestId("docs-skeleton")).toHaveCount(0);
});

test("My files: the selected room and its documents persist across a tab switch", async ({ page }) => {
  await page.addInitScript(twoRoomsMock());
  const J = (b: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  await page.route("**/dataroom/committee/info", (r) => r.fulfill(J({ online: 3, n: 3, threshold: 2 })));
  await page.route("**/dataroom/rooms-vault/**", (r) => r.fulfill(J({ found: false, blob: null })));
  await page.route("**/dataroom/rooms?owner=**", (r) => r.fulfill(J({ owner: DEMO_G, count: 1, dataroomId: "CID", rooms: [
    { roomId: ROOM_HEX, label: "Room A", owner: DEMO_G, docCount: 1, committeeDocCount: 1, ledger: 5, visibility: "private", name: null, description: null },
  ] })));
  await page.route("**/dataroom/documents/**", async (r) => {
    await new Promise((res) => setTimeout(res, 600));
    return r.fulfill(J({ roomId: ROOM_HEX, count: 1, start: 0, limit: 25, dataroomId: "CID", documents: [committeeDoc(ROOM_HEX, DOC_HEX, 5)] }));
  });

  await page.goto("/app/dataroom/documents#mine");
  await page.getByTestId("my-room").first().click({ timeout: 30_000 });
  await expect(page.locator(`[title="${DOC_HEX}"]`)).toBeVisible({ timeout: 15_000 });

  // Leave Documents (client-side nav) then return to My files: the selection + its documents repaint at once
  // from cache, with no skeleton.
  await page.getByRole("link", { name: "Overview", exact: true }).first().click();
  await expect(page.getByTestId("dataroom-overview")).toBeVisible();
  await page.getByRole("link", { name: "Documents", exact: true }).first().click();
  await page.getByTestId("doc-subtab-mine").click();
  await expect(page.locator(`[title="${DOC_HEX}"]`)).toBeVisible();
  await expect(page.getByTestId("docs-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("my-room").first()).toHaveAttribute("aria-pressed", "true");
});

test("dataroom overview: task-oriented cards route to the right place; guided-demo tab removed", async ({ page }) => {
  await page.goto("/app/dataroom");
  // the landing is a featured "Store a document" hero card + an "All tasks" grid (no duplicate "what do you
  // want to do?" description; the one-line lead lives in the header)
  await expect(page.getByTestId("dataroom-overview")).toBeVisible();
  await expect(page.getByText("Start here")).toBeVisible();
  await expect(page.getByText("All tasks")).toBeVisible();

  // "All tasks" now mirrors the real menu: Store (hero) + Open / My files (Documents) + Membership + Discover
  await expect(page.getByTestId("task-store")).toBeVisible();
  await expect(page.getByTestId("task-browse")).toBeVisible();
  await expect(page.getByTestId("task-access")).toBeVisible();
  await expect(page.getByTestId("task-membership")).toBeVisible();
  await expect(page.getByTestId("task-discover")).toBeVisible();
  // the "Get in anonymously" + "Open with a key" cards were retired; the real member flow is task-access
  await expect(page.getByTestId("task-eligibility")).toHaveCount(0);
  await expect(page.getByTestId("task-open")).toHaveCount(0);

  // the live key-release readiness pill is shown so a visitor sees the keepers are up before they try the
  // "Open a shared document" path (count is environment-dependent; assert the format, not a fixed number)
  const committee = page.getByTestId("overview-committee");
  await expect(committee).toBeVisible({ timeout: 30_000 });
  await expect(committee).toContainText(/of \d+ keepers online/);

  // the passive "Guided demo" is no longer a dataroom tab
  await expect(page.getByRole("link", { name: "Guided demo" })).toHaveCount(0);

  // the concept explainer, the timing demo, and the on-chain contract list all moved OFF the Overview
  // (to Documentation + the Contracts reference page), so the Overview stays task-focused
  await expect(page.getByTestId("overview-what-is")).toHaveCount(0);
  await expect(page.getByTestId("overview-onchain")).toHaveCount(0);
  await expect(page.getByTestId("m7-showcase")).toHaveCount(0);

  // the headline member-open card points to Documents > Open (assert the link, then navigate into it)
  await expect(page.getByTestId("task-access")).toHaveAttribute("href", /\/dataroom\/documents#open$/);
  await page.getByTestId("task-access").click();
  await expect(page).toHaveURL(/\/dataroom\/documents#open$/);

  // the Documents submenu is now Open / Store / My files ("Open with a key" was retired from the submenu)
  await expect(page.getByTestId("doc-subtab-open")).toBeVisible();
  await expect(page.getByTestId("doc-subtab-store")).toBeVisible();
  await expect(page.getByTestId("doc-subtab-mine")).toBeVisible();
  await expect(page.getByTestId("doc-subtab-bykey")).toHaveCount(0);
});

// M7 — the read-only showcase panel, now on the public Docs > Capabilities page: a wallet-free demonstration
// of the timing defense (a green anonymity meter for a real testnet room + its on-chain grant log showing a
// clustered, shuffled batch of accesses). Mocks the two chain-reads the panel makes; no wallet, so it proves
// the panel is public.
test("M7 showcase: Docs Capabilities shows a green meter + a batched on-chain access record (no wallet)", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const grant = (index: number, acc: string, dt: number) => ({
    index, accessor: acc.repeat(32), nullifier: "00".repeat(32), eligibleRoot: "00".repeat(32), ledger: 1, timestamp: now + dt,
  });
  await page.route("**/dataroom/membership/eligible/**", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ roomId: "cba6", memberCount: 24, commitments: [], computedRoot: "00".repeat(32), pinnedRoot: "00".repeat(32), inSync: true }),
  }));
  await page.route("**/dataroom/membership/grants/**", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ roomId: "cba6", count: 4, dataroomId: "CID", grants: [grant(0, "ab", 0), grant(1, "cd", 5), grant(2, "ef", 10), grant(3, "12", 15)] }),
  }));

  await page.goto("/docs/capabilities");
  const panel = page.getByTestId("m7-showcase");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId("anon-meter")).toHaveAttribute("data-tier", "green");
  await expect(panel.getByTestId("anon-meter-count")).toHaveText("24");
  await expect(panel.getByTestId("m7-showcase-grants").locator("> div")).toHaveCount(4);
  await expect(panel.getByTestId("m7-showcase-spread")).toContainText("within 15 seconds");
});

// M7 showcase regression (S1): if the serving backend's eligible store is reset (memberCount 0) while the
// grants are still on-chain, the panel must HIDE rather than render a contradictory red "below the floor"
// meter next to a real access log. The whole panel is gone, not a half-broken showcase.
test("M7 showcase: hides cleanly when the meter source is reset (no red showcase)", async ({ page }) => {
  await page.route("**/dataroom/membership/eligible/**", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ roomId: "cba6", memberCount: 0, commitments: [], computedRoot: "00".repeat(32), pinnedRoot: "00".repeat(32), inSync: true }),
  }));
  await page.route("**/dataroom/membership/grants/**", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ roomId: "cba6", count: 2, dataroomId: "CID", grants: [
      { index: 0, accessor: "ab".repeat(32), nullifier: "00".repeat(32), eligibleRoot: "00".repeat(32), ledger: 1, timestamp: 1782061790 },
      { index: 1, accessor: "cd".repeat(32), nullifier: "00".repeat(32), eligibleRoot: "00".repeat(32), ledger: 1, timestamp: 1782061795 },
    ] }),
  }));
  await page.goto("/docs/capabilities");
  await expect(page.getByText("A sealed room for sensitive documents.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("m7-showcase")).toHaveCount(0); // hidden, not a red meter
});
