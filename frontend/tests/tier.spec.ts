import { test, expect } from "@playwright/test";

// Standalone Bonded Access (multi-token). The page lets a connected wallet pick ANY token + amount + deadline
// as the requirement, mint an anonymous handle, and (when the anonymity set is large enough) prove. These are
// render-level checks against the live backend's bond reads; the full prove flow is exercised on-chain in the
// backend e2e. A fresh requirement (the stubbed TUSD here) has no qualifying bonds yet, so proving is gated.
const DEPLOYER = "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6";
const TUSD_ISSUER = "GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM";
// A fixed wallet signature (SEP-53) so the handle-vault key + id are deterministic across "devices" in tests.
const SIG_B64 = Buffer.from(new Uint8Array(64).fill(0x07)).toString("base64");
const mock = (addr: string) => `
  localStorage.setItem("zkorage.wallet.connected", "1");
  window.__freighterMock = {
    isConnected: async () => ({ isConnected: true }),
    isAllowed: async () => ({ isAllowed: true }),
    requestAccess: async () => ({ address: "${addr}" }),
    getAddress: async () => ({ address: "${addr}" }),
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
    signTransaction: async (xdr) => ({ signedTxXdr: xdr, signerAddress: "${addr}" }),
    signMessage: async () => ({ signedMessage: "${SIG_B64}", signerAddress: "${addr}" }),
  };
`;
const DARK = `localStorage.setItem("zkorage-theme","dark");`;
const stubHorizon = (page: import("@playwright/test").Page) =>
  page.route("**/horizon-testnet.stellar.org/accounts/**", (route) =>
    route.fulfill({
      json: {
        balances: [
          { asset_type: "credit_alphanum4", asset_code: "TUSD", asset_issuer: TUSD_ISSUER, balance: "207116.0000000" },
          { asset_type: "native", balance: "10000.0000000" },
        ],
      },
    }),
  );

test("tier: the Bonded Access tab is present in the bonded group", async ({ page }) => {
  await page.goto("/app/bonded");
  await expect(page.getByTestId("bonded-overview")).toBeVisible();
  await expect(page.getByRole("link", { name: "Bonded Access", exact: true })).toBeVisible();
});

test("tier: multi-token requirement, handle mints, anonymity-set gating (light + dark)", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text());
  });
  await page.addInitScript(mock(DEPLOYER));
  await stubHorizon(page);

  // The qual-set lands from the live escrow scan for the current requirement (TUSD by default here).
  const waitQual = () => page.waitForResponse((r) => r.url().includes("/bonded/bond/qual-set") && r.status() === 200, { timeout: 30_000 });
  let qualResp = waitQual();
  await page.goto("/app/bonded/tier");
  await expect(page.getByTestId("bonded-tier")).toBeVisible();

  // The requirement is built from the wallet's tokens: the picker lists TUSD + XLM, with an amount + a
  // picker-only deadline trigger (the calendar icon at the right edge, no manual typing).
  const picker = page.getByTestId("tier-token");
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("option", { name: /TUSD/ })).toBeAttached();
  await expect(page.getByRole("option", { name: /XLM/ })).toBeAttached();
  await expect(page.getByTestId("tier-amount")).toBeVisible();
  await expect(page.getByTestId("tier-deadline-trigger")).toBeVisible();
  await expect(page.getByTestId("tier-deadline-trigger")).not.toBeEmpty();

  const size = (await (await qualResp).json()).anonSetSize ?? 0;

  // Mint an anonymous handle (idempotent: an already-stored handle shows in the panel).
  const create = page.getByTestId("tier-create-identity");
  if (await create.isVisible().catch(() => false)) {
    await create.click();
  }
  await expect(page.getByTestId("tier-identity")).toBeVisible({ timeout: 15_000 });
  // A recovery affordance (re-mint + re-enrol) is offered once a handle exists.
  await expect(page.getByTestId("tier-regen-identity")).toBeVisible();

  // A fresh requirement (stubbed TUSD) has no qualifying bonds, so the small-set warning shows and proving is
  // gated. (If the set has somehow reached the floor, proving is enabled and the warning is absent.)
  await expect(page.getByTestId("tier-anonset")).toBeVisible({ timeout: 30_000 });
  if (size < 3) {
    await expect(page.getByTestId("tier-anonset-warning")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("tier-prove")).toBeDisabled();
  } else {
    await expect(page.getByTestId("tier-anonset-warning")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("tier-prove")).toBeEnabled({ timeout: 30_000 });
  }

  await page.screenshot({ path: "tests/bonded-tier.png", fullPage: true });

  await page.addInitScript(DARK);
  qualResp = waitQual();
  await page.reload();
  await expect(page.getByTestId("bonded-tier")).toBeVisible();
  await expect(page.getByTestId("tier-prove")).toBeVisible({ timeout: 30_000 });
  await (await qualResp).json();
  await page.screenshot({ path: "tests/bonded-tier-dark.png", fullPage: true });

  expect(errs, errs.join("\n")).toHaveLength(0);
});

