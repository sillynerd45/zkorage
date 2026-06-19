const BASE = (import.meta.env.VITE_BACKEND_URL as string | undefined) || "/api";

export interface Info {
  verifierId: string;
  tokenId: string | null;
  policyId: string | null;
  gateId: string | null;
  complianceId: string | null;
  payrollId: string | null;
  network: string;
  proverUrl: string | null;
  publicRpc: string;
  decimals: number;
  kycIssuerId: string;
  identityImageId: string;
  complianceImageId: string;
  payrollImageId: string;
  payrollAttesterId: string;
  auditorPub: string;
  denyRoot: string;
  denyDepth: number;
  denySize: number;
  // Week 8 — fundraising (composition)
  accreditedId?: string | null;
  fundraiseId?: string | null;
  accreditedImageId?: string;
  accreditedIssuerId?: string;
  revenueImageId?: string;
  revenueAttesterId?: string;
  fundraiseThreshold?: string;
}

export interface Bundle {
  seal: string;
  image_id: string;
  journal_digest: string;
  journal: string;
}

export interface ProveStatus {
  status: "queued" | "claimed" | "proving_local" | "done" | "error";
  by?: string;
  bundle?: Bundle;
  error?: string;
}

export interface Cost {
  cpuInsns?: number;
  memBytes?: number;
  minResourceFee?: string;
}

export interface VerifiedResult {
  index?: number;
  result: boolean;
  supply: string;
  issuer_id: string;
  claim_type: number;
  nonce: string;
  expiry: string;
  ledger: number;
  timestamp: string;
}

export interface HistoryResp {
  count: number;
  start: number;
  limit: number;
  results: VerifiedResult[];
  policyId: string;
}

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

export interface AuditVerifyResp {
  verdict: boolean;
  checklist: AuditChecklist;
  decodedJournal?: Record<string, unknown>;
  recomputedDigest?: string;
  liveSupply?: string;
  notes: string[];
  recipe?: Recipe;
  error?: string;
}

export interface Recipe {
  readLatestOnChain: string;
  readHistoryOnChain: string;
  reVerifyProof: string;
}

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
  recipe: Recipe;
}

export interface SubmitResp {
  ok: boolean;
  txHash?: string;
  cost?: Cost;
  result?: VerifiedResult;
  error?: string;
  policyId: string;
}

async function j<T>(r: Response): Promise<T> {
  const body = await r.json();
  if (!r.ok) throw new Error((body as { error?: string }).error || `HTTP ${r.status}`);
  return body as T;
}

export const getInfo = () => fetch(`${BASE}/info`).then(j<Info>);
export const getSupply = () => fetch(`${BASE}/supply`).then(j<{ supply: string; decimals: number }>);
export const getResult = () =>
  fetch(`${BASE}/result`).then(j<{ result: VerifiedResult | null; policyId: string }>);
export const getBundle = () => fetch(`${BASE}/bundle/latest`).then(j<Bundle>);

export const proveReserves = (reserves: string) =>
  post<{ jobId: string; supply: string; issuerId: string }>("/prove-reserves", { reserves });

export const getProveStatus = (jobId: string) =>
  fetch(`${BASE}/prove-status/${jobId}`).then(j<ProveStatus>);

export const submit = (bundle: Bundle) => post<SubmitResp>("/submit", bundle);
export const mint = (whole: string) => post<{ ok: boolean; txHash?: string; supply: string }>("/mint", { whole });
export const burn = (whole: string) => post<{ ok: boolean; txHash?: string; supply: string }>("/burn", { whole });

export const getCount = () => fetch(`${BASE}/count`).then(j<{ count: number; policyId: string }>);
export const getHistory = (start = 0, limit = 50) =>
  fetch(`${BASE}/history?start=${start}&limit=${limit}`).then(j<HistoryResp>);
export const getResultByIssuer = (issuer: string) =>
  fetch(`${BASE}/result/${issuer}`).then(j<{ result: VerifiedResult; policyId: string }>);
export const getAuditBundle = (issuer?: string) =>
  fetch(`${BASE}/audit/${issuer ?? "latest"}`).then(j<AuditBundle>);
