// zkorage Confidential Data Room — DR5 field-level disclosure policy + redaction.
//
// The data owner / custodian redacts (as in FOIA: the producing agency redacts; M&A: the seller redacts
// before sharing with bidders; HIPAA: the covered entity de-identifies). zkorage's "the prover sees
// plaintext" principle already puts redaction owner-side. "Which fields get redacted" follows a field-level
// **disclosure policy** — the programmable analog of established standards:
//   • HIPAA Safe Harbor §164.514(b)(2) — strip the 18 identifiers; coarsen dates to the year.
//   • PCI-DSS Req 3.4 — mask the PAN (show only the last 4).
//   • FOIA 5 U.S.C. §552(b) — per-field exemption codes + a redaction log accompanying the production.
//   • GDPR Art. 5(1)(c) — data minimization (disclose only what the purpose needs).
//
// A structured document (named fields) + a policy that tags each field by disclosure tier:
//   "public"  → may appear in the public teaser AND the auditor view.
//   "auditor" → disclosed to the allowlisted auditor (in the redacted view); hidden from the public.
//   "private" → never disclosed; MASKED in the redacted view (PCI/HIPAA-style) per a mask rule.
//
// DR5 stays integrity-faithful only (no new guest): the auditor is cryptographically certain they received
// the exact redacted bytes the owner committed to (the seal guest's faithful tag + the on-chain
// content_hash). The redaction-*correctness* (`redacted = applyPolicy(original)`) is owner-asserted — that
// honest gap is the documented boundary; closing it would need a new redaction-proving guest (deferred).

export type Tier = "public" | "auditor" | "private";

/** How a `private` field is masked in the redacted view. */
export type MaskRule =
  | "drop" // omit the field entirely (GDPR data minimization)
  | "last4" // PCI PAN masking: keep the last 4 chars, prefix "****"
  | "year" // HIPAA date coarsening: a YYYY-MM-DD date → "YYYY"
  | "redact"; // replace with "[REDACTED]" (FOIA-style)

export interface FieldPolicy {
  tier: Tier;
  /** Required when tier === "private"; ignored otherwise. Defaults to "redact". */
  mask?: MaskRule;
}

export type DisclosurePolicy = Record<string, FieldPolicy>;
export type StructuredDoc = Record<string, string | number | boolean>;

export interface RedactionLogEntry {
  field: string;
  tier: Tier;
  mask: MaskRule;
  /** The standard the mask aligns with (for the human-readable redaction log). */
  basis: string;
}

export interface RedactedDisclosure {
  /** The redacted document the auditor receives: public + auditor fields intact, private fields masked. */
  view: StructuredDoc;
  /** A FOIA-style redaction log: every private field, its tier, mask rule, and the standard basis. */
  log: RedactionLogEntry[];
}

const MASK_BASIS: Record<MaskRule, string> = {
  drop: "GDPR Art. 5(1)(c) data minimization — field omitted",
  last4: "PCI-DSS Req 3.4 — PAN masked to last 4",
  year: "HIPAA Safe Harbor §164.514(b)(2) — date coarsened to year",
  redact: "FOIA 5 U.S.C. §552(b) — value redacted",
};

/** Apply a single mask rule to a field value, returning the masked value (or `undefined` to drop it). */
function applyMask(value: string | number | boolean, mask: MaskRule): string | undefined {
  const s = String(value);
  switch (mask) {
    case "drop":
      return undefined;
    case "last4":
      return s.length <= 4 ? "****" : "****" + s.slice(-4);
    case "year": {
      const m = /^(\d{4})\b/.exec(s);
      return m ? m[1] : "[REDACTED]"; // not a recognizable date → redact rather than leak
    }
    case "redact":
    default:
      return "[REDACTED]";
  }
}

/**
 * Redact a structured document per the disclosure policy → the auditor's view. `public` and `auditor`
 * fields are kept verbatim; `private` fields are masked (PCI/HIPAA/GDPR-style) and recorded in the
 * redaction log. A field absent from the policy is treated as `private`/`redact` (fail-closed — an
 * unclassified field is never leaked). Pure; deterministic; no I/O.
 */
export function redact(doc: StructuredDoc, policy: DisclosurePolicy): RedactedDisclosure {
  const view: StructuredDoc = {};
  const log: RedactionLogEntry[] = [];
  for (const key of Object.keys(doc)) {
    const fp: FieldPolicy = policy[key] ?? { tier: "private", mask: "redact" };
    if (fp.tier === "public" || fp.tier === "auditor") {
      view[key] = doc[key];
      continue;
    }
    // private → mask.
    const mask: MaskRule = fp.mask ?? "redact";
    const masked = applyMask(doc[key], mask);
    if (masked !== undefined) view[key] = masked;
    log.push({ field: key, tier: "private", mask, basis: MASK_BASIS[mask] });
  }
  return { view, log };
}

/** The PUBLIC projection — only `public` fields. What a no-access counterparty may see alongside a teaser. */
export function publicView(doc: StructuredDoc, policy: DisclosurePolicy): StructuredDoc {
  const out: StructuredDoc = {};
  for (const key of Object.keys(doc)) {
    if (policy[key]?.tier === "public") out[key] = doc[key];
  }
  return out;
}

