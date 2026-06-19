import { useState, useEffect } from "react";
import { getDataroomInfo } from "@/lib/api";
import { sdk } from "@/lib/sdk";

// A seeded ~2-minute guided walkthrough to the "aha" (UX research: a guided demo path). It uses the LIVE,
// instant read path against the seeded DR2 grant (no multi-minute proof), so a first-time visitor reaches
// the load-bearing idea (anonymous-but-eligible, one-time) in a couple of minutes, then is handed off to the
// real hands-on flow. These (room, accessor) are the live grant the DR2 acceptance proved (granted, identity
// absent), the same pair the dataroom-dr2 spec checks.
export const DEMO_ROOM = "c1c33201dad189af07b344cc6b20a9a3e6b75601f04344e618d5281cefa46d75";
export const GRANTED_ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";

export const STEPS = ["The scenario", "Prove you belong", "What the record shows", "Check it yourself"];

export function useGuidedDemo() {
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

  function restart() {
    setStep(1);
    setResult(null);
  }

  return {
    step,
    setStep,
    checking,
    result,
    err,
    dataroomId,
    checkLive,
    restart,
  };
}
