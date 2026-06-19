import { defineConfig } from "@playwright/test";

// Drives a real Chromium against the running dev stack (Vite + backend + testnet).
// Servers are expected to be already running (vite on BASE_URL, backend proxied at /api).
export default defineConfig({
  testDir: "./tests",
  // *.itest.ts = live on-chain integration tests (friendbot + backend; pull @stellar/stellar-sdk). They
  // run via playwright.itest.config.ts, never in the default suite (the SDK graph trips the collector).
  testIgnore: "**/*.itest.ts",
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  // These are LIVE testnet integration tests sharing on-chain state (the token supply that por.spec
  // mints/burns, the relay signer's sequence number). Run them one at a time so files don't race.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:5174",
    headless: process.env.HEADLESS === "1",
    viewport: { width: 1100, height: 1400 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