/**
 * The teaser figure — a designated `public` numeric field (e.g. `annual_revenue_usd`). The appraiser signs
 * `value = this figure`, and the teaser proves `figure ≥ threshold` without revealing it. Throws if the
 * field is missing, not numeric, or not classified `public` (a teaser must be about a publicly-teasable
 * figure, not a private one).
 */
export function teaserFigure(doc: StructuredDoc, policy: DisclosurePolicy, field: string): bigint {
  if (policy[field]?.tier !== "public") {
    throw new Error(`teaser field "${field}" must be classified public`);
  }
  const v = doc[field];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
    throw new Error(`teaser field "${field}" must be a non-negative integer, got ${String(v)}`);
  }
  return BigInt(v);
}

// ── Demo fixtures: a confidential financial statement + a standards-aligned default policy ──

/** A demo confidential financial statement (the "document" a startup puts in the data room). */
export const DEMO_FINANCIAL_DOC: StructuredDoc = {
  company: "Stellar Aurora Labs, Inc.",
  fiscal_year: 2025,
  annual_revenue_usd: 4_250_000, // the public teaser figure
  auditor_firm: "Nimbus & Co. CPAs",
  gross_margin_pct: 62,
  net_income_usd: 880_000,
  cash_usd: 3_100_000,
  bank_account: "4012888888881881",
  routing_number: "021000021",
  ceo_ssn: "123-45-6789",
  signed_date: "2026-03-14",
};

/**
 * The default disclosure policy for the demo statement — public headline + appraiser, auditor-tier
 * financials, and private identifiers masked per HIPAA/PCI/GDPR. The owner can override any tier.
 */
export const DEMO_FINANCIAL_POLICY: DisclosurePolicy = {
  company: { tier: "public" },
  fiscal_year: { tier: "public" },
  annual_revenue_usd: { tier: "public" }, // teaser figure
  auditor_firm: { tier: "public" },
  gross_margin_pct: { tier: "auditor" },
  net_income_usd: { tier: "auditor" },
  cash_usd: { tier: "auditor" },
  bank_account: { tier: "private", mask: "last4" }, // PCI
  routing_number: { tier: "private", mask: "drop" }, // data minimization
  ceo_ssn: { tier: "private", mask: "redact" }, // FOIA/HIPAA identifier
  signed_date: { tier: "private", mask: "year" }, // HIPAA date coarsening
};

/** The teaser figure field for the demo statement. */
export const DEMO_TEASER_FIELD = "annual_revenue_usd";
/** The teaser field id the appraiser signs as the envelope `nonce` (1 = revenue). */
export const FIELD_TAG_REVENUE = 1;

// CLI self-test: `npx tsx src/redaction.ts`.
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
const isMain = !!process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { view, log } = redact(DEMO_FINANCIAL_DOC, DEMO_FINANCIAL_POLICY);
  const pub = publicView(DEMO_FINANCIAL_DOC, DEMO_FINANCIAL_POLICY);
  const figure = teaserFigure(DEMO_FINANCIAL_DOC, DEMO_FINANCIAL_POLICY, DEMO_TEASER_FIELD);

  console.log("── public view (no-access counterparty) ──");
  console.log(JSON.stringify(pub, null, 2));
  console.log("── auditor redacted view ──");
  console.log(JSON.stringify(view, null, 2));
  console.log("── redaction log ──");
  for (const e of log) console.log(`  ${e.field}: ${e.mask} (${e.basis})`);
  console.log("teaser figure (annual_revenue_usd) =", figure.toString());

  // Assertions (private fields masked, never leaked verbatim; public/auditor intact).
  if ((view as Record<string, unknown>).routing_number !== undefined) throw new Error("routing_number must be dropped");
  if (view.bank_account !== "****1881") throw new Error(`bank_account must be PCI-masked, got ${view.bank_account}`);
  if (view.ceo_ssn !== "[REDACTED]") throw new Error("ceo_ssn must be redacted");
  if (view.signed_date !== "2026") throw new Error(`signed_date must coarsen to year, got ${view.signed_date}`);
  if (view.annual_revenue_usd !== 4_250_000) throw new Error("public revenue must survive into the auditor view");
  if (view.net_income_usd !== 880_000) throw new Error("auditor-tier net_income must survive");
  if (String(view.bank_account).includes("4012888888881881")) throw new Error("PAN must not appear verbatim");
  if ((pub as Record<string, unknown>).net_income_usd !== undefined) throw new Error("auditor-tier field must NOT be in the public view");
  if (Object.keys(pub).length !== 4) throw new Error(`public view must have exactly the 4 public fields, got ${Object.keys(pub).length}`);
  if (figure !== 4_250_000n) throw new Error("teaser figure mismatch");

  // An unclassified field must fail-closed to private/redact (never leaked).
  const r2 = redact({ secret_unknown: "leak-me" }, {});
  if (r2.view.secret_unknown !== "[REDACTED]") throw new Error("unclassified field must fail-closed to redacted");

  // A non-public teaser field must be rejected.
  let threw = false;
  try {
    teaserFigure(DEMO_FINANCIAL_DOC, DEMO_FINANCIAL_POLICY, "net_income_usd");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("teaserFigure must reject a non-public field");

  console.log("[ok] DR5 redaction policy: PCI/HIPAA/GDPR masking, public projection, fail-closed, teaser figure");
}
