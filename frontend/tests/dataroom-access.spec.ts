import { test, expect } from "@playwright/test";

// M3 + M4 — "Open a shared document" with sign-to-derive identity (Model B) + the anonymity meter / k=5 floor.
// The reader's room identity is derived from their wallet in the browser; the flow branches on their live
// on-chain status, and access is gated on the room's eligible-set size (the anonymity set). These tests mock
// Freighter (connected + signMessage) and stub the backend reads the hook makes directly. The SDK's chain
// reads (canOpenDocument) hit the real testnet RPC, where a freshly-derived accessor is never granted
// (admitted=false), so the not-yet-granted branches are deterministic. The full granted->open crypto path is
// covered by the live e2e (backend/scripts/m3-live-e2e.mjs).

const ADDR = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const SIG_B64 = Buffer.from(new Uint8Array(64).fill(0x07)).toString("base64");
const mock = `
  localStorage.setItem("zkorage.wallet.connected", "1");
  window.__freighterMock = {
    isConnected: async () => ({ isConnected: true }),
    isAllowed: async () => ({ isAllowed: true }),
    requestAccess: async () => ({ address: "${ADDR}" }),
    getAddress: async () => ({ address: "${ADDR}" }),
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: "${ADDR}" }),
    signMessage: async () => ({ signedMessage: "${SIG_B64}", signerAddress: "${ADDR}" }),
  };
`;

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function stubReads(
  page: import("@playwright/test").Page,
  enrollState: "none" | "pending" | "eligible",
  memberCount: number,
) {
  await page.route("**/dataroom/committee/info", (r) => r.fulfill(json({
    threshold: 2, n: 3, online: 3, dataroomId: "CID", note: "",
    keypers: [1, 2, 3].map((i) => ({ endpoint: `k${i}`, ok: true, keyperIndex: i, shares: 1, sealPub: String(i).repeat(64).slice(0, 64) })),
  })));
  await page.route("**/dataroom/committee/document/**", (r) => r.fulfill(json({
    document: { content_hash: "ab".repeat(32), k_commitment: "cd".repeat(32), pointer: "blob://x" }, dataroomId: "CID",
  })));
  await page.route("**/dataroom/enroll/status/**", (r) => r.fulfill(json({ state: enrollState })));
  await page.route("**/dataroom/membership/eligible/**", (r) => r.fulfill(json({
    roomId: "modelb", memberCount, commitments: [], computedRoot: "00".repeat(32), pinnedRoot: "00".repeat(32), inSync: true,
  })));
}

test("M3 reader: a non-member derives an identity and is sent to request to join (meter shown)", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(mock);
  await stubReads(page, "none", 8); // above the floor, amber

  await page.goto("/app/dataroom/access");
  await expect(page.getByTestId("access-card")).toBeVisible({ timeout: 30_000 });
  // the anonymity meter renders the room's eligible-set size + the honest caveat
  await expect(page.getByTestId("anon-meter")).toHaveAttribute("data-tier", "amber", { timeout: 30_000 });
  await expect(page.getByTestId("anon-meter-count")).toHaveText("8");

  await page.getByTestId("access-check-btn").click();
  await expect(page.getByTestId("access-stand-in")).toBeVisible({ timeout: 30_000 });
  const result = page.getByTestId("access-result");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toHaveAttribute("data-admitted", "false");
  await expect(page.getByTestId("access-join-pointer")).toBeVisible();
  await expect(page.getByRole("link", { name: /Request to join in Membership/i })).toHaveAttribute(
    "href",
    "/app/dataroom/membership",
  );
  await expect(page.getByTestId("access-open-btn")).toBeDisabled();

  await page.screenshot({ path: "tests/dataroom-access-page.png", fullPage: true });
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("M3 reader: on the list but not granted -> the one-time membership proof is offered (dark, above floor)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(mock);
  await stubReads(page, "eligible", 25); // green

  await page.goto("/app/dataroom/access");
  await expect(page.getByTestId("anon-meter")).toHaveAttribute("data-tier", "green", { timeout: 30_000 });
  await page.getByTestId("access-check-btn").click();
  await expect(page.getByTestId("access-result")).toHaveAttribute("data-admitted", "false", { timeout: 30_000 });

  // the prove-once step appears, ENABLED above the floor, with the honest self-hosted-prover copy
  const prove = page.getByTestId("access-prove");
  await expect(prove).toBeVisible();
  await expect(prove).toContainText(/self-hosted prover/i);
  await expect(page.getByTestId("access-prove-btn")).toBeEnabled();
  // no demo-key inputs remain (sign-to-derive replaced them)
  await expect(page.getByTestId("access-accessor")).toHaveCount(0);
  await expect(page.getByTestId("access-secret")).toHaveCount(0);

  await page.screenshot({ path: "tests/dataroom-access-prove-dark.png", fullPage: true });
});

