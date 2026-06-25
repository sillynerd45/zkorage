import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { useBonded } from "@/lib/hooks/useBonded";
import { useWallet } from "@/lib/wallet/WalletContext";
import { Panel } from "@/components/app/blocks";
import { Button } from "@/components/ui/button";
import AccessList from "@/components/app/bonded/AccessList";
import { loadIdentityAt } from "@/lib/bonded/handle";

export default function BondedAccessPage() {
  const b = useBonded();
  const { signMessage } = useWallet();
  // The current wallet's handle accessor (per-wallet localStorage), re-read on a wallet change.
  const [accessor, setAccessor] = useState<string | null>(() => loadIdentityAt(null)?.accessor ?? null);
  useEffect(() => {
    setAccessor(loadIdentityAt(b.address)?.accessor ?? loadIdentityAt(null)?.accessor ?? null);
  }, [b.address]);

  return (
    <div className="grid gap-4" data-testid="bonded-access-page">
      <Panel title="Your access">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Requirements your handle can open right now, and ones that have ended. Proving runs on the Bonded
          Access tab; granted access shows up here.
        </p>
      </Panel>

      {!b.connected ? (
        <Panel>
          <div className="flex flex-col items-start gap-3 py-1">
            <p className="text-[13px] text-muted-foreground">Connect your wallet to see the access your handle holds.</p>
            <Button variant="brand" onClick={() => void b.connect()} data-testid="access-connect">
              <Wallet className="size-4" /> Connect wallet
            </Button>
          </div>
        </Panel>
      ) : (
        <AccessList accessor={accessor} connected={b.connected} address={b.address} signMessage={signMessage} />
      )}
    </div>
  );
}