export const verifyAuditBundle = (bundle?: Bundle) => post<AuditVerifyResp>("/audit/verify", bundle ?? {});
/** Absolute badge URL (so it works embedded off-site too). */
export const badgeUrl = (issuer?: string) =>
  `${BASE}/badge${issuer ? `/${issuer}` : ""}.svg`;

// ---- Week 5: identity (KYC selective-disclosure gate) ----

export interface AccessRecord {
  index?: number;
  accessor: string;
  issuer_id: string;
  claim_type: number;
  nonce: string;
  expiry: string;
  ledger: number;
  timestamp: string;
}

export interface GrantResp {
  ok: boolean;
  txHash?: string;
  cost?: Cost;
  result?: AccessRecord;
  journal?: Record<string, unknown>;
  error?: string;
  gateId: string;
}

export interface AccessResp {
  accessor: string;
  granted: boolean;
  record: AccessRecord | null;
  gateId: string;
}

export const proveKyc = (subject: string, accessor: string, kycStatus = 1) =>
  post<{ jobId: string; accessor: string; issuerId: string }>("/prove-kyc", { subject, accessor, kycStatus });

export const grantAccess = (bundle: Bundle) => post<GrantResp>("/grant-access", bundle);

export const getGateAccess = (accessor: string) =>
  fetch(`${BASE}/gate/access/${accessor}`).then(j<AccessResp>);

export const getGateCount = () => fetch(`${BASE}/gate/count`).then(j<{ count: number; gateId: string }>);

export const getGateHistory = (start = 0, limit = 50) =>
  fetch(`${BASE}/gate/history?start=${start}&limit=${limit}`).then(
    j<{ count: number; start: number; limit: number; results: AccessRecord[]; gateId: string }>,
  );

// ---- Week 6: compliance (KYC ∧ not-sanctioned gate) ----

export interface ComplianceAccessRecord extends AccessRecord {
  deny_root: string;
}

export interface ComplianceGrantResp {
  ok: boolean;
  txHash?: string;
  cost?: Cost;
  result?: ComplianceAccessRecord;
  journal?: Record<string, unknown>;
  error?: string;
  complianceId: string;
}

export interface ComplianceAccessResp {
  accessor: string;
  granted: boolean;
  record: ComplianceAccessRecord | null;
  complianceId: string;
}

/** /prove-compliance returns a proving jobId, OR (for a sanctioned subject) sanctioned:true and no job. */
export interface ProveComplianceResp {
  jobId?: string;
  accessor?: string;
  issuerId?: string;
  denyRoot?: string;
  sanctioned?: boolean;
  subject?: string;
  message?: string;
}

export interface Denylist {
  root: string;
  depth: number;
  size: number;
}

export const proveCompliance = (subject: string, accessor: string, kycStatus = 1) =>
  post<ProveComplianceResp>("/prove-compliance", { subject, accessor, kycStatus });

export const grantCompliance = (bundle: Bundle) => post<ComplianceGrantResp>("/grant-compliance", bundle);

export const getComplianceAccess = (accessor: string) =>
  fetch(`${BASE}/compliance/access/${accessor}`).then(j<ComplianceAccessResp>);

export const getComplianceHistory = (start = 0, limit = 50) =>
  fetch(`${BASE}/compliance/history?start=${start}&limit=${limit}`).then(
    j<{ count: number; start: number; limit: number; results: ComplianceAccessRecord[]; complianceId: string }>,
  );

export const getDenylist = () => fetch(`${BASE}/denylist`).then(j<Denylist>);

// ---- Week 7: confidential payroll (proof-of-income + auditor view-key) ----

export interface PayrollAccessRecord {
  index?: number;
  accessor: string;
  issuer_id: string;
  threshold: string;
  auditor_pub: string;
  eph_pub: string;
  ct: string;
  tag: string;
  claim_type: number;
  nonce: string;
  expiry: string;
  ledger: number;
  timestamp: string;
}

export interface PayrollGrantResp {
  ok: boolean;
  txHash?: string;
  cost?: Cost;
  result?: PayrollAccessRecord;
  journal?: Record<string, unknown>;
  error?: string;
  payrollId: string;
}

