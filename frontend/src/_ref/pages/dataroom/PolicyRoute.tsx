import { useCallback, useEffect, useState } from "react";
import { VerdictMark } from "../../StatusBadge";
import { DEMO_DATAROOM_POLICY, type RoomAccess } from "zkorage-sdk";
import { Disclosure, Hex } from "../../components/Disclosure";
import { GlossaryTip } from "../../components/GlossaryTip";
import { sdk, isHex32 } from "./shared";

// DR6 — private-policy composition + revocation/rotation (the finale). A requester is admitted only by
// satisfying a composite policy (member ∧ KYC ∧ accredited ∧ not-sanctioned), each an independent ZK
// proof bound to one pseudonymous accessor, AND'd on-chain. No new guest — the AND is the cross-call.
export default function PolicyRoute() {
  const [dr6Room, setDr6Room] = useState(DEMO_DATAROOM_POLICY.roomId);
  const [dr6Accessor, setDr6Accessor] = useState(DEMO_DATAROOM_POLICY.accessor);
  const [dr6Access, setDr6Access] = useState<RoomAccess | null>(null);
  const [dr6Epoch, setDr6Epoch] = useState<number | null>(null);
  const [dr6Counts, setDr6Counts] = useState<{ grants: number; admissions: number } | null>(null);
  const [dr6Busy, setDr6Busy] = useState(false);
  const [dr6Err, setDr6Err] = useState<string | null>(null);

  // DR6 — read the live composed admission (per-leg) + the room's grant/admission counts + key epoch,
  // entirely in-browser via the SDK (public RPC). The reads reveal only the pseudonymous accessor.
  const loadAccess = useCallback((room: string, accessor: string) => {
    if (!isHex32(room) || !isHex32(accessor)) { setDr6Access(null); return; }
    sdk.canAccessRoom(room.trim(), accessor.trim()).then(setDr6Access).catch(() => setDr6Access(null));
    sdk.getCommitteeKeyEpoch(DEMO_DATAROOM_POLICY.roomId, DEMO_DATAROOM_POLICY.docId).then(setDr6Epoch).catch(() => setDr6Epoch(null));
    Promise.all([sdk.getGrantCount(room.trim()), sdk.getAdmissionCount(room.trim())])
      .then(([grants, admissions]) => setDr6Counts({ grants, admissions })).catch(() => setDr6Counts(null));
  }, []);

  useEffect(() => {
    loadAccess(DEMO_DATAROOM_POLICY.roomId, DEMO_DATAROOM_POLICY.accessor);
  }, [loadAccess]);

  // DR6 — read the live composed admission for any (room, accessor), entirely in-browser via the SDK.
  async function onCheckAccess() {
    setDr6Busy(true); setDr6Err(null);
    try {
      const room = dr6Room.trim().toLowerCase();
      const accessor = dr6Accessor.trim().toLowerCase();
      if (!isHex32(room) || !isHex32(accessor)) { setDr6Err("Room and accessor must be 32-byte hex."); return; }
      setDr6Access(await sdk.canAccessRoom(room, accessor));
      const [grants, admissions] = await Promise.all([sdk.getGrantCount(room), sdk.getAdmissionCount(room)]);
      setDr6Counts({ grants, admissions });
    } catch (e) {
      setDr6Err(String((e as Error)?.message ?? e)); setDr6Access(null);
    } finally {
      setDr6Busy(false);
    }
  }

  return (
    <div className="card" data-testid="dr6-card" style={{ borderColor: "var(--violet)" }}>
      <h2>Meet all conditions <span className="demo-note">get in only if you meet every condition — anonymously <span aria-hidden="true">🧩</span></span></h2>
      <p className="hint" style={{ marginTop: 0 }}>
        You're let in <b>only if you meet every condition at once</b> — you're a <b>member</b>, <b>ID-checked</b>,
        <b> accredited</b>, and <b>not on a sanctions list</b>. Each is a separate <b>private
        proof</b><GlossaryTip term="private proof" /> tied to one <b>stand-in ID</b><GlossaryTip term="stand-in ID" />,
        and the room checks them all together. Nothing reveals <b>which member</b> you are or any of your details.
        A member can be <b>removed</b> at any time, and the document key <b>rotated</b> so their old parts are useless.
      </p>
      {/* the policy machinery (the on-chain AND + the gate addresses) — demoted behind a "Verify details"
          expander (UX research §12); the plain admission verdict below is what most people need */}
      <Disclosure
        toggleTestId="dr6-engine-details"
        summary={<>The rule checks <b>all conditions at once</b> — member <b>and</b> ID-checked <b>and</b> accredited <b>and</b> not-sanctioned. Expand to see the exact contract each condition is checked against.</>}
      >
        <div className="row"><span className="k">All conditions (checked together)</span><span className="v">member · ID-check · accredited · not-sanctioned</span></div>
        {dr6Access?.policy && (
          <>
            <div className="row"><span className="k">ID-check contract</span><span className="v" data-testid="dr6-compliance-gate">{dr6Access.policy.compliance_gate ? <Hex value={dr6Access.policy.compliance_gate} chars={8} /> : "— (not required)"}</span></div>
            <div className="row"><span className="k">Accredited contract</span><span className="v" data-testid="dr6-accredited-gate">{dr6Access.policy.accredited_gate ? <Hex value={dr6Access.policy.accredited_gate} chars={8} /> : "— (not required)"}</span></div>
          </>
        )}
      </Disclosure>

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>Who gets in <span className="demo-note">read-only · runs in your browser</span></h3>
      <p className="hint" style={{ marginTop: 0 }}>The public record shows only the stand-in ID — never your name, which member you are, or any of your details.</p>
      <div className="controls" style={{ flexWrap: "wrap" }}>
        <label>Room
          <input style={{ minWidth: 280, fontFamily: "monospace", fontSize: 12 }} value={dr6Room} onChange={(e) => setDr6Room(e.target.value)} aria-label="dr6 room" data-testid="dr6-room" />
        </label>
        <label>Stand-in ID
          <input style={{ minWidth: 280, fontFamily: "monospace", fontSize: 12 }} value={dr6Accessor} onChange={(e) => setDr6Accessor(e.target.value)} aria-label="dr6 accessor" data-testid="dr6-accessor" />
        </label>
        <button onClick={onCheckAccess} disabled={dr6Busy} data-testid="dr6-check-btn">{dr6Busy ? "Checking…" : "Check who gets in"}</button>
      </div>

      {dr6Access && (
        <div data-testid="dr6-access" data-admitted={String(dr6Access.admitted)} style={{ marginTop: 10 }}>
          {dr6Access.admitted
            ? <div className="verdict ok" data-testid="dr6-verdict-ok"><span className="badge"><VerdictMark ok /></span><span>ADMITTED — every condition is met, proven anonymously</span></div>
            : <div className="verdict err" data-testid="dr6-verdict-deny"><span className="badge"><VerdictMark ok={false} /></span><span>{dr6Access.revoked ? "DENIED — access was removed" : "DENIED — one of the required checks didn't pass"}</span></div>}
          <div className="row"><span className="k">Member (got in anonymously)</span><span className="v" data-testid="dr6-leg-membership">{dr6Access.membership ? "✓" : "✗"}</span></div>
          <div className="row"><span className="k">ID-checked and not sanctioned</span><span className="v" data-testid="dr6-leg-compliance">{dr6Access.compliance === null ? "— (not required)" : dr6Access.compliance ? "✓" : "✗"}</span></div>
          <div className="row"><span className="k">Accredited investor</span><span className="v" data-testid="dr6-leg-accredited">{dr6Access.accredited === null ? "— (not required)" : dr6Access.accredited ? "✓" : "✗"}</span></div>
          <div className="row"><span className="k">Access removed</span><span className="v" data-testid="dr6-revoked">{dr6Access.revoked ? "yes" : "no"}</span></div>
          <div className="row"><span className="k">Your identity / which member</span><span className="v"><span aria-hidden="true">🔒</span> never revealed</span></div>
        </div>
      )}
      {dr6Err && <p className="err-text" data-testid="dr6-error">{dr6Err}</p>}

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>How fast, how private <span className="demo-note">live on the public record + measured</span></h3>
      <div className="row"><span className="k">Demo room passes / admissions (live)</span><span className="v" data-testid="dr6-counts">{dr6Counts ? `${dr6Counts.grants} pass(es) · ${dr6Counts.admissions} admission(s)` : "…"}</span></div>
      <div className="row"><span className="k">Demo document key version (live)</span><span className="v" data-testid="dr6-epoch">{dr6Epoch === null ? "…" : dr6Epoch}</span></div>
      <div className="row"><span className="k">Proof work per condition</span><span className="v">member 2 · ID-check 2 · accredited 1 (~6–12s each on GPU)</span></div>
      <div className="row"><span className="k">Checking all conditions</span><span className="v">~3 quick reads; no new proof needed to combine them</span></div>
      <div className="row"><span className="k">Privacy</span><span className="v">your name · which member · ID-check subject · accreditation all hidden; the record shows only a stand-in ID + pass/fail flags</span></div>
    </div>
  );
}
