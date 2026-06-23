// Public data contracts for the zkorage SDK. All bytes are lower-case hex strings; all chain
// integers wider than 32 bits are strings (to avoid JS number precision loss).

/** A RISC Zero → Groth16 proof bundle (the verifiable artifact). */
export interface Bundle {
  seal: string; // hex
  image_id: string; // 32-byte hex
  journal: string; // raw journal hex (61 PoR/revenue · 85 identity/accredited · 117 compliance · 229 payroll/dataroom-seal)
  journal_digest?: string; // hex (optional; the SDK recomputes sha256(journal) itself)
}

/** A verified-claim result persisted on-chain by the policy contract. */
export interface VerifiedResult {
  index?: number; // position in the append-only history log
  result: boolean;
  supply: string; // bound supply (u64)
  issuer_id: string; // 32-byte hex
  claim_type: number;
  nonce: string;
  expiry: string;
  ledger: number;
  timestamp: string;
}

/** The policy contract's configuration. */
export interface PolicyConfig {
  admin: string;
  verifier: string;
  token: string;
  image_id: string; // 32-byte hex (the pinned guest image)
  claim_type: number;
}

/** The decoded 61-byte public journal. */
export interface DecodedJournal {
  result: boolean;
  claimType: number;
  issuerId: string; // hex
  supply: string; // the bound supply (journal "threshold" field)
  nonce: string;
  expiry: string;
}

/** Per-check result of an independent re-verification. */
export interface AuditChecklist {
  journalWellFormed: boolean;
  digestMatches: boolean;
  imagePinned: boolean;
  resultTrue: boolean;
  claimTypeOk: boolean;
  issuerAllowed: boolean;
  notExpired: boolean;
  proofValidOnChain: boolean;
  supplyBoundMatches: boolean;
  verdict: boolean;
}

/** Result of `verifyBundle`. */
export interface VerifyResult {
  verdict: boolean;
  checklist: AuditChecklist;
  decodedJournal: DecodedJournal;
  recomputedDigest: string;
  liveSupply: string | null;
  notes: string[];
}

/** Result of the high-level `isReservesGteSupply`. */
export interface ReservesAnswer {
  /** True iff the persisted result is `reserves ≥ supply` AND its bound supply still equals live supply. */
  answer: boolean;
  boundSupply: string | null;
  liveSupply: string | null;
  /** Whether the bound supply still equals the live circulating supply (no mint/burn since proving). */
  fresh: boolean;
  result: VerifiedResult | null;
}

/** The shareable audit bundle (proof + on-chain result + reproducible CLI recipe). */
export interface AuditBundle {
  network: string;
  rpc: string;
  contracts: { verifier: string; token: string | null; policy: string | null };
  canonicalImageId: string | null;
  claimType: number | null;
  proof: Bundle | null;
  decodedJournal: Record<string, unknown> | null;
  onChainResult: VerifiedResult | null;
  currentSupply: string | null;
  decimals: number;
  recipe: { readLatestOnChain: string; readHistoryOnChain: string; reVerifyProof: string };
}

export interface ZkorageConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contracts: { verifier: string; token: string; policy: string; gate: string; compliance: string; payroll: string; accredited: string; fundraise: string; dataroom: string; solvencyGate: string; escrow: string; bondToken: string; tierGate: string; bondGate: string };
  /** A funded account used only as the read-only simulation source (never signs). */
  readSource: string;
  /** Optional REST base URL — only needed for `getAuditBundle` (the proof bundle isn't on-chain). */
  apiBaseUrl?: string;
  decimals: number;
}

// ---------------------------------------------------------------------------------------------------
// Week 5 — Identity (KYC selective disclosure). The relying-party gate grants access to a public
// `accessor` proven to be backed by an allow-listed KYC provider, without revealing the subject.
// ---------------------------------------------------------------------------------------------------

/** The relying-party gate's configuration. */
export interface GateConfig {
  admin: string;
  verifier: string;
  image_id: string; // 32-byte hex (the pinned identity guest image)
  claim_type: number; // 3 = identity / KYC
}

