import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Integration tests (*.itest.ts): live on-chain flows that need friendbot + a running backend, and that
// pull @stellar/stellar-sdk into the spec. They're kept OUT of the default `playwright test` run because
// bundling that large SDK graph alongside the whole suite trips Playwright's collector. Run on demand:
//   npx playwright test -c playwright.itest.config.ts
export default defineConfig({
  ...base,
  testMatch: "**/*.itest.ts",
  testIgnore: undefined,
});
