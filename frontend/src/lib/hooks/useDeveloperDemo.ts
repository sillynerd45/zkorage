import { useState } from "react";
import type { AuditChecklist, ReservesAnswer } from "zkorage-sdk";
import { sdk } from "@/lib/sdk";

// The Developers docs page dogfoods the SDK: this runs `zkorage-sdk` IN THE BROWSER, straight against the
// public Soroban RPC — the same package the MCP server and any developer uses. Ported from the legacy
// DeveloperPage. The shared `sdk` client reads from the chain; the proof bundle comes via REST.
export const DEV_CHECKS: { key: keyof AuditChecklist; label: string }[] = [
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

export function useDeveloperDemo() {
  const [answer, setAnswer] = useState<ReservesAnswer | null>(null);
  const [checklist, setChecklist] = useState<AuditChecklist | null>(null);
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setState("running");
    setErr(null);
    setAnswer(null);
    setChecklist(null);
    try {
      const a = await sdk.isReservesGteSupply();
      setAnswer(a);
      const audit = await sdk.getAuditBundle();
      if (audit.proof) setChecklist((await sdk.verifyBundle(audit.proof)).checklist);
      setState("done");
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setState("error");
    }
  }

  return { answer, checklist, state, err, run };
}