export interface PayrollAccessResp {
  accessor: string;
  granted: boolean;
  record: PayrollAccessRecord | null;
  payrollId: string;
}

export interface ProvePayrollResp {
  jobId?: string;
  accessor?: string;
  auditorPub?: string;
  threshold?: string;
  issuerId?: string;
}

export interface PayrollAuditEntry {
  index: number;
  accessor: string;
  threshold: string;
  salary: string | null;
  faithful: boolean;
}

export interface PayrollAuditResp {
  count: number; // distinct employees
  grants: number; // total income-verification events in the log
  total: string;
  entries: PayrollAuditEntry[];
  payrollId: string;
}

export const provePayroll = (salary: string, threshold: string, accessor: string) =>
  post<ProvePayrollResp>("/prove-payroll", { salary, threshold, accessor });

export const submitPayroll = (bundle: Bundle) => post<PayrollGrantResp>("/submit-payroll", bundle);

export const getPayrollAccess = (accessor: string) =>
  fetch(`${BASE}/payroll/access/${accessor}`).then(j<PayrollAccessResp>);

export const getPayrollHistory = (start = 0, limit = 50) =>
  fetch(`${BASE}/payroll/history?start=${start}&limit=${limit}`).then(
    j<{ count: number; start: number; limit: number; results: PayrollAccessRecord[]; payrollId: string }>,
  );

/** AUDITOR: open EVERY grant → per-employee salaries + the payroll total (deduped by accessor).
 * The backend `/payroll/open/:accessor` (single open) also exists; the SDK exposes a key-free
 * `openPayrollDisclosure` for programmatic use — the dashboard only needs the aggregate audit. */
export const auditPayroll = (viewKey?: string) =>
  post<PayrollAuditResp>("/payroll/audit", viewKey ? { viewKey } : {});

async function post<T>(path: string, body: unknown): Promise<T> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(j<T>);
}

/** Format base units (7 dp) as a human token amount. */
export function fmtAmount(base: string | bigint, decimals = 7): string {
  const v = BigInt(base);
  const d = 10n ** BigInt(decimals);
  const whole = v / d;
  return whole.toLocaleString("en-US");
}

// ─────────────────────────── Week 8 — Fundraising (composition) ───────────────────────────

export interface RevenueRecord {
  threshold: string;
  issuer_id: string;
  claim_type: number;
  nonce: string;
  expiry: string;
  ledger: number;
  timestamp: string;
}

export interface InvestorAccess {
  index?: number;
  accessor: string;
  revenue_threshold: string;
  ledger: number;
  timestamp: string;
}

export interface FundraiseInfo {
  config: {
    admin: string; verifier: string; accredited_gate: string;
    revenue_image_id: string; revenue_claim_type: number; revenue_threshold: string;
  } | null;
  revenueVerified: boolean;
  revenueRecord: RevenueRecord | null;
  admissions: number;
  accreditedId: string | null;
  fundraiseId: string;
}

export interface CanAccessResp {
  accessor: string;
  canAccess: boolean;
  revenueVerified: boolean;
  accredited: boolean | null;
  fundraiseId: string;
}

export interface AccreditedAccessResp {
  accessor: string;
  granted: boolean;
  record: AccessRecord | null;
  accreditedId: string;
}

export interface FundraiseGrantResp {
  ok: boolean;
  txHash?: string;
  cost?: Cost;
  result?: InvestorAccess;
  accessor?: string;
  error?: string;
  fundraiseId: string;
}

export interface RevenueSubmitResp {
  ok: boolean;
  txHash?: string;
  cost?: Cost;
  result?: RevenueRecord;
  journal?: Record<string, unknown>;
  error?: string;
  fundraiseId: string;
}

// --- accredited (identity leg) ---
export const proveAccredited = (subject: string, accessor: string, accreditedStatus = 1) =>
  post<{ jobId: string; accessor: string; issuerId: string }>("/prove-accredited", { subject, accessor, accreditedStatus });