/** An access grant persisted on-chain by the gate contract. */
export interface AccessRecord {
  index?: number; // position in the append-only history log
  accessor: string; // 32-byte hex (the access holder)
  issuer_id: string; // 32-byte hex (the KYC provider)
  claim_type: number;
  nonce: string;
  expiry: string;
  ledger: number;
  timestamp: string;
}

/** The decoded 85-byte identity journal. `subject_id` is intentionally absent (hidden). */
export interface DecodedIdentityJournal {
  result: boolean;
  claimType: number;
  issuerId: string; // hex (KYC provider)
  accessor: string; // hex (public binding)
  nonce: string;
  expiry: string;
}

/** Per-check result of an independent identity-proof re-verification. */
export interface IdentityChecklist {
  journalWellFormed: boolean;
  digestMatches: boolean;
  imagePinned: boolean;
  resultTrue: boolean;
  claimTypeOk: boolean;
  issuerAllowed: boolean;
  notExpired: boolean;
  proofValidOnChain: boolean;
  verdict: boolean;
}

/** Result of `verifyIdentityBundle`. */
export interface IdentityVerifyResult {
  verdict: boolean;
  checklist: IdentityChecklist;
  decodedJournal: DecodedIdentityJournal;
  recomputedDigest: string;
  notes: string[];
}

/** Result of the high-level `isKycVerified`. */
export interface KycAnswer {
  /** True iff this accessor has a persisted (non-expired) KYC access grant. */
  answer: boolean;
  accessor: string; // 32-byte hex
  record: AccessRecord | null;
}

// ---------------------------------------------------------------------------------------------------
// Week 6 — Compliance (KYC ∧ not-sanctioned). The compliance gate grants access to a public `accessor`
// proven to be backed by an allow-listed KYC provider AND not in the sanctions deny-list (the proof's
// committed deny-list Merkle root must equal the gate's pinned root), without revealing the subject.
// ---------------------------------------------------------------------------------------------------

/** The compliance gate's configuration. */
export interface ComplianceConfig {
  admin: string;
  verifier: string;
  image_id: string; // 32-byte hex (the pinned compliance guest image)
  claim_type: number; // 4 = compliance
  deny_root: string; // 32-byte hex (the authoritative sanctions deny-list Merkle root)
}

/** A compliance access grant persisted on-chain by the compliance gate. */
export interface ComplianceAccessRecord {
  index?: number; // position in the append-only history log
  accessor: string; // 32-byte hex (the access holder)
  issuer_id: string; // 32-byte hex (the KYC provider)
  deny_root: string; // 32-byte hex (the sanctions snapshot this grant was verified against)
  claim_type: number;
  nonce: string;
  expiry: string;
  ledger: number;
  timestamp: string;
}

/** The decoded 117-byte compliance journal. `subject_id` is intentionally absent (hidden). */
export interface DecodedComplianceJournal {
  result: boolean;
  claimType: number;
  issuerId: string; // hex (KYC provider)
  denyRoot: string; // hex (sanctions deny-list root the proof checked)
  accessor: string; // hex (public binding)
  nonce: string;
  expiry: string;
}

/** Per-check result of an independent compliance-proof re-verification. */
export interface ComplianceChecklist {
  journalWellFormed: boolean;
  digestMatches: boolean;
  imagePinned: boolean;
  resultTrue: boolean;
  claimTypeOk: boolean;
  denyRootMatches: boolean;
  issuerAllowed: boolean;
  notExpired: boolean;
  proofValidOnChain: boolean;
  verdict: boolean;
}

/** Result of `verifyComplianceBundle`. */
export interface ComplianceVerifyResult {
  verdict: boolean;
  checklist: ComplianceChecklist;
  decodedJournal: DecodedComplianceJournal;
  recomputedDigest: string;
  notes: string[];
}

/** Result of the high-level `isCompliant`. */
export interface ComplianceAnswer {
  /** True iff this accessor has a persisted (non-expired) "KYC'd & not-sanctioned" access grant. */
  answer: boolean;
  accessor: string; // 32-byte hex
  record: ComplianceAccessRecord | null;
}

// ---------------------------------------------------------------------------------------------------
// Week 7 — Confidential payroll (proof-of-income + auditor view-key). The payroll gate grants an
// income-verified record to a public `accessor` proven to have a signed salary ≥ a public threshold,
// WITHOUT revealing the salary. The salary is encrypted in-guest to an allow-listed auditor's x25519
// key (Option B ECIES); only the auditor's view key opens it (provably faithful).
// ---------------------------------------------------------------------------------------------------

