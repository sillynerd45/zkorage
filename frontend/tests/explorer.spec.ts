import { test, expect } from "@playwright/test";

// The public Explorer is the public-rooms directory, split into Membership and Bonded Access tabs. We stub
// /dataroom/directory so the two room types render deterministically (offline).

const MEM = "a".repeat(64);
const BOND = "b".repeat(64);

const DIRECTORY = {
  count: 2,
  dataroomId: "CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN",
  rooms: [
    {
      roomId: MEM,
      name: "Acme due diligence",
      description: "Series B data room",
      memberBucket: "5-19",
      anonTier: "ok",
      listedAt: 1781400000,
      bond: null,
    },
    {
      roomId: BOND,
      name: "Token holders room",
      description: "Lock a bond to enter",
      memberBucket: "under 5",
      anonTier: "forming",
      listedAt: 1781410000,
      bond: {
        bondOpen: true,
        token: "C" + "A".repeat(55),
        symbol: "TUSD",
        decimals: 7,
        issuer: null,
        minAmount: "100000000000",
        deadline: 9999999999,
        reqId: "c".repeat(64),
      },
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/dataroom/directory", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DIRECTORY) }),
  );
});

test("explorer: two tabs split membership vs bonded rooms", async ({ page }) => {
  await page.goto("/explorer");
  await expect(page.getByRole("heading", { name: "Explorer" })).toBeVisible();

  // tabs with counts
  await expect(page.getByTestId("explorer-tab-membership")).toContainText("1");
  await expect(page.getByTestId("explorer-tab-bonded")).toContainText("1");

  // default = membership: the membership room is shown, with a verify link
  const memList = page.getByTestId("explorer-list-membership");
  await expect(memList).toBeVisible();
  await expect(memList.getByText("Acme due diligence")).toBeVisible();
  await expect(memList.getByRole("link", { name: /verify on-chain/i })).toHaveAttribute(
    "href",
    `/verify/room/${MEM}`,
  );

  // switch to bonded: the bonded room with its lock requirement
  await page.getByTestId("explorer-tab-bonded").click();
  const bondList = page.getByTestId("explorer-list-bonded");
  await expect(bondList).toBeVisible();
  await expect(bondList.getByText("Token holders room")).toBeVisible();
  // the bond requirement: minAmount 100000000000 @ 7dp = 10,000 TUSD
  await expect(bondList.getByText(/10,000 TUSD to enter/)).toBeVisible();
});

test("explorer: find a room by id resolves a listed room", async ({ page }) => {
  await page.route("**/dataroom/room-meta/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        roomId: MEM,
        visibility: "listed",
        discoverable: true,
        exists: true,
        name: "Resolved room",
        memberBucket: "5-19",
        anonTier: "ok",
        bond: null,
      }),
    }),
  );
  await page.goto("/explorer");
  await page.getByTestId("explorer-lookup-input").fill(MEM);
  await page.getByTestId("explorer-lookup-input").press("Enter");
  await expect(page.getByText("Resolved room")).toBeVisible();
});