export const grantAccredited = (bundle: Bundle) => post<GrantResp>("/grant-accredited", bundle);
export const getAccreditedAccess = (accessor: string) =>
  fetch(`${BASE}/accredited/access/${accessor}`).then(j<AccreditedAccessResp>);

// --- revenue (financial leg) ---
export const proveRevenue = (revenue: string) =>
  post<{ jobId: string; threshold: string; issuerId: string }>("/prove-revenue", { revenue });
export const submitRevenue = (bundle: Bundle) => post<RevenueSubmitResp>("/fundraise/submit-revenue", bundle);

// --- fundraise (the composition) ---
export const getFundraiseInfo = () => fetch(`${BASE}/fundraise/info`).then(j<FundraiseInfo>);
export const canAccessFundraise = (accessor: string) =>
  fetch(`${BASE}/fundraise/can-access/${accessor}`).then(j<CanAccessResp>);
export const requestFundraiseAccess = (accessor: string) =>
  post<FundraiseGrantResp>("/fundraise/request-access", { accessor });
export const getFundraiseHistory = (start = 0, limit = 50) =>
  fetch(`${BASE}/fundraise/history?start=${start}&limit=${limit}`).then(j<{ count: number; results: InvestorAccess[]; fundraiseId: string }>);

// ─────────────────────────── DR1 — Confidential Data Room (data plane) ───────────────────────────

export interface DataroomConfig {
  admin: string;
  verifier: string;
  seal_image_id: string;
  claim_type: number;
}

export interface DataroomInfoResp {
  config: DataroomConfig | null;
  roomCount: number;
  dataroomImageId: string;
  recipientPub: string;
  storage: string; // "r2" | "local"
  dataroomId: string;
}

export interface Room {
  index: number;
  room_id: string;
  owner: string;
  ledger: number;
  timestamp: string;
}

export interface DataroomDoc {
  index: number;
  room_id: string;
  doc_id: string;
  recipient_pub: string;
  content_hash: string;
  eph_pub: string;
  ct: string;
  tag: string;
  blob_pointer: string;
  ledger: number;
  timestamp: string;
}

export interface CreateRoomResp {
  ok: boolean;
  txHash?: string;
  roomId: string;
  owner?: string;
  room?: Room;
  error?: string;
  dataroomId: string;
}

export interface ProveSealResp {
  jobId?: string;
  roomId: string;
  docId: string;
  recipientPub: string;
  contentHash: string;
  blobPointer: string;
  size: number;
  deduped: boolean;
  storage: string;
  error?: string;
}

export interface SubmitDocResp {
  ok: boolean;
  txHash?: string;
  cost?: Cost;
  result?: DataroomDoc;
  journal?: Record<string, unknown>;
  blobPointer?: string;
  error?: string;
  dataroomId: string;
}

export const getDataroomInfo = () => fetch(`${BASE}/dataroom/info`).then(j<DataroomInfoResp>);

export const getDataroomRoom = (roomId: string) =>
  fetch(`${BASE}/dataroom/room/${roomId}`).then(j<{ roomId: string; room: Room | null; dataroomId: string }>);

export const createRoom = (roomId?: string) =>
  post<CreateRoomResp>("/dataroom/create-room", roomId ? { roomId } : {});

export const proveSeal = (roomId: string, content: string, recipientPub?: string, docId?: string) =>
  post<ProveSealResp>("/dataroom/prove-seal", {
    roomId,
    content,
    ...(recipientPub ? { recipientPub } : {}),
    ...(docId ? { docId } : {}),
  });

export const submitDocument = (bundle: Bundle, blobPointer?: string) =>
  post<SubmitDocResp>("/dataroom/submit-document", { ...bundle, ...(blobPointer ? { blobPointer } : {}) });

export const getDataroomDocuments = (roomId: string, start = 0, limit = 50) =>
  fetch(`${BASE}/dataroom/documents/${roomId}?start=${start}&limit=${limit}`).then(
    j<{ roomId: string; count: number; start: number; limit: number; documents: DataroomDoc[]; dataroomId: string }>,
  );

