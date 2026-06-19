import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ZkorageClient } from "zkorage-sdk";
import { VerdictMark } from "../StatusBadge";
import {
  getAuditBundle,
  verifyAuditBundle,
  badgeUrl,
  fmtAmount,
  type AuditBundle,
  type AuditChecklist,
  type Bundle,
} from "../api";

const short = (h: string, n = 8) => (h && h.length > 2 * n ? `${h.slice(0, n)}…${h.slice(-n)}` : h);

const CHECKS: { key: keyof AuditChecklist; label: string }[] = [
  { key: "journalWellFormed", label: "Journal is the canonical 61-byte layout" },
  { key: "digestMatches", label: "sha256(journal) recomputed here matches the bundle digest" },
  { key: "imagePinned", label: "Guest image_id equals the policy's on-chain pin" },
  { key: "resultTrue", label: "Journal asserts reserves ≥ supply" },
  { key: "claimTypeOk", label: "Claim type is Proof-of-Reserves (2)" },
  { key: "issuerAllowed", label: "Issuer is in the on-chain allowlist" },
  { key: "notExpired", label: "Attestation is not expired" },
  { key: "proofValidOnChain", label: "Groth16 proof accepted by the public verifier contract" },
  { key: "supplyBoundMatches", label: "Bound supply equals the live token total_supply" },
];

type TrustMode = "public-rpc" | "backend-fallback" | null;

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); });
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