test("M7 reader: an eligible member's access is BATCHED (queued for the window, not submitted instantly)", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReads(page, "eligible", 8); // above the floor (amber)

  // prove once -> hand the bundle to the batching relay -> queued for the next window (NOT request_access now).
  await page.route("**/dataroom/membership/prove-access", (r) => r.fulfill(json({
    jobId: "job-1", roomId: "modelb", eligibleRoot: "00".repeat(32),
    nullifier: "ab".repeat(32), accessor: "cd".repeat(32), recipientPub: "ef".repeat(32),
  })));
  await page.route("**/prove-status/**", (r) => r.fulfill(json({
    status: "done", bundle: { seal: "00".repeat(8), image_id: "11".repeat(32), journal: "22".repeat(32) },
  })));
  let queued = 0;
  let requested = 0;
  await page.route("**/dataroom/membership/request-access", (r) => { requested++; return r.fulfill(json({ ok: true })); });
  await page.route("**/dataroom/membership/queue-access", (r) => {
    queued++;
    return r.fulfill(json({ ok: true, ticket: "aa".repeat(16), status: "queued", flushAt: Date.now() + 60_000, nextFlushAt: Date.now() + 60_000, windowMs: 60_000 }));
  });
  await page.route("**/dataroom/membership/queue-status/**", (r) => r.fulfill(json({
    ticket: "aa".repeat(16), status: "queued", roomId: "modelb", accessor: "cd".repeat(32),
    flushAt: Date.now() + 60_000, nextFlushAt: Date.now() + 60_000, windowMs: 60_000, txHash: null, error: null,
  })));

  await page.goto("/app/dataroom/access");
  await expect(page.getByTestId("anon-meter")).toHaveAttribute("data-tier", "amber", { timeout: 30_000 });
  await page.getByTestId("access-check-btn").click();
  await expect(page.getByTestId("access-result")).toHaveAttribute("data-admitted", "false", { timeout: 30_000 });

  // the prove copy now explains the access is recorded in a shuffled batch, not instantly
  await expect(page.getByTestId("access-prove")).toContainText(/batch/i);
  await page.getByTestId("access-prove-btn").click();

  // it is queued for the window (the batching relay), not submitted immediately: the button + an ETA say so
  await expect(page.getByTestId("access-prove-btn")).toHaveText(/Waiting for the window/i, { timeout: 30_000 });
  await expect(page.getByTestId("access-queued-eta")).toBeVisible();
  expect(queued).toBe(1);
  expect(requested).toBe(0); // the immediate request-access route is NOT used by the Model B reader
});

test("M4 floor: below 5 members the meter is red and access is disabled", async ({ page }) => {
  await page.addInitScript(mock);
  await stubReads(page, "eligible", 2); // below the floor -> red, disabled

  await page.goto("/app/dataroom/access");
  await expect(page.getByTestId("access-card")).toBeVisible({ timeout: 30_000 });
  // red meter + the caveat that names the floor
  await expect(page.getByTestId("anon-meter")).toHaveAttribute("data-tier", "red", { timeout: 30_000 });
  await expect(page.getByTestId("access-card")).toContainText(/at least 5 members/i);

  await page.getByTestId("access-check-btn").click();
  await expect(page.getByTestId("access-result")).toHaveAttribute("data-admitted", "false", { timeout: 30_000 });
  // even an eligible member cannot prove or open below the floor
  await expect(page.getByTestId("access-prove-btn")).toBeDisabled();
  await expect(page.getByTestId("access-floor-note")).toBeVisible();
  await expect(page.getByTestId("access-open-btn")).toBeDisabled();

  await page.screenshot({ path: "tests/dataroom-access-floor.png", fullPage: true });
});

test("M3 reader: wallet-gated, and the folded tab still routes from the overview", async ({ page }) => {
  // no wallet mock -> the page asks to connect first
  await page.goto("/app/dataroom");
  await expect(page.getByTestId("task-access")).toBeVisible();
  await expect(page.getByTestId("task-policy")).toHaveCount(0);
  await expect(page.getByTestId("task-release")).toHaveCount(0);
  await page.getByTestId("task-access").click();
  await expect(page).toHaveURL(/\/dataroom\/access$/);
  await expect(page.getByTestId("access-connect-prompt")).toBeVisible({ timeout: 30_000 });
});