export const getDataroomDocument = (roomId: string, docId: string) =>
  fetch(`${BASE}/dataroom/document/${roomId}/${docId}`).then(
    j<{ roomId: string; docId: string; document: DataroomDoc | null; dataroomId: string }>,
  );

// ── DR2 — anonymous eligibility (membership + nullifier) ──

export interface MembershipInfoResp {
  dataroomId: string;
  membershipImageId: string;
  membershipImageOnchain: string | null;
  claimType: number;
  treeDepth: number;
  recipientPub: string;
}

export interface MintedIdentity {
  idSecret: string;
  idTrapdoor: string;
  holderSeed: string;
  accessor: string;
  note: string;
}

export interface RegisterResp {
  ok: boolean;
  roomId: string;
  idCommitment: string;
  memberIndex: number;
  added: boolean;
  memberCount: number;
  eligibleRoot: string;
  minted?: MintedIdentity;
  error?: string;
}

export interface EligibleResp {
  roomId: string;
  memberCount: number;
  commitments: string[];
  computedRoot: string;
  pinnedRoot: string | null;
  inSync: boolean;
}

export interface SetRootResp {
  ok: boolean;
  txHash?: string;
  roomId: string;
  eligibleRoot?: string;
  memberCount?: number;
  error?: string;
}

export interface ProveAccessResp {
  jobId?: string;
  roomId: string;
  eligibleRoot: string;
  nullifier: string;
  accessor: string;
  recipientPub: string;
  error?: string;
}

export interface RequestAccessResp {
  ok: boolean;
  txHash?: string;
  cost?: Cost;
  grant?: Record<string, unknown>;
  error?: string;
  dataroomId: string;
}

export const getMembershipInfo = () =>
  fetch(`${BASE}/dataroom/membership/info`).then(j<MembershipInfoResp>);

export const getEligible = (roomId: string) =>
  fetch(`${BASE}/dataroom/membership/eligible/${roomId}`).then(j<EligibleResp>);

export const registerMember = (roomId: string, mint = true) =>
  post<RegisterResp>("/dataroom/membership/register", { roomId, mint });

export const setEligibleRoot = (roomId: string) =>
  post<SetRootResp>("/dataroom/membership/set-root", { roomId });

export const proveAccess = (
  roomId: string,
  idSecret: string,
  idTrapdoor: string,
  holderSeed: string,
  recipientPub?: string,
) =>
  post<ProveAccessResp>("/dataroom/membership/prove-access", {
    roomId, idSecret, idTrapdoor, holderSeed, ...(recipientPub ? { recipientPub } : {}),
  });

export const requestAccess = (bundle: Bundle) =>
  post<RequestAccessResp>("/dataroom/membership/request-access", bundle);

// ── DR3 — threshold-ECIES committee (key release) ──

export interface CommitteeKeyper {
  endpoint: string;
  ok: boolean;
  keyperIndex?: number;
  shares?: number;
  rpc?: string;
  error?: string;
}

export interface CommitteeInfoResp {
  threshold: number;
  n: number;
  online: number;
  keypers: CommitteeKeyper[];
  dataroomId: string;
  note: string;
}

export interface CommitteeDoc {
  index: number;
  room_id: string;
  doc_id: string;
  content_hash: string;
  k_commitment: string;
  blob_pointer: string;
  ledger: number;
  timestamp: string;
}

export const getCommitteeInfo = () =>
  fetch(`${BASE}/dataroom/committee/info`).then(j<CommitteeInfoResp>);

// ── DR4 — document-authenticity (signed-PDF / zkPDF: third-party truth) ──

export interface DocauthInfoResp {
  dataroomId: string;
  docauthImageId: string;
  docauthImageOnchain: string | null;
  claimType: number;
  issuerKeyHash: string;
  issuerAllowlisted: boolean;
  note: string;
}

export const getDocauthInfo = () =>
  fetch(`${BASE}/dataroom/docauth/info`).then(j<DocauthInfoResp>);

export const getCommitteeDocument = (roomId: string, docId: string) =>
  fetch(`${BASE}/dataroom/committee/document/${roomId}/${docId}`).then(
    j<{ roomId: string; docId: string; document: CommitteeDoc | null; dataroomId: string }>,
  );