export default function VerifyPage() {
  const { issuer } = useParams();
  const [bundle, setBundle] = useState<AuditBundle | null>(null);
  const [checklist, setChecklist] = useState<AuditChecklist | null>(null);
  const [trust, setTrust] = useState<TrustMode>(null);
  const [recomputed, setRecomputed] = useState<string>("");
  const [liveSupply, setLiveSupply] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [state, setState] = useState<"loading" | "checking" | "done" | "error">("loading");
  const [err, setErr] = useState<string | null>(null);

  const explorer = (kind: "contract", id: string) =>
    `https://stellar.expert/explorer/${bundle?.network ?? "testnet"}/${kind}/${id}`;

  const run = useCallback(async () => {
    setState("loading");
    setErr(null);
    setChecklist(null);
    setTrust(null);
    setNotes([]);
    try {
      const ab = await getAuditBundle(issuer);
      setBundle(ab);
      if (!ab.proof?.journal) {
        setErr("No proof bundle available for this claim yet.");
        setState("error");
        return;
      }
      setState("checking");
      const proof = ab.proof as Bundle;
      // Trustless path: re-verify straight against the public RPC, using the same `zkorage-sdk`
      // a developer or the MCP server would use. The `getConfig` probe surfaces RPC unreachability
      // (e.g. browser CORS) so the backend fallback below actually triggers.
      const z = new ZkorageClient({
        rpcUrl: ab.rpc,
        contracts: { verifier: ab.contracts.verifier, token: ab.contracts.token ?? "", policy: ab.contracts.policy ?? "" },
        apiBaseUrl: "/api",
      });
      try {
        await z.getConfig(); // connectivity probe — throws if the public RPC is unreachable
        const r = await z.verifyBundle(proof);
        setChecklist(r.checklist);
        setRecomputed(r.recomputedDigest);
        setLiveSupply(r.liveSupply);
        setNotes(r.notes);
        setTrust("public-rpc");
      } catch (e) {
        // Fallback: the backend does the same public reads (RPC likely blocked by browser CORS).
        const r = await verifyAuditBundle(proof);
        setChecklist(r.checklist);
        setRecomputed(r.recomputedDigest ?? "");
        setLiveSupply(r.liveSupply ?? null);
        setNotes([...(r.notes ?? []), "public RPC unreachable from the browser: " + String((e as Error).message ?? e)]);
        setTrust("backend-fallback");
      }
      setState("done");
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setState("error");
    }
  }, [issuer]);

  useEffect(() => { run(); }, [run]);

  const verdict = checklist?.verdict ?? false;
  const dj = bundle?.proof?.journal ? bundle.decodedJournal : null;
  const claimIssuer = (dj?.issuerId as string) ?? issuer ?? "";
  const shareLink = typeof window !== "undefined"
    ? `${window.location.origin}/verify${claimIssuer ? `/${claimIssuer}` : ""}`
    : "";
  const embedSnippet = `<a href="${shareLink}"><img src="${typeof window !== "undefined" ? window.location.origin : ""}${badgeUrl(claimIssuer || undefined)}" alt="zkorage Proof-of-Reserves"></a>`;

  return (
    <>
      <p className="sub">
        <b>Verify it yourself.</b> No wallet, no trust in our server. This page recomputes the journal
        hash, checks the image-id pin, and asks the <b>public</b> Soroban contracts to confirm the
        Groth16 proof and the supply binding — exactly the checks anyone can reproduce with the CLI
        commands below. Reserves are never revealed.
      </p>

      <div
        className="card verdict-card"
        data-testid="verify-verdict"
        data-state={state === "done" ? (verdict ? "verified" : "rejected") : state}
      >
        {state === "loading" && <p className="hint">Loading claim…</p>}
        {state === "checking" && <p className="hint">Re-verifying against the chain…</p>}
        {state === "error" && <div className="verdict err"><span className="badge">!</span><span>{err}</span></div>}
        {state === "done" && (
          <>
            <div className={`verdict ${verdict ? "ok" : "err"}`}>
              <span className="badge"><VerdictMark ok={!!verdict} /></span>
              <span>{verdict ? "Reserves ≥ Supply — independently verified on-chain" : "Not verified — a check failed below"}</span>
            </div>
            <div className="trust-note" data-testid="trust-mode">
              {trust === "public-rpc"
                ? `Checked directly against the public RPC (${bundle?.rpc}) — our server was not in the trust path.`
                : `Public RPC was unreachable from this browser, so the checks ran via the zkorage API (it performs the same public reads). For a fully trustless check, run the CLI commands below.`}
            </div>
          </>
        )}
      </div>

      {checklist && (
        <div className="card">
          <h2>Verification checklist</h2>
          <ul className="checklist">
            {CHECKS.map((c) => (
              <li key={c.key} data-testid={`check-${c.key}`} data-ok={checklist[c.key]} className={checklist[c.key] ? "ok" : "bad"}>
                <span className="mark">{checklist[c.key] ? "✓" : "✗"}</span>
                <span>{c.label}</span>
              </li>
            ))}
          </ul>
          {notes.length > 0 && (
            <div className="notes">{notes.map((n, i) => <div key={i} className="note">• {n}</div>)}</div>
          )}
        </div>
      )}

      {dj && bundle && (
        <div className="card">
          <h2>The claim</h2>
          <div className="row"><span className="k">claim</span><span className="v">Proof-of-Reserves</span></div>
          <div className="row"><span className="k">bound supply</span><span className="v" data-testid="bound-supply">{fmtAmount(String(dj.supply ?? "0"), bundle.decimals)} zUSD</span></div>
          {liveSupply && <div className="row"><span className="k">live total_supply</span><span className="v">{fmtAmount(liveSupply, bundle.decimals)} zUSD</span></div>}
          <div className="row"><span className="k">reserves</span><span className="v private">private — never revealed</span></div>
          <div className="row"><span className="k">issuer</span><span className="v">{short(String(dj.issuerId ?? ""))}</span></div>
          <div className="row"><span className="k">image_id</span><span className="v">{short(bundle.canonicalImageId ?? "")}</span></div>
          {recomputed && <div className="row"><span className="k">journal sha256</span><span className="v">{short(recomputed)}</span></div>}
        </div>
      )}

      {bundle && (
        <div className="card">
          <h2>On-chain contracts <span className="demo-note">read them yourself</span></h2>
          <div className="row"><span className="k">policy</span><span className="v"><a href={explorer("contract", bundle.contracts.policy ?? "")} target="_blank" rel="noreferrer">{short(bundle.contracts.policy ?? "")} ↗</a></span></div>
          <div className="row"><span className="k">verifier</span><span className="v"><a href={explorer("contract", bundle.contracts.verifier)} target="_blank" rel="noreferrer">{short(bundle.contracts.verifier)} ↗</a></span></div>
          {bundle.contracts.token && <div className="row"><span className="k">token</span><span className="v"><a href={explorer("contract", bundle.contracts.token)} target="_blank" rel="noreferrer">{short(bundle.contracts.token)} ↗</a></span></div>}
        </div>
      )}

      {bundle?.recipe && (
        <div className="card" data-testid="cli-recipe">
          <h2>Verify it yourself · CLI</h2>
          <p className="hint">Reproduce every check above with the public RPC — no zkorage server involved.</p>
          {[
            { t: "Read the persisted result on-chain", c: bundle.recipe.readLatestOnChain },
            { t: "List the verified-results history", c: bundle.recipe.readHistoryOnChain },
            { t: "Re-verify the Groth16 proof", c: bundle.recipe.reVerifyProof },
          ].map((r, i) => (
            <div className="cli" key={i}>
              <div className="cli-t">{r.t} <Copy text={r.c} /></div>
              <pre>{r.c}</pre>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Share</h2>
        <div className="row"><span className="k">link</span><span className="v">{shareLink} <Copy text={shareLink} /></span></div>
        <div className="badge-embed">
          <img src={badgeUrl(claimIssuer || undefined)} alt="zkorage Proof-of-Reserves badge" data-testid="badge-img" />
        </div>
        <div className="cli"><div className="cli-t">Embed this badge <Copy text={embedSnippet} /></div><pre>{embedSnippet}</pre></div>
        <div className="btnrow"><button className="ghost" onClick={run} data-testid="reverify">Re-verify</button></div>
      </div>
    </>
  );
}
