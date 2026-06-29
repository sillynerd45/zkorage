import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Droplets,
  Wallet,
  CheckCircle2,
  ExternalLink,
  Loader2,
  AlertTriangle,
  ArrowRight,
  Download,
} from "lucide-react";
import { useWallet } from "@/lib/wallet/WalletContext";
import { getFaucetInfo, faucetBuildTrustlines, faucetClaim, type FaucetInfoResp, type FaucetClaimResp } from "@/lib/api";
import { PageHeader, SectionCard } from "@/components/marketing/blocks";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const EXPERT = "https://stellar.expert/explorer/testnet";
const short = (s: string, n = 5) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

type Acct = {
  funded: boolean;
  xlm: string;
  // code -> { balance, trusted }
  tokens: Record<string, { balance: string; trusted: boolean }>;
};

type Msg = { kind: "error" | "success" | "info"; text: string } | null;

async function loadAccount(address: string, info: FaucetInfoResp): Promise<Acct> {
  const r = await fetch(`${HORIZON}/accounts/${address}`);
  const tokens: Acct["tokens"] = {};
  for (const a of info.assets) tokens[a.code] = { balance: "0", trusted: false };
  if (!r.ok) return { funded: false, xlm: "0", tokens };
  const j = (await r.json()) as {
    balances?: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }[];
  };
  let xlm = "0";
  for (const b of j.balances ?? []) {
    if (b.asset_type === "native") {
      xlm = b.balance;
      continue;
    }
    const match = info.assets.find((a) => a.code === b.asset_code && a.issuer === b.asset_issuer);
    if (match) tokens[match.code] = { balance: b.balance, trusted: true };
  }
  return { funded: true, xlm, tokens };
}

const fmt = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : s;
};

