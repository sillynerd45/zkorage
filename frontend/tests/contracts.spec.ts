import { test, expect, type Page } from "@playwright/test";

// The Contracts reference page (/app/contracts): a read-only list of the deployed Stellar testnet contract
// ids the app actually uses, for the Data Room and Bonded Access, each with a link to a public explorer.
// Stubs the public info endpoints the page reads so the assertions are deterministic and offline. The legacy
// zkUSD solvency/tier gates + zkUSD bond/supply tokens are intentionally NOT shown. No wallet needed.

const IDS = {
  dataroom: "CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN",
  verifier: "CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW",
  escrow: "CAMQKJKAJTOMT66N5N3E3VIRTN5ACDKV6P3Z2HLYVJHLAVRGJKHZFOXC",
  bondGate: "CCKX6B7QIE42YA27Y4KTB6CTXRB3OBGR5EW7N2BLAG4AB3V6CFDKXCZU",
};

const json = (body: object) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function stubInfo(page: Page) {
  await page.route("**/dataroom/info", (r) =>
    r.fulfill(json({ config: { admin: "", verifier: IDS.verifier, seal_image_id: "", claim_type: 8 }, roomCount: 0, dataroomImageId: "", recipientPub: "", storage: "local", dataroomId: IDS.dataroom })),
  );
  await page.route("**/escrow/info", (r) => r.fulfill(json({ escrowId: IDS.escrow, bondTokenId: "" })));
  await page.route("**/bonded/bond/info", (r) =>
    r.fulfill(json({ bondGateId: IDS.bondGate, bondImageId: "", claimType: 14, minAnonSet: 3, escrowId: IDS.escrow })),
  );
}

test("contracts page lists the Data Room + Bonded Access contracts with explorer links", async ({ page }) => {
  await stubInfo(page);
  await page.goto("/app/contracts");

  const root = page.getByTestId("contracts-page");
  await expect(root).toBeVisible();
  // scope to the page body: the app top bar also renders a "Contracts" heading for this route
  await expect(root.getByRole("heading", { name: "Contracts", exact: true })).toBeVisible();

  const dr = page.getByTestId("contracts-dataroom");
  await expect(dr).toContainText("DataRoom contract");
  await expect(dr).toContainText("Proof verifier");

  const bonded = page.getByTestId("contracts-bonded");
  await expect(bonded).toContainText("Escrow");
  await expect(bonded).toContainText("Bonded Access gate");
  // zUSD-related contracts are removed
  await expect(bonded).not.toContainText("Solvency gate");
  await expect(bonded).not.toContainText("Bond token");
  await expect(bonded).not.toContainText("Supply token");
  await expect(root).not.toContainText("zUSD");

  // each contract id links out to the public explorer; assert the DataRoom + bond-gate resolve to their ids
  await expect(dr.getByTestId("contract-explorer-link").first()).toHaveAttribute(
    "href",
    new RegExp(`stellar\\.expert/explorer/testnet/contract/${IDS.dataroom}`),
  );
  await expect(bonded.getByTestId("contract-explorer-link").last()).toHaveAttribute(
    "href",
    new RegExp(`stellar\\.expert/explorer/testnet/contract/${IDS.bondGate}`),
  );
});
