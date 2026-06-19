import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { getDataroomInfo, type DataroomInfoResp } from "../../api";
import { short, explorer } from "./shared";

// Parent layout for the decomposed Data Room: a capability sub-nav + the shared Engine card, with each
// capability rendered one-concept-at-a-time via <Outlet/>. (UX research §6 — meet one concept per route.)
export default function DataRoomLayout() {
  const [info, setInfo] = useState<DataroomInfoResp | null>(null);
  useEffect(() => {
    getDataroomInfo().then(setInfo).catch(() => {});
  }, []);

  return (
    <>
      <p className="sub">
        A <b>confidential data room</b> is a sealed room for sensitive documents. You prove you're
        <b> allowed in without revealing who you are</b>, and files stay encrypted — only people you choose can
        open them. The files never leave your side in the clear; only a tamper-evident fingerprint goes on the
        public record. And every claim here is <b>checkable by anyone</b>, directly on the public record —
        <b> no wallet, no account, no trusting our server</b>. Pick a capability below; each is its own step.
      </p>

      <nav className="subnav" aria-label="Data Room capabilities">
        <NavLink to="/dataroom" end>Overview</NavLink>
        <NavLink to="/dataroom/demo">Guided demo</NavLink>
        <NavLink to="/dataroom/eligibility">Get in anonymously <span aria-hidden="true">⭐</span></NavLink>
        <NavLink to="/dataroom/release">Release the key</NavLink>
        <NavLink to="/dataroom/disclosure">Share a masked copy</NavLink>
        <NavLink to="/dataroom/policy">Meet all conditions</NavLink>
        <NavLink to="/dataroom/anchor">Store a document</NavLink>
        <NavLink to="/dataroom/authenticity">Prove a signed fact</NavLink>
      </nav>

      <div className="card">
        <h2>Engine</h2>
        <div className="row"><span className="k">Network</span><span className="v">testnet</span></div>
        {info?.dataroomId && <div className="row"><span className="k">DataRoom contract</span><span className="v"><a href={explorer("contract", info.dataroomId)} target="_blank" rel="noreferrer">{short(info.dataroomId, 8)} ↗</a></span></div>}
        {info?.config?.verifier && <div className="row"><span className="k">Groth16 verifier</span><span className="v"><a href={explorer("contract", info.config.verifier)} target="_blank" rel="noreferrer">{short(info.config.verifier, 8)} ↗</a></span></div>}
        {info && <div className="row"><span className="k">Blob storage</span><span className="v" data-testid="storage">{info.storage === "r2" ? "Cloudflare R2" : "local stand-in"} · content-addressed</span></div>}
        {info && <div className="row"><span className="k">Rooms</span><span className="v" data-testid="room-count">{info.roomCount}</span></div>}
      </div>

      <Outlet />
    </>
  );
}
