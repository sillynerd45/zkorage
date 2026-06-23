import { Asset, Networks } from "@stellar/stellar-sdk";
import { toBaseUnits } from "@/lib/api";

// Token options for the Bonded Proofs Deposit picker. The escrow holds any SEP-41 token, so a deposit just
// needs that token's contract address. For a classic Stellar asset that address is its Stellar Asset
// Contract (SAC), which is deterministic from the asset (code + issuer), computed here client-side. zkUSD is
// a known Soroban token (the demo bond token, with a faucet). The wallet's holdings come from Horizon.

const HORIZON = "https://horizon-testnet.stellar.org";
const NET = Networks.TESTNET;

export interface TokenOption {
  key: string; // stable <option> key
  symbol: string; // display symbol
  contractId: string; // SEP-41 / SAC address passed to deposit
  decimals: number;
  balanceBase: string; // base units, decimal string
  kind: "zkusd" | "native" | "classic" | "custom";
  issuer?: string;
  faucet?: boolean;
}

interface HorizonBalance {
  asset_type: string;
  balance: string;
  asset_code?: string;
  asset_issuer?: string;
}

// Base units -> a plain decimal string with NO grouping commas (safe to drop into a number input).
export function plainAmount(base: string, decimals: number): string {
  const v = BigInt(base || "0");
  const d = 10n ** BigInt(decimals);
  const whole = (v / d).toString();
  const frac = (v % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// Build the deposit token list: zkUSD (known, faucet) + native XLM + every classic asset the wallet holds.
export async function loadWalletTokens(
  address: string,
  bondTokenId: string,
  zkusdBalanceBase: string,
): Promise<TokenOption[]> {
  const opts: TokenOption[] = [
    {
      key: bondTokenId,
      symbol: "zkUSD",
      contractId: bondTokenId,
      decimals: 7,
      balanceBase: zkusdBalanceBase || "0",
      kind: "zkusd",
      faucet: true,
    },
  ];
  try {
    const res = await fetch(`${HORIZON}/accounts/${address}`);
    if (res.ok) {
      const acct = (await res.json()) as { balances?: HorizonBalance[] };
      for (const bal of acct.balances ?? []) {
        // Per-row guard: one malformed asset (e.g. an issuer Asset() rejects) must not drop the rest.
        try {
          if (bal.asset_type === "native") {
            opts.push({
              key: "native",
              symbol: "XLM",
              contractId: Asset.native().contractId(NET),
              decimals: 7,
              balanceBase: toBaseUnits(bal.balance, 7) ?? "0",
              kind: "native",
            });
          } else if (bal.asset_code && bal.asset_issuer) {
            opts.push({
              key: `${bal.asset_code}:${bal.asset_issuer}`,
              symbol: bal.asset_code,
              contractId: new Asset(bal.asset_code, bal.asset_issuer).contractId(NET),
              decimals: 7,
              balanceBase: toBaseUnits(bal.balance, 7) ?? "0",
              kind: "classic",
              issuer: bal.asset_issuer,
            });
          }
        } catch {
          /* skip a malformed balance row */
        }
      }
    }
  } catch {
    /* Horizon unreachable: still offer zkUSD so the page works. */
  }
  return opts;
}
