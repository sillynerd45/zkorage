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
  // Week 8: fundraising (composition)
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

export const submit = (bundle: Bundle, signer?: TxSigner): Promise<SubmitResp> =>
  signer
    ? writeViaWallet("/submit", { ...bundle }, signer).then((r) => ({ ...r, policyId: "" }))
    : post<SubmitResp>("/submit", bundle);
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

export const grantAccess = (bundle: Bundle, signer?: TxSigner): Promise<GrantResp> =>
  signer
    ? writeViaWallet("/grant-access", { ...bundle }, signer).then((r) => ({ ...r, gateId: "" }))
    : post<GrantResp>("/grant-access", bundle);

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

export const grantCompliance = (bundle: Bundle, signer?: TxSigner): Promise<ComplianceGrantResp> =>
  signer
    ? writeViaWallet("/grant-compliance", { ...bundle }, signer).then((r) => ({ ...r, complianceId: "" }))
    : post<ComplianceGrantResp>("/grant-compliance", bundle);

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

export const submitPayroll = (bundle: Bundle, signer?: TxSigner): Promise<PayrollGrantResp> =>
  signer
    ? writeViaWallet("/submit-payroll", { ...bundle }, signer).then((r) => ({ ...r, payrollId: "" }))
    : post<PayrollGrantResp>("/submit-payroll", bundle);

export const getPayrollAccess = (accessor: string) =>
  fetch(`${BASE}/payroll/access/${accessor}`).then(j<PayrollAccessResp>);

export const getPayrollHistory = (start = 0, limit = 50) =>
  fetch(`${BASE}/payroll/history?start=${start}&limit=${limit}`).then(
    j<{ count: number; start: number; limit: number; results: PayrollAccessRecord[]; payrollId: string }>,
  );

/** AUDITOR: open EVERY grant → per-employee salaries + the payroll total (deduped by accessor).
 * The backend `/payroll/open/:accessor` (single open) also exists; the SDK exposes a key-free
 * `openPayrollDisclosure` for programmatic use. The dashboard only needs the aggregate audit. */
export const auditPayroll = (viewKey?: string) =>
  post<PayrollAuditResp>("/payroll/audit", viewKey ? { viewKey } : {});

async function post<T>(path: string, body: unknown): Promise<T> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(j<T>);
}

// ── Client-side signing (Freighter) ─────────────────────────────────────────────────────────────
// A signer = the connected wallet's address + a sign(xdr) function (see lib/wallet). When a write call
// is given a signer, it routes through the wallet: backend builds unsigned XDR for the user's address →
// Freighter signs → backend submits + confirms. The user pays their own gas. With no signer, the call
// is the plain server-relay POST. Only the permissionless proof routes accept this; the contracts are
// unchanged. The returned record's rich fields come from the page's on-chain re-read after success.
export interface TxSigner {
  address: string;
  sign: (xdr: string) => Promise<string>;
}

export interface WalletWriteResult {
  ok: boolean;
  txHash?: string;
  cost?: Cost;
  error?: string;
}

async function writeViaWallet(
  path: string,
  body: Record<string, unknown>,
  signer: TxSigner,
): Promise<WalletWriteResult> {
  const built = await post<WalletWriteResult & { xdr?: string }>(path, { ...body, source: signer.address });
  if (!built.ok || !built.xdr) return { ok: false, error: built.error || "could not build the transaction" };
  let signedXdr: string;
  try {
    signedXdr = await signer.sign(built.xdr);
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "signing was declined" };
  }
  return post<WalletWriteResult>("/tx/submit", { signedXdr });
}

/** Format base units (7 dp) as a human token amount. */
export function fmtAmount(base: string | bigint, decimals = 7): string {
  const v = BigInt(base);
  const d = 10n ** BigInt(decimals);
  const whole = v / d;
  return whole.toLocaleString("en-US");
}

// ─────────────────────────── Week 8: Fundraising (composition) ───────────────────────────

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
export const grantAccredited = (bundle: Bundle, signer?: TxSigner): Promise<GrantResp> =>
  signer
    ? writeViaWallet("/grant-accredited", { ...bundle }, signer).then((r) => ({ ...r, gateId: "" }))
    : post<GrantResp>("/grant-accredited", bundle);
export const getAccreditedAccess = (accessor: string) =>
  fetch(`${BASE}/accredited/access/${accessor}`).then(j<AccreditedAccessResp>);

// --- revenue (financial leg) ---
export const proveRevenue = (revenue: string) =>
  post<{ jobId: string; threshold: string; issuerId: string }>("/prove-revenue", { revenue });
export const submitRevenue = (bundle: Bundle, signer?: TxSigner): Promise<RevenueSubmitResp> =>
  signer
    ? writeViaWallet("/fundraise/submit-revenue", { ...bundle }, signer).then((r) => ({ ...r, fundraiseId: "" }))
    : post<RevenueSubmitResp>("/fundraise/submit-revenue", bundle);

// --- fundraise (the composition) ---
export const getFundraiseInfo = () => fetch(`${BASE}/fundraise/info`).then(j<FundraiseInfo>);
export const canAccessFundraise = (accessor: string) =>
  fetch(`${BASE}/fundraise/can-access/${accessor}`).then(j<CanAccessResp>);
export const requestFundraiseAccess = (accessor: string, signer?: TxSigner): Promise<FundraiseGrantResp> =>
  signer
    ? writeViaWallet("/fundraise/request-access", { accessor }, signer).then((r) => ({ ...r, fundraiseId: "" }))
    : post<FundraiseGrantResp>("/fundraise/request-access", { accessor });
export const getFundraiseHistory = (start = 0, limit = 50) =>
  fetch(`${BASE}/fundraise/history?start=${start}&limit=${limit}`).then(j<{ count: number; results: InvestorAccess[]; fundraiseId: string }>);

