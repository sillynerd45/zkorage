import type { ElementType, ReactNode } from "react";
import { useReveal } from "@/lib/hooks/useReveal";

// Thin wrapper around useReveal: <Reveal as="section" index={i}>…</Reveal>. `index` staggers a grid's cards
// (index * 80ms). Content is visible by default (see useReveal), so this is safe under reduced-motion / no-JS.
export function Reveal({
  as: Tag = "div",
  index = 0,
  step = 80,
  className,
  children,
  ...rest
}: {
  as?: ElementType;
  index?: number;
  step?: number;
  className?: string;
  children: ReactNode;
  [k: string]: unknown;
}) {
  const ref = useReveal<HTMLElement>({ delayMs: index * step });
  return (
    <Tag ref={ref} className={className} {...rest}>
      {children}
    </Tag>
  );
}