export default function Faucet() {
  const w = useWallet();
  const [info, setInfo] = useState<FaucetInfoResp | null>(null);
  const [acct, setAcct] = useState<Acct | null>(null);
  const [busy, setBusy] = useState<null | "fund" | "claim">(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [result, setResult] = useState<FaucetClaimResp | null>(null);

  useEffect(() => {
    getFaucetInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  const refresh = useCallback(async () => {
    if (!info || !w.address) return;
    try {
      setAcct(await loadAccount(w.address, info));
    } catch {
      setAcct(null);
    }
  }, [info, w.address]);

  useEffect(() => {
    if (w.status === "connected" && w.address && info) {
      setAcct(null);
      void refresh();
    }
  }, [w.status, w.address, info, refresh]);

  const onFund = async () => {
    if (!w.address) return;
    setBusy("fund");
    setMsg(null);
    try {
      const r = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(w.address)}`);
      await refresh();
      // friendbot returns 400 if the account already exists; either way refresh shows the real balance.
      setMsg(
        r.ok
          ? { kind: "success", text: "Funded with testnet XLM. You can create trustlines now." }
          : { kind: "info", text: "This wallet may already be funded. Check the balance above." },
      );
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error)?.message || "could not reach friendbot" });
    } finally {
      setBusy(null);
    }
  };

  const onClaim = async () => {
    if (!w.address) return;
    setBusy("claim");
    setMsg(null);
    setResult(null);
    try {
      const built = await faucetBuildTrustlines(w.address);
      let signed: string | undefined;
      if (built.xdr) signed = await w.sign(built.xdr); // user signs the changeTrust tx in Freighter
      const out = await faucetClaim(w.address, signed);
      setResult(out);
      await refresh();
      setMsg({ kind: "success", text: `Sent ${fmt(out.amount)} of each token to your wallet.` });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error)?.message || "the request failed" });
    } finally {
      setBusy(null);
    }
  };

  const connected = w.status === "connected" && !!w.address;

  return (
    <div>
      <PageHeader
        eyebrow="Testnet faucet"
        title="Faucet"
        lead={
          <>
            Get test tokens to try Bonded Proofs and Bonded Access. Connect Freighter on testnet, create the
            trustlines, and each token's issuer sends you{" "}
            <span className="font-medium text-foreground">{info ? fmt(info.amount) : "10,000"}</span> of it. One
            claim per wallet per day.
          </>
        }
      />

      <SectionCard label="Get test tokens">
        {/* wallet gate */}
        {!connected ? (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {w.status === "not-installed"
                ? "Freighter is not installed in this browser."
                : w.status === "wrong-network"
                  ? "Your wallet is connected, but not on testnet. Switch Freighter to the Test network."
                  : "Connect your Freighter wallet to continue. The tokens are sent to the address you connect."}
            </p>
            {w.status === "not-installed" ? (
              <a
                href="https://www.freighter.app/"
                target="_blank"
                rel="noreferrer"
                className={cn(buttonVariants({ size: "sm" }))}
              >
                Get Freighter <ExternalLink className="size-4" />
              </a>
            ) : w.status === "wrong-network" ? null : (
              <button
                type="button"
                onClick={() => void w.connect().catch(() => {})}
                disabled={w.status === "connecting" || w.status === "checking"}
                className={cn(buttonVariants({ size: "sm" }))}
                data-testid="faucet-connect"
              >
                <Wallet className="size-4" />
                {w.status === "connecting" ? "Connecting…" : "Connect Freighter"}
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {/* connected account */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3.5 py-2.5">
              <span className="font-mono text-[13px] text-foreground">{short(w.address!, 6)}</span>
              <span className="text-[13px] text-muted-foreground">
                {acct ? `${fmt(acct.xlm)} XLM` : "loading…"}
              </span>
            </div>

            {/* unfunded -> friendbot */}
            {acct && !acct.funded ? (
              <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-4">
                <p className="text-sm leading-relaxed text-foreground">
                  Your wallet has no testnet XLM yet. Stellar needs a small XLM reserve to create a trustline,
                  so fund it first.
                </p>
                <button
                  type="button"
                  onClick={() => void onFund()}
                  disabled={busy !== null}
                  className={cn(buttonVariants({ size: "sm" }))}
                  data-testid="faucet-fund"
                >
                  {busy === "fund" ? <Loader2 className="size-4 animate-spin" /> : <Droplets className="size-4" />}
                  Fund with testnet XLM
                </button>
              </div>
            ) : (
              <>
                {/* token list */}
                <ul className="divide-y divide-border/70 rounded-lg border">
                  {info?.assets.map((a) => {
                    const t = acct?.tokens[a.code];
                    return (
                      <li key={a.code} className="flex items-center justify-between gap-3 px-3.5 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {a.code}{" "}
                            <a
                              href={`${EXPERT}/asset/${a.code}-${a.issuer}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-muted-foreground hover:text-brand"
                              aria-label={`${a.code} on Stellar Expert`}
                            >
                              <ExternalLink className="inline size-3" />
                            </a>
                          </p>
                          <p className="truncate text-[13px] text-muted-foreground">{a.name}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-medium text-foreground">{t ? fmt(t.balance) : "0"}</p>
                          <p className="text-[11px] text-muted-foreground">{t?.trusted ? "trustline set" : "no trustline"}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => void onClaim()}
                    disabled={busy !== null || !info?.configured}
                    className={cn(buttonVariants({ size: "default" }), "w-full sm:w-auto")}
                    data-testid="faucet-claim"
                  >
                    {busy === "claim" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                    Get all test tokens
                  </button>
                  <p className="text-[13px] text-muted-foreground">
                    This creates any missing trustlines (you sign once) and sends{" "}
                    {info ? fmt(info.amount) : "10,000"} of each token. One claim per wallet per day.
                  </p>
                </div>

                {/* per-claim result */}
                {result && (
                  <ul className="space-y-1.5 rounded-lg border border-success/40 bg-success/5 p-3.5 text-[13px]">
                    {result.sent.map((s) => (
                      <li key={s.code} className="flex items-center justify-between gap-3">
                        <span className="text-foreground">
                          <CheckCircle2 className="mr-1 inline size-3.5 text-success" /> {fmt(s.amount)} {s.code}
                        </span>
                        <a href={`${EXPERT}/tx/${s.txHash}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-brand">
                          tx <ExternalLink className="inline size-3" />
                        </a>
                      </li>
                    ))}
                    {result.skipped.map((s) => (
                      <li key={s.code} className="text-muted-foreground">
                        {s.code} skipped: {s.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {/* status message */}
            {msg && (
              <p
                className={cn(
                  "flex items-start gap-2 text-[13px] leading-relaxed",
                  msg.kind === "error" ? "text-destructive" : msg.kind === "success" ? "text-success" : "text-muted-foreground",
                )}
                role={msg.kind === "error" ? "alert" : undefined}
              >
                {msg.kind === "error" && <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
                {msg.text}
              </p>
            )}
          </div>
        )}
      </SectionCard>

      <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
        Testnet only. These tokens have no value. Once you hold them, try{" "}
        <Link to="/app/bonded" className="font-medium text-brand hover:underline">
          Bonded Proofs <ArrowRight className="inline size-3.5" />
        </Link>{" "}
        to lock a bond, or browse public rooms in the{" "}
        <Link to="/explorer" className="font-medium text-brand hover:underline">
          Explorer
        </Link>
        .
      </p>
    </div>
  );
}
