import { test, expect } from "@playwright/test";

// M1 — request-then-approve enrollment UI. Headless Chrome can't load the real extension, so we inject the
// connected-wallet seam (now incl. signMessage for sign-to-derive) and stub the /dataroom/enroll/* endpoints,
// so this drives the UI without a live backend/prover.
const ADDR = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const SIG_B64 = Buffer.from(new Uint8Array(64).fill(0x07)).toString("base64"); // a fixed SEP-53 signature
const OWNER_ROOM = "b".repeat(64);
const JOIN_ROOM = "a".repeat(64);
const mock = (addr: string) => `
  localStorage.setItem("zkorage.wallet.connected", "1");
  window.__freighterMock = {
    isConnected: async () => ({ isConnected: true }),
    isAllowed: async () => ({ isAllowed: true }),
    requestAccess: async () => ({ address: "${addr}" }),
    getAddress: async () => ({ address: "${addr}" }),
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: "${addr}" }),
    signMessage: async () => ({ signedMessage: "${SIG_B64}", signerAddress: "${addr}" }),
  };
`;
const DARK = `localStorage.setItem("zkorage-theme","dark");`;

async function stubs(page: import("@playwright/test").Page) {
  let approved = false;
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/dataroom/committee/info", (r) => r.fulfill(json({ online: 3, n: 3, threshold: 2 })));
  await page.route("**/dataroom/rooms?owner=**", (r) =>
    r.fulfill(json({ owner: ADDR, count: 1, rooms: [{ roomId: OWNER_ROOM, label: "Acme board", owner: ADDR, docCount: 0, ledger: 1, visibility: "private", name: null, description: null }], dataroomId: "" })));
  await page.route("**/dataroom/room/visibility", (r) =>
    r.fulfill(json({ ok: true, roomId: OWNER_ROOM, visibility: "listed", name: "Acme board", description: null })));
  await page.route("**/dataroom/enroll/status/**", (r) => r.fulfill(json({ state: "none" })));
  await page.route("**/dataroom/enroll/request", (r) => r.fulfill(json({ ok: true, state: "pending", added: true })));
  await page.route("**/dataroom/enroll/requests/**", (r) =>
    r.fulfill(json({ roomId: OWNER_ROOM, pending: approved ? [] : [{ commitment: "c".repeat(64), label: "Alice", requester: ADDR, ts: 1 }], memberCount: approved ? 1 : 0 })));
  await page.route("**/dataroom/enroll/approve", (r) => { approved = true; return r.fulfill(json({ ok: true, xdr: "AAAAtest" })); });
  await page.route("**/tx/submit", (r) => r.fulfill(json({ ok: true, txHash: "deadbeef" })));
}

