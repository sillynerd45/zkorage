import { test, expect } from "@playwright/test";

// Bonded Proofs (BP2 escrow + BP3/BP4 solvency) — the connected-wallet seam (headless Chrome can't load
// the real extension) points at the DEPLOYER, who on the live testnet escrow owns released locks (#1, #2)
// and active revocable self-bonds (#3, #4). Lock #4 backs a LIVE solvency proof on the gate, so the Prove
// tab shows a SOLVENT badge for this wallet.
const DEPLOYER = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const ACTIVE_LOCK = 4; // revocable, still-locked, and bonded to the solvency proof
const mock = (addr: string) => `
  localStorage.setItem("zkorage.wallet.connected", "1");
  window.__freighterMock = {
    isConnected: async () => ({ isConnected: true }),
    isAllowed: async () => ({ isAllowed: true }),
    requestAccess: async () => ({ address: "${addr}" }),
    getAddress: async () => ({ address: "${addr}" }),
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: "${addr}" }),
  };
`;
const DARK = `localStorage.setItem("zkorage-theme","dark");`;

test("bonded: overview is action-first (Bonded Access hero + manage cards), tabs present (light + dark)", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => {
    // Keep this assertion for real app/JS errors. Ignore transient network resource loads (e.g. the
    // Google-Fonts woff2 the dev server may abort on a fast reload) — those are not app defects.
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text());
  });
  await page.goto("/app/bonded");
  await expect(page.getByTestId("bonded-overview")).toBeVisible();
  // the action-first cards: Bonded Access leads, the two escrow utilities follow, each a real link
  await expect(page.getByTestId("bonded-task-tier")).toHaveAttribute("href", "/app/bonded/tier");
  await expect(page.getByTestId("bonded-task-deposit")).toHaveAttribute("href", "/app/bonded/deposit");
  await expect(page.getByTestId("bonded-task-balances")).toHaveAttribute("href", "/app/bonded/balances");
  // Prove Solvency is dropped from the pillar (route stays, but no card/tab)
  await expect(page.getByTestId("bonded-task-prove")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Prove Solvency", exact: true })).toHaveCount(0);
  // the verify note linking to the public chain
  await expect(page.getByTestId("bonded-verify-note")).toBeVisible();
  // the tab bar exposes the renamed Bonded Access tab + My Balances (exact name = the tab, not the card)
  await expect(page.getByRole("link", { name: "Bonded Access", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "My Balances", exact: true })).toBeVisible();
  await page.screenshot({ path: "tests/bonded-overview.png", fullPage: true });

  await page.addInitScript(DARK);
  await page.reload();
  await expect(page.getByTestId("bonded-overview")).toBeVisible();
  await page.screenshot({ path: "tests/bonded-overview-dark.png", fullPage: true });

  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("bonded: my balances lists the wallet's locks with the right actions", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  await page.goto("/app/bonded/balances");
  await expect(page.getByTestId("bonded-balances")).toBeVisible({ timeout: 60_000 });
  // The card is amount-led now; the on-chain escrow id is demoted to a per-lock testid (`lock-<id>`), so
  // assert by testid instead of the old "Lock #N" title text. lock #4 is the active revocable self-bond →
  // Release + Extend; lock #1 is the released lock with no actions.
  await expect(page.getByTestId(`lock-${ACTIVE_LOCK}`)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId(`lock-${ACTIVE_LOCK}`)).toContainText(`#${ACTIVE_LOCK}`);
  // The highlighted unlock block (right column) renders per lock and carries the date.
  await expect(page.getByTestId(`unlock-${ACTIVE_LOCK}`)).toBeVisible();
  await expect(page.getByTestId(`unbond-${ACTIVE_LOCK}`)).toBeVisible();
  await expect(page.getByTestId(`extend-${ACTIVE_LOCK}`)).toBeVisible();
  // A testid is exact, so this never collides with a double-digit id (e.g. #10/#11) the way a "Lock #1"
  // substring would.
  await expect(page.getByTestId("lock-1")).toBeVisible();
  await page.screenshot({ path: "tests/bonded-balances.png", fullPage: true });

  await page.addInitScript(DARK);
  await page.reload();
  await expect(page.getByTestId(`lock-${ACTIVE_LOCK}`)).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "tests/bonded-balances-dark.png", fullPage: true });
});

