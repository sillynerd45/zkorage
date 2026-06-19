import { Link, useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { DATAROOM_TABS } from "@/lib/content";
import { GlossaryTip } from "@/components/GlossaryTip";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/app/blocks";

export default function DataRoomOverview() {
  const navigate = useNavigate();
  const caps = DATAROOM_TABS.filter((t) => t.slug && t.slug !== "demo");
  return (
    <div data-testid="dataroom-overview" className="space-y-5">
      <Panel title="What is a confidential data room?">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          It's a shared room of <b className="text-foreground">encrypted</b> documents. The files themselves
          never go on the public record — only a tamper-evident{" "}
          <b className="text-foreground">fingerprint</b>
          <GlossaryTip term="fingerprint" /> of each does, so anyone can confirm a document wasn't swapped
          out, while the contents stay private.
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The hard part is <b className="text-foreground">who gets in</b>. Here you prove you're{" "}
          <b className="text-foreground">allowed to enter — without revealing who you are</b>, and each pass
          works <b className="text-foreground">once</b>. That's the one thing only a{" "}
          <b className="text-foreground">private proof</b>
          <GlossaryTip term="private proof" /> can give you, and it's what this room is built around.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => navigate("/app/dataroom/demo")} data-testid="overview-see-it-work">
            See it work →
          </Button>
          <span className="text-xs text-muted-foreground">a 2-minute guided tour · no wallet needed</span>
        </div>
        <p className="mt-4 text-sm text-muted-foreground" data-testid="overview-verify-note">
          Don't take our word for it: every result here is <b className="text-foreground">checkable by
          anyone</b>, directly on the public record — no wallet, no account.{" "}
          <Link to="/verify" className="text-brand hover:underline">
            Verify it yourself →
          </Link>
        </p>
      </Panel>

      <div>
        <h2 className="mb-1 text-lg font-semibold tracking-tight">What you can do here</h2>
        <p className="mb-3 text-sm text-muted-foreground">Each capability is its own step. The starred one is the core idea.</p>
        <div className="grid gap-2.5">
          {caps.map((t) => (
            <Link key={t.slug} to={`/app/dataroom/${t.slug}`} className="group block focus-visible:outline-none">
              <div className="flex items-start gap-3 rounded-2xl border bg-card p-4 transition-colors hover:border-brand/30 hover:bg-accent/40 group-focus-visible:ring-2 group-focus-visible:ring-ring">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <h3 className="font-semibold tracking-tight">{t.label}</h3>
                    {t.star && <span aria-hidden="true">⭐</span>}
                  </div>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{t.blurb}</p>
                </div>
                <ChevronRight className="size-5 shrink-0 self-center text-muted-foreground transition-colors group-hover:text-brand" />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
