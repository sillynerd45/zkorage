// A compact, theme-aware SVG of the zkorage pipeline for the Landing "How it works" section. It shows the
// real data flow behind the three steps: your data goes only to a prover you self-host (it never leaves), the
// proof and a short fingerprint are written to Stellar, and anyone re-checks the public result by reading the
// ledger. Same meaning-not-color convention as the docs diagrams: private/off-chain is a dashed brand outline,
// public is a solid neutral outline. Hand-built SVG, theme tokens (no hex), no animation (reduced-motion safe).

import { useId } from "react";

const VB_W = 820;
const VB_H = 196;
const NY = 18;
const NH = 58;
const MID_Y = NY + NH / 2;

const NODES = {
  you: { x: 14, w: 152, kind: "private" as const, title: "Your data", sub: "stays with you" },
  prover: { x: 224, w: 178, kind: "private" as const, title: "Self-hosted prover", sub: "you run it" },
  stellar: { x: 452, w: 148, kind: "public" as const, title: "Stellar", sub: "public result" },
  anyone: { x: 660, w: 150, kind: "public" as const, title: "Anyone", sub: "re-checks, read-only" },
};

function cx(n: { x: number; w: number }) {
  return n.x + n.w / 2;
}

function FlowNode({ n }: { n: (typeof NODES)[keyof typeof NODES] }) {
  return (
    <g>
      <rect
        x={n.x}
        y={NY}
        width={n.w}
        height={NH}
        rx={12}
        strokeWidth={1.5}
        strokeDasharray={n.kind === "private" ? "5 4" : undefined}
        className={n.kind === "private" ? "fill-brand/10 stroke-brand" : "fill-card stroke-muted-foreground"}
      />
      <text x={cx(n)} y={NY + 25} textAnchor="middle" fontSize={14} fontWeight={600} className="fill-foreground">
        {n.title}
      </text>
      <text x={cx(n)} y={NY + 43} textAnchor="middle" fontSize={11} className="fill-muted-foreground">
        {n.sub}
      </text>
    </g>
  );
}

function Arrow({ idp, from, to, label, tone }: { idp: string; from: number; to: number; label: string; tone: "muted" | "brand" }) {
  return (
    <g>
      <line
        x1={from + 4}
        y1={MID_Y}
        x2={to - 2}
        y2={MID_Y}
        strokeWidth={1.75}
        strokeLinecap="round"
        className={tone === "brand" ? "stroke-brand" : "stroke-muted-foreground"}
        markerEnd={`url(#${idp}-arrow-${tone})`}
      />
      <text x={(from + to) / 2} y={MID_Y - 7} textAnchor="middle" fontSize={11} className="fill-muted-foreground">
        {label}
      </text>
    </g>
  );
}

export function HowItWorksFlow() {
  const uid = useId();
  const yC = cx(NODES.you);
  const sC = cx(NODES.stellar);
  const ctrlX = (yC + sC) / 2;
  return (
    <figure className="rounded-xl border bg-card p-4 sm:p-5">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        className="h-auto"
        role="img"
        aria-labelledby={`${uid}-t ${uid}-d`}
      >
        <title id={`${uid}-t`}>How zkorage works</title>
        <desc id={`${uid}-d`}>
          Your data goes only to a prover you self-host and never leaves it. The prover produces a
          zero-knowledge proof, and a short fingerprint plus the proof result are written to Stellar. Anyone can
          re-check the public result by reading the ledger.
        </desc>
        <defs aria-hidden="true">
          {(["muted", "brand"] as const).map((tone) => (
            <marker
              key={tone}
              id={`${uid}-arrow-${tone}`}
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 z" className={tone === "brand" ? "fill-brand" : "fill-muted-foreground"} />
            </marker>
          ))}
        </defs>

        {/* Anchor: a fingerprint path from You straight to Stellar, dipping below and skipping the prover. Drawn
            thinner + lighter than the data arrows so it reads as a derived public artifact, not a data flow. */}
        <path
          d={`M ${yC} ${NY + NH} Q ${ctrlX} ${VB_H - 8} ${sC} ${NY + NH}`}
          fill="none"
          strokeWidth={1.25}
          strokeLinecap="round"
          className="stroke-muted-foreground/55"
          markerEnd={`url(#${uid}-arrow-muted)`}
        />
        <text x={ctrlX} y={VB_H - 16} textAnchor="middle" fontSize={11.5} className="fill-muted-foreground">
          anchor: a public fingerprint
        </text>

        <FlowNode n={NODES.you} />
        <FlowNode n={NODES.prover} />
        <FlowNode n={NODES.stellar} />
        <FlowNode n={NODES.anyone} />

        <Arrow idp={uid} from={NODES.you.x + NODES.you.w} to={NODES.prover.x} label="your data" tone="brand" />
        <Arrow idp={uid} from={NODES.prover.x + NODES.prover.w} to={NODES.stellar.x} label="proof" tone="brand" />
        <Arrow idp={uid} from={NODES.stellar.x + NODES.stellar.w} to={NODES.anyone.x} label="reads" tone="muted" />
      </svg>
      <figcaption className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
        Your file and the prover stay private (dashed). Only a fingerprint, the proof, and the result are public
        (solid), so anyone can re-check the result by reading the ledger.
      </figcaption>
    </figure>
  );
}