// A qualifying bond the wallet already holds, plus matching backend reads, so the "use a bond you hold"
// loader + the "already held" detection can be exercised without an on-chain deposit. The lock's token is a
// valid C-address that is NOT in the wallet picker, so loading it also exercises the synthetic-token path.
const LOCK_TOKEN = "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5";
const FIXED_COMMIT = "ab".repeat(32);
const LOCK_AMOUNT = "25000000000"; // 2500 with 7 decimals
const LOCK_UNLOCK = Math.floor(Date.UTC(2030, 6, 1, 12, 0, 0) / 1000); // 2030-07-01 12:00 UTC, minute-aligned
const HEX32 = (b: number) => b.toString(16).padStart(2, "0").repeat(32);

function stubBond(page: import("@playwright/test").Page) {
  page.route("**/escrow/locks**", (route) =>
    route.fulfill({
      json: {
        owner: DEPLOYER,
        count: 1,
        escrowId: "ESCROW",
        locks: [
          {
            id: 99,
            depositor: DEPLOYER,
            claimant: DEPLOYER,
            token: LOCK_TOKEN,
            amount: LOCK_AMOUNT,
            unlock_time: LOCK_UNLOCK,
            commitment: FIXED_COMMIT,
            revocable: false,
            released: false,
            is_locked: true,
            role: "self",
            tokenSymbol: "TUSD",
            tokenDecimals: 7,
          },
        ],
      },
    }),
  );
  page.route("**/escrow/balance**", (route) => route.fulfill({ json: { owner: DEPLOYER, balance: "0", bondTokenId: "" } }));
  page.route("**/bonded/bond/info", (route) =>
    route.fulfill({
      json: {
        bondGateId: "GATE",
        imageId: HEX32(0xaa),
        minAnonSet: 3,
        escrowId: "ESCROW",
        standaloneSetId: HEX32(0x11),
        standaloneEnrolledCount: 1,
        standaloneMemberRoot: null,
        grantCount: 0,
      },
    }),
  );
  page.route("**/bonded/bond/qual-set**", (route) =>
    route.fulfill({
      json: {
        token: LOCK_TOKEN,
        minAmount: LOCK_AMOUNT,
        deadline: LOCK_UNLOCK,
        reqId: HEX32(0xcd),
        anonSetSize: 3,
        minAnonSet: 3,
        belowMin: false,
        computedRoot: HEX32(0xef),
        published: true,
        ringLen: 3,
        locks: [{ id: 99, commitment: FIXED_COMMIT, amount: LOCK_AMOUNT, unlock_time: LOCK_UNLOCK, depositor: DEPLOYER }],
      },
    }),
  );
  page.route("**/bonded/bond/status**", (route) =>
    route.fulfill({ json: { accessor: HEX32(0x04), reqId: HEX32(0xcd), is_granted: false, grant: null, bondGateId: "GATE" } }),
  );
  page.route("**/bonded/bond/enroll", (route) =>
    route.fulfill({
      json: {
        ok: true,
        setId: HEX32(0x11),
        memberIndex: 0,
        memberCount: 1,
        memberRoot: HEX32(0x00),
        minted: {
          idSecret: HEX32(0x01),
          idTrapdoor: HEX32(0x02),
          holderSeed: HEX32(0x03),
          accessor: HEX32(0x04),
          qualCommitment: FIXED_COMMIT,
        },
      },
    }),
  );
  page.route("**/bonded/bond/handle-vault/**", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ json: { ok: true } })
      : route.fulfill({ json: { found: false, blob: null } }),
  );
}

