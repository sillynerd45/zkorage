import { cn } from "@/lib/utils";

// The zkorage brand mark: the generated "ZK" monogram (JPG, mark only; the "zkorage" wordmark stays as real
// text next to it). To mirror the old bg-primary tile, which inverted with the theme, we show the dark-surface
// mark (white glyph on near-black) on the LIGHT theme so it reads as a dark tile that pops on the light header,
// and the light-surface mark (navy glyph on white) on the DARK theme. Decorative: the adjacent "zkorage" text
// carries the accessible name, so the images are aria-hidden.
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-7 shrink-0 place-items-center overflow-hidden rounded-md", className)}>
      <img
        src="/brand/zkorage-mark-dark.jpg"
        alt=""
        aria-hidden="true"
        className="size-full object-cover dark:hidden"
      />
      <img
        src="/brand/zkorage-mark-light.jpg"
        alt=""
        aria-hidden="true"
        className="hidden size-full object-cover dark:block"
      />
    </span>
  );
}
