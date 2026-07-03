import { test, expect } from "@playwright/test";
// NOTE: @stellar/stellar-sdk is imported dynamically inside the test (not at the top level). A top-level
// import of this large package trips Playwright's collection-time bundling when the whole suite loads
// together (a misleading "two versions of @playwright/test" error); a runtime import avoids it.

// End-to-end test of the CLIENT-SIGNED (Freighter) write path through the real React app, on testnet.
// Playwright can't drive the actual extension popup, so we inject window.__freighterMock (the seam in
// lib/wallet/client.ts) AND back its signTransaction with a real, friendbot-funded Stellar keypair via
// page.exposeFunction — i.e. the browser asks Node to sign, exactly mirroring what Freighter does.
// This exercises useTxSigner → api.writeViaWallet → backend /submit?source → sign → /tx/submit → chain.
test("PoR via wallet: a connected wallet signs + submits the verify tx on-chain", async ({ page }) => {
  test.setTimeout(120_000);
  const { Keypair, TransactionBuilder, Networks } = await import("@stellar/stellar-sdk");
  const kp = Keypair.random();
  const fb = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  expect(fb.status).toBe(200);
  // Poll Horizon until the account actually exists (friendbot returns before the ledger closes), so the
  // app can load its sequence number when it builds the tx.
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`https://horizon-testnet.stellar.org/accounts/${kp.publicKey()}`);
    if (r.ok) break;
    await new Promise((res) => setTimeout(res, 1500));
  }

  // The Node-side signer the in-browser mock calls (the real key never enters the page).
  await page.exposeFunction("__zkSign", (xdr: string) => {
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    tx.sign(kp);
    return tx.toXDR();
  });

  await page.addInitScript((G) => {
    localStorage.setItem("zkorage.wallet.connected", "1");
  localStorage.setItem("zkorage.sync.noPrompt", "1");
    (window as unknown as { __freighterMock: unknown }).__freighterMock = {
      isConnected: async () => ({ isConnected: true }),
      isAllowed: async () => ({ isAllowed: true }),
      requestAccess: async () => ({ address: G }),
      getAddress: async () => ({ address: G }),
      getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
      signTransaction: async (xdr: string) => ({
        signedTxXdr: await (window as unknown as { __zkSign: (x: string) => Promise<string> }).__zkSign(xdr),
        signerAddress: G,
      }),
    };
  }, kp.publicKey());

  await page.goto("/app/reserves");
  await expect(page.getByTestId("wallet-address")).toContainText(kp.publicKey().slice(0, 4), { timeout: 5000 });

  // "Verify on-chain" now routes through the wallet: backend builds the tx with the wallet as source,
  // the funded key signs it, the backend submits it. The proof verifies true on-chain.
  await page.getByTestId("verify").click();
  await expect(page.getByTestId("proof-status")).toHaveAttribute("data-state", "verified", { timeout: 90_000 });
  await expect(page.getByTestId("verdict-card")).toContainText("verified on Stellar");
});
