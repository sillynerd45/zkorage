import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { VerdictMark } from "../../StatusBadge";
import { GlossaryTip } from "../../components/GlossaryTip";
import { getDataroomInfo } from "../../api";
import { sdk, short, explorer } from "./shared";

// A seeded ~2-minute guided walkthrough to the "aha" (UX research: a guided demo path). It uses the LIVE,
// instant read path against the seeded DR2 grant — no multi-minute proof — so a first-time visitor reaches
// the load-bearing idea (anonymous-but-eligible, one-time) in a couple of minutes, then is handed off to the
// real hands-on flow. These (room, accessor) are the live grant the DR2 acceptance proved (granted, identity
// absent) — the same pair the dataroom-dr2 spec checks.
const DEMO_ROOM = "c1c33201dad189af07b344cc6b20a9a3e6b75601f04344e618d5281cefa46d75";
const GRANTED_ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";

const STEPS = ["The scenario", "Prove you belong", "What the record shows", "Check it yourself"];

export default function GuidedDemoRoute() {
  const [step, setStep] = useState(1);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ granted: boolean; grant: Awaited<ReturnType<typeof sdk.getGrant>> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dataroomId, setDataroomId] = useState<string | null>(null);

  useEffect(() => {
    getDataroomInfo().then((i) => setDataroomId(i.dataroomId ?? null)).catch(() => {});
  }, []);

  async function checkLive() {
    setChecking(true); setErr(null);
    try {
      const [granted, grant] = await Promise.all([
        sdk.isRoomGranted(DEMO_ROOM, GRANTED_ACCESSOR),
        sdk.getGrant(DEMO_ROOM, GRANTED_ACCESSOR),
      ]);
      setResult({ granted, grant });
      setStep(3);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="card" data-testid="demo-card" style={{ borderColor: "var(--violet)" }}>
      <h2>Guided demo <span className="demo-note">~2 minutes · live on-chain · no wallet</span></h2>

      <ol className="stepper" aria-label="demo steps">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const cls = n === step ? "active" : n < step ? "done" : "";
          return (
            <li key={label} className={cls} aria-current={n === step ? "step" : undefined}>
              <span className="num" aria-hidden="true">{n < step ? "✓" : n}</span>
              {n < step && <span className="sr-only">completed: </span>}
              {label}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <div data-testid="demo-step-1">
          <p className="hint" style={{ fontSize: 14, color: "var(--fg)" }}>
            Picture a <b>sealed data room</b> of sensitive documents — a whistleblower drop, an anonymous
            due-diligence room, a sealed-bid auction. To get in, you must prove you're <b>on the approved list</b>.
          </p>
          <p className="hint" style={{ fontSize: 14, color: "var(--fg)" }}>
            But revealing <i>which</i> member you are would burn your cover. A normal login can't help: it always
            learns who you are, and it can let you back in any time. <b>That's the gap only a private proof<GlossaryTip term="private proof" /> closes.</b>
          </p>
          <div className="btnrow"><button onClick={() => setStep(2)} data-testid="demo-next-1">Start →</button></div>
        </div>
      )}

      {step === 2 && (
        <div data-testid="demo-step-2">
          <p className="hint" style={{ fontSize: 14, color: "var(--fg)" }}>
            Here's a <b>real member</b> who proved they belong in the live demo room — anonymously. Let's read
            what the public record actually shows about them. (This is a live, read-only lookup; nothing to sign,
            no wallet.)
          </p>
          <div className="row"><span className="k">Room</span><span className="v">{short(DEMO_ROOM, 8)}</span></div>
          <div className="row"><span className="k">Stand-in ID<GlossaryTip term="stand-in ID" /></span><span className="v">{short(GRANTED_ACCESSOR, 8)}</span></div>
          <div className="btnrow">
            <button onClick={checkLive} disabled={checking} data-testid="demo-check">
              {checking ? "Reading the ledger…" : "Read the live room →"}
            </button>
          </div>
          {err && <p className="err-text" data-testid="demo-error">{err}</p>}
        </div>
      )}

      {step === 3 && result && (
        <div data-testid="demo-step-3">
          <div className={`verdict ${result.granted ? "ok" : "err"}`} data-testid="demo-verdict" data-granted={String(result.granted)}>
            <span className="badge"><VerdictMark ok={result.granted} /></span>
            <span>{result.granted ? "You're in — and the public record shows only a stand-in ID" : "Not in"}</span>
          </div>
          {result.grant && (
            <>
              <div className="row"><span className="k">one-time pass<GlossaryTip term="one-time pass" /></span><span className="v">{short(result.grant.nullifier, 8)}</span></div>
              <div className="row"><span className="k">approved-list fingerprint</span><span className="v">{short(result.grant.eligible_root, 8)}</span></div>
              <div className="row"><span className="k">identity / which member</span><span className="v private" data-testid="demo-identity-absent">absent — the record never reveals who this is</span></div>
            </>
          )}
          <p className="hint" style={{ fontSize: 14, color: "var(--fg)", marginTop: 12 }}>
            That's the whole idea. The room is <b>certain</b> this person belongs — yet has <b>no idea who
            they are</b>. And that <b>one-time pass</b> is the catch a login can't reproduce: the same member
            gets in <b>once</b>. Try to re-enter and the room turns them away.
          </p>
          <div className="btnrow"><button onClick={() => setStep(4)} data-testid="demo-next-3">One more thing →</button></div>
        </div>
      )}

      {step === 4 && (
        <div data-testid="demo-step-4">
          <p className="hint" style={{ fontSize: 14, color: "var(--fg)" }}>
            <b>Don't take our word for any of it.</b> Everything you just saw is on the public record and
            checkable by anyone — <b>no wallet, no account, no trusting our server</b>.
          </p>
          <div className="btnrow" style={{ flexWrap: "wrap" }}>
            {dataroomId && (
              <a className="ghost" style={{ display: "inline-block", padding: "12px 22px", borderRadius: 12, border: "1px solid var(--glass-border)" }} href={explorer("contract", dataroomId)} target="_blank" rel="noreferrer" data-testid="demo-explorer">
                Open the room on the public record ↗
              </a>
            )}
            <Link to="/verify" data-testid="demo-verify">Check a full proof yourself →</Link>
          </div>
          <p className="hint" style={{ marginTop: 14 }}>
            Want to do it for real? <Link to="/dataroom/eligibility" data-testid="demo-handoff">Run the full anonymous-entry flow yourself →</Link> (joins a room
            anonymously, proves you belong, and shows the one-time pass blocking a second entry).
          </p>
          <div className="btnrow"><button className="ghost" onClick={() => { setStep(1); setResult(null); }} data-testid="demo-restart">Restart the tour</button></div>
        </div>
      )}
    </div>
  );
}