test("bonded: my balances redisplays cached locks instantly on a return visit (no reload flash)", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  await page.goto("/app/bonded/balances");
  // First load fills the in-memory snapshot cache (this is the slow one that hits testnet).
  await expect(page.getByTestId(`lock-${ACTIVE_LOCK}`)).toBeVisible({ timeout: 60_000 });

  // Leave to another bonded tab, then come back. The cache should paint the lock at once and the
  // first-load "Loading your locks…" panel must never appear.
  await page.getByRole("link", { name: "Deposit", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/bonded\/deposit/);
  // The deposit page body also links to "My Balances"; the tab bar renders first in DOM, so target it.
  await page.getByRole("link", { name: "My Balances", exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/bonded\/balances/);
  await expect(page.getByTestId(`lock-${ACTIVE_LOCK}`)).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText(/Loading your locks/)).toHaveCount(0);
});

// A real testnet issuer so the client-side SAC computation has a valid asset to hash. The deposit pipeline
// is multi-token (proven on-chain separately); this test covers the picker UI deterministically by stubbing
// the wallet's Horizon balances.
const TUSD_ISSUER = "GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM";

test("bonded: deposit form, token picker + mode switcher", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  // Stub the wallet's on-chain balances so the picker is deterministic (no live Horizon dependency).
  await page.route("**/horizon-testnet.stellar.org/accounts/**", (route) =>
    route.fulfill({
      json: {
        balances: [
          { asset_type: "credit_alphanum4", asset_code: "TUSD", asset_issuer: TUSD_ISSUER, balance: "207116.0000000" },
          { asset_type: "native", balance: "10000.0000000" },
        ],
      },
    }),
  );
  await page.goto("/app/bonded/deposit");
  await expect(page.getByTestId("bonded-deposit")).toBeVisible();

  // The token picker lists the wallet's real tokens (TUSD + XLM); zkUSD + the faucet are gone. TUSD is the
  // first balance, so it is the default selection.
  const picker = page.getByTestId("deposit-token");
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("option", { name: /XLM/ })).toBeAttached();
  await expect(page.getByRole("option", { name: /TUSD/ })).toBeAttached();
  await expect(page.getByRole("option", { name: /zkUSD/ })).toHaveCount(0); // dropped
  await expect(page.getByTestId("bonded-faucet")).toHaveCount(0); // faucet dropped
  await expect(page.getByTestId("deposit-amount")).toBeVisible();
  await expect(page.getByTestId("deposit-balance")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Amount (TUSD)")).toBeVisible(); // TUSD is the default
  await expect(page.getByTestId("deposit-balance")).toContainText("TUSD");

  // Switch to XLM: the amount label + balance follow the token.
  await picker.selectOption("native");
  await expect(page.getByText("Amount (XLM)")).toBeVisible();
  await expect(page.getByTestId("deposit-balance")).toContainText("XLM");

  // The "paste a contract address" advanced path reveals an input, and submit stays disabled until a token
  // is loaded (so a half-typed or edited address can never be deposited).
  await picker.selectOption("__paste__");
  await expect(page.getByTestId("deposit-token-paste")).toBeVisible();
  await expect(page.getByTestId("deposit-submit")).toBeDisabled();
  await page.getByTestId("deposit-token-paste").fill("CABC");
  await expect(page.getByTestId("deposit-submit")).toBeDisabled();

  // The unlock field is now a picker-only trigger (the real datetime-local input is hidden, opened via
  // showPicker). Assert the visible trigger carries a formatted value, and that setting the hidden input's
  // value (what the native picker does) updates the trigger label. force: bypasses the hidden input's
  // visibility/pointer-events actionability checks.
  await expect(page.getByTestId("deposit-unlock-trigger")).toBeVisible();
  await expect(page.getByTestId("deposit-unlock-trigger")).not.toBeEmpty();
  await page.getByTestId("deposit-unlock").fill("2026-09-01T15:30", { force: true });
  await expect(page.getByTestId("deposit-unlock-trigger")).toContainText("Sep 1, 2026");
  await expect(page.getByTestId("deposit-submit")).toBeVisible();
  await expect(page.getByTestId("deposit-privacy")).toBeVisible(); // honest "this lock is public" note

  // Mode switcher: send reveals the recipient, bond reveals the revocable checkbox.
  await page.getByTestId("mode-send").click();
  await expect(page.getByTestId("deposit-recipient")).toBeVisible();
  await page.getByTestId("mode-bond").click();
  await expect(page.getByTestId("deposit-revocable")).toBeVisible();

  await page.screenshot({ path: "tests/bonded-deposit.png", fullPage: true });
});

