import { test, expect } from "@playwright/test";

// M5 — the public directory + resolve-by-id. The Discover page is wallet-OPTIONAL (browsing is public), so
// these tests run WITHOUT a wallet mock and stub the read-only directory/room-meta endpoints.
const LISTED1 = "1".repeat(64); // named, listed
const LISTED2 = "2".repeat(64); // unnamed, listed, forming
const UNLISTED = "3".repeat(64); // resolvable by exact id, not in the directory
const PRIVATE = "4".repeat(64); // reveals nothing
const DARK = `localStorage.setItem("zkorage-theme","dark");`;

async function stubs(page: import("@playwright/test").Page) {
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/dataroom/directory", (r) =>
    r.fulfill(
      json({
        count: 2,
        dataroomId: "",
        rooms: [
          { roomId: LISTED1, name: "Series A data room", description: "Diligence pack for the round.", memberBucket: "5-19", anonTier: "ok", listedAt: 2 },
          { roomId: LISTED2, name: null, description: null, memberBucket: "under 5", anonTier: "forming", listedAt: 1 },
        ],
      }),
    ));
  await page.route("**/dataroom/room-meta/**", (r) => {
    const url = r.request().url();
    if (url.includes(UNLISTED)) {
      return r.fulfill(json({ roomId: UNLISTED, visibility: "unlisted", discoverable: true, listed: false, name: "Quiet round", description: null, memberBucket: "20-49", anonTier: "strong" }));
    }
    return r.fulfill(json({ roomId: PRIVATE, visibility: "private", discoverable: false }));
  });
}

test("discover: browse the directory (coarse buckets, no exact counts) + resolve by id", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await stubs(page);
  await page.goto("/app/dataroom/discover");

  // directory lists exactly the two listed rooms, each with a coarse bucket badge (a range, not a number).
  await expect(page.getByTestId("discover-card")).toBeVisible();
  await expect(page.getByTestId("discover-room")).toHaveCount(2);
  await expect(page.getByTestId("bucket-badge").first()).toContainText("5-19");
  await expect(page.getByTestId("bucket-badge").first()).toHaveAttribute("data-tier", "ok");
  await expect(page.getByText("Unnamed room")).toBeVisible(); // LISTED2 opted out of a name

  // switch to the "Find by id" sub-tab for the resolve-by-id flow (the directory is the default sub-tab).
  await page.getByTestId("discover-subtab-find").click();
  // resolve an UNLISTED room by exact id -> discoverable with a bucket, marked unlisted.
  await page.getByTestId("discover-lookup-input").fill(UNLISTED);
  await page.getByTestId("discover-lookup-btn").click();
  await expect(page.getByTestId("discover-lookup-result")).toHaveAttribute("data-discoverable", "true");
  await expect(page.getByTestId("discover-lookup-result")).toContainText("unlisted");
  await expect(page.getByTestId("discover-lookup-result").getByTestId("bucket-badge")).toContainText("20-49");

  // resolve a PRIVATE id -> reveals nothing (still offers a request-to-join, since by-id join works).
  await page.getByTestId("discover-lookup-input").fill(PRIVATE);
  await page.getByTestId("discover-lookup-btn").click();
  await expect(page.getByTestId("discover-lookup-result")).toHaveAttribute("data-discoverable", "false");
  await expect(page.getByTestId("discover-lookup-result")).not.toContainText("members");

  await page.screenshot({ path: "tests/discover.png", fullPage: true });
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("discover: a request-to-join link routes to Membership with the room prefilled", async ({ page }) => {
  await stubs(page);
  await page.goto("/app/dataroom/discover");
  await expect(page.getByTestId("discover-room").first()).toBeVisible();
  await page.getByTestId("discover-join").first().click();
  // No wallet -> Membership shows the connect prompt, but the URL carries the room id for prefill on connect.
  await expect(page).toHaveURL(new RegExp(`/app/dataroom/membership\\?room=${LISTED1}`));
  await expect(page.getByTestId("enroll-connect-prompt")).toBeVisible();
});

test("discover: reflects your local request status on the directory buttons", async ({ page }) => {
  // A connected wallet whose local request history (this browser) marks LISTED1 approved + LISTED2 pending.
  const ADDR = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
  await page.addInitScript(`
    localStorage.setItem("zkorage.wallet.connected", "1");
    window.__freighterMock = {
      isConnected: async () => ({ isConnected: true }),
      isAllowed: async () => ({ isAllowed: true }),
      requestAccess: async () => ({ address: "${ADDR}" }),
      getAddress: async () => ({ address: "${ADDR}" }),
      getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    };
    localStorage.setItem("zkorage.dr.requests.${ADDR}", JSON.stringify([
      { roomId: "${LISTED1}", label: "Series A", state: "eligible", ts: 2 },
      { roomId: "${LISTED2}", state: "pending", ts: 1 },
    ]));
  `);
  await stubs(page);
  await page.goto("/app/dataroom/discover");
  await expect(page.getByTestId("discover-room")).toHaveCount(2);

  // approved -> "Open" deep-links to the access tab; pending -> "Requested"; neither says "Request to join".
  const openLink = page.getByTestId("discover-open");
  await expect(openLink).toBeVisible();
  await expect(openLink).toHaveAttribute("href", `/app/dataroom/documents?room=${LISTED1}#open`);
  await expect(page.getByTestId("discover-requested")).toBeVisible();
  await expect(page.getByTestId("discover-join")).toHaveCount(0);
});

test("discover: renders dark", async ({ page }) => {
  await page.addInitScript(DARK);
  await stubs(page);
  await page.goto("/app/dataroom/discover");
  await expect(page.getByTestId("discover-card")).toBeVisible();
  await expect(page.getByTestId("discover-room")).toHaveCount(2);
  await page.screenshot({ path: "tests/discover-dark.png", fullPage: true });
});
