import { defineConfig } from "@playwright/test";

// Drives a real Chromium against the running dev stack (Vite + backend + testnet).
// Servers are expected to be already running (vite on BASE_URL, backend proxied at /api).
export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:5174",
    headless: process.env.HEADLESS === "1",
    viewport: { width: 1100, height: 1400 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
