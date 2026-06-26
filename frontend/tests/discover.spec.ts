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
  // Own-room detection reads the connected wallet's rooms; default to "owns none" so directory cards are
  // joinable. A test that wants an owned card overrides this route after calling stubs().
  await page.route("**/dataroom/rooms?owner=**", (r) =>
    r.fulfill(json({ owner: "", count: 0, dataroomId: "", rooms: [] })));
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

test("discover: your own listed room is marked, not joinable", async ({ page }) => {
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
  `);
  await stubs(page);
  // This wallet OWNS LISTED1 (override the default "owns none" route, registered after stubs() so it wins).
  await page.route("**/dataroom/rooms?owner=**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      owner: ADDR, count: 1, dataroomId: "",
      rooms: [{ roomId: LISTED1, label: "Series A data room", owner: ADDR, docCount: 0, ledger: 1, visibility: "listed", name: "Series A data room", description: null }],
    }) }));
  await page.goto("/app/dataroom/discover");
  await expect(page.getByTestId("discover-room")).toHaveCount(2);

  // LISTED1 is mine -> marked "Your room" (links to Room Management for THIS room), not a join button.
  const ownLink = page.getByTestId("discover-own-room");
  await expect(ownLink).toBeVisible();
  await expect(ownLink).toHaveAttribute("href", `/app/dataroom/manage?room=${LISTED1}`);
  await expect(ownLink).toContainText("Your room");
  await expect(page.locator('[data-testid="discover-room"][data-own="true"]')).toHaveCount(1);
  // LISTED2 is not mine and has no local status -> still joinable.
  await expect(page.getByTestId("discover-join")).toHaveCount(1);
});

test("discover: a bond-only room shows the bond requirement + 'Open with a bond', not request-to-join", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  const BONDED = "5".repeat(64);
  const BTOKEN = "CALISDUWPL24M3LWLOXIWYNRQ42YYMZJ4ZU6UYIVCCB4NH4DMV767NZX";
  const BISSUER = "GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM";
  await stubs(page);
  // Override the directory with a single bond-only room (registered after stubs() so it wins).
  await page.route("**/dataroom/directory", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      count: 1, dataroomId: "",
      rooms: [{
        roomId: BONDED, name: "Bonded deal room", description: "Lock a bond to enter.",
        memberBucket: "under 5", anonTier: "forming", listedAt: 3,
        bond: { bondOpen: true, token: BTOKEN, symbol: "TUSD", decimals: 7, issuer: BISSUER, minAmount: "1000000000", deadline: 4102444800, reqId: "ab".repeat(32) },
      }],
    }) }));
  await page.goto("/app/dataroom/discover");

  const room = page.getByTestId("discover-room");
  await expect(room).toHaveCount(1);
  await expect(room).toHaveAttribute("data-bonded", "true");

  // The member bucket is replaced by a "Bond to enter" pill (a bond-only room has no approved members).
  await expect(page.getByTestId("discover-bond-pill")).toBeVisible();
  await expect(page.getByTestId("bucket-badge")).toHaveCount(0);

  // The requirement is shown: amount + token + deadline, with the token contract AND issuer as Stellar Expert links.
  const req = page.getByTestId("discover-bond-req");
  await expect(req).toContainText("100 TUSD");
  await expect(req).toContainText("locked until");
  await expect(req.locator(`a[href="https://stellar.expert/explorer/testnet/contract/${BTOKEN}"]`)).toBeVisible();
  await expect(page.getByTestId("discover-bond-issuer").locator(`a[href="https://stellar.expert/explorer/testnet/account/${BISSUER}"]`)).toBeVisible();

  // The action is "Open with a bond" -> the reader flow, NOT request-to-join.
  const open = page.getByTestId("discover-bond-open");
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("href", `/app/dataroom/documents?room=${BONDED}#open`);
  await expect(page.getByTestId("discover-join")).toHaveCount(0);

  await page.screenshot({ path: "tests/discover-bonded.png", fullPage: true });
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("discover: a bond-only room resolved by id shows the requirement + 'Open with a bond'", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  const BONDED = "6".repeat(64);
  const BTOKEN = "CALISDUWPL24M3LWLOXIWYNRQ42YYMZJ4ZU6UYIVCCB4NH4DMV767NZX";
  const BISSUER = "GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM";
  await stubs(page);
  // Resolve any id to a discoverable bond-only room (registered after stubs() so it wins).
  await page.route("**/dataroom/room-meta/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      roomId: BONDED, visibility: "unlisted", discoverable: true, listed: false,
      name: "Bonded deal room", description: "Lock a bond to enter.", memberBucket: "under 5", anonTier: "forming",
      bond: { bondOpen: true, token: BTOKEN, symbol: "TUSD", decimals: 7, issuer: BISSUER, minAmount: "1000000000", deadline: 4102444800, reqId: "ab".repeat(32) },
    }) }));
  await page.goto("/app/dataroom/discover");
  await page.getByTestId("discover-subtab-find").click();
  await page.getByTestId("discover-lookup-input").fill(BONDED);
  await page.getByTestId("discover-lookup-btn").click();

  const result = page.getByTestId("discover-lookup-result");
  await expect(result).toHaveAttribute("data-discoverable", "true");
  await expect(result).toHaveAttribute("data-bonded", "true");
  // Shows the bond requirement (amount + token + contract/issuer links), not a member bucket.
  await expect(result.getByTestId("discover-bond-pill")).toBeVisible();
  await expect(result.getByTestId("discover-bond-req")).toContainText("100 TUSD");
  await expect(result.getByTestId("discover-bond-issuer").locator("a")).toHaveAttribute("href", `https://stellar.expert/explorer/testnet/account/${BISSUER}`);
  await expect(result.getByTestId("bucket-badge")).toHaveCount(0);
  // The action is "Open with a bond" -> the reader flow, NOT request-to-join.
  await expect(result.getByTestId("discover-bond-open")).toHaveAttribute("href", `/app/dataroom/documents?room=${BONDED}#open`);
  await expect(result.getByTestId("discover-join")).toHaveCount(0);
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("discover: renders dark", async ({ page }) => {
  await page.addInitScript(DARK);
  await stubs(page);
  await page.goto("/app/dataroom/discover");
  await expect(page.getByTestId("discover-card")).toBeVisible();
  await expect(page.getByTestId("discover-room")).toHaveCount(2);
  await page.screenshot({ path: "tests/discover-dark.png", fullPage: true });
});