test("tier: load a bond you already hold, and the already-held detection", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errs.push(m.text());
  });
  await page.addInitScript(mock(DEPLOYER));
  await stubHorizon(page);
  stubBond(page);

  await page.goto("/app/bonded/tier");
  await expect(page.getByTestId("bonded-tier")).toBeVisible();

  // The requirement starts at the default (100 of the first wallet token). The existing bond is offered as a
  // chip but not yet loaded, so it is not marked active.
  await expect(page.getByTestId("tier-amount")).toHaveValue("100");
  const chip = page.getByTestId("tier-mybond-99");
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toHaveAttribute("aria-pressed", "false");

  // Load the bond: its token, amount, and deadline populate the requirement, and the chip marks active.
  await chip.click();
  await expect(page.getByTestId("tier-amount")).toHaveValue("2500");
  await expect(page.getByTestId("tier-deadline-trigger")).toContainText("2030");
  await expect(chip).toHaveAttribute("aria-pressed", "true");

  // Mint the handle whose tag matches the bond, so the page recognizes the bond is already held.
  await page.getByTestId("tier-create-identity").click();
  await expect(page.getByTestId("tier-identity")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("tier-bond-have")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("tier-bond-have")).toContainText("lock #99");
  // The primary "Lock 2500" is replaced by the "Lock another" secondary.
  await expect(page.getByTestId("tier-bond")).toHaveCount(0);
  await expect(page.getByTestId("tier-bond-again")).toBeVisible();
  // The stubbed set is at the floor (3), so proving is enabled.
  await expect(page.getByTestId("tier-prove")).toBeEnabled({ timeout: 30_000 });

  expect(errs, errs.join("\n")).toHaveLength(0);
});

test("tier: the handle backs up to the wallet and restores on another device", async ({ page }) => {
  await page.addInitScript(mock(DEPLOYER));
  await stubHorizon(page);
  await page.goto("/app/bonded/tier");
  await expect(page.getByTestId("bonded-tier")).toBeVisible();

  // Create a handle: it mints + auto-backs-up (sign once -> encrypt -> store the opaque blob in the vault).
  await page.getByTestId("tier-create-identity").click();
  await expect(page.getByTestId("tier-identity")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("tier-sync")).toContainText("Backed up to your wallet", { timeout: 15_000 });
  const handle = (await page.getByTestId("tier-identity").innerText()).match(/[0-9a-f]{6}…[0-9a-f]{6}/)?.[0] ?? "";
  expect(handle).not.toBe("");

  // Simulate a fresh device: drop the local handle + the in-memory signature, reload.
  await page.evaluate(() => localStorage.removeItem("zkorage-bond-identity"));
  await page.reload();
  await expect(page.getByTestId("tier-create-identity")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("tier-identity")).toHaveCount(0);

  // Restore from the wallet: same signature -> same vault id -> pull + decrypt -> the SAME handle is back.
  await page.getByTestId("tier-restore").click();
  await expect(page.getByTestId("tier-identity")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("tier-identity")).toContainText(handle);
  await expect(page.getByTestId("tier-sync")).toContainText("Backed up to your wallet", { timeout: 15_000 });
});
