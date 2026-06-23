import { useCallback, useEffect, useState } from "react";
import { getTokenBalance } from "@/lib/api";
import { loadWalletTokens, classicAssetToken, plainAmount, type TokenOption } from "@/lib/bonded/tokens";
import { short } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// The token a Bonded Access requirement names: the owner picks which token readers must bond. The owner may
// not hold that token, so there are three ways in: pick one the wallet holds, paste a SEP-41 contract, or name
// a classic Stellar asset by code + issuer (its SAC is derived client-side). The resolved token (id, symbol,
// decimals) is reported up via onResolved; null while the input is incomplete, so the caller disables submit.

type Source = "wallet" | "paste" | "classic";

const selectCls =
  "h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export function BondTokenPicker({
  address,
  onResolved,
}: {
  address: string | null;
  onResolved: (t: TokenOption | null) => void;
}) {
  const [source, setSource] = useState<Source>("wallet");
  const [wallet, setWallet] = useState<TokenOption[]>([]);
  const [walletKey, setWalletKey] = useState("");
  const [loadingWallet, setLoadingWallet] = useState(false);

  const [paste, setPaste] = useState("");
  const [pasteTok, setPasteTok] = useState<TokenOption | null>(null);
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);

  const [code, setCode] = useState("");
  const [issuer, setIssuer] = useState("");
  const [classicTok, setClassicTok] = useState<TokenOption | null>(null);
  const [classicErr, setClassicErr] = useState<string | null>(null);

  // Load the owner's wallet tokens once they connect (reuses the Deposit picker's source).
  useEffect(() => {
    if (!address) return;
    let live = true;
    setLoadingWallet(true);
    loadWalletTokens(address)
      .then((list) => {
        if (!live) return;
        setWallet(list);
        setWalletKey((k) => k || list[0]?.key || "");
      })
      .finally(() => live && setLoadingWallet(false));
    return () => { live = false; };
  }, [address]);

  // Report the resolved token up whenever the active source's selection changes.
  const walletTok = wallet.find((t) => t.key === walletKey) ?? null;
  useEffect(() => {
    const resolved = source === "wallet" ? walletTok : source === "paste" ? pasteTok : classicTok;
    onResolved(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, walletKey, pasteTok, classicTok, wallet.length]);

  const resolvePaste = useCallback(async () => {
    setPasteErr(null);
    setPasteTok(null);
    const c = paste.trim().toUpperCase();
    if (!/^C[A-Z2-7]{55}$/.test(c)) {
      setPasteErr("Enter a valid contract address (starts with C).");
      return;
    }
    setPasteBusy(true);
    try {
      const t = await getTokenBalance(address ?? "", c);
      setPasteTok({ key: c, symbol: t.symbol || "token", contractId: c, decimals: t.decimals, balanceBase: t.balance, kind: "custom" });
    } catch (e) {
      setPasteErr((e as Error)?.message ?? "Could not read that token.");
    } finally {
      setPasteBusy(false);
    }
  }, [paste, address]);

  const resolveClassic = useCallback(() => {
    setClassicErr(null);
    setClassicTok(null);
    try {
      setClassicTok(classicAssetToken(code, issuer));
    } catch (e) {
      setClassicErr((e as Error)?.message ?? "Could not build that asset.");
    }
  }, [code, issuer]);

  return (
    <div className="space-y-2">
      <select
        value={source}
        onChange={(e) => setSource(e.target.value as Source)}
        className={selectCls}
        data-testid="bond-token-source"
        aria-label="token source"
      >
        <option value="wallet">From your wallet</option>
        <option value="paste">Paste a SEP-41 contract</option>
        <option value="classic">Classic asset by code and issuer</option>
      </select>

      {source === "wallet" && (
        <div className="space-y-1.5">
          <select
            value={walletKey}
            onChange={(e) => setWalletKey(e.target.value)}
            className={selectCls}
            data-testid="bond-token-wallet"
            aria-label="wallet token"
            disabled={loadingWallet && wallet.length === 0}
          >
            {wallet.length === 0 && <option value="">{loadingWallet ? "Loading your tokens…" : "No tokens found"}</option>}
            {wallet.map((t) => (
              <option key={t.key} value={t.key}>
                {t.symbol} · {short(t.contractId, 4)}
              </option>
            ))}
          </select>
          <p className="text-[12px] text-muted-foreground">
            You can require a token you do not hold. Switch to paste or classic asset for that.
          </p>
        </div>
      )}

      {source === "paste" && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-end gap-2">
            <Input
              value={paste}
              onChange={(e) => { setPaste(e.target.value); setPasteTok(null); setPasteErr(null); }}
              placeholder="Contract id (56 chars, starts with C)"
              className="w-72 font-mono text-[13px]"
              data-testid="bond-token-paste"
            />
            <Button type="button" variant="outline" size="sm" disabled={pasteBusy} onClick={() => void resolvePaste()} data-testid="bond-token-load">
              {pasteBusy ? "Resolving…" : "Resolve"}
            </Button>
          </div>
          {pasteErr && <p className="text-[12px] text-destructive">{pasteErr}</p>}
          {pasteTok && <p className="text-[12px] text-success">{pasteTok.symbol} · {pasteTok.decimals} decimals</p>}
        </div>
      )}

      {source === "classic" && (
        <div className="space-y-1.5">
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
            <Input value={code} onChange={(e) => { setCode(e.target.value); setClassicTok(null); setClassicErr(null); }} placeholder="CODE (e.g. USDC)" data-testid="bond-token-code" />
            <Input value={issuer} onChange={(e) => { setIssuer(e.target.value); setClassicTok(null); setClassicErr(null); }} placeholder="Issuer (G... address)" className="font-mono text-[13px]" data-testid="bond-token-issuer" />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={resolveClassic} data-testid="bond-token-classic-resolve">Resolve</Button>
          {classicErr && <p className="text-[12px] text-destructive">{classicErr}</p>}
          {classicTok && (
            <p className="text-[12px] text-success">
              Resolved to SAC {short(classicTok.contractId, 6)} · {classicTok.symbol}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export { plainAmount };