/** The payroll gate's configuration. */
export interface PayrollConfig {
  admin: string;
  verifier: string;
  image_id: string; // 32-byte hex (the pinned payroll guest image)
  claim_type: number; // 5 = payroll
}

/** An income-verified grant persisted on-chain by the payroll gate (carries the auditor disclosure). */
export interface PayrollAccessRecord {
  index?: number; // position in the append-only history log
  accessor: string; // 32-byte hex (the verified-income credential holder)
  issuer_id: string; // 32-byte hex (the payroll attester)
  threshold: string; // the public income bar the (hidden) salary cleared
  auditor_pub: string; // 32-byte hex (the auditor x25519 disclosure target)
  eph_pub: string; // 32-byte hex (ECIES ephemeral pubkey)
  ct: string; // 40-byte hex (ECIES ciphertext of salary_be8 ‖ blinding32)
  tag: string; // 32-byte hex (sha256(DOMAIN_TAG ‖ salary ‖ blinding))
  claim_type: number;
  nonce: string;
  expiry: string;
  ledger: number;
  timestamp: string;
}

/** The decoded 229-byte payroll journal. `salary` is intentionally absent (encrypted to the auditor). */
export interface DecodedPayrollJournal {
  result: boolean;
  claimType: number;
  issuerId: string; // hex (payroll attester)
  threshold: string; // the public income bar
  accessor: string; // hex (public binding)
  auditorPub: string; // hex (auditor x25519 disclosure target)
  ephPub: string; // hex (ECIES ephemeral pubkey)
  ct: string; // hex (40-byte ciphertext)
  tag: string; // hex (32-byte integrity tag)
  nonce: string;
  expiry: string;
}

/** Per-check result of an independent payroll-proof re-verification. */
export interface PayrollChecklist {
  journalWellFormed: boolean;
  digestMatches: boolean;
  imagePinned: boolean;
  resultTrue: boolean;
  claimTypeOk: boolean;
  issuerAllowed: boolean;
  auditorAllowed: boolean;
  notExpired: boolean;
  proofValidOnChain: boolean;
  verdict: boolean;
}

/** Result of `verifyPayrollBundle`. */
export interface PayrollVerifyResult {
  verdict: boolean;
  checklist: PayrollChecklist;
  decodedJournal: DecodedPayrollJournal;
  recomputedDigest: string;
  notes: string[];
}

/** Result of the high-level `isIncomeVerified`. */
export interface IncomeAnswer {
  /** True iff this accessor has a persisted (non-expired) income-verified grant. */
  answer: boolean;
  accessor: string; // 32-byte hex
  record: PayrollAccessRecord | null;
}

// ---------------------------------------------------------------------------------------------------
// Week 8 — Fundraising (composition). A fundraise admits an investor only when BOTH (a) the investor
// proved "accredited = yes" (the accredited gate, identity-style) AND (b) the fundraise proved
// "revenue ≥ X" (a value≥threshold financial claim ingested by the fundraise contract). The fundraise
// AND's them on-chain (cross-call is_granted ∧ is_revenue_verified). Two facts, two proofs, one grant.
// ---------------------------------------------------------------------------------------------------

/** The accredited gate's configuration (identity-style; reuses the gate shape, claim_type 7). */
export interface AccreditedConfig {
  admin: string;
  verifier: string;
  image_id: string; // 32-byte hex (the pinned accredited guest image)
  claim_type: number; // 7 = accredited-investor
}

// The accredited gate's access record is identical to the KYC gate's — reuse `AccessRecord`.

/** The fundraise contract's configuration. */
export interface FundraiseConfig {
  admin: string;
  verifier: string;
  accredited_gate: string; // the accredited gate it AND's against
  revenue_image_id: string; // 32-byte hex (the generic value≥threshold guest)
  revenue_claim_type: number; // 6 = revenue
  revenue_threshold: string; // the public revenue floor X (u64)
}

