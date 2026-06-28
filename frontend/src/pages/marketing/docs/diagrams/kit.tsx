import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared SVG primitives for the documentation flowcharts. Everything reads theme tokens (no hex), so the
// diagrams adapt to light and dark for free. Meaning never rests on color alone: a private/off-chain node
// is a dashed brand outline, a public-chain node is a solid neutral outline, and each carries a one-word
// sublabel plus a text legend (WCAG 1.4.1). Hand-drawn boxes-and-arrows, no image files, no canvas.

export type NodeKind = "private" | "public";

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
  private: "fill-brand/10 stroke-brand",
  public: "fill-card stroke-muted-foreground",
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
  minWidth,
  children,
}: {
  idPrefix: string;
  decorative: boolean;
  title: string;
  desc: string;
  height?: number;
  // Only the tall sequence diagram passes this, and only on the described (zoom) copy, so the labels never
  // shrink below readable in a narrow dialog (the dialog scrolls instead). The four linear flows never set it.
  minWidth?: number;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox={`0 0 ${VB_W} ${height}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      className="h-auto"
      style={minWidth ? { minWidth } : undefined}
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

export function NodeLegend({ className }: { className?: string }) {
  return (
    <ul className={cn("mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-[11px] text-muted-foreground", className)}>
      <li className="inline-flex items-center gap-1.5">
        <Swatch kind="private" /> Stays private, off the chain
      </li>
      <li className="inline-flex items-center gap-1.5">
        <Swatch kind="public" /> On the public chain
      </li>
    </ul>
  );
}

// ─────────────────────────────── Sequence-diagram primitives ───────────────────────────────
// The store flow is the one diagram rich enough to need actor lifelines + numbered messages instead of a
// single row, so these primitives live alongside (never replace) Node/Edge/colsLeft. They reuse DiagramSvg,
// the idPrefix-scoped arrow markers, and NODE_RECT, so the same meaning-not-color convention holds: an actor
// that keeps data OFF the chain is a dashed-brand box + dashed lifeline; the one ON-chain actor (Soroban) is a
// solid-neutral box + solid lifeline; a return value is a dashed arrow; a wallet-signed step carries a key
// glyph plus the word "sign" in its label (so the cue is never color alone, WCAG 1.4.1).

const LL_W = 96; // actor header width
const LL_H = 42; // actor header height (title + sublabel)
const LL_TOP = 14; // header top y
const LL_HEAD_BOTTOM = LL_TOP + LL_H; // 56, where lifelines start
const SEQ_FIRST_X = 104; // centre-x of the leftmost lifeline (leaves a left rail for phase labels)
const SEQ_LAST_X = 752; //  centre-x of the rightmost lifeline (header right edge lands on 800)

// Centre-x of each of n evenly-spread lifelines across the standard 800-wide viewBox.
export function lifelineCols(n: number): number[] {
  const pitch = n > 1 ? (SEQ_LAST_X - SEQ_FIRST_X) / (n - 1) : 0;
  return Array.from({ length: n }, (_, i) => SEQ_FIRST_X + i * pitch);
}

// One actor: a header box (dashed brand if off-chain, solid neutral if on-chain) over a full-height lifeline.
export function Lifeline({
  x,
  kind,
  title,
  sub,
  bottomY,
}: {
  x: number;
  kind: NodeKind;
  title: string;
  sub?: string;
  bottomY: number;
}) {
  const left = x - LL_W / 2;
  return (
    <g>
      {/* The vertical lifeline carries the off-chain (dashed) vs on-chain (solid) meaning down its full run. */}
      <line
        x1={x}
        y1={LL_HEAD_BOTTOM}
        x2={x}
        y2={bottomY}
        strokeWidth={1.25}
        strokeDasharray={kind === "private" ? "4 6" : undefined}
        className="stroke-muted-foreground/45"
      />
      <rect
        x={left}
        y={LL_TOP}
        width={LL_W}
        height={LL_H}
        rx={10}
        strokeWidth={1.5}
        strokeDasharray={kind === "private" ? "5 4" : undefined}
        className={NODE_RECT[kind]}
      />
      <text x={x} y={LL_TOP + (sub ? 19 : 26)} textAnchor="middle" fontSize={12.5} fontWeight={600} className="fill-foreground">
        {title}
      </text>
      {sub && (
        <text x={x} y={LL_TOP + 33} textAnchor="middle" fontSize={9.5} className="fill-muted-foreground">
          {sub}
        </text>
      )}
    </g>
  );
}

// Numbered order chip, sits on a message near its source. Decorative; the sr-only <ol> is the real ordering.
function StepBadge({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g aria-hidden="true">
      <circle cx={x} cy={y} r={8.5} strokeWidth={1.25} className="fill-card stroke-brand" />
      <text x={x} y={y + 3.5} textAnchor="middle" fontSize={11} fontWeight={700} className="fill-brand">
        {n}
      </text>
    </g>
  );
}

// A tiny key glyph = "this message is wallet-signed". Shape-based (the label also says "sign"), so 1.4.1 holds.
function SignKey({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} aria-hidden="true">
      <circle cx={-3.2} cy={0} r={3.2} className="fill-brand" />
      <circle cx={-3.2} cy={0} r={1.2} className="fill-card" />
      <rect x={-0.4} y={-1} width={6.5} height={2} rx={0.6} className="fill-brand" />
      <rect x={4.7} y={-1} width={1.6} height={3.4} rx={0.4} className="fill-brand" />
    </g>
  );
}

// A numbered message arrow between two lifelines. `variant="return"` draws it dashed (a value coming back);
// `tone="brand"` marks a write to the public chain (or a private signing step). `sign` adds the key glyph.
export function SeqMsg({
  idPrefix,
  n,
  fromX,
  toX,
  y,
  label,
  variant = "call",
  tone = "muted",
  sign = false,
  labelAlign = "center",
}: {
  idPrefix: string;
  n?: number;
  fromX: number;
  toX: number;
  y: number;
  label: string;
  variant?: "call" | "return";
  tone?: "muted" | "brand";
  sign?: boolean;
  // "start" anchors the label at the source end (just past the badge) so a long label on a SHORT arrow does
  // not overhang back across the badge. The sign arrows (short Browser->Wallet hops) use it.
  labelAlign?: "center" | "start";
}) {
  const dir = Math.sign(toX - fromX) || 1;
  const x1 = fromX + dir * 6;
  const x2 = toX - dir * 2;
  const midX = (x1 + x2) / 2;
  const start = labelAlign === "start";
  const labelX = start ? x1 + dir * 24 : midX;
  const labelAnchor = start ? (dir > 0 ? "start" : "end") : "middle";
  // Seat the key glyph on the arrow near the target (the wallet), with a card halo so the line does not strike
  // through it. Reads as "this arrow carries a signature" instead of a glyph floating below the line.
  const keyX = toX - dir * 16;
  return (
    <g>
      <line
        x1={x1}
        y1={y}
        x2={x2}
        y2={y}
        strokeWidth={tone === "brand" ? 2 : 1.75}
        strokeLinecap="round"
        strokeDasharray={variant === "return" ? "5 4" : undefined}
        className={tone === "brand" ? "stroke-brand" : "stroke-muted-foreground"}
        markerEnd={`url(#${idPrefix}-arrow-${tone})`}
      />
      <text
        x={labelX}
        y={y - 8}
        textAnchor={labelAnchor}
        fontSize={variant === "return" ? 11 : 12}
        fontStyle={variant === "return" ? "italic" : undefined}
        fontWeight={variant === "return" ? 400 : 500}
        className={variant === "return" ? "fill-muted-foreground" : "fill-foreground"}
      >
        {label}
      </text>
      {typeof n === "number" && <StepBadge x={x1 + dir * 11} y={y} n={n} />}
      {sign && (
        <g aria-hidden="true">
          <circle cx={keyX} cy={y} r={7} className="fill-card" />
          <SignKey x={keyX} y={y} />
        </g>
      )}
    </g>
  );
}

// A multi-line boxed step anchored over a lifeline: the in-browser dealer (private, dashed brand) or the
// on-chain record (public, solid neutral). `fill-card` masks the lifelines it overlaps so no line strikes
// through the text; the stroke carries the private/public meaning.
export function SeqBox({
  n,
  x,
  y,
  w,
  h,
  kind,
  title,
  lines,
  emphasizeLast = false,
}: {
  n?: number;
  x: number; // left
  y: number; // top
  w: number;
  h: number;
  kind: NodeKind;
  title: string;
  lines: string[];
  emphasizeLast?: boolean;
}) {
  const titleClass = kind === "private" ? "fill-brand" : "fill-muted-foreground";
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        strokeWidth={1.5}
        strokeDasharray={kind === "private" ? "5 4" : undefined}
        className={kind === "private" ? "fill-card stroke-brand" : "fill-card stroke-muted-foreground"}
      />
      {typeof n === "number" && <StepBadge x={x + 1} y={y + 15} n={n} />}
      <text x={x + 16} y={y + 19} fontSize={11} fontWeight={600} className={titleClass}>
        {title}
      </text>
      {lines.map((ln, i) => {
        const last = i === lines.length - 1;
        return (
          <text
            key={i}
            x={x + 16}
            y={y + 39 + i * 18}
            fontSize={11}
            fontWeight={emphasizeLast && last ? 700 : 400}
            className="fill-foreground"
          >
            {ln}
          </text>
        );
      })}
    </g>
  );
}

