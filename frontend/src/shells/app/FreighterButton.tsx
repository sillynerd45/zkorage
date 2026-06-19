import { useEffect, useRef } from "react";
import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/hooks/useWallet";

// App-shell top-right wallet affordance — PLACEHOLDER. Non-functional "Connect Freighter" that opens a
// brief "coming soon" popover. No @stellar/freighter-api dependency yet; wiring is a later pass (see
// lib/hooks/useWallet). The proofs/flows on every page work without a wallet today.
export function FreighterButton() {
  const w = useWallet();
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!w.comingSoon) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") w.dismiss();
    };
    const onClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) w.dismiss();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [w]);

  return (
    <div className="relative" ref={popRef}>
      <Button
        variant="outline"
        size="sm"
        onClick={w.connect}
        aria-haspopup="dialog"
        aria-expanded={w.comingSoon}
        data-testid="freighter-connect"
      >
        <Wallet className="size-4" />
        <span className="hidden sm:inline">Connect Freighter</span>
        <span className="sm:hidden">Connect</span>
      </Button>
      {w.comingSoon && (
        <div
          role="dialog"
          aria-label="Wallet connection"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 animate-fade-in rounded-lg border bg-popover p-3.5 text-popover-foreground shadow-lg"
        >
          <p className="text-sm font-medium">Wallet connection — coming soon</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Every flow here works without a wallet today. Freighter sign-in lands in a later pass; it won't
            change the proofs you can already run.
          </p>
        </div>
      )}
    </div>
  );
}
