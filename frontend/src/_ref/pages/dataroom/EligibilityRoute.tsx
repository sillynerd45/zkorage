import { useEffect, useRef, useState } from "react";
import {
  getMembershipInfo,
  getEligible,
  createRoom,
  registerMember,
  setEligibleRoot,
  proveAccess,
  requestAccess,
  getProveStatus,
  type MembershipInfoResp,
  type EligibleResp,
  type Bundle,
} from "../../api";
import { DEMO_DATAROOM } from "zkorage-sdk";
import { ProofStatusBadge, ProveWait, VerdictMark, type ClaimState } from "../../StatusBadge";
import { Disclosure, Hex } from "../../components/Disclosure";
import { GlossaryTip } from "../../components/GlossaryTip";
import { humanError } from "../../errors";
import { sdk, short, isHex32 } from "./shared";

// DR2 — the marquee: anonymous eligibility + nullifier. The load-bearing ZK.
const DR2_DEMO_ROOM = DEMO_DATAROOM.roomId;
const DR2_DEMO_ACCESSOR = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";

export default function EligibilityRoute() {
  const [memInfo, setMemInfo] = useState<MembershipInfoResp | null>(null);
  const [elig, setElig] = useState<EligibleResp | null>(null);
  const [dr2State, setDr2State] = useState<ClaimState>("draft");
  const [dr2Step, setDr2Step] = useState("");
  const [dr2By, setDr2By] = useState<string | null>(null);
  const [dr2Grant, setDr2Grant] = useState<{ accessor: string; nullifier?: string; reused?: boolean } | null>(null);
  const [dr2Err, setDr2Err] = useState<string | null>(null);
  const [dr2Busy, setDr2Busy] = useState(false);
  // read-only status check (in-browser SDK)
  const [statusRoom, setStatusRoom] = useState(DR2_DEMO_ROOM);
  const [statusAccessor, setStatusAccessor] = useState(DR2_DEMO_ACCESSOR);
  const [statusRes, setStatusRes] = useState<{ granted: boolean; grant: Awaited<ReturnType<typeof sdk.getGrant>> } | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  // set true on unmount so the multi-minute DR2 poll loop stops awaiting + stops setState-ing.
  const dr2Cancel = useRef(false);

  useEffect(() => {
    getMembershipInfo().then(setMemInfo).catch(() => {});
    getEligible(DR2_DEMO_ROOM).then(setElig).catch(() => {});
    return () => { dr2Cancel.current = true; };
  }, []);

  // DR2 — the full anonymous-eligibility ZK flow (the marquee). Mints an identity into a FRESH room's
  // eligible set (anonymity set of 2), pins the root, proves membership worker-first, and request_access
  // grants the pseudonymous accessor — then re-submitting the SAME proof is rejected #NullifierUsed.
  async function onRequestAccess() {
    setDr2Busy(true); setDr2Err(null); setDr2Grant(null); setDr2By(null); setDr2State("proving");
    const room = `zkorage-dr2-demo-${Math.random().toString(16).slice(2, 10)}`;
    try {
      dr2Cancel.current = false;
      setDr2Step("Creating a fresh room + eligible set…");
      await createRoom(room);
      const me = await registerMember(room, true);            // mint MY identity
      await registerMember(room, true);                       // a 2nd member → anonymity set of 2
      if (!me.minted) throw new Error("register did not mint an identity");
      setDr2Step("Pinning the eligible-set Merkle root on-chain…");
      const sr = await setEligibleRoot(room);
      if (!sr.ok) throw new Error(sr.error || "set-root failed");
      setDr2Step("Proving membership (sha256-Merkle + nullifier + holder sig) — worker-first, a few minutes…");
      const pa = await proveAccess(room, me.minted.idSecret, me.minted.idTrapdoor, me.minted.holderSeed);
      if (!pa.jobId) throw new Error(pa.error || "prove-access failed");
      // poll for the proof
      let bundle: Bundle | null = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 12 * 60 * 1000) {
        if (dr2Cancel.current) return; // component unmounted — stop polling + stop setState
        const s = await getProveStatus(pa.jobId);
        setDr2By(s.by ?? null);
        if (s.status === "done" && s.bundle) { bundle = s.bundle; break; }
        if (s.status === "error") throw new Error(s.error || "proving failed");
        await new Promise((r) => setTimeout(r, 4000));
      }
      if (!bundle) throw new Error("proof timed out");
      setDr2State("verifying"); setDr2Step("Submitting the proof — request_access…");
      const ra = await requestAccess(bundle);
      if (!ra.ok) throw new Error(ra.error || "request_access rejected");
      setDr2Grant({ accessor: pa.accessor, nullifier: pa.nullifier });
      setDr2State("verified");
      // The marquee: re-submitting the SAME proof (same nullifier) must be rejected #NullifierUsed.
      setDr2Step("Re-submitting the same proof to demonstrate the nullifier…");
      const ra2 = await requestAccess(bundle);
      setDr2Grant({ accessor: pa.accessor, nullifier: pa.nullifier, reused: ra2.ok === false && /#15|NullifierUsed/.test(ra2.error || "") });
    } catch (e) {
      setDr2Err(String((e as Error).message ?? e)); setDr2State("failed");
    } finally { setDr2Busy(false); setDr2Step(""); }
  }

  // DR2 — read-only status check (entirely in-browser via the SDK): is this accessor granted, and what is
  // its (pseudonymous) on-chain grant record? Reveals NO identity.
  async function onCheckStatus() {
    setStatusErr(null); setStatusRes(null);
    if (!isHex32(statusRoom) || !isHex32(statusAccessor)) { setStatusErr("room and accessor must each be 32-byte hex"); return; }
    setStatusBusy(true);
    try {
      const [granted, grant] = await Promise.all([
        sdk.isRoomGranted(statusRoom.trim(), statusAccessor.trim()),
        sdk.getGrant(statusRoom.trim(), statusAccessor.trim()),
      ]);
      setStatusRes({ granted, grant });
    } catch (e) {
      setStatusErr(String((e as Error).message ?? e));
    } finally { setStatusBusy(false); }
  }

  return (
    <div className="card" data-testid="dr2-card" style={{ borderColor: "var(--violet)" }}>
      <h2>Get in anonymously <span className="demo-note">the core idea <span aria-hidden="true">⭐</span></span></h2>
      <p className="hint">
        You get into a room <b>only by proving you're on its approved list</b> — <b>without showing which
        member you are</b>, and <b>only once per room</b> (a <b>one-time pass</b><GlossaryTip term="one-time pass" /> stops
        the same member entering twice). A normal access list can't do this: it always learns who you are and
        can let you back in any time. That's the one thing only a <b>private proof</b><GlossaryTip term="private proof" /> can
        give you. The public record shows neither your name nor which member you are — though the
        <b>time you enter is still recorded</b> on it.
      </p>

      {/* engine machinery — demoted behind a "Verify details" expander (UX research §12: lead with meaning) */}
      <Disclosure
        toggleTestId="dr2-engine-details"
        summary={<>The cryptographic engine — the <b>pinned proving program</b>, this room's <b>approved-list fingerprint</b>, and the proof internals. You don't need these to use the room; expand to check them yourself.</>}
      >
        <div className="row"><span className="k">Proving program (pinned)</span><span className="v" data-testid="dr2-image">{memInfo?.membershipImageOnchain ? <Hex value={memInfo.membershipImageOnchain} chars={8} /> : "—"}{memInfo && memInfo.membershipImageOnchain === memInfo.membershipImageId ? " ✓" : ""}</span></div>
        <div className="row"><span className="k">claim type</span><span className="v">{memInfo?.claimType ?? "—"} · tree depth {memInfo?.treeDepth ?? "—"}</span></div>
        <div className="row"><span className="k">Approved-list fingerprint</span><span className="v" data-testid="dr2-root">{elig?.pinnedRoot ? <Hex value={elig.pinnedRoot} chars={8} /> : "—"}</span></div>
        <div className="row"><span className="k">Demo room approved list</span><span className="v" data-testid="dr2-grants">{elig?.memberCount != null ? `${elig.memberCount} member(s)${elig.inSync ? " · in sync ✓" : ""}` : "—"}</span></div>
        <p className="hint" style={{ margin: "6px 0 0" }}>Proof internals: a depth-20 SHA-256 Merkle membership proof + a per-room nullifier (the one-time pass) + an in-prover holder signature.</p>
      </Disclosure>

      {/* request anonymous access — the full ZK flow */}
      <div className="btnrow" style={{ marginTop: 14 }}>
        <button onClick={onRequestAccess} disabled={dr2Busy} data-testid="dr2-request">
          {dr2Busy ? "Working…" : "Request anonymous access"}
        </button>
        <ProofStatusBadge state={dr2State} />
      </div>
      <p className="hint">Joins a fresh room anonymously, proves you belong (a few minutes), and gets you in — then shows the same proof can't be reused to enter again.</p>
      {dr2Busy && dr2Step && <p className="hint" data-testid="dr2-step">{dr2Step}</p>}
      <ProveWait state={dr2State} proveBy={dr2By} privacy="Your identity — and which member you are — never leaves your browser; only the anonymous proof goes on-chain." />
      {dr2Grant && (
        <div data-testid="dr2-verdict" style={{ marginTop: 8 }}>
          <div className="verdict ok"><span className="badge"><VerdictMark ok /></span><span>You're in — anonymously (the public record shows only a stand-in ID, not your name)</span></div>
          <div className="row"><span className="k">your stand-in ID</span><span className="v" data-testid="dr2-accessor">{short(dr2Grant.accessor, 8)}</span></div>
          <div className="row"><span className="k">one-time pass (used)</span><span className="v">{short(dr2Grant.nullifier ?? "", 8)}</span></div>
          <div className="row"><span className="k">your identity</span><span className="v private">hidden — the proof never shows which member you are</span></div>
          {dr2Grant.reused !== undefined && (
            <div className="row"><span className="k">re-entry with the same pass</span><span className="v" data-testid="dr2-reuse">{dr2Grant.reused ? "blocked — this pass was already used (one entry per room)" : "⚠ not blocked — unexpected"}</span></div>
          )}
        </div>
      )}
      {dr2Err && <p className="err-text" data-testid="dr2-error">{humanError(dr2Err, "dataroom")}</p>}

      {/* read-only status check — in-browser via the SDK */}
      <h3 style={{ marginTop: 18, marginBottom: 6 }}>Check who's in <span className="demo-note">read-only · runs in your browser</span></h3>
      <div className="btnrow" style={{ flexWrap: "wrap" }}>
        <label className="fld" style={{ margin: 0 }}>room</label>
        <input style={{ minWidth: 300, fontFamily: "monospace", fontSize: 12 }} value={statusRoom} onChange={(e) => setStatusRoom(e.target.value)} aria-label="status room" data-testid="dr2-status-room" />
        <label className="fld" style={{ margin: 0 }}>stand-in ID</label>
        <input style={{ minWidth: 300, fontFamily: "monospace", fontSize: 12 }} value={statusAccessor} onChange={(e) => setStatusAccessor(e.target.value)} aria-label="status accessor" data-testid="dr2-status-accessor" />
        <button onClick={onCheckStatus} disabled={statusBusy} data-testid="dr2-status-btn">{statusBusy ? "Checking…" : "Check access"}</button>
      </div>
      {statusRes && (
        <div data-testid="dr2-status-result" data-granted={String(statusRes.granted)} style={{ marginTop: 8 }}>
          <div className={`verdict ${statusRes.granted ? "ok" : "err"}`}>
            <span className="badge"><VerdictMark ok={statusRes.granted} /></span>
            <span>{statusRes.granted ? "In — this stand-in ID has a currently-valid pass" : "Not in this room"}</span>
          </div>
          {statusRes.grant && (
            <>
              <div className="row"><span className="k">one-time pass</span><span className="v">{short(statusRes.grant.nullifier, 8)}</span></div>
              <div className="row"><span className="k">approved-list fingerprint</span><span className="v">{short(statusRes.grant.eligible_root, 8)}</span></div>
              <div className="row"><span className="k">identity</span><span className="v private">absent — the record shows only a stand-in ID</span></div>
            </>
          )}
        </div>
      )}
      {statusErr && <p className="err-text" data-testid="dr2-status-error">{statusErr}</p>}
    </div>
  );
}
