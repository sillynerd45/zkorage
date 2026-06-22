import { test, expect, type Page } from "@playwright/test";

// The Contracts reference page (/app/contracts): a read-only list of the deployed Stellar testnet contract
// ids for the Data Room and Bonded Proofs, each with a link to a public explorer. Stubs the four public info
// endpoints the page reads so the assertions are deterministic and offline. No wallet needed.

const IDS = {
  dataroom: "CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN",
  verifier: "CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW",
  escrow: "CAMQKJKAJTOMT66N5N3E3VIRTN5ACDKV6P3Z2HLYVJHLAVRGJKHZFOXC",
  bond: "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5",
  solvency: "CDHUG4NFTDIO4HX2MZH3PR77EKYUAU47HVKH4UO2WG7GSKDEF4ABWMLA",
  tier: "CASSJSBMFDS3BCUBYKXG52SUS7GIHBCHDUM5FGQO4LY5VOWPUPPUFKZP",
  supply: "CC3JKNC4EKALMT7WALUMCTVBSH73ZZSP3AC4B7IQUAZ7UYYZCEIISQLA",
};

const json = (body: object) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function stubInfo(page: Page) {
  await page.route("**/dataroom/info", (r) =>
    r.fulfill(json({ config: { admin: "", verifier: IDS.verifier, seal_image_id: "", claim_type: 8 }, roomCount: 0, dataroomImageId: "", recipientPub: "", storage: "local", dataroomId: IDS.dataroom })),
  );
  await page.route("**/escrow/info", (r) => r.fulfill(json({ escrowId: IDS.escrow, bondTokenId: IDS.bond })));
  await page.route("**/bonded/solvency/info", (r) =>
    r.fulfill(json({ solvencyGateId: IDS.solvency, supplyTokenId: IDS.supply, solvencyImageId: "", auditorPub: "", escrowId: IDS.escrow, bondTokenId: IDS.bond, claimType: 12 })),
  );
  await page.route("**/bonded/tier/info", (r) =>
    r.fulfill(json({ tierGateId: IDS.tier, tierImageId: "", claimType: 13, minAnonSet: 3, enrolledCount: 0, grantCount: 0, escrowId: IDS.escrow, bondTokenId: IDS.bond })),
  );
}

test("contracts page lists the Data Room + Bonded Proofs contracts with explorer links", async ({ page }) => {
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
  await expect(bonded).toContainText("Bond token");
  await expect(bonded).toContainText("Solvency gate");
  await expect(bonded).toContainText("Anonymous tier gate");
  await expect(bonded).toContainText("Supply token");

  // each contract id links out to the public explorer; assert the DataRoom contract resolves to its id
  await expect(dr.getByTestId("contract-explorer-link").first()).toHaveAttribute(
    "href",
    new RegExp(`stellar\\.expert/explorer/testnet/contract/${IDS.dataroom}`),
  );
});
