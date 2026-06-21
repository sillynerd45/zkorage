import { test, expect } from "@playwright/test";

// M3 — "Open a shared document" with sign-to-derive identity (Model B). The reader's room identity is derived
// from their wallet in the browser; the flow branches on their live on-chain status. These tests mock Freighter
// (connected + signMessage) and stub the backend reads the hook makes directly. The SDK's chain reads
// (canOpenDocument) hit the real testnet RPC, where a freshly-derived accessor is never granted (admitted=false),
// so the not-yet-granted branches are deterministic. The full granted->open crypto path is covered by the live
// e2e (backend/scripts/m3-live-e2e.mjs), since a mock wallet cannot produce an on-chain-granted accessor.

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

async function stubReads(page: import("@playwright/test").Page, enrollState: "none" | "pending" | "eligible") {
  await page.route("**/dataroom/committee/info", (r) => r.fulfill(json({
    threshold: 2, n: 3, online: 3, dataroomId: "CID", note: "",
    keypers: [1, 2, 3].map((i) => ({ endpoint: `k${i}`, ok: true, keyperIndex: i, shares: 1, sealPub: String(i).repeat(64).slice(0, 64) })),
  })));
  await page.route("**/dataroom/committee/document/**", (r) => r.fulfill(json({
    document: { content_hash: "ab".repeat(32), k_commitment: "cd".repeat(32), pointer: "blob://x" }, dataroomId: "CID",
  })));
  await page.route("**/dataroom/enroll/status/**", (r) => r.fulfill(json({ state: enrollState })));
}

test("M3 reader: a non-member derives an identity and is sent to request to join", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(mock);
  await stubReads(page, "none");

  await page.goto("/app/dataroom/access");
  await expect(page.getByTestId("access-card")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("access-check-btn").click();

  // the identity is derived from the wallet (one signMessage) and only the pseudonymous stand-in ID is shown
  await expect(page.getByTestId("access-stand-in")).toBeVisible({ timeout: 30_000 });
  // a freshly-derived accessor is not granted on-chain (live RPC), so the reader does not yet qualify
  const result = page.getByTestId("access-result");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toHaveAttribute("data-admitted", "false");
  // and they are pointed to Membership to request to join (they are not on the list)
  await expect(page.getByTestId("access-join-pointer")).toBeVisible();
  await expect(page.getByRole("link", { name: /Request to join in Membership/i })).toHaveAttribute(
    "href",
    "/app/dataroom/membership",
  );
  // the open step stays disabled until they qualify
  await expect(page.getByTestId("access-open-btn")).toBeDisabled();

  await page.screenshot({ path: "tests/dataroom-access-page.png", fullPage: true });
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("M3 reader: on the list but not granted -> the one-time membership proof is offered (dark)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(mock);
  await stubReads(page, "eligible");

  await page.goto("/app/dataroom/access");
  await expect(page.getByTestId("access-card")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("access-check-btn").click();
  await expect(page.getByTestId("access-result")).toHaveAttribute("data-admitted", "false", { timeout: 30_000 });

  // the prove-once step appears with the honest self-hosted-prover copy (we do not click it: it runs the prover)
  const prove = page.getByTestId("access-prove");
  await expect(prove).toBeVisible();
  await expect(prove).toContainText(/self-hosted prover/i);
  await expect(page.getByTestId("access-prove-btn")).toBeVisible();
  // no demo-key inputs remain (sign-to-derive replaced them)
  await expect(page.getByTestId("access-accessor")).toHaveCount(0);
  await expect(page.getByTestId("access-secret")).toHaveCount(0);

  await page.screenshot({ path: "tests/dataroom-access-prove-dark.png", fullPage: true });
});

test("M3 reader: wallet-gated, and the folded tab still routes from the overview", async ({ page }) => {
  // no wallet mock -> the page asks to connect first
  await page.goto("/app/dataroom");
  await expect(page.getByTestId("task-access")).toBeVisible();
  // the old separate "Meet all conditions" / "Release the key" tasks stay folded away
  await expect(page.getByTestId("task-policy")).toHaveCount(0);
  await expect(page.getByTestId("task-release")).toHaveCount(0);
  await page.getByTestId("task-access").click();
  await expect(page).toHaveURL(/\/dataroom\/access$/);
  await expect(page.getByTestId("access-connect-prompt")).toBeVisible({ timeout: 30_000 });
});
