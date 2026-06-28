import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { BadgeCheck, KeyRound, FolderLock, Landmark, Compass, ArrowRight } from "lucide-react";
import { getRoomMeta } from "@/lib/api";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { detectVerifyTarget } from "@/lib/verify/detect";
import { PageHeader, SectionCard } from "@/components/marketing/blocks";

// A working Proof-of-Reserves issuer on testnet, used as the "try one" example so a first-time visitor can see
// a real re-check without hunting for an id.
const EXAMPLE_ISSUER = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";

const KINDS = [
  {
    icon: KeyRound,
    title: "A bonded access grant",
    body: "Paste a bonded access verify link. We ask the public bond gate whether an anonymous handle holds a qualifying bond right now. The wallet behind it is never shown.",
  },
  {
    icon: FolderLock,
    title: "A Data Room",
    body: "Paste a room id (64 hex). We confirm the room exists on the public Data Room contract and show how readers get in. The documents stay encrypted.",
  },
  {
    icon: Landmark,
    title: "A Proof-of-Reserves",
    body: "Paste an issuer id. We recompute the journal, re-check the Groth16 proof on-chain, and confirm reserves cover the circulating supply. The reserve figure stays private.",
  },
];

export default function VerifyHome() {
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const ranQ = useRef(false);

  const run = useCallback(
    (raw: string) => {
      const t = detectVerifyTarget(raw);
      if (t.kind === "unknown") {
        setError("That does not look like a zkorage verify link or id. Paste a verify link, a room id, or an issuer id.");
        return;
      }
      setError(null);
      if (t.kind === "bond") return navigate(`/verify/bond${t.search}`);
      if (t.kind === "reserves") return navigate(`/verify/${t.issuer}`);
      if (t.kind === "room") return navigate(`/verify/room/${t.roomId}`);
      // Ambiguous bare hex (a room id and a reserves issuer share the 64-hex shape): probe the public room
      // first; if there is no such room, fall back to a reserves issuer.
      setProbing(true);
      getRoomMeta(t.id)
        .then((m) => navigate(m && (m.discoverable || m.exists) ? `/verify/room/${t.id}` : `/verify/${t.id}`))
        .catch(() => navigate(`/verify/${t.id}`))
        .finally(() => setProbing(false));
    },
    [navigate],
  );

  // A handoff link (e.g. the landing "Don't trust. Verify." box) forwards the pasted value as ?q=; run it once.
  useEffect(() => {
    const q = sp.get("q");
    if (q && !ranQ.current) {
      ranQ.current = true;
      setValue(q);
      run(q);
    }
  }, [sp, run]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    run(value);
  }

  return (
    <>
      <PageHeader
        eyebrow="Verify & explore"
        title="Verify it yourself"
        lead={
          <>
            <b>No wallet, and no need to trust our server.</b> Paste a verify link or an id, and zkorage
            re-checks it against the public Soroban contracts. Anyone can reproduce the same read. The data
            behind a claim is never revealed.
          </>
        }
      />

      <SectionCard>
        <form onSubmit={onSubmit}>
          <label htmlFor="verify-input" className="text-sm font-medium text-foreground">
            Paste a verify link or an id
          </label>
          <p id="verify-input-hint" className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A bonded access link, a Data Room id, or a Proof-of-Reserves issuer id.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              id="verify-input"
              data-testid="verify-input"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              aria-describedby="verify-input-hint"
              aria-invalid={error ? true : undefined}
              placeholder="https://zkorage.wazowsky.id/verify/bond?… or a 64-hex id"
              spellCheck={false}
              autoComplete="off"
              className="h-10 w-full rounded-md border border-input bg-card px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="submit"
              disabled={probing}
              data-testid="verify-submit"
              className={cn(
                buttonVariants({ variant: "brand" }),
                "shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
              )}
            >
              <BadgeCheck className="size-4" /> {probing ? "Checking…" : "Verify"}
            </button>
          </div>
          {error && (
            <p data-testid="verify-input-error" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-sm">
          <span className="text-muted-foreground">Try one:</span>
          <button
            type="button"
            data-testid="verify-example-reserves"
            onClick={() => {
              setValue(EXAMPLE_ISSUER);
              run(EXAMPLE_ISSUER);
            }}
            className="rounded-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            A live Proof-of-Reserves
          </button>
          <Link
            to="/explorer"
            className="inline-flex items-center gap-1 rounded-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Compass className="size-3.5" /> Browse public rooms
          </Link>
        </div>
      </SectionCard>

      <SectionCard label="What you can verify">
        <ul className="space-y-4">
          {KINDS.map((k) => (
            <li key={k.title} className="flex items-start gap-3">
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
                <k.icon className="size-[18px]" />
              </span>
              <div>
                <p className="text-sm font-medium text-foreground">{k.title}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{k.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 border-t pt-3 text-sm text-muted-foreground">
          Looking for the full list of published results?{" "}
          <Link
            to="/explorer"
            className="inline-flex items-center gap-1 rounded-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open the Explorer <ArrowRight className="size-3.5" />
          </Link>
        </p>
      </SectionCard>
    </>
  );
}
