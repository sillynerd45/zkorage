import { useState } from "react";
import { ZkorageClient, type AuditChecklist, type ReservesAnswer } from "zkorage-sdk";
import { VerdictMark } from "../StatusBadge";

// The /developer page dogfoods the SDK: the live demo below runs `zkorage-sdk` IN YOUR BROWSER,
// straight against the public Soroban RPC — the same package the MCP server and any developer uses.
const z = new ZkorageClient({ apiBaseUrl: "/api" }); // reads go to the public RPC; /api only for the proof bundle

const CHECKS: { key: keyof AuditChecklist; label: string }[] = [
  { key: "journalWellFormed", label: "journal well-formed" },
  { key: "digestMatches", label: "digest matches" },
  { key: "imagePinned", label: "image_id pinned" },
  { key: "resultTrue", label: "result = true" },
  { key: "claimTypeOk", label: "claim type ok" },
  { key: "issuerAllowed", label: "issuer allow-listed" },
  { key: "notExpired", label: "not expired" },
  { key: "proofValidOnChain", label: "Groth16 proof valid" },
  { key: "supplyBoundMatches", label: "supply binding holds" },
];

const SDK_SNIPPET = `import { ZkorageClient } from "zkorage-sdk";

const z = new ZkorageClient();                       // testnet defaults baked in, no keys
const a = await z.isReservesGteSupply();             // on-chain-verified answer + freshness
// { answer: true, boundSupply, liveSupply, fresh, result }

const audit = await z.getAuditBundle();              // proof bundle (via REST)
const v = await z.verifyBundle(audit.proof!);        // full Groth16 re-verify vs the public chain
// v.verdict === true, v.checklist = { ...9 checks }`;

const MCP_SNIPPET = `{
  "mcpServers": {
    "zkorage": {
      "command": "node",
      "args": ["<repo>/mcp/dist/server.js"],
      "env": { "ZKORAGE_API_BASE": "http://localhost:8787" }
    }
  }
}
// then ask: "Using zkorage, is the latest issuer's reserves >= supply?"`;

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copy" onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}>
      {done ? "copied" : "copy"}
    </button>
  );
}

export default function DeveloperPage() {
  const [answer, setAnswer] = useState<ReservesAnswer | null>(null);
  const [checklist, setChecklist] = useState<AuditChecklist | null>(null);
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setState("running"); setErr(null); setAnswer(null); setChecklist(null);
    try {
      const a = await z.isReservesGteSupply();
      setAnswer(a);
      const audit = await z.getAuditBundle();
      if (audit.proof) setChecklist((await z.verifyBundle(audit.proof)).checklist);
      setState("done");
    } catch (e) {
      setErr(String((e as Error).message ?? e)); setState("error");
    }
  }

  return (
    <>
      <p className="sub">
        <b>Build on zkorage.</b> A read-only TypeScript SDK and an MCP server let any developer — or any
        AI agent — query and <b>re-verify</b> a claim straight against the public chain, with no keys and
        no trust in our server. The demo below runs the SDK <b>in this browser</b>.
      </p>

      {/* live SDK demo */}
      <div className="card" data-testid="dev-demo">
        <h2>Live SDK demo <span className="demo-note">zkorage-sdk · in-browser · public RPC</span></h2>
        <div className="btnrow">
          <button onClick={run} disabled={state === "running"} data-testid="dev-run">
            {state === "running" ? "Running…" : "Run isReservesGteSupply() + verifyBundle()"}
          </button>
        </div>
        {state === "error" && <p className="err-text">{err}</p>}
        {answer && (
          <div className={`verdict ${answer.answer ? "ok" : "err"}`} data-testid="dev-answer" data-answer={answer.answer}>
            <span className="badge"><VerdictMark ok={!!answer.answer} /></span>
            <span>reserves ≥ supply: <b>{String(answer.answer)}</b>{answer.fresh ? "" : " (supply stale)"}</span>
          </div>
        )}
        {answer && (
          <>
            <div className="row"><span className="k">bound supply</span><span className="v">{answer.boundSupply}</span></div>
            <div className="row"><span className="k">live supply</span><span className="v">{answer.liveSupply}</span></div>
          </>
        )}
        {checklist && (
          <ul className="checklist" data-testid="dev-checklist" style={{ marginTop: 14 }}>
            {CHECKS.map((c) => (
              <li key={c.key} data-testid={`dev-check-${c.key}`} data-ok={checklist[c.key]} className={checklist[c.key] ? "ok" : "bad"}>
                <span className="mark">{checklist[c.key] ? "✓" : "✗"}</span><span>{c.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* SDK quickstart */}
      <div className="card">
        <h2>TypeScript SDK <span className="demo-note">zkorage-sdk</span></h2>
        <p className="hint">Trust-minimized reads + full Groth16 re-verify. Node + browser. No keys.</p>
        <div className="cli"><div className="cli-t">usage <Copy text={SDK_SNIPPET} /></div><pre>{SDK_SNIPPET}</pre></div>
      </div>

      {/* MCP quickstart */}
      <div className="card">
        <h2>MCP server <span className="demo-note">read-only · no key custody</span></h2>
        <p className="hint">Wire the read-only MCP server into Claude Desktop / Claude Code (stdio) and ask it to verify a claim.</p>
        <div className="cli"><div className="cli-t">claude config <Copy text={MCP_SNIPPET} /></div><pre>{MCP_SNIPPET}</pre></div>
      </div>

      {/* REST */}
      <div className="card">
        <h2>REST API</h2>
        <div className="row"><span className="k">OpenAPI spec</span><span className="v"><a href="/api/openapi.yaml" target="_blank" rel="noreferrer">/api/openapi.yaml ↗</a></span></div>
        <div className="row"><span className="k">Swagger UI</span><span className="v">served by the backend at <code>/docs</code></span></div>
      </div>
    </>
  );
}
