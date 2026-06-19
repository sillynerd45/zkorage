import { Link } from "react-router-dom";
import { useGuidedDemo, DEMO_ROOM, GRANTED_ACCESSOR, STEPS } from "@/lib/hooks/useGuidedDemo";
import { short, explorer } from "@/lib/format";
import { GlossaryTip } from "@/components/GlossaryTip";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataRow, Verdict } from "@/components/app/blocks";
import { cn } from "@/lib/utils";

// A seeded ~2-minute guided walkthrough to the "aha", driven by the LIVE instant read path against the
// seeded DR2 grant (no multi-minute proof). Presentational only — all state/effects live in useGuidedDemo.
export default function Demo() {
  const d = useGuidedDemo();
  const { step, result } = d;
  return (
    <div className="space-y-5">
      <Card className="rounded-2xl border-brand/40 p-6" data-testid="demo-card">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">Guided demo</h2>
          <span className="text-[11px] uppercase tracking-wide text-brand">~2 minutes · live on-chain · no wallet</span>
        </div>

        <ol className="mb-5 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]" aria-label="demo steps">
          {STEPS.map((label, i) => {
            const n = i + 1;
            const done = n < step;
            const active = n === step;
            return (
              <li
                key={label}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-1.5",
                  active ? "font-semibold text-foreground" : done ? "text-success" : "text-muted-foreground",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-5 place-items-center rounded-full border text-[11px] font-semibold",
                    active
                      ? "border-brand/50 bg-brand/10 text-brand"
                      : done
                        ? "border-success/50 bg-success/10 text-success"
                        : "border-border text-muted-foreground",
                  )}
                >
                  {done ? "✓" : n}
                </span>
                {done && <span className="sr-only">completed: </span>}
                {label}
              </li>
            );
          })}
        </ol>

        {step === 1 && (
          <div data-testid="demo-step-1" className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Picture a <b className="text-foreground">sealed data room</b> of sensitive documents — a whistleblower drop, an anonymous
              due-diligence room, a sealed-bid auction. To get in, you must prove you're <b className="text-foreground">on the approved list</b>.
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              But revealing <i>which</i> member you are would burn your cover. A normal login can't help: it always
              learns who you are, and it can let you back in any time. <b className="text-foreground">That's the gap only a private proof<GlossaryTip term="private proof" /> closes.</b>
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button onClick={() => d.setStep(2)} data-testid="demo-next-1">Start →</Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div data-testid="demo-step-2" className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Here's a <b className="text-foreground">real member</b> who proved they belong in the live demo room — anonymously. Let's read
              what the public record actually shows about them. (This is a live, read-only lookup; nothing to sign,
              no wallet.)
            </p>
            <div className="pt-1">
              <DataRow k="Room">{short(DEMO_ROOM, 8)}</DataRow>
              <DataRow k={<>Stand-in ID<GlossaryTip term="stand-in ID" /></>}>{short(GRANTED_ACCESSOR, 8)}</DataRow>
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button onClick={d.checkLive} disabled={d.checking} data-testid="demo-check">
                {d.checking ? "Reading the ledger…" : "Read the live room →"}
              </Button>
            </div>
            {d.err && <p className="text-sm text-destructive" data-testid="demo-error">{d.err}</p>}
          </div>
        )}

        {step === 3 && result && (
          <div data-testid="demo-step-3" className="space-y-3">
            <div data-testid="demo-verdict" data-granted={String(result.granted)}>
              <Verdict ok={result.granted}>
                {result.granted ? "You're in — and the public record shows only a stand-in ID" : "Not in"}
              </Verdict>
            </div>
            {result.grant && (
              <div className="pt-1">
                <DataRow k={<>one-time pass<GlossaryTip term="one-time pass" /></>}>{short(result.grant.nullifier, 8)}</DataRow>
                <DataRow k="approved-list fingerprint">{short(result.grant.eligible_root, 8)}</DataRow>
                <DataRow k="identity / which member" variant="private" testId="demo-identity-absent">
                  absent — the record never reveals who this is
                </DataRow>
              </div>
            )}
            <p className="text-sm leading-relaxed text-muted-foreground">
              That's the whole idea. The room is <b className="text-foreground">certain</b> this person belongs — yet has <b className="text-foreground">no idea who
              they are</b>. And that <b className="text-foreground">one-time pass</b> is the catch a login can't reproduce: the same member
              gets in <b className="text-foreground">once</b>. Try to re-enter and the room turns them away.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button onClick={() => d.setStep(4)} data-testid="demo-next-3">One more thing →</Button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div data-testid="demo-step-4" className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              <b className="text-foreground">Don't take our word for any of it.</b> Everything you just saw is on the public record and
              checkable by anyone — <b className="text-foreground">no wallet, no account, no trusting our server</b>.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {d.dataroomId && (
                <a
                  className={cn(buttonVariants({ variant: "outline" }))}
                  href={explorer("contract", d.dataroomId)}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="demo-explorer"
                >
                  Open the room on the public record ↗
                </a>
              )}
              <Link to="/verify" className={cn(buttonVariants({ variant: "link" }))} data-testid="demo-verify">
                Check a full proof yourself →
              </Link>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Want to do it for real?{" "}
              <Link to="/app/dataroom/eligibility" className="text-brand hover:underline" data-testid="demo-handoff">
                Run the full anonymous-entry flow yourself →
              </Link>{" "}
              (joins a room
              anonymously, proves you belong, and shows the one-time pass blocking a second entry).
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button variant="ghost" onClick={d.restart} data-testid="demo-restart">Restart the tour</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
