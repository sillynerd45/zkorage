// Meaning-first, action-first plain-language translations of raw contract/prover failures.
// One shared map so every page speaks the same human language (UX research §4 "meaning-first error copy"):
// lead with what happened and what to do, never the raw "#N" code or "Groth16 / guest / journal" jargon.
// `domain` disambiguates codes that mean different things in different contracts (e.g. #10, #11, #12).

export type ErrorDomain =
  | "identity"
  | "compliance"
  | "payroll"
  | "fundraise"
  | "reserves"
  | "dataroom"
  | "generic";

// Codes whose meaning is the SAME across every contract.
const GENERIC: Record<number, string> = {
  3: "This proof came from an unexpected program version. Re-generate it with the current prover.",
  4: "The proof's public summary was malformed. Try generating it again.",
  5: "The proof didn't check out on the public record. Generate a fresh one and try again.",
  6: "The fact you tried to prove isn't true (the condition wasn't met).",
  7: "That's the wrong kind of claim for this check.",
  8: "That signer isn't on this check's approved list.",
  9: "This credential has expired. Get a fresh one from the issuer.",
};

// Codes whose meaning depends on the specific contract.
const PER_DOMAIN: Partial<Record<ErrorDomain, Record<number, string>>> = {
  compliance: {
    11: "This checked an out-of-date sanctions list. Generate a fresh proof against the current one.",
  },
  payroll: {
    11: "That auditor isn't on the approved list for confidential disclosure.",
  },
  reserves: {
    10: "The proven reserves no longer match the current supply on the public record. Re-prove against today's supply.",
  },
  fundraise: {
    10: "The proven revenue floor doesn't match this fundraise's required threshold.",
    11: "No valid revenue proof on file yet. Add a revenue-over-threshold proof first.",
    12: "This investor isn't accredited yet. Add an accredited-investor proof first.",
  },
  dataroom: {
    11: "A room with that name already exists.",
    12: "That room doesn't exist yet. Create it first.",
    13: "Only the room owner can do that.",
    14: "This document is already saved in the room.",
    15: "This invitation has already been used. Each pass works once, so request a new one to enter again.",
    16: "The room's approved list changed since this proof was made. Generate a fresh one.",
    17: "This room isn't open yet. The owner hasn't published its approved list.",
  },
};

// Extract the contract error code NUMERICALLY so `#1` can't be matched inside `#11`.
function codeOf(raw: string): number | null {
  const m = raw.match(/Error\(Contract,\s*#(\d+)\)/) ?? raw.match(/#(\d+)/);
  return m ? Number(m[1]) : null;
}

export function humanError(raw?: string, domain: ErrorDomain = "generic"): string {
  if (!raw) return "Something didn't go through. Please try again.";
  const code = codeOf(raw);
  if (code != null) {
    const perDomain = PER_DOMAIN[domain]?.[code];
    if (perDomain) return perDomain;
    if (GENERIC[code]) return GENERIC[code];
    // Coded but unmapped: never surface a raw "Error(Contract, #N)" line to the user.
    return `That didn't go through (code ${code}). Try generating a fresh proof and submitting again.`;
  }
  // No contract code: surface the first line only (never a multi-line stack).
  return raw.split("\n")[0];
}