// ─────────────────────────── DR1: Confidential Data Room (data plane) ───────────────────────────

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

// With a wallet connected, the room is created ON-CHAIN owned by the wallet (it signs create_room), so
// "Browse = rooms your wallet owns" reads a real on-chain owner. No wallet → the server relay creates it.
export const createRoom = (roomId?: string, signer?: TxSigner): Promise<CreateRoomResp> =>
  signer
    ? writeViaWallet("/dataroom/create-room", roomId ? { roomId } : {}, signer).then((r) => ({
        ok: r.ok, txHash: r.txHash, error: r.error, roomId: roomId ?? "", dataroomId: "",
      }))
    : post<CreateRoomResp>("/dataroom/create-room", roomId ? { roomId } : {});

export interface MyRoom {
  roomId: string;
  label: string | null;
  owner: string;
  docCount: number;
  ledger: number | null;
}
/** The rooms a given owner (Stellar G-address) owns on-chain — the owner's "my documents" view. */
export const getMyRooms = (owner: string) =>
  fetch(`${BASE}/dataroom/rooms?owner=${encodeURIComponent(owner)}`).then(
    j<{ owner: string; count: number; rooms: MyRoom[]; dataroomId: string }>,
  );

// Accepts either UTF-8 `content` or base64 `contentB64` (binary: PDF, image, any file). The backend
// encrypts whichever is supplied; only one is sent so an empty text box never overrides a chosen file.
export const proveSeal = (
  roomId: string,
  payload: { content?: string; contentB64?: string },
  recipientPub?: string,
  docId?: string,
) =>
  post<ProveSealResp>("/dataroom/prove-seal", {
    roomId,
    ...(payload.contentB64 ? { contentB64: payload.contentB64 } : { content: payload.content ?? "" }),
    ...(recipientPub ? { recipientPub } : {}),
    ...(docId ? { docId } : {}),
  });

// With a wallet connected, the wallet is the room owner on-chain, so IT signs put_document. No wallet →
// the server relay (owns the room) signs.
export const submitDocument = (bundle: Bundle, blobPointer?: string, signer?: TxSigner): Promise<SubmitDocResp> =>
  signer
    ? writeViaWallet("/dataroom/submit-document", { ...bundle, ...(blobPointer ? { blobPointer } : {}) }, signer).then((r) => ({
        ok: r.ok, txHash: r.txHash, error: r.error, blobPointer, dataroomId: "",
      }))
    : post<SubmitDocResp>("/dataroom/submit-document", { ...bundle, ...(blobPointer ? { blobPointer } : {}) });

export const getDataroomDocuments = (roomId: string, start = 0, limit = 50) =>
  fetch(`${BASE}/dataroom/documents/${roomId}?start=${start}&limit=${limit}`).then(
    j<{ roomId: string; count: number; start: number; limit: number; documents: DataroomDoc[]; dataroomId: string }>,
  );

export const getDataroomDocument = (roomId: string, docId: string) =>
  fetch(`${BASE}/dataroom/document/${roomId}/${docId}`).then(
    j<{ roomId: string; docId: string; document: DataroomDoc | null; dataroomId: string }>,
  );

// ── DR2: anonymous eligibility (membership + nullifier) ──

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

// ── DR3: threshold-ECIES committee (key release) ──

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

// ── DR4: document-authenticity (signed-PDF / zkPDF: third-party truth) ──

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

// ── Bonded Proofs: the Soroban-native time-locked escrow (BP2) ──
// Reads are public; writes are always wallet-signed (the depositor/claimant authorises). No ZK yet.

export interface LockView {
  id: number;
  depositor: string;
  claimant: string;
  token: string;
  amount: string; // base units, decimal string
  unlock_time: number; // unix seconds
  commitment: string; // 32-byte hex
  revocable: boolean;
  released: boolean;
  is_locked: boolean;
  role: "depositor" | "claimant" | "self";
}

export interface EscrowInfo {
  escrowId: string;
  bondTokenId: string;
}

export const getEscrowInfo = () => fetch(`${BASE}/escrow/info`).then(j<EscrowInfo>);

export const listEscrowLocks = (owner: string) =>
  fetch(`${BASE}/escrow/locks?owner=${owner}`).then(
    j<{ owner: string; count: number; locks: LockView[]; escrowId: string }>,
  );

export interface DepositReq {
  amount: string; // base units
  unlock_time: number; // unix seconds (must be in the future)
  revocable: boolean;
  claimant?: string; // defaults to the depositor (a self-bond)
  token?: string; // defaults to the bond token
  commitment?: string; // 32-byte hex; defaults to all-zero
}

export const escrowDeposit = (req: DepositReq, signer: TxSigner): Promise<WalletWriteResult> =>
  writeViaWallet("/escrow/deposit", { ...req }, signer);

export const escrowWithdraw = (lockId: number, signer: TxSigner): Promise<WalletWriteResult> =>
  writeViaWallet("/escrow/withdraw", { lock_id: lockId }, signer);

export const escrowClaim = (lockId: number, signer: TxSigner): Promise<WalletWriteResult> =>
  writeViaWallet("/escrow/claim", { lock_id: lockId }, signer);

export const escrowUnbond = (lockId: number, signer: TxSigner): Promise<WalletWriteResult> =>
  writeViaWallet("/escrow/unbond", { lock_id: lockId }, signer);

export const escrowSetTimelock = (
  lockId: number,
  newUnlock: number,
  signer: TxSigner,
): Promise<WalletWriteResult> =>
  writeViaWallet("/escrow/set-timelock", { lock_id: lockId, new_unlock_time: newUnlock }, signer);