test("membership: member derives + requests; owner approves (light)", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(mock(ADDR));
  await stubs(page);
  await page.goto("/app/dataroom/membership");

  // member: ONE button derives the per-room id (signMessage) AND files the request (Join is the default sub-tab).
  await expect(page.getByTestId("enroll-card")).toBeVisible();
  await expect(page.getByTestId("enroll-join-room")).toBeVisible(); // Join sub-tab is the default
  await page.getByTestId("enroll-join-room").fill(JOIN_ROOM);
  await page.getByTestId("enroll-label").fill("Alice from Acme");
  await page.getByTestId("enroll-request").click();
  await expect(page.getByTestId("enroll-state")).toHaveAttribute("data-state", "pending", { timeout: 15_000 });
  await expect(page.getByTestId("enroll-commitment")).toBeVisible(); // derived id shown for transparency
  // the button now reflects the result (disabled + "Request sent") so it's clear the request landed.
  await expect(page.getByTestId("enroll-request")).toBeDisabled();
  await expect(page.getByTestId("enroll-request")).toContainText("Request sent");

  // "Your requests" history now lists this room with a Pending pill (kept locally, per wallet).
  const reqRow = page.getByTestId("request-row").first();
  await expect(reqRow).toBeVisible();
  await expect(reqRow.getByTestId("request-state-pill")).toHaveAttribute("data-state", "pending");

  // owner: switch to the Approve sub-tab, pick a room I own -> see the pending request -> approve -> it clears.
  await page.getByTestId("member-subtab-approve").click();
  await expect(page.getByTestId("enroll-my-rooms")).toBeVisible();
  await page.getByTestId("enroll-owner-room").first().click();
  // the selected room exposes its exact id with a copy button (to share with people to invite).
  const roomIdRow = page.getByTestId("enroll-room-id");
  await expect(roomIdRow).toBeVisible();
  await expect(roomIdRow.getByRole("button", { name: /copy room id/i })).toBeVisible();
  await expect(page.getByTestId("enroll-pending-row")).toHaveCount(1);
  // Privacy (choice A): the pending row shows the self-chosen label, NEVER the requester's wallet address.
  const pendingRow = page.getByTestId("enroll-pending-row").first();
  await expect(pendingRow).toContainText("Alice");
  await expect(pendingRow).not.toContainText(ADDR.slice(0, 6)); // no wallet-address fragment
  await page.getByTestId("enroll-approve").click();
  await expect(page.getByTestId("enroll-no-pending")).toBeVisible({ timeout: 15_000 });

  // M5: set the room's discovery tier to listed + a public name, then save.
  await expect(page.getByTestId("enroll-visibility")).toBeVisible();
  // Save starts disabled: the room is Private and the selected tier is also Private (nothing changed).
  await expect(page.getByTestId("vis-save")).toBeDisabled();
  await page.getByTestId("vis-listed").click();
  await expect(page.getByTestId("vis-name")).toBeVisible(); // name input appears once not private
  await page.getByTestId("vis-name").fill("Acme board");
  await expect(page.getByTestId("vis-save")).toBeEnabled(); // changing the tier makes the form dirty
  await page.getByTestId("vis-save").click();
  await expect(page.getByTestId("vis-saved")).toBeVisible({ timeout: 15_000 });
  // after saving, the snapshot matches the form again -> Save goes back to disabled.
  await expect(page.getByTestId("vis-save")).toBeDisabled();

  await page.screenshot({ path: "tests/membership.png", fullPage: true });
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("membership: prefills the join room from a directory ?room= link", async ({ page }) => {
  await page.addInitScript(mock(ADDR));
  await stubs(page);
  await page.goto(`/app/dataroom/membership?room=${JOIN_ROOM}`);
  await expect(page.getByTestId("enroll-card")).toBeVisible();
  // Arriving from a directory link lands on the Join sub-tab with the room prefilled.
  await expect(page.getByTestId("member-subtab-join")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("enroll-join-room")).toHaveValue(JOIN_ROOM);
});

test("membership: the request button reflects state and resets when the room id changes", async ({ page }) => {
  await page.addInitScript(mock(ADDR));
  await stubs(page);
  await page.goto("/app/dataroom/membership");
  const reqBtn = page.getByTestId("enroll-request");
  await expect(reqBtn).toBeEnabled();
  await expect(reqBtn).toContainText("Request to join");

  await page.getByTestId("enroll-join-room").fill(JOIN_ROOM);
  await reqBtn.click();
  await expect(page.getByTestId("enroll-state")).toHaveAttribute("data-state", "pending", { timeout: 15_000 });
  await expect(reqBtn).toBeDisabled();
  await expect(reqBtn).toContainText("Request sent");

  // editing the room id clears the per-room result so the button is usable again for the NEW room.
  await page.getByTestId("enroll-join-room").fill("d".repeat(64));
  await expect(reqBtn).toBeEnabled();
  await expect(reqBtn).toContainText("Request to join");
  await expect(page.getByTestId("enroll-state")).toHaveCount(0);
});

test("membership: Approve all batches every pending request in one action", async ({ page }) => {
  const j = (b: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  let batched = false;
  let batchCalls = 0;
  await page.addInitScript(mock(ADDR));
  await page.route("**/dataroom/committee/info", (r) => r.fulfill(j({ online: 3, n: 3, threshold: 2 })));
  await page.route("**/dataroom/rooms?owner=**", (r) =>
    r.fulfill(j({ owner: ADDR, count: 1, rooms: [{ roomId: OWNER_ROOM, label: "Acme board", owner: ADDR, docCount: 0, ledger: 1, visibility: "private", name: null, description: null }], dataroomId: "" })));
  await page.route("**/dataroom/enroll/requests/**", (r) =>
    r.fulfill(j({
      roomId: OWNER_ROOM,
      pending: batched ? [] : [{ commitment: "c".repeat(64), label: "Alice", ts: 1 }, { commitment: "d".repeat(64), label: "Bob", ts: 2 }],
      memberCount: batched ? 2 : 0,
    })));
  await page.route("**/dataroom/enroll/approve-batch", (r) => { batched = true; batchCalls++; return r.fulfill(j({ ok: true, xdr: "AAAAtest" })); });
  await page.route("**/tx/submit", (r) => r.fulfill(j({ ok: true, txHash: "deadbeef" })));

  await page.goto("/app/dataroom/membership");
  await page.getByTestId("member-subtab-approve").click();
  await page.getByTestId("enroll-owner-room").first().click();
  await expect(page.getByTestId("enroll-pending-row")).toHaveCount(2);

  // a single "Approve all (N)" button clears every pending request in one batch (one wallet signature).
  const allBtn = page.getByTestId("enroll-approve-all");
  await expect(allBtn).toContainText("Approve all (2)");
  await allBtn.click();
  await expect(page.getByTestId("enroll-no-pending")).toBeVisible({ timeout: 15_000 });
  expect(batchCalls).toBe(1);
});

test("membership: an approved request offers Open documents; a pending one has no open button", async ({ page }) => {
  // Seed the local request history: JOIN_ROOM approved, OWNER_ROOM pending (this browser, per wallet).
  await page.addInitScript(mock(ADDR));
  await page.addInitScript(`localStorage.setItem("zkorage.dr.requests.${ADDR}", JSON.stringify([
    { roomId: "${JOIN_ROOM}", label: "Acme", state: "eligible", ts: 2 },
    { roomId: "${OWNER_ROOM}", state: "pending", ts: 1 },
  ]));`);
  await stubs(page);
  await page.goto("/app/dataroom/membership");

  await expect(page.getByTestId("request-row")).toHaveCount(2);
  // only the approved row has an action: "Open documents" deep-linking to the access tab with the room prefilled.
  const openLink = page.getByTestId("request-open");
  await expect(openLink).toHaveCount(1);
  await expect(openLink).toHaveAttribute("href", `/app/dataroom/access?room=${JOIN_ROOM}`);
});

test("membership: renders dark + requires a wallet", async ({ page }) => {
  // dark, connected
  await page.addInitScript(mock(ADDR));
  await page.addInitScript(DARK);
  await stubs(page);
  await page.goto("/app/dataroom/membership");
  await expect(page.getByTestId("enroll-card")).toBeVisible();
  await page.screenshot({ path: "tests/membership-dark.png", fullPage: true });

  // no wallet -> the connect prompt instead of the form
  await page.addInitScript(`localStorage.removeItem("zkorage.wallet.connected"); window.__freighterMock = {
    isConnected: async () => ({ isConnected: true }), isAllowed: async () => ({ isAllowed: false }),
    getAddress: async () => ({ address: "" }), getNetwork: async () => ({ network: "TESTNET" }),
  };`);
  await page.goto("/app/dataroom/membership");
  await expect(page.getByTestId("enroll-connect-prompt")).toBeVisible();
});
