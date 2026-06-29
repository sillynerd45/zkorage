import { Link } from "react-router-dom";
import { BrandMark } from "@/components/BrandMark";

// Marketing-shell footer: site links + honest testnet note. (The fixed VersionBadge carries the build SHA.)
const LINKS: { to: string; label: string }[] = [
  { to: "/docs", label: "Documentation" },
  { to: "/verify", label: "Verify it yourself" },
  { to: "/explorer", label: "Explorer" },
  { to: "/faucet", label: "Faucet" },
  { to: "/app", label: "Open the app" },
];

export function Footer() {
  return (
    <footer className="mt-16 border-t bg-card/40">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-sm">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <BrandMark />
            <span className="text-[17px]">zkorage</span>
          </div>
          <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
            Share sealed documents and open them anonymously, on Stellar. Anyone can re-check the result without
            ever seeing the files.
          </p>
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" /> Stellar testnet · demo, unaudited
          </p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-10 gap-y-2 text-sm">
          {LINKS.map((l) => (
            <Link key={l.to} to={l.to} className="text-muted-foreground transition-colors hover:text-foreground">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
