import { useLayoutEffect, useRef } from "react";

interface RevealOptions {
  /** stagger delay in ms (used by grids so cards cascade) */
  delayMs?: number;
  /** fraction visible before revealing (default 0.15) */
  threshold?: number;
  /** px before the viewport edge to start (default "0px 0px -10% 0px") */
  rootMargin?: string;
}

// Scroll reveal. Attach the returned ref to any element. The element renders VISIBLE by default; only when
// IntersectionObserver is available AND motion is allowed do we hide it (in useLayoutEffect, before paint, so
// there is no visible->hidden flash) and then reveal it on scroll-in. If JS, the observer, or motion is off,
// nothing is ever hidden, so content is never stuck. The CSS for the states lives in index.css ([data-reveal]).
export function useReveal<T extends HTMLElement = HTMLDivElement>(opts: RevealOptions = {}) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") return; // stay visible

    if (opts.delayMs) el.style.setProperty("--reveal-delay", `${opts.delayMs}ms`);
    el.dataset.reveal = "hidden"; // hide before first paint (no flash)

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).dataset.reveal = "shown";
            io.unobserve(e.target);
          }
        }
      },
      { threshold: opts.threshold ?? 0.15, rootMargin: opts.rootMargin ?? "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [opts.delayMs, opts.threshold, opts.rootMargin]);

  return ref;
}
