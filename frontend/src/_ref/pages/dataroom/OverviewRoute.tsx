import { Link, useNavigate } from "react-router-dom";
import { GlossaryTip } from "../../components/GlossaryTip";

// Index for /dataroom: lead with plain human meaning (UX research §6 — meet one concept per route), then
// hand off to the marquee with a single "See it work" CTA. The cryptographic machinery lives one click
// deeper, inside each capability route — this page deliberately shows none of it.
const CAPABILITIES: { to: string; title: string; blurb: string; star?: boolean }[] = [
  { to: "/dataroom/eligibility", title: "Get in anonymously", blurb: "Prove you're allowed in without revealing who you are — and only once.", star: true },
  { to: "/dataroom/release", title: "Release the key", blurb: "No single server holds a document's key — it takes 2 of 3 separate keepers to release it, so one can't leak it alone." },
  { to: "/dataroom/disclosure", title: "Share a masked copy", blurb: "Prove a fact about a sealed document, and share a masked copy (private fields blacked out) with an auditor — provably the real file." },
  { to: "/dataroom/policy", title: "Meet all conditions", blurb: "Admit someone only if they meet every condition — member AND ID-checked AND accredited AND not sanctioned — all without revealing who they are." },
  { to: "/dataroom/anchor", title: "Store a document", blurb: "Encrypt a document, keep the file private, and post only a tamper-evident fingerprint to the public record." },
  { to: "/dataroom/authenticity", title: "Prove a signed fact", blurb: "Prove a fact a bank signed for you (e.g. \"balance ≥ X\") without showing the statement or the exact value." },
];

export default function OverviewRoute() {
  const navigate = useNavigate();
  return (
    <div data-testid="dataroom-overview">
      <div className="card">
        <h2>What is a confidential data room?</h2>
        <p className="hint" style={{ maxWidth: 720 }}>
          It's a shared room of <b>encrypted</b> documents. The files themselves never go on the public record —
          only a tamper-evident <b>fingerprint</b><GlossaryTip term="fingerprint" /> of each does, so anyone can
          confirm a document wasn't swapped out, while the contents stay private.
        </p>
        <p className="hint" style={{ maxWidth: 720 }}>
          The hard part is <b>who gets in</b>. Here you prove you're <b>allowed to enter — without revealing
          who you are</b>, and each pass works <b>once</b>. A normal access list can't do that: it always
          learns your identity and can let you back in any time. That's the one thing only a <b>private
          proof</b><GlossaryTip term="private proof" /> can give you, and it's what this room is built around.
        </p>
        <div className="btnrow" style={{ marginTop: 8 }}>
          <button onClick={() => navigate("/dataroom/demo")} data-testid="overview-see-it-work">
            See it work →
          </button>
          <span className="demo-note" style={{ alignSelf: "center" }}>a 2-minute guided tour · no wallet needed</span>
        </div>
        <p className="hint" data-testid="overview-verify-note" style={{ marginTop: 12 }}>
          Don't take our word for it: every result here is <b>checkable by anyone</b>, directly on the
          public record — no wallet, no account. <Link to="/verify">Verify it yourself →</Link>
        </p>
      </div>

      <div className="card">
        <h2>What you can do here</h2>
        <p className="hint">Each capability is its own step — pick one. The starred one is the core idea.</p>
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
          {CAPABILITIES.map((c) => (
            <li key={c.to} style={{ padding: "10px 0", borderTop: "1px solid var(--glass-border)" }}>
              <Link to={c.to} style={{ fontWeight: 600 }}>
                {c.title}{c.star ? <span aria-hidden="true"> ⭐</span> : null}
              </Link>
              <p className="hint" style={{ margin: "3px 0 0" }}>{c.blurb}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
