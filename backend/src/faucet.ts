// Faucet for the test classic assets (TUSD / TGLD / TBND / TBIL). A tester connects a wallet, creates the
// trustlines, and each asset's issuer pays them 10,000 of the asset (issuance). These are CLASSIC Stellar
// operations over Horizon; the rest of the backend is Soroban-RPC-only, so this module owns its own Horizon
// server. Rate-limited to once per 24h per wallet (see faucet-store.ts).
//
// The asset PUBLIC info (code, name, issuer pubkey, SAC contract id) is public and hard-coded below (it also
// lives in development/Classic-Asset/assets.json + scripts/keepalive.mjs). The issuer SECRETS are read from
// the env var FAUCET_ISSUER_SECRETS (a JSON map { CODE: "S..." }), so no secret is committed. If a secret is
// missing the faucet reports itself unconfigured.

import { Horizon, TransactionBuilder, Operation, Asset, Keypair, Networks, BASE_FEE } from "@stellar/stellar-sdk";

const HORIZON_URL = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
export const FAUCET_AMOUNT = process.env.FAUCET_AMOUNT || "10000";
export const FAUCET_WINDOW_MS = Number(process.env.FAUCET_WINDOW_MS || 24 * 60 * 60 * 1000);

export interface FaucetAsset {
  code: string;
  name: string;
  issuer: string;
  sac: string;
}

// Testnet only. Matches development/Classic-Asset/assets.json.
export const FAUCET_ASSETS: FaucetAsset[] = [
  { code: "TUSD", name: "Test USD stablecoin", issuer: "GDFEJBM6RGK2IL2PIMGVNTGSO7O2NOVILFQUMIC55YMFKSGACA5IO2PM", sac: "CALISDUWPL24M3LWLOXIWYNRQ42YYMZJ4ZU6UYIVCCB4NH4DMV767NZX" },
  { code: "TGLD", name: "Test gold token", issuer: "GBDNBG6WDCKN4MZUITNRA7WVRMMIA6J6ILOJ76LYEEEOSSG6WT3ILSPA", sac: "CA3CH2YR5TY4IUYBYLCMFSDT2SDY34Q5GFZEDEZ5LOL7BCYY23XYUG57" },
  { code: "TBND", name: "Test bond token", issuer: "GDTZCXVKWTOM42LALZSOQPD2TMDTOIMLZLSRSDWFSX4R2XL77I5EIP2D", sac: "CAGZZDZ2ZKP7C4PXYTBVEN5Z7RVP3275OMHA7JFZK2X2Y4SMGNRZJZQK" },
  { code: "TBIL", name: "Test treasury-bill token", issuer: "GA36SK3SLDXCJJXOUJU3PWT4QWHMLU2GQUF6UQMNBVMISTUA7OVJMU64", sac: "CDOB2L6FVFOH3GFJDI6DD4VA5GW5MLRXPJFSNA3UF7W7EAOM5CA6C3YE" },
];

function issuerSecrets(): Record<string, string> {
  const raw = process.env.FAUCET_ISSUER_SECRETS;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function faucetConfigured(): boolean {
  const s = issuerSecrets();
  return FAUCET_ASSETS.every((a) => typeof s[a.code] === "string" && s[a.code].length > 0);
}

function horizon(): Horizon.Server {
  return new Horizon.Server(HORIZON_URL);
}

type HorizonAccount = Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

function assetOf(a: FaucetAsset): Asset {
  return new Asset(a.code, a.issuer);
}

const trustKey = (a: FaucetAsset) => `${a.code}:${a.issuer}`;

// The account's funded state + the set of faucet trustlines it already holds. A missing account (Horizon 404)
// is reported as not-funded, so the caller can prompt friendbot rather than treating it as an error.
export async function accountState(
  address: string,
): Promise<{ funded: boolean; trusts: Set<string>; acct: HorizonAccount | null }> {
  try {
    const acct = await horizon().loadAccount(address);
    const trusts = new Set<string>();
    for (const b of acct.balances as Array<{ asset_type: string; asset_code?: string; asset_issuer?: string }>) {
      if (b.asset_type === "native") continue;
      if (b.asset_code && b.asset_issuer) trusts.add(`${b.asset_code}:${b.asset_issuer}`);
    }
    return { funded: true, trusts, acct };
  } catch (e: unknown) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404 || (e as { name?: string })?.name === "NotFoundError") {
      return { funded: false, trusts: new Set(), acct: null };
    }
    throw e;
  }
}

// Build an unsigned changeTrust transaction (source = the user) for every faucet asset the account does not
// yet trust. Returns { none: true } if all are already trusted. The user signs this in their wallet.
export async function buildTrustlineXdr(
  address: string,
): Promise<{ xdr: string; codes: string[] } | { none: true }> {
  const { funded, trusts, acct } = await accountState(address);
  if (!funded || !acct) throw new Error("account not found; fund the wallet with testnet XLM first");
  const missing = FAUCET_ASSETS.filter((a) => !trusts.has(trustKey(a)));
  if (missing.length === 0) return { none: true };
  const b = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE });
  for (const a of missing) b.addOperation(Operation.changeTrust({ asset: assetOf(a) }));
  const tx = b.setTimeout(300).build();
  return { xdr: tx.toXDR(), codes: missing.map((a) => a.code) };
}

// Submit the user-signed trustline transaction. Validates it is a plain (not fee-bump) transaction whose
// source is the claiming wallet and whose ops are all changeTrust, so this is not a generic Horizon relay.
export async function submitSignedXdr(signedXdr: string, expectedSource: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, PASSPHRASE);
  if ("innerTransaction" in tx) throw new Error("a fee-bump transaction is not accepted here");
  if (tx.source !== expectedSource) throw new Error("the trustline transaction is not for this account");
  if (!tx.operations.every((o) => o.type === "changeTrust")) throw new Error("only changeTrust operations are allowed");
  const r = await horizon().submitTransaction(tx as Parameters<Horizon.Server["submitTransaction"]>[0]);
  return r.hash;
}

// Pay `amount` of one asset from its issuer to `to` (this issues the asset). Signs with the issuer secret.
export async function payAsset(code: string, to: string, amount: string): Promise<string> {
  const a = FAUCET_ASSETS.find((x) => x.code === code);
  if (!a) throw new Error(`unknown faucet asset ${code}`);
  const secret = issuerSecrets()[code];
  if (!secret) throw new Error(`faucet issuer secret for ${code} not configured`);
  const kp = Keypair.fromSecret(secret);
  const acct = await horizon().loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ destination: to, asset: assetOf(a), amount }))
    .setTimeout(180)
    .build();
  tx.sign(kp);
  const r = await horizon().submitTransaction(tx);
  return r.hash;
}
