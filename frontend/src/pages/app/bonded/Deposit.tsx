import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Wallet } from "lucide-react";
import { useBonded } from "@/lib/hooks/useBonded";
import { Panel } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtAmount, toBaseUnits } from "@/lib/api";
import { cn } from "@/lib/utils";

// now + 1 hour, formatted for a datetime-local input (local time, minute precision).
function defaultUnlock(): string {
  const d = new Date(Date.now() + 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function BondedDeposit() {
  const b = useBonded();
  const nav = useNavigate();
  const [amount, setAmount] = useState("100");
  const [unlockAt, setUnlockAt] = useState(defaultUnlock);
  const [mode, setMode] = useState<"bond" | "send">("bond");
  const [revocable, setRevocable] = useState(true);
  const [recipient, setRecipient] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const unlockUnix = useMemo(() => Math.floor(new Date(unlockAt).getTime() / 1000), [unlockAt]);

  if (!b.connected) {
    return (
      <Panel title="Deposit">
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-[14px] text-muted-foreground">Connect your Freighter wallet on testnet to lock tokens.</p>
          <Button variant="brand" onClick={() => void b.connect()} data-testid="bonded-connect">
            <Wallet className="size-4" /> Connect wallet
          </Button>
        </div>
      </Panel>
    );
  }

  const submit = async () => {
    setErr(null);
    setOk(null);
    const base = toBaseUnits(amount);
    if (!base) return setErr("Enter a valid amount (up to 7 decimals).");
    if (BigInt(base) > BigInt(b.balance)) return setErr(`You only have ${fmtAmount(b.balance)} zkUSD. Get more from the faucet.`);
    if (!unlockUnix || unlockUnix <= Math.floor(Date.now() / 1000)) return setErr("Pick an unlock time in the future.");
    const claimant = mode === "send" ? recipient.trim() : b.address!;
    const rev = mode === "send" ? false : revocable;
    if (mode === "send" && !/^G[A-Z2-7]{55}$/.test(claimant)) return setErr("Enter a valid recipient address (G…).");
    const r = await b.deposit({ amount: base, unlock_time: unlockUnix, revocable: rev, claimant });
    if (r.ok) {
      setOk(`Locked. tx ${r.txHash ?? ""}`);
      setTimeout(() => nav("/app/bonded/balances"), 900);
    } else {
      setErr(r.error ?? "deposit failed");
    }
  };

  const busy = b.busy === "deposit";

  return (
    <Panel title="Lock tokens" className="max-w-xl">
      <div className="grid gap-4" data-testid="bonded-deposit">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="amt">Amount (zkUSD)</Label>
            <span className="text-[12px] text-muted-foreground" data-testid="deposit-balance">
              Balance: {fmtAmount(b.balance)} zkUSD
            </span>
          </div>
          <Input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-48" data-testid="deposit-amount" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={b.busy === "faucet"} onClick={() => void b.fundFaucet()} data-testid="bonded-faucet">
              {b.busy === "faucet" ? "Minting…" : "Get 1,000 test zkUSD"}
            </Button>
            <span className="text-[12px] text-muted-foreground">A demo bond token, minted to your wallet.</span>
          </div>
        </div>

        <div>
          <Label htmlFor="unlock">Unlock time</Label>
          <Input id="unlock" type="datetime-local" value={unlockAt} onChange={(e) => setUnlockAt(e.target.value)} className="mt-1 w-64" data-testid="deposit-unlock" />
          <p className="mt-1 text-[12px] text-muted-foreground">Funds free up at this time. You can extend it later, never shorten it.</p>
        </div>

        <div>
          <Label>Type</Label>
          <div className="mt-1 flex w-fit gap-1 rounded-xl border bg-card p-1" role="radiogroup" aria-label="Lock type">
            {(["bond", "send"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                data-testid={`mode-${m}`}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                  mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {m === "bond" ? "Bond (to yourself)" : "One-way send"}
              </button>
            ))}
          </div>
        </div>

        {mode === "bond" ? (
          <label className="flex items-start gap-2 text-[13px] leading-relaxed">
            <input type="checkbox" checked={revocable} onChange={(e) => setRevocable(e.target.checked)} className="mt-0.5" data-testid="deposit-revocable" />
            <span>Allow early release (revocable). Unchecked means it stays locked until the unlock time, with no early exit.</span>
          </label>
        ) : (
          <div>
            <Label htmlFor="rcpt">Recipient (G…)</Label>
            <Input id="rcpt" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="G…" className="mt-1 font-mono text-[13px]" data-testid="deposit-recipient" />
            <p className="mt-1 text-[12px] text-muted-foreground">Only this address can claim, and only after the unlock time. A send cannot be pulled back.</p>
          </div>
        )}

        {err && <p className="text-[13px] text-destructive" data-testid="deposit-error">{err}</p>}
        {ok && <p className="break-all text-[13px] text-success" data-testid="deposit-ok">{ok}</p>}

        <div>
          <Button variant="brand" disabled={busy} onClick={() => void submit()} data-testid="deposit-submit">
            {busy ? "Confirm in Freighter…" : "Lock tokens"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