// A subtle phase band (alternating tint) with a short uppercase label in the left rail. Drawn behind the
// lifelines to group the flow in time without crowding the actors.
export function PhaseBand({ y, h, label, tint }: { y: number; h: number; label: string; tint: boolean }) {
  return (
    <g aria-hidden="true">
      {tint && <rect x={8} y={y} width={784} height={h} className="fill-muted" opacity={0.45} />}
      <line x1={8} y1={y} x2={792} y2={y} strokeWidth={1} className="stroke-muted-foreground/20" />
      <text x={14} y={y + 15} fontSize={9.5} fontWeight={600} letterSpacing="0.04em" className="fill-muted-foreground">
        {label}
      </text>
    </g>
  );
}

// Sequence-flow legend: the two-state node legend plus the return-arrow + wallet-sign cues, in selectable text.
export function SeqLegend({ className }: { className?: string }) {
  return (
    <ul className={cn("mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-[11px] text-muted-foreground", className)}>
      <li className="inline-flex items-center gap-1.5">
        <Swatch kind="private" /> Off the chain, stays private
      </li>
      <li className="inline-flex items-center gap-1.5">
        <Swatch kind="public" /> On the public chain
      </li>
      <li className="inline-flex items-center gap-1.5">
        <svg width="26" height="10" aria-hidden="true" className="shrink-0">
          <line x1="1" y1="5" x2="22" y2="5" strokeWidth="1.5" strokeDasharray="4 3" className="stroke-muted-foreground" />
          <path d="M19 1 L25 5 L19 9 z" className="fill-muted-foreground" />
        </svg>
        Dashed arrow: a value returns
      </li>
      <li className="inline-flex items-center gap-1.5">
        <svg width="14" height="12" aria-hidden="true" className="shrink-0">
          <circle cx="5" cy="5" r="3.2" className="fill-brand" />
          <circle cx="5" cy="5" r="1.2" className="fill-card" />
          <rect x="7.6" y="4" width="5.5" height="2" rx="0.6" className="fill-brand" />
        </svg>
        You sign in your wallet
      </li>
    </ul>
  );
}
