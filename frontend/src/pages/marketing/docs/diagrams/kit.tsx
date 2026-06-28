import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared SVG primitives for the documentation flowcharts. Everything reads theme tokens (no hex), so the
// diagrams adapt to light and dark for free. Meaning never rests on color alone: a private/off-chain node
// is a dashed brand outline, a public-chain node is a solid neutral outline, and each carries a one-word
// sublabel plus a text legend (WCAG 1.4.1). Hand-drawn boxes-and-arrows, no image files, no canvas.

export type NodeKind = "private" | "public" | "verified";

// Each diagram is rendered twice: a decorative inline copy (the figcaption + an sr-only step list carry the
// meaning) and a described copy inside the zoom dialog (role="img" + <title>/<desc>). idPrefix keeps the
// arrow-marker ids unique across both instances.
export interface DiagramProps {
  idPrefix: string;
  decorative: boolean;
}

// Node geometry, tuned so a single row of 4 renders near 1:1 in the docs content column.
export const NODE_W = 156;
export const NODE_H = 80;
export const VB_W = 800;
export const VB_H = 128;
const NODE_Y = 24;
const NODE_YC = NODE_Y + NODE_H / 2; // vertical centre, where edges sit
const PITCH = NODE_W + 50;

// Left-x of each node when n nodes are centred across the standard viewBox.
export function colsLeft(n: number): number[] {
  const total = n * NODE_W + (n - 1) * 50;
  const start = (VB_W - total) / 2;
  return Array.from({ length: n }, (_, i) => start + i * PITCH);
}

const NODE_RECT: Record<NodeKind, string> = {
  private: "fill-brand/5 stroke-brand",
  public: "fill-card stroke-muted-foreground",
  verified: "fill-success/5 stroke-success",
};

// One flow box. `title` may be one or two short lines; `sub` is the one-word private/public cue.
export function Node({
  left,
  kind,
  title,
  sub,
  y = NODE_Y,
}: {
  left: number;
  kind: NodeKind;
  title: string | [string, string];
  sub?: string;
  y?: number;
}) {
  const lines = Array.isArray(title) ? title : [title];
  const cx = left + NODE_W / 2;
  let titleY: number[];
  let subY = 0;
  if (sub) {
    if (lines.length === 2) {
      titleY = [y + 30, y + 48];
      subY = y + 66;
    } else {
      titleY = [y + 38];
      subY = y + 58;
    }
  } else {
    titleY = lines.length === 2 ? [y + 36, y + 54] : [y + 46];
  }
  return (
    <g>
      <rect
        x={left}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={12}
        strokeWidth={1.5}
        strokeDasharray={kind === "private" ? "5 4" : undefined}
        className={NODE_RECT[kind]}
      />
      {lines.map((ln, i) => (
        <text
          key={i}
          x={cx}
          y={titleY[i]}
          textAnchor="middle"
          className="fill-foreground"
          fontSize={15}
          fontWeight={600}
        >
          {ln}
        </text>
      ))}
      {sub && (
        <text x={cx} y={subY} textAnchor="middle" className="fill-muted-foreground" fontSize={11.5}>
          {sub}
        </text>
      )}
    </g>
  );
}

// A left-to-right arrow between two adjacent nodes (or any two points).
export function Edge({
  idPrefix,
  from,
  to,
  y = NODE_YC,
  tone = "muted",
}: {
  idPrefix: string;
  from: number; // left-x of the source node
  to: number; // left-x of the target node
  y?: number;
  tone?: "muted" | "brand";
}) {
  return (
    <line
      x1={from + NODE_W}
      y1={y}
      x2={to - 2}
      y2={y}
      strokeWidth={1.75}
      strokeLinecap="round"
      className={tone === "brand" ? "stroke-brand" : "stroke-muted-foreground"}
      markerEnd={`url(#${idPrefix}-arrow-${tone})`}
    />
  );
}

// Arrowhead markers, defined once per SVG instance (unique per idPrefix to avoid id collisions).
function DiagramDefs({ idPrefix }: { idPrefix: string }) {
  return (
    <defs aria-hidden="true">
      {(["muted", "brand"] as const).map((tone) => (
        <marker
          key={tone}
          id={`${idPrefix}-arrow-${tone}`}
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
  );
}

// The <svg> shell + a11y wiring. Decorative copies are aria-hidden; described copies expose title/desc.
export function DiagramSvg({
  idPrefix,
  decorative,
  title,
  desc,
  height = VB_H,
  children,
}: {
  idPrefix: string;
  decorative: boolean;
  title: string;
  desc: string;
  height?: number;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox={`0 0 ${VB_W} ${height}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      className="h-auto"
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-labelledby": `${idPrefix}-t ${idPrefix}-d` })}
    >
      {!decorative && (
        <>
          <title id={`${idPrefix}-t`}>{title}</title>
          <desc id={`${idPrefix}-d`}>{desc}</desc>
        </>
      )}
      <DiagramDefs idPrefix={idPrefix} />
      {children}
    </svg>
  );
}

// HTML legend under the caption, so the words are selectable. Mirrors the node styles as tiny swatches.
function Swatch({ kind }: { kind: NodeKind }) {
  return (
    <svg width="22" height="14" aria-hidden="true" className="shrink-0">
      <rect
        x="1"
        y="1"
        width="20"
        height="12"
        rx="3"
        strokeWidth="1.5"
        strokeDasharray={kind === "private" ? "4 3" : undefined}
        className={NODE_RECT[kind]}
      />
    </svg>
  );
}

export function NodeLegend({ verified = false, className }: { verified?: boolean; className?: string }) {
  return (
    <ul className={cn("mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-[11px] text-muted-foreground", className)}>
      <li className="inline-flex items-center gap-1.5">
        <Swatch kind="private" /> Stays private, off the chain
      </li>
      <li className="inline-flex items-center gap-1.5">
        <Swatch kind="public" /> On the public chain
      </li>
      {verified && (
        <li className="inline-flex items-center gap-1.5">
          <Swatch kind="verified" /> Anyone can verify
        </li>
      )}
    </ul>
  );
}
