import { test, expect } from "@playwright/test";
import { bondAccessCommitment } from "zkorage-sdk";

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
  localStorage.setItem("zkorage.sync.dontAsk", "1");
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
  localStorage.setItem("zkorage.sync.dontAsk", "1");
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

test("discover: a bond-only room shows the bond requirement + 'Check Bonded Access', not request-to-join", async ({ page }) => {
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

  // The bond requirement is hidden behind the expand to keep the row compact; the chevron reveals it.
  await expect(page.getByTestId("discover-bond-req")).toHaveCount(0);
  await page.getByTestId("discover-room-toggle").click();

  // Expanded: amount + token + deadline (with a TIME, not just a date), and the token contract AND issuer links.
  const req = page.getByTestId("discover-bond-req");
  await expect(req).toBeVisible();
  await expect(req).toContainText("100 TUSD");
  await expect(req).toContainText("locked until");
  await expect(req).toContainText(/:\d{2}/); // the deadline includes the time (hh:mm)
  await expect(req.locator(`a[href="https://stellar.expert/explorer/testnet/contract/${BTOKEN}"]`)).toBeVisible();
  await expect(page.getByTestId("discover-bond-issuer").locator(`a[href="https://stellar.expert/explorer/testnet/account/${BISSUER}"]`)).toBeVisible();

  // The action is "Check Bonded Access" (a button that checks access then routes), NOT request-to-join.
  const open = page.getByTestId("discover-bond-check");
  await expect(open).toBeVisible();
  await expect(open).toContainText("Check Bonded Access");
  await expect(page.getByTestId("discover-join")).toHaveCount(0);

  await page.screenshot({ path: "tests/discover-bonded.png", fullPage: true });

  // No wallet -> the check cannot read this browser's bond, so it hands off to the Open page (which prompts
  // connect and re-runs the check there).
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/app/dataroom/documents\\?room=${BONDED}#open`));
  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("discover: a bond-only room resolved by id shows the requirement + 'Check Bonded Access'", async ({ page }) => {
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
  await expect(result.getByTestId("discover-bond-req")).toContainText(/:\d{2}/); // deadline includes the time
  await expect(result.getByTestId("discover-bond-issuer").locator("a")).toHaveAttribute("href", `https://stellar.expert/explorer/testnet/account/${BISSUER}`);
  await expect(result.getByTestId("bucket-badge")).toHaveCount(0);
  // The action is "Check Bonded Access" (button that checks access then routes), NOT request-to-join.
  const create = result.getByTestId("discover-bond-check");
  await expect(create).toContainText("Check Bonded Access");
  await expect(result.getByTestId("discover-join")).toHaveCount(0);
  expect(errs, errs.join("\n")).toHaveLength(0);
});

// "Check Bonded Access" routing: with a connected wallet that holds a handle, the button reads this browser's
// handle commitment, looks it up in the live qualifying set, and routes accordingly (no signature needed).
const CHECK_ADDR = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const CHECK_ID_SECRET = "11".repeat(32);
const CHECK_COMMITMENT = bondAccessCommitment(CHECK_ID_SECRET);
const BONDED_CHK = "8".repeat(64);
const CHK_TOKEN = "CALISDUWPL24M3LWLOXIWYNRQ42YYMZJ4ZU6UYIVCCB4NH4DMV767NZX";
const CHK_REQ = { bondOpen: true, token: CHK_TOKEN, symbol: "TUSD", decimals: 7, issuer: null, minAmount: "1000000000", deadline: 4102444800, reqId: "cd".repeat(32) };

async function connectedWithHandle(page: import("@playwright/test").Page) {
  await page.addInitScript(`
    localStorage.setItem("zkorage.wallet.connected", "1");
  localStorage.setItem("zkorage.sync.dontAsk", "1");
    window.__freighterMock = {
      isConnected: async () => ({ isConnected: true }),
      isAllowed: async () => ({ isAllowed: true }),
      requestAccess: async () => ({ address: "${CHECK_ADDR}" }),
      getAddress: async () => ({ address: "${CHECK_ADDR}" }),
      getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    };
    localStorage.setItem("zkorage-bond-identity.${CHECK_ADDR}", JSON.stringify({
      accessor: "${"a".repeat(64)}", idSecret: "${CHECK_ID_SECRET}", idTrapdoor: "${"22".repeat(32)}",
      holderSeed: "${"33".repeat(32)}", qualCommitment: "${CHECK_COMMITMENT}", minted: true,
    }));
  `);
  await stubs(page);
  await page.route("**/dataroom/directory", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      count: 1, dataroomId: "",
      rooms: [{ roomId: BONDED_CHK, name: "Bonded deal room", description: "Lock a bond to enter.", memberBucket: "under 5", anonTier: "forming", listedAt: 3, bond: CHK_REQ }],
    }) }));
}

