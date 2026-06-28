import { test, expect } from "@playwright/test";

// The "Your access" tab under Bonded Proofs: the handle's grants, live-checked on-chain, sorted soonest-
// expiring first, with the ended ones below and a share link on active rows.
const DEPLOYER = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const ACCESSOR = "04".repeat(32);
const REQ_A = "aa".repeat(32); // active, soonest-expiring
const REQ_B = "bb".repeat(32); // active, later
const REQ_C = "cc".repeat(32); // ended (not granted)
const SIG_B64 = Buffer.from(new Uint8Array(64).fill(0x07)).toString("base64");
const mock = (addr: string) => `
  localStorage.setItem("zkorage.wallet.connected", "1");
  localStorage.setItem("zkorage.sync.dontAsk", "1");
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
const D_SOON = Math.floor(Date.UTC(2030, 0, 1, 12, 0, 0) / 1000);
const D_LATER = Math.floor(Date.UTC(2031, 0, 1, 12, 0, 0) / 1000);
const D_PAST = Math.floor(Date.UTC(2024, 0, 1, 12, 0, 0) / 1000);

function seed() {
  const handle = JSON.stringify({ idSecret: "01".repeat(32), idTrapdoor: "02".repeat(32), holderSeed: "03".repeat(32), accessor: ACCESSOR, qualCommitment: "ab".repeat(32) });
  const grants = JSON.stringify([
    { reqId: REQ_B, tokenSymbol: "TGLD", minAmount: "5000000000", decimals: 7, deadline: D_LATER },
    { reqId: REQ_A, tokenSymbol: "TUSD", minAmount: "25000000000", decimals: 7, deadline: D_SOON },
    { reqId: REQ_C, tokenSymbol: "XLM", minAmount: "1000000000", decimals: 7, deadline: D_PAST },
  ]);
  return `localStorage.setItem(${JSON.stringify(`zkorage-bond-identity.${DEPLOYER}`)}, ${JSON.stringify(handle)});
    localStorage.setItem(${JSON.stringify(`zkorage-bond-grants.${ACCESSOR}`)}, ${JSON.stringify(grants)});`;
}

function stub(page: import("@playwright/test").Page) {
  page.route("**/escrow/locks**", (route) => route.fulfill({ json: { owner: DEPLOYER, count: 0, escrowId: "E", locks: [] } }));
  page.route("**/escrow/balance**", (route) => route.fulfill({ json: { owner: DEPLOYER, balance: "0", bondTokenId: "" } }));
  page.route("**/bonded/bond/grants-vault/**", (route) => route.fulfill({ json: { found: false, blob: null } }));
  page.route("**/bonded/bond/status**", (route) => {
    const req = new URL(route.request().url()).searchParams.get("req_id");
    const granted = req === REQ_A || req === REQ_B;
    route.fulfill({ json: { accessor: ACCESSOR, reqId: req, is_granted: granted, grant: granted ? { index: 0 } : null, bondGateId: "G" } });
  });
}

test("access tab: the Your access tab is present under Bonded Proofs", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  stub(page);
  await page.goto("/app/bonded/access");
  await expect(page.getByTestId("bonded-access-page")).toBeVisible();
  await expect(page.getByRole("link", { name: "Your access", exact: true })).toBeVisible();
});

test("access tab: active grants sort soonest-expiring first, ended below, with share links", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  await page.addInitScript(seed());
  stub(page);
  await page.goto("/app/bonded/access");
  await expect(page.getByTestId("tier-access")).toBeVisible({ timeout: 15_000 });

  const rows = page.getByTestId("tier-access-row");
  await expect(rows).toHaveCount(3, { timeout: 15_000 });
  // Active rows first, soonest-expiring (TUSD, 2030) above the later one (TGLD, 2031); the ended XLM row last.
  await expect(rows.nth(0)).toContainText("2,500 TUSD");
  await expect(rows.nth(0)).toContainText("active until");
  await expect(rows.nth(1)).toContainText("500 TGLD");
  await expect(rows.nth(2)).toContainText("XLM");
  await expect(rows.nth(2)).toContainText("expired");

  // Active rows are shareable; the ended one is not.
  await expect(page.getByTestId("tier-access-share")).toHaveCount(2);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("tier-access-share").first().click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`/verify/bond?accessor=${ACCESSOR}`);
  expect(copied).toContain(`req=${REQ_A}`);
});

test("access tab: with no handle it points to the Bonded Access tab", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  stub(page);
  await page.goto("/app/bonded/access");
  await expect(page.getByTestId("tier-access-empty")).toContainText("Mint a handle", { timeout: 15_000 });
});
