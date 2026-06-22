import { test, expect } from "@playwright/test";

// M2 Step 4 — the browser-dealer "Store shared document" flow. Stubs the backend so it runs without a live
// keeper/chain, and ASSERTS the relay (deal-sealed) receives only ciphertext + sealed shares + an escrow
// copy, NEVER the plaintext or K. That is the whole point of Option B.
const ADDR = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const SIG_B64 = Buffer.from(new Uint8Array(64).fill(0x07)).toString("base64");
const ROOM_ID = "a3".repeat(32);
const PLAINTEXT = "Series A board minutes — strictly confidential";
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

test("committee store: the browser deals; the relay gets only ciphertext + sealed shares", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  let dealBody: any = null;
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  await page.addInitScript(mock);
  await page.route("**/dataroom/info", (r) => r.fulfill(json({ dataroomId: "CID", dataroomImageId: "ab".repeat(32), recipientPub: "cd".repeat(32) })));
  await page.route("**/dataroom/rooms?owner=**", (r) => r.fulfill(json({ owner: ADDR, count: 0, rooms: [], dataroomId: "CID" })));
  await page.route(`**/dataroom/room/**`, (r) => r.fulfill(json({ roomId: ROOM_ID, room: { index: 0, room_id: ROOM_ID, owner: ADDR, ledger: 1, timestamp: "0" }, dataroomId: "CID" })));
  await page.route("**/dataroom/committee/info", (r) => r.fulfill(json({
    threshold: 2, n: 3, online: 3, dataroomId: "CID", note: "",
    keypers: [1, 2, 3].map((i) => ({ endpoint: `k${i}`, ok: true, keyperIndex: i, shares: 0, sealPub: String(i).repeat(64).slice(0, 64) })),
  })));
  await page.route("**/dataroom/committee/deal-sealed", (r) => {
    dealBody = r.request().postDataJSON();
    return r.fulfill(json({ ok: true, roomId: ROOM_ID, docId: dealBody.docId, contentHash: "ef".repeat(32), blobPointer: "blob://x", kCommitment: dealBody.kCommitment, dealt: 3 }));
  });
  await page.route("**/dataroom/committee/anchor", (r) => r.fulfill(json({ ok: true, xdr: "AAAAanchor" })));
  await page.route("**/tx/submit", (r) => r.fulfill(json({ ok: true, txHash: "deadbeefcafe" })));

  await page.goto("/app/dataroom/documents#store");
  // the Data Room stores a document one way now (an anonymous committee doc): no access-mode toggle and no
  // recipient field, just the shared-membership note.
  await expect(page.getByRole("heading", { name: "Store a document" })).toBeVisible();
  await expect(page.getByTestId("access-mode-shared")).toHaveCount(0);
  await expect(page.getByTestId("shared-access-note")).toBeVisible();
  await expect(page.getByTestId("recipient-input")).toHaveCount(0); // no recipient field anymore

  await page.getByTestId("room-label").fill("acme-board-docs");
  await page.getByTestId("store-mode-text").click();
  await page.getByTestId("doc-content").fill(PLAINTEXT);
  await page.getByTestId("upload").click(); // "Store shared document"
  await page.getByRole("button", { name: "Yes, post it" }).click();

  await expect(page.getByTestId("anchor-verdict-card")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("shared-result-room")).toBeVisible();
  await expect(page.getByTestId("shared-result-doc")).toBeVisible();

  // the dealer ran in the browser: the relay got ciphertext + 3 sealed shares + an escrow copy, NOT the plaintext.
  expect(dealBody, "deal-sealed was called").toBeTruthy();
  expect(dealBody.sealedShares).toHaveLength(3);
  expect(dealBody.escrow?.ephPub, "escrow copy present").toBeTruthy();
  expect(typeof dealBody.blobB64).toBe("string");
  expect(dealBody.kCommitment).toMatch(/^[0-9a-f]{64}$/);
  // the plaintext never appears anywhere in the relay payload (it is encrypted client-side).
  const wire = JSON.stringify(dealBody);
  expect(wire.includes(PLAINTEXT)).toBe(false);
  expect(Buffer.from(dealBody.blobB64, "base64").toString("utf8").includes(PLAINTEXT)).toBe(false);

  await page.screenshot({ path: "tests/committee-store.png", fullPage: true });
  expect(errs, errs.join("\n")).toHaveLength(0);
});