test("discover: Check Bonded Access opens the room when you hold a qualifying bond", async ({ page }) => {
  await connectedWithHandle(page);
  // The qualifying set contains THIS handle's commitment -> you hold a bond.
  await page.route("**/bonded/bond/qual-set**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      token: CHK_TOKEN, minAmount: "1000000000", deadline: 4102444800, reqId: CHK_REQ.reqId,
      anonSetSize: 4, minAnonSet: 3, belowMin: false, computedRoot: "", published: true, ringLen: 1,
      locks: [{ id: 1, commitment: CHECK_COMMITMENT, amount: "1000000000", unlock_time: 4102444800, depositor: "" }],
    }) }));
  await page.goto("/app/dataroom/discover");
  await page.getByTestId("discover-bond-check").click();
  // Holds a bond -> Documents>Open with setup=bond so the open proof starts on its own.
  await expect(page).toHaveURL(new RegExp(`/app/dataroom/documents\\?room=${BONDED_CHK}&setup=bond#open`));
});

test("discover: Check Bonded Access sends you to Bonded Proofs when you hold no bond", async ({ page }) => {
  await connectedWithHandle(page);
  // The qualifying set does NOT contain this handle's commitment -> no qualifying bond.
  await page.route("**/bonded/bond/qual-set**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      token: CHK_TOKEN, minAmount: "1000000000", deadline: 4102444800, reqId: CHK_REQ.reqId,
      anonSetSize: 0, minAnonSet: 3, belowMin: true, computedRoot: "", published: false, ringLen: 0, locks: [],
    }) }));
  await page.goto("/app/dataroom/discover");
  await page.getByTestId("discover-bond-check").click();
  // No bond -> Bonded Proofs > Bonded Access, pre-filled with this requirement, to lock one.
  await expect(page).toHaveURL(/\/app\/bonded\/tier\?/);
  await expect(page).toHaveURL(new RegExp(`token=${encodeURIComponent(CHK_TOKEN)}`));
  await expect(page).toHaveURL(/min=1000000000/);
  await expect(page).toHaveURL(/sym=TUSD/);
});

test("discover: looking up your own private room by id offers 'Your room', not request-to-join", async ({ page }) => {
  const ADDR = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
  const MINE = "7".repeat(64);
  await page.addInitScript(`
    localStorage.setItem("zkorage.wallet.connected", "1");
  localStorage.setItem("zkorage.sync.dontAsk", "1");
    window.__freighterMock = {
      isConnected: async () => ({ isConnected: true }),
      isAllowed: async () => ({ isAllowed: true }),
      requestAccess: async () => ({ address: "${ADDR}" }),
      getAddress: async () => ({ address: "${ADDR}" }),
      getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    };
  `);
  await stubs(page);
  // This wallet owns MINE (override the default "owns none", registered after stubs() so it wins).
  await page.route("**/dataroom/rooms?owner=**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      owner: ADDR, count: 1, dataroomId: "",
      rooms: [{ roomId: MINE, label: "My private room", owner: ADDR, docCount: 0, ledger: 1, visibility: "private", name: null, description: null }],
    }) }));
  // room-meta for MINE -> private/dark (no owner check on this public endpoint).
  await page.route("**/dataroom/room-meta/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ roomId: MINE, visibility: "private", discoverable: false }) }));

  await page.goto("/app/dataroom/discover");
  await page.getByTestId("discover-subtab-find").click();
  await page.getByTestId("discover-lookup-input").fill(MINE);
  await page.getByTestId("discover-lookup-btn").click();

  const result = page.getByTestId("discover-lookup-result");
  await expect(result).toHaveAttribute("data-discoverable", "false");
  // It's mine -> "Your room" link to Room Management, not a request-to-join.
  const own = result.getByTestId("discover-own-room");
  await expect(own).toBeVisible();
  await expect(own).toHaveAttribute("href", `/app/dataroom/manage?room=${MINE}`);
  await expect(result.getByTestId("discover-join")).toHaveCount(0);
});

test("discover: shows a shimmer skeleton while the directory loads (cold path)", async ({ page }) => {
  // Delay the directory read so the cold-load skeleton is observable before the list paints. A fresh page has
  // no module cache, so this is the cold path; a warm reload would show the thin refresh bar instead.
  const fulfill = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/dataroom/directory", async (r) => {
    await new Promise((res) => setTimeout(res, 700));
    return r.fulfill(fulfill({
      count: 1, dataroomId: "",
      rooms: [{ roomId: LISTED1, name: "Series A data room", description: "Diligence pack for the round.", memberBucket: "5-19", anonTier: "ok", listedAt: 2 }],
    }));
  });
  await page.route("**/dataroom/rooms?owner=**", (r) => r.fulfill(fulfill({ owner: "", count: 0, dataroomId: "", rooms: [] })));

  await page.goto("/app/dataroom/discover");
  // cold path: the shimmer skeleton shows while loading (the old plain "Loading…" text is gone)
  await expect(page.getByTestId("discover-list-skeleton")).toBeVisible();
  // then the real list swaps in and the skeleton is gone
  await expect(page.getByTestId("discover-room")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("discover-list-skeleton")).toHaveCount(0);
});