test("bonded: deposit token picker persists its list + selection on a return visit", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  await page.route("**/horizon-testnet.stellar.org/accounts/**", (route) =>
    route.fulfill({
      json: {
        balances: [
          { asset_type: "credit_alphanum4", asset_code: "TUSD", asset_issuer: TUSD_ISSUER, balance: "207116.0000000" },
          { asset_type: "native", balance: "10000.0000000" },
        ],
      },
    }),
  );
  await page.goto("/app/bonded/deposit");
  const picker = page.getByTestId("deposit-token");
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("option", { name: /TUSD/ })).toBeAttached();
  // Change the pick away from the default, then leave to another tab and return.
  await picker.selectOption("native");
  await expect(page.getByText("Amount (XLM)")).toBeVisible();
  await page.getByRole("link", { name: "My Balances", exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/bonded\/balances/);
  await page.getByRole("link", { name: "Deposit", exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/bonded\/deposit/);
  // The picker paints from the in-memory cache: no "Loading your tokens…" placeholder, and the XLM pick
  // is remembered (not reset to the first token).
  await expect(page.getByRole("option", { name: /Loading your tokens/ })).toHaveCount(0);
  await expect(page.getByTestId("deposit-token")).toHaveValue("native", { timeout: 3_000 });
  await expect(page.getByText("Amount (XLM)")).toBeVisible();
});

test("bonded: prove tab shows the LIVE solvency badge + the release control (the self-void)", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  await page.goto("/app/bonded/prove");
  await expect(page.getByTestId("bonded-prove")).toBeVisible({ timeout: 60_000 });
  // the live badge polls the gate's is_granted (which re-reads the escrow lock) -> SOLVENT while bonded
  const badge = page.getByTestId("solvency-badge");
  await expect(badge).toHaveAttribute("data-state", "active", { timeout: 60_000 });
  await expect(badge).toContainText("Solvent");
  // the money-shot control: pulling the bond voids the proof
  await expect(page.getByTestId(`release-collateral-${ACTIVE_LOCK}`)).toBeVisible();
  // at least one provable revocable lock is listed
  await expect(page.getByTestId(`prove-solvency-${ACTIVE_LOCK}`)).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "tests/bonded-prove.png", fullPage: true });

  await page.addInitScript(DARK);
  await page.reload();
  await expect(page.getByTestId("solvency-badge")).toHaveAttribute("data-state", "active", { timeout: 60_000 });
  await expect(page.getByTestId(`prove-solvency-${ACTIVE_LOCK}`)).toBeVisible({ timeout: 60_000 }); // let the lock list land
  await page.screenshot({ path: "tests/bonded-prove-dark.png", fullPage: true });
});
