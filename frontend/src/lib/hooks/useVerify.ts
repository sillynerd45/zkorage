import { useCallback, useEffect, useState } from "react";
import { ZkorageClient } from "zkorage-sdk";
import {
  getAuditBundle,
  verifyAuditBundle,
  badgeUrl,
  type AuditBundle,
  type AuditChecklist,
  type Bundle,
} from "@/lib/api";

export type TrustMode = "public-rpc" | "backend-fallback" | null;
export type VerifyState = "loading" | "checking" | "done" | "error";

// The 9 independent checks (carried-over labels). Both variants render this list.
export const CHECKS: { key: keyof AuditChecklist; label: string }[] = [
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

// "Verify it yourself" data layer (extracted from the legacy VerifyPage). Re-checks a proof against the
// public RPC via the same SDK a developer would use, falling back to the backend's public reads if the
// browser can't reach the RPC (CORS).
export function useVerify(issuer?: string) {
  const [bundle, setBundle] = useState<AuditBundle | null>(null);
  const [checklist, setChecklist] = useState<AuditChecklist | null>(null);
  const [trust, setTrust] = useState<TrustMode>(null);
  const [recomputed, setRecomputed] = useState("");
  const [liveSupply, setLiveSupply] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [state, setState] = useState<VerifyState>("loading");
  const [err, setErr] = useState<string | null>(null);

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
      const z = new ZkorageClient({
        rpcUrl: ab.rpc,
        contracts: {
          verifier: ab.contracts.verifier,
          token: ab.contracts.token ?? "",
          policy: ab.contracts.policy ?? "",
        },
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

  useEffect(() => {
    run();
  }, [run]);

  const verdict = checklist?.verdict ?? false;
  const dj = bundle?.proof?.journal ? bundle.decodedJournal : null;
  const claimIssuer = (dj?.issuerId as string) ?? issuer ?? "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const shareLink = `${origin}/verify${claimIssuer ? `/${claimIssuer}` : ""}`;
  const badge = badgeUrl(claimIssuer || undefined);
  const embedSnippet = `<a href="${shareLink}"><img src="${origin}${badge}" alt="zkorage Proof-of-Reserves"></a>`;

  return {
    bundle,
    checklist,
    trust,
    recomputed,
    liveSupply,
    notes,
    state,
    err,
    run,
    verdict,
    dj,
    claimIssuer,
    shareLink,
    embedSnippet,
    badge,
  };
}