test("discover: search filters and 'Show more' paginates a long directory", async ({ page }) => {
  const fulfill = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  // 10 listed rooms; one named so a search can single it out (it sits on page 2, so this also proves search
  // works across the FULL set, not just the visible page).
  const rooms = Array.from({ length: 10 }, (_, i) => ({
    roomId: (i + 1).toString(16).padStart(64, "0"),
    name: i === 9 ? "Acme special room" : `Series room ${i}`,
    description: null,
    memberBucket: "5-19",
    anonTier: "ok",
    listedAt: 10 - i,
  }));
  await page.route("**/dataroom/directory", (r) => r.fulfill(fulfill({ count: rooms.length, dataroomId: "", rooms })));
  await page.route("**/dataroom/rooms?owner=**", (r) => r.fulfill(fulfill({ owner: "", count: 0, dataroomId: "", rooms: [] })));
  await page.goto("/app/dataroom/discover");

  // The search box appears (list > 6), and only the first page (8 of 10) renders.
  await expect(page.getByTestId("discover-search-input")).toBeVisible();
  await expect(page.getByTestId("discover-room")).toHaveCount(8);
  await expect(page.getByTestId("discover-show-more-bar")).toContainText("Showing 8 of 10 rooms");

  // Show more reveals the rest; the bar then disappears.
  await page.getByTestId("discover-show-more-btn").click();
  await expect(page.getByTestId("discover-room")).toHaveCount(10);
  await expect(page.getByTestId("discover-show-more-bar")).toHaveCount(0);

  // Search filters the full set (case-insensitive) to the matching room, even though it was on page 2.
  await page.getByTestId("discover-search-input").fill("acme");
  await expect(page.getByTestId("discover-room")).toHaveCount(1);
  await expect(page.getByTestId("discover-room")).toContainText("Acme special room");

  // Clearing the search restores the list and resets to the first page (8 of 10).
  await page.getByTestId("discover-search-clear").click();
  await expect(page.getByTestId("discover-room")).toHaveCount(8);

  // A search with no match shows the empty-result line.
  await page.getByTestId("discover-search-input").fill("zzz-no-such-room");
  await expect(page.getByTestId("discover-search-empty")).toBeVisible();
  await expect(page.getByTestId("discover-room")).toHaveCount(0);
});

test("discover: only a bond room expands (to its requirement) via chevron OR card click; a membership room has no chevron", async ({ page }) => {
  const fulfill = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  const BTOKEN = "CALISDUWPL24M3LWLOXIWYNRQ42YYMZJ4ZU6UYIVCCB4NH4DMV767NZX";
  const BISSUER = "GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM";
  await page.route("**/dataroom/directory", (r) => r.fulfill(fulfill({
    count: 2, dataroomId: "",
    rooms: [
      // a membership room, even WITH a description, is not expandable (nothing to hide)
      { roomId: LISTED1, name: "Series A data room", description: "Full diligence pack for the Series A round.", memberBucket: "5-19", anonTier: "ok", listedAt: 2 },
      // a bond-only room IS expandable (to reveal its requirement)
      { roomId: LISTED2, name: "Bonded deal room", description: "Lock a bond to enter.", memberBucket: "under 5", anonTier: "forming", listedAt: 1,
        bond: { bondOpen: true, token: BTOKEN, symbol: "TUSD", decimals: 7, issuer: BISSUER, minAmount: "1000000000", deadline: 4102444800, reqId: "ab".repeat(32) } },
    ],
  })));
  await page.route("**/dataroom/rooms?owner=**", (r) => r.fulfill(fulfill({ owner: "", count: 0, dataroomId: "", rooms: [] })));
  await page.goto("/app/dataroom/discover");

  const membership = page.getByTestId("discover-room").filter({ hasText: "Series A data room" });
  const bonded = page.getByTestId("discover-room").filter({ hasText: "Bonded deal room" });

  // The membership room has NO chevron (and its description just shows); the bond room has a chevron.
  await expect(membership.getByTestId("discover-room-toggle")).toHaveCount(0);
  await expect(membership).toContainText("Full diligence pack");
  await expect(bonded.getByTestId("discover-room-toggle")).toBeVisible();

  // The bond requirement is hidden until expanded.
  await expect(bonded.getByTestId("discover-bond-req")).toHaveCount(0);

  // Clicking the card BODY (the name, not the chevron) reveals the requirement.
  await bonded.getByText("Bonded deal room").click();
  await expect(bonded.getByTestId("discover-bond-req")).toBeVisible();
  await expect(bonded.getByTestId("discover-bond-req")).toContainText("100 TUSD");

  // The chevron toggles it closed again.
  await bonded.getByTestId("discover-room-toggle").click();
  await expect(bonded.getByTestId("discover-bond-req")).toHaveCount(0);
});

test("discover: renders dark", async ({ page }) => {
  await page.addInitScript(DARK);
  await stubs(page);
  await page.goto("/app/dataroom/discover");
  await expect(page.getByTestId("discover-card")).toBeVisible();
  await expect(page.getByTestId("discover-room")).toHaveCount(2);
  await page.screenshot({ path: "tests/discover-dark.png", fullPage: true });
});
