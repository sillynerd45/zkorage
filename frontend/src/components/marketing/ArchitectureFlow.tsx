// The "How zkorage works" architecture diagram (a generated raster). Light + dark versions swap with the
// theme. The image carries its own title and legend; we provide a descriptive alt so screen readers get the
// flow. Only the visible image sits in the accessibility tree (the other is display:none), so both carry the
// same alt without double-announcing.

const ALT =
  "How zkorage works. Your browser encrypts the file with AES-256-GCM and splits its key two-of-three locally. " +
  "The backend stores the encrypted file in Cloudflare R2 and hands three sealed key shares to a two-of-three " +
  "keeper committee. Your browser anchors a tamper-evident record on Soroban, with no key and no contents " +
  "on-chain. A self-hosted RISC Zero prover builds a zero-knowledge proof that you qualify; Soroban verifies " +
  "the Groth16 proof on-chain and records a grant without learning who you are; then two of three keepers " +
  "release sealed key shares so your browser rebuilds the key and decrypts the file.";

export function ArchitectureFlow({ className }: { className?: string }) {
  return (
    <figure className={className}>
      <img
        src="/diagrams/zkorage-architecture-light.png"
        alt={ALT}
        loading="lazy"
        decoding="async"
        className="block w-full rounded-xl border dark:hidden"
      />
      <img
        src="/diagrams/zkorage-architecture-dark.png"
        alt={ALT}
        loading="lazy"
        decoding="async"
        className="hidden w-full rounded-xl border dark:block"
      />
    </figure>
  );
}
