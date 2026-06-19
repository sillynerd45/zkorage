import { useId } from "react";
import { GLOSSARY } from "@/lib/glossary";

// The "what's this?" affordance (UX terminology report §7.3/§7.4 + progressive disclosure): plain word on
// the surface, the exact gloss one focus/hover away. Accessible: role="tooltip" linked via aria-describedby,
// revealed on hover OR keyboard focus (group-focus-within). display:none by default, so it never affects layout.
export function GlossaryTip({ term, label }: { term: keyof typeof GLOSSARY | string; label?: string }) {
  const id = useId();
  const text = GLOSSARY[term] ?? term;
  return (
    <span className="group relative inline-flex align-baseline">
      <button
        type="button"
        aria-label={`What is ${label ?? term}?`}
        aria-describedby={id}
        className="ml-1 inline-grid h-[15px] w-[15px] cursor-help place-items-center rounded-full border border-border text-[10px] font-semibold leading-none text-muted-foreground hover:border-brand hover:text-brand focus-visible:border-brand focus-visible:text-brand"
      >
        ?
      </button>
      <span
        role="tooltip"
        id={id}
        className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-[60] hidden w-max max-w-[min(260px,78vw)] -translate-x-1/2 rounded-lg border bg-popover px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-popover-foreground shadow-lg group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
}
