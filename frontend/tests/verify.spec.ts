import { test, expect } from "@playwright/test";

// The public /verify page is now a smart-input router: paste a verify link or a bare id and it auto-detects
// the proof type and routes to the right on-chain read. The PoR (/verify/:issuer) and bond (/verify/bond)
// deep links still render their dedicated verdict pages (covered by por.spec / verify-bond.spec).

const HEX = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const ROOM = "46745e986e85e583e76eb57217419021e3e3e23835c9b27bb562a596b7b34209";

test("verify home: renders the smart input", async ({ page }) => {
  await page.goto("/verify");
  await expect(page.getByText("Verify it yourself").first()).toBeVisible();
  await expect(page.getByTestId("verify-input")).toBeVisible();
  await expect(page.getByTestId("verify-submit")).toBeVisible();
});

test("verify home: a bonded link routes to /verify/bond with the query preserved", async ({ page }) => {
  await page.goto("/verify");
  await page.getByTestId("verify-input").fill(`https://zkorage.wazowsky.id/verify/bond?accessor=${HEX}&req=${ROOM}&amount=100`);
  await page.getByTestId("verify-submit").click();
  await expect(page).toHaveURL(/\/verify\/bond\?accessor=/);
});

test("verify home: a reserves link routes to /verify/:issuer", async ({ page }) => {
  await page.goto("/verify");
  await page.getByTestId("verify-input").fill(`/verify/${HEX}`);
  await page.getByTestId("verify-submit").click();
  await expect(page).toHaveURL(new RegExp(`/verify/${HEX}$`));
});

test("verify home: the public-room example routes to /verify/room/:id", async ({ page }) => {
  await page.route("**/dataroom/directory", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        count: 1,
        dataroomId: "CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN",
        rooms: [{ roomId: ROOM, name: "Demo room", description: null, memberBucket: "5-19", anonTier: "ok", listedAt: 1, bond: null }],
      }),
    }),
  );
  await page.goto("/verify");
  await page.getByTestId("verify-example-room").click();
  await expect(page).toHaveURL(new RegExp(`/verify/room/${ROOM}$`));
});

test("verify home: garbage shows an inline error and does not navigate", async ({ page }) => {
  await page.goto("/verify");
  await page.getByTestId("verify-input").fill("hello world");
  await page.getByTestId("verify-submit").click();
  await expect(page.getByTestId("verify-input-error")).toBeVisible();
  await expect(page).toHaveURL(/\/verify$/);
});

test("verify home: a known room id probes the room and routes to /verify/room/:id", async ({ page }) => {
  await page.route("**/dataroom/room-meta/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ roomId: ROOM, visibility: "listed", discoverable: true, exists: true, name: "Demo room", bond: null }),
    }),
  );
  await page.goto("/verify");
  await page.getByTestId("verify-input").fill(ROOM);
  await page.getByTestId("verify-submit").click();
  await expect(page).toHaveURL(new RegExp(`/verify/room/${ROOM}$`));
  await expect(page.getByTestId("verify-room-verdict")).toHaveAttribute("data-state", "exists");
});

test("verify home: an id with no public room falls back to reserves", async ({ page }) => {
  await page.route("**/dataroom/room-meta/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ roomId: HEX, visibility: "private", discoverable: false }),
    }),
  );
  await page.goto("/verify");
  await page.getByTestId("verify-input").fill(HEX);
  await page.getByTestId("verify-submit").click();
  await expect(page).toHaveURL(new RegExp(`/verify/${HEX}$`));
});

test("verify home: a ?q handoff auto-runs (forwarded from the landing CTA)", async ({ page }) => {
  const q = encodeURIComponent(`/verify/${HEX}`);
  await page.goto(`/verify?q=${q}`);
  await expect(page).toHaveURL(new RegExp(`/verify/${HEX}$`));
});