/** The latest verified revenue proof (the financial leg). The real revenue is hidden — only the floor. */
export interface RevenueRecord {
  threshold: string; // the proven revenue floor X (u64)
  issuer_id: string; // 32-byte hex (the revenue auditor)
  claim_type: number; // 6
  nonce: string;
  expiry: string;
  ledger: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------------------------------
// BP3 — Bonded Proofs solvency gate. A `reserves >= supply` proof (reserves private) bound to a
// revocable escrow lock; the gate reads the lock LIVE so the grant self-voids on unbond.
// ---------------------------------------------------------------------------------------------------

export interface SolvencyConfig {
  admin: string;
  verifier: string;
  escrow: string;
  escrow_id: string; // 32-byte hex (== journal.escrow)
  supply_token: string;
  supply_token_id: string; // 32-byte hex (== journal.supply_token)
  bond_token: string;
  bond_token_id: string; // 32-byte hex (== journal.bond_token)
  image_id: string; // 32-byte hex (the pinned guest image)
  claim_type: number; // 12
}

/** A solvency proof record persisted on-chain by the gate, keyed by the bond depositor. The real reserve
 * figure is never stored — only the supply it was proven to cover. */
export interface SolvencyRecord {
  index?: number;
  depositor: string; // the bond owner (Stellar address)
  issuer_id: string; // 32-byte hex (the bonded reserve auditor)
  supply: string; // the proven liability (== supply_token.total_supply() at submit)
  lock_id: string; // the escrow lock backing the proof (u64)
  min_amount: string; // the bonded amount the proof asserts (u64)
  expiry: string;
  nonce: string;
  ledger: number;
  timestamp: string;
}

/** The live solvency answer for a depositor. `answer` is the AUTHORITATIVE on-chain `is_granted`
 * decision — it flips false the instant the depositor unbonds (or the lock unlocks / supply changes). */
export interface SolvencyAnswer {
  answer: boolean;
  depositor: string;
  record: SolvencyRecord | null;
}

// ---------------------------------------------------------------------------------------------------
// BP5 — Bonded Proofs tier gate. An anonymous proof of (enrolled member ∧ a qualifying non-revocable
// bonded lock, amount >= threshold, unlock >= X) with a per-context nullifier; the grant expires at X.
// ---------------------------------------------------------------------------------------------------

/** The 181-byte tier journal, decoded. The identity (id_secret/id_trapdoor/which lock) is NEVER present. */
export interface DecodedTierJournal {
  result: boolean;
  claimType: number; // 13
  memberRoot: string; // 32-byte hex (enrolled-member set)
  qualRoot: string; // 32-byte hex (qualifying-lock set for (threshold, X))
  threshold: string; // u64
  unlockAfter: string; // u64 (= X)
  context: string; // 32-byte hex (the nullifier domain / tier label)
  nullifier: string; // 32-byte hex
  accessor: string; // 32-byte hex (the grant target / consenting key)
}

export interface TierConfig {
  admin: string;
  verifier: string;
  image_id: string; // 32-byte hex (the pinned guest image)
  claim_type: number; // 13
}

/** A tier grant persisted on-chain by the gate, keyed by the accessor. Reveals neither identity nor lock. */
export interface TierGrant {
  index?: number;
  accessor: string; // 32-byte hex
  threshold: string; // u64
  unlock_after: string; // u64 (= X; the grant's expiry)
  context: string; // 32-byte hex
  nullifier: string; // 32-byte hex
  member_root: string; // 32-byte hex
  qual_root: string; // 32-byte hex
  ledger: number;
  timestamp: string;
}

/** The live tier answer for an accessor. `answer` is the on-chain `is_granted` decision (now < X). */
export interface TierAnswer {
  answer: boolean;
  accessor: string;
  grant: TierGrant | null;
}

/** An independently recomputed qualifying-set root (the trustless audit of the gate's published root). */
export interface RecomputedQualRoot {
  root: string; // 32-byte hex
  size: number; // anonymity-set size (number of unique qualifying commitments)
  commitments: string[]; // the qualifying-lock commitments, in lock-id order
  accepted: boolean; // whether this recomputed root is in the gate's accepted ring for (threshold, X)
  /** true iff the lock scan reached a natural end (a fully-not-found batch) rather than hitting the scan cap.
   *  A false here means the recomputed root may omit locks beyond the cap — do NOT treat it as authoritative. */
  complete: boolean;
}

export interface TierChecklist {
  journalWellFormed: boolean;
  digestMatches: boolean;
  imagePinned: boolean;
  resultTrue: boolean;
  claimTypeOk: boolean;
  memberRootPinned: boolean; // journal.member_root == the gate's enrolled root
  qualRootAccepted: boolean; // journal.qual_root is in the gate's accepted ring for (threshold, X)
  deadlineFuture: boolean; // now < X (the grant would still be live)
  nullifierFresh: boolean; // surfaced separately — a spent nullifier is still a sound proof
  proofValidOnChain: boolean;
  verdict: boolean;
}

/** Result of `verifyTierBundle`. */
export interface TierVerifyResult {
  verdict: boolean;
  checklist: TierChecklist;
  decodedJournal: DecodedTierJournal;
  recomputedDigest: string;
  notes: string[];
}

/** An investor admission persisted on-chain by the fundraise contract. */
export interface InvestorAccess {
  index?: number; // position in the append-only admission history
  accessor: string; // 32-byte hex (the admitted investor)
  revenue_threshold: string; // the floor X in force at admission
  ledger: number;
  timestamp: string;
}

/** Per-check result of an independent revenue-proof re-verification. */
export interface RevenueChecklist {
  journalWellFormed: boolean;
  digestMatches: boolean;
  imagePinned: boolean;
  resultTrue: boolean;
  claimTypeOk: boolean; // claim_type == 6
  issuerAllowed: boolean;
  thresholdMatches: boolean; // proven floor == the fundraise's pinned X
  notExpired: boolean;
  proofValidOnChain: boolean;
  verdict: boolean;
}

/** Result of `verifyRevenueBundle`. (`decodedJournal.supply` carries the proven revenue floor X.) */
export interface RevenueVerifyResult {
  verdict: boolean;
  checklist: RevenueChecklist;
  decodedJournal: DecodedJournal;
  recomputedDigest: string;
  thresholdX: string | null;
  notes: string[];
}

/** Result of the high-level `isAccredited`. */
export interface AccreditedAnswer {
  /** True iff this accessor has a persisted (non-expired) accredited-investor access grant. */
  answer: boolean;
  accessor: string; // 32-byte hex
  record: AccessRecord | null;
}

/** Result of the high-level `canAccessFundraise` — THE composition decision. */
export interface FundraiseAccessAnswer {
  /** The composed live decision: revenue ≥ X is verified AND the investor is accredited. */
  answer: boolean;
  accessor: string; // 32-byte hex
  /** The financial leg: the fundraise has a currently-valid revenue ≥ X proof. */
  revenueVerified: boolean;
  /** The identity leg: this accessor is a currently-accredited investor. */
  accredited: boolean;
  /** The on-chain admission record, if `request_investor_access` was called for this accessor. */
  record: InvestorAccess | null;
}

// ---------------------------------------------------------------------------------------------------
// DR1 — Confidential Data Room (data plane). An owner anchors documents as (content_hash, blob_pointer,
// recipient_pub) + the in-guest ECIES disclosure (eph_pub/ct/tag); the ciphertext lives off-chain
// (R2/local), content-addressed by content_hash. The document key K is sealed to a recipient x25519 key
// and bound to content_hash/room_id/doc_id (faithful) — a holder of the recipient SECRET recovers K
// key-free (the SDK opener), fetches the blob, and AEAD-decrypts. ZK is plumbing in DR1.
// ---------------------------------------------------------------------------------------------------

/** The DataRoom contract's configuration. */
export interface DataroomConfig {
  admin: string;
  verifier: string;
  seal_image_id: string; // 32-byte hex (the pinned DR1 seal guest image)
  claim_type: number; // 8 = dataroom seal
}

/** A room (the registry entry an owner creates before anchoring documents). */
export interface Room {
  index: number;
  room_id: string; // 32-byte hex
  owner: string; // the account that created the room
  ledger: number;
  timestamp: string;
}

/** An anchored document. The ciphertext is off-chain; only these commitments + the ECIES disclosure
 *  are on-chain. The document key K is recoverable only with the recipient's x25519 secret (not here). */
export interface DataroomDocument {
  index: number; // position in the room's append-only document log
  room_id: string; // 32-byte hex
  doc_id: string; // 32-byte hex
  recipient_pub: string; // 32-byte hex (x25519 disclosure target)
  content_hash: string; // 32-byte hex (sha256 of the stored ciphertext blob)
  eph_pub: string; // 32-byte hex (ECIES ephemeral pubkey)
  ct: string; // 32-byte hex (ECIES ciphertext of the doc key K)
  tag: string; // 32-byte hex (faithful tag = sha256(DOMAIN ‖ K ‖ content_hash ‖ room_id ‖ doc_id))
  blob_pointer: string; // off-chain pointer (e.g. r2://… / local://… / a bare content hash)
  ledger: number;
  timestamp: string;
}

/** The decoded 229-byte data-room seal journal. `K` is absent (ECIES-sealed to the recipient). */
export interface DecodedDataroomSealJournal {
  result: boolean;
  claimType: number;
  roomId: string; // hex
  docId: string; // hex
  recipientPub: string; // hex
  contentHash: string; // hex
  ephPub: string; // hex
  ct: string; // hex
  tag: string; // hex
}

/** Per-check result of an independent data-room seal-proof re-verification. */
export interface DataroomSealChecklist {
  journalWellFormed: boolean;
  digestMatches: boolean;
  imagePinned: boolean;
  resultTrue: boolean;
  claimTypeOk: boolean; // claim_type == 8
  proofValidOnChain: boolean;
  verdict: boolean;
}

/** Result of `verifyDataroomBundle`. (DR1 is commitment-only — no issuer/attester allowlist.) */
export interface DataroomVerifyResult {
  verdict: boolean;
  checklist: DataroomSealChecklist;
  decodedJournal: DecodedDataroomSealJournal;
  recomputedDigest: string;
  notes: string[];
}

// ── DR4 — document-authenticity (signed-PDF / zkPDF: third-party truth) ──

/** The decoded 113-byte DR4 docauth journal. The signed statement, the account, and the exact value are
 *  absent — only the proven predicate (`value >= threshold`) is revealed. */
export interface DecodedDocauthJournal {
  result: boolean;
  claimType: number; // 10 = document-authenticity
  fieldTag: number; // which field the predicate is about (1 = account balance)
  threshold: string; // u64 decimal string (the public floor X; value >= X proven)
  issuerKeyHash: string; // hex (sha256 of the third-party RSA modulus n; the allowlisted issuer key)
  roomId: string; // hex
  msgDigest: string; // hex (sha256(statement) — binds the fact to the exact document)
}

/** A DR4 document-authenticity fact (the on-chain record `attest_document_fact` stores). Reveals only the
 *  proven predicate + threshold + issuer key hash + the document hash — never the statement or exact value. */
export interface DocumentFact {
  index: number; // position in the room's fact log
  room_id: string; // hex
  msg_digest: string; // hex (sha256(statement))
  field_tag: number; // 1 = balance
  threshold: string; // u64 decimal string
  issuer_key_hash: string; // hex (the allowlisted third-party RSA key)
  attester: string; // G... address (the room owner who attested)
  ledger: number;
  timestamp: string;
}

/** Per-check result of an independent docauth-proof re-verification. */
export interface DocauthChecklist {
  journalWellFormed: boolean;
  digestMatches: boolean;
  imagePinned: boolean; // image_id == the DataRoom's pinned docauth image
  resultTrue: boolean;
  claimTypeOk: boolean; // claim_type == 10
  issuerAllowlisted: boolean; // the journal's issuer_key_hash is on-chain allowlisted (third-party truth)
  proofValidOnChain: boolean;
  verdict: boolean;
}

/** Result of `verifyDocauthBundle` — an independent re-verification of a signed-document fact proof. */
export interface DocauthVerifyResult {
  verdict: boolean;
  checklist: DocauthChecklist;
  decodedJournal: DecodedDocauthJournal;
  recomputedDigest: string;
  notes: string[];
}

// ── DR5 — faithful disclosure / data-side teaser ──

/** A DR5 teaser — a public, ZK-verified fact about a SEALED document (`figure >= threshold`, doc unseen),
 *  vouched by an allowlisted appraiser. Reveals only the predicate, the public floor, which appraiser
 *  vouched, and the document it is about (doc_id + the anchored blob's content_hash). The exact figure is
 *  never on-chain. */
export interface Teaser {
  index: number; // position in the room's teaser log
  room_id: string; // hex
  doc_id: string; // hex (the sealed document the teaser advertises)
  content_hash: string; // hex (the anchored blob hash the teaser is bound to)
  field_tag: number; // 1 = revenue (attester-signed via the envelope nonce)
  threshold: string; // u64 decimal string (the public floor X; figure >= X proven)
  attester: string; // hex (the allowlisted appraiser ed25519 pubkey that vouched the figure)
  expiry: string; // u64 decimal string (teaser freshness deadline)
  asserter: string; // G... address (the room owner who bound the teaser to the document)
  ledger: number;
  timestamp: string;
}

/** Per-check result of an independent teaser-proof re-verification. */
export interface TeaserChecklist {
  journalWellFormed: boolean;
  digestMatches: boolean;
  imagePinned: boolean; // image_id == the DataRoom's pinned teaser image (the generic value>=threshold guest)
  resultTrue: boolean;
  claimTypeOk: boolean; // claim_type == 11
  attesterAllowlisted: boolean; // the journal's issuer_id is an allowlisted appraiser (third-party truth)
  proofValidOnChain: boolean;
  verdict: boolean;
}

/** Result of `verifyTeaserBundle` — an independent re-verification of a data-side teaser proof. The teaser
 *  reuses the generic 61-byte value>=threshold journal (the figure is absent). */
export interface TeaserVerifyResult {
  verdict: boolean;
  checklist: TeaserChecklist;
  decodedJournal: DecodedJournal;
  recomputedDigest: string;
  notes: string[];
}

/** Result of the key-free `openDocument` recipient opener. */
export interface OpenedDocument {
  /** Was the document found on-chain? */
  found: boolean;
  /** True iff the recovered K's tag matched (right recipient key AND K is the one bound to THIS doc). */
  faithful: boolean;
  /** True iff the fetched ciphertext's sha256 matched the on-chain content_hash (only checked if faithful). */
  contentHashVerified: boolean;
  contentHash: string; // 32-byte hex (empty if not found)
  recipientPub: string; // 32-byte hex (empty if not found)
  /** The recovered document plaintext (only present when faithful AND the blob was fetched + verified). */
  plaintext: Uint8Array | null;
  /** The plaintext decoded as UTF-8, if it is valid UTF-8 (convenience). */
  plaintextUtf8: string | null;
}

// ── DR3 — threshold-ECIES committee documents (key release) ──

/** A committee document: its key K is Shamir-split across the keyper committee (no on-chain key material).
 *  On-chain we keep the ciphertext content_hash, a sha256(K) commitment, and the off-chain pointer. */
export interface CommitteeDocument {
  index: number; // position in the room's committee-doc log
  room_id: string; // 32-byte hex
  doc_id: string; // 32-byte hex
  content_hash: string; // 32-byte hex (sha256 of the stored ciphertext blob)
  k_commitment: string; // 32-byte hex (sha256(K); the recipient checks reconstruction before download)
  blob_pointer: string; // off-chain pointer (r2://… / local://… / a bare content hash)
  ledger: number;
  timestamp: string;
}

// ── DR6 — private-policy composition + revocation/rotation ──

/** A room's DR6 composite-admission policy. PUBLIC config (which legs apply); the privacy is the
 *  requester's hidden attributes satisfying it. `compliance_gate`/`accredited_gate` are `null` when that
 *  leg is not required. */
export interface RoomPolicy {
  require_membership: boolean; // the DR2 anonymity spine (true in the demo; a gate-only room may be false, but a fully-empty policy is rejected on-chain)
  compliance_gate: string | null; // C-address of the compliance gate (KYC ∧ not-sanctioned), or null
  accredited_gate: string | null; // C-address of the accredited gate, or null
}

/** A DR6 composite-policy admission record (audit). Reveals only the pseudonymous accessor + which legs
 *  the policy required at admission time — never identity, which member, KYC subject, or accreditation. */
export interface Admission {
  index: number; // position in the room's admission log
  room_id: string; // hex
  accessor: string; // hex (pseudonymous)
  required_compliance: boolean;
  required_accredited: boolean;
  ledger: number;
  timestamp: string;
}

/** The live composed admission decision broken out by leg (for UIs that show WHY). `admitted` is the
 *  on-chain `is_admitted` AND; the per-leg booleans are the individual live reads. */
export interface RoomAccess {
  admitted: boolean; // on-chain is_admitted (the composed AND)
  membership: boolean; // DR2 is_granted (revoke- + root-aware)
  compliance: boolean | null; // compliance gate is_granted (null if the policy doesn't require it)
  accredited: boolean | null; // accredited gate is_granted (null if the policy doesn't require it)
  revoked: boolean; // surgically revoked in this room
  policy: RoomPolicy | null; // the room's policy (null if unset)
}

/** Result of the key-free `openCommitteeDocument` recipient opener (collect → reconstruct → decrypt). */
export interface OpenedCommitteeDocument {
  /** Was the committee document found on-chain? */
  found: boolean;
  /** Did >= threshold keypers release a sealed share for this accessor (i.e. is the grant live)? */
  released: boolean;
  /** How many sealed shares opened faithfully with the supplied recipient secret. */
  faithfulShares: number;
  /** True iff K was reconstructed (>= threshold faithful shares whose sha256(K) matched the commitment). */
  reconstructed: boolean;
  /** True iff the fetched ciphertext's sha256 matched the on-chain content_hash. */
  contentHashVerified: boolean;
  contentHash: string; // 32-byte hex (empty if not found)
  kCommitment: string; // 32-byte hex (empty if not found)
  recipientPub: string; // 32-byte hex (the on-chain grant key the keypers sealed to; empty if none released)
  /** Which 2-of-3 keyper pair reconstructed K (when reconstructed). */
  reconstructedFromPair: [number, number] | null;
  /** The recovered document plaintext (only present when fully opened + content-hash verified). */
  plaintext: Uint8Array | null;
  plaintextUtf8: string | null;
}

// ── DR2 — anonymous eligibility (membership + nullifier) ──

/** The decoded 165-byte DR2 membership journal. The member's identity is absent — anonymity; only the
 *  pseudonymous accessor + nullifier + the eligible-set root the proof checked appear. */
export interface DecodedMembershipJournal {
  result: boolean;
  claimType: number; // 9 = membership
  roomId: string; // hex
  eligibleRoot: string; // hex (the Merkle root the proof checked; pinned == the room's EligibleRoot)
  nullifier: string; // hex (one access per identity per room)
  accessor: string; // hex (ed25519 grant target == the in-guest holder signing key)
  recipientPub: string; // hex (x25519 receiving key for the DR3 keypers; bound by NEW-5)
}

/** A DR2 anonymous-eligibility access grant (the on-chain record `request_access` stores). Reveals neither
 *  identity nor which eligible member — only the pseudonymous accessor/recipient + nullifier + root. */
export interface MembershipGrant {
  index: number; // position in the room's grant log
  room_id: string; // hex
  accessor: string; // hex
  recipient_pub: string; // hex
  eligible_root: string; // hex (the root snapshot; re-pinning revokes via is_granted)
  nullifier: string; // hex
  ledger: number;
  timestamp: string;
}

/** Per-check result of an independent membership-proof re-verification. */
export interface MembershipChecklist {
  journalWellFormed: boolean;
  digestMatches: boolean;
  imagePinned: boolean; // image_id == the DataRoom's pinned membership image
  resultTrue: boolean;
  claimTypeOk: boolean; // claim_type == 9
  rootPinned: boolean; // the journal's eligible_root == the room's on-chain EligibleRoot
  nullifierFresh: boolean; // the nullifier is NOT yet spent in the room (a fresh proof would grant)
  proofValidOnChain: boolean;
  verdict: boolean;
}

/** Result of `verifyMembershipBundle`. */
export interface MembershipVerifyResult {
  verdict: boolean;
  checklist: MembershipChecklist;
  decodedJournal: DecodedMembershipJournal;
  recomputedDigest: string;
  notes: string[];
}
