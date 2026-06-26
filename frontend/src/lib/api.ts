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

/** Format base units (7 dp) as a human token amount, keeping any fractional part (trailing zeros trimmed). */
export function fmtAmount(base: string | bigint, decimals = 7): string {
  let v = BigInt(base);
  const neg = v < 0n;
  if (neg) v = -v;
  const d = 10n ** BigInt(decimals);
  const whole = (v / d).toLocaleString("en-US");
  const frac = (v % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}

/** Parse a human token amount (e.g. "100.5") to base units exactly (no float drift). Null if invalid. */
export function toBaseUnits(input: string, decimals = 7): string | null {
  const s = input.trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") return null;
  const [w, f = ""] = s.split(".");
  if (f.length > decimals) return null; // more precision than the token supports
  const v = BigInt((w || "0") + f.padEnd(decimals, "0"));
  return v > 0n ? v.toString() : null;
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
  content_hash: string;
  blob_pointer: string;
  ledger: number;
  timestamp: string;
  // "dr1" = a single-recipient ECIES seal (legacy); "committee" = an anonymous Model B doc (keeper-released,
  // or owner-reopened via the escrow copy). The current Store form only makes committee docs.
  kind?: "dr1" | "committee";
  // DR1-only seal fields (absent on committee docs).
  recipient_pub?: string;
  eph_pub?: string;
  ct?: string;
  tag?: string;
  // Committee-only commitment (sha256(K)).
  k_commitment?: string;
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
  docCount: number; // total = DR1 seals + committee docs
  dr1DocCount?: number;
  committeeDocCount?: number;
  ledger: number | null;
  // M5: the owner's own discovery settings (surfaced only on the owner's own rooms; not a public leak).
  visibility?: RoomVisibility | null;
  name?: string | null;
  description?: string | null;
}
/** The rooms a given owner (Stellar G-address) owns on-chain — the owner's "my documents" view. */
export const getMyRooms = (owner: string) =>
  fetch(`${BASE}/dataroom/rooms?owner=${encodeURIComponent(owner)}`).then(
    j<{ owner: string; count: number; rooms: MyRoom[]; dataroomId: string }>,
  );

// ── M1: request-then-approve enrollment ──────────────────────────────────────────────────────────
// A member files a public id_commitment (request); the room owner approves, which pins set_eligible_root.
// Joining is identified; accessing stays anonymous (the membership proof hides which member).
export type EnrollState = "eligible" | "pending" | "none";
export interface EnrollRequestItem {
  commitment: string;
  label?: string;
  requester?: string;
  ts: number;
}
export interface EnrollRequestsResp {
  roomId: string;
  pending: EnrollRequestItem[];
  memberCount: number;
}

export const enrollRequest = (
  roomId: string,
  commitment: string,
  opts?: { label?: string; source?: string },
) =>
  post<{ ok: boolean; state: EnrollState; added?: boolean; error?: string }>("/dataroom/enroll/request", {
    roomId,
    commitment,
    ...opts,
  });

export const getEnrollRequests = (roomId: string) =>
  fetch(`${BASE}/dataroom/enroll/requests/${roomId}`).then(j<EnrollRequestsResp>);

export const getEnrollStatus = (roomId: string, commitment: string) =>
  fetch(`${BASE}/dataroom/enroll/status/${roomId}/${commitment}`).then(
    j<{ state: EnrollState; memberIndex?: number }>,
  );

export const enrollReject = (roomId: string, commitment: string) =>
  post<{ ok: boolean; removed: boolean; error?: string }>("/dataroom/enroll/reject", { roomId, commitment });

/** Owner approves a pending member: appends the commitment and pins set_eligible_root. With a wallet signer
 *  the owner signs the root change; otherwise the server relay signs (a room it owns). */
export const enrollApprove = (
  roomId: string,
  commitment: string,
  signer?: TxSigner,
): Promise<WalletWriteResult> =>
  signer
    ? writeViaWallet("/dataroom/enroll/approve", { roomId, commitment }, signer)
    : post<WalletWriteResult>("/dataroom/enroll/approve", { roomId, commitment });

/** Owner approves ALL currently-pending members in ONE root re-pin (the M7 batch append: new leaves added in
 *  randomized order, the root pinned once). Omitting `commitments` approves every pending request, so the
 *  owner signs a single tx for the whole batch instead of one per member. */
export const enrollApproveBatch = (roomId: string, signer?: TxSigner): Promise<WalletWriteResult> =>
  signer
    ? writeViaWallet("/dataroom/enroll/approve-batch", { roomId }, signer)
    : post<WalletWriteResult>("/dataroom/enroll/approve-batch", { roomId });

// ── M5: discovery tiers + public directory ───────────────────────────────────────────────────────
// Visibility is an off-chain, NON-security discovery flag. The directory shows only rooms the owner opted
// into ("listed"), with COARSE member buckets (never exact counts) and no access feed.
export type RoomVisibility = "private" | "unlisted" | "listed";
export type AnonTier = "forming" | "ok" | "strong";

// A TRUE bond-only room's requirement, surfaced in the directory so a reader sees which bond opens the room
// (instead of a request-to-join). Present only for bond-only rooms; null/absent for membership rooms.
export interface DirectoryBond {
  bondOpen: boolean;
  token: string; // SEP-41 / SAC contract address
  symbol: string;
  decimals: number;
  issuer: string | null; // the classic asset's issuer (G-address), null for native / pure-Soroban
  minAmount: string; // base units
  deadline: number; // unix seconds
  reqId: string;
}
export interface DirectoryRoom {
  roomId: string;
  name: string | null;
  description: string | null;
  memberBucket: string; // coarse range, e.g. "5-19" — never an exact count
  anonTier: AnonTier;
  listedAt: number | null;
  bond?: DirectoryBond | null;
}
export interface RoomMeta {
  roomId: string;
  visibility: RoomVisibility;
  discoverable: boolean;
  listed?: boolean;
  exists?: boolean;
  name?: string | null;
  description?: string | null;
  memberBucket?: string;
  anonTier?: AnonTier;
  bond?: DirectoryBond | null;
}

/** PUBLIC directory: only "listed" rooms, with coarse member buckets (never exact). Wallet not required. */
export const getDirectory = () =>
  fetch(`${BASE}/dataroom/directory`).then(
    j<{ count: number; rooms: DirectoryRoom[]; dataroomId: string }>,
  );

/** Resolve one room by EXACT id. A private room reveals nothing (discoverable=false); unlisted/listed
 *  return the opt-in name/description + a coarse count. */
export const getRoomMeta = (roomId: string) =>
  fetch(`${BASE}/dataroom/room-meta/${encodeURIComponent(roomId)}`).then(j<RoomMeta>);

/** Owner: set a room's discovery tier + opt-in public name/description (off-chain, no tx). The connected
 *  wallet address is sent as `source` so the backend's on-chain owner-gate passes for a wallet-owned room
 *  (no source => the demo relay/ADMIN owner). Throws on a 4xx (e.g. not the owner). */
export const setRoomVisibility = (
  roomId: string,
  patch: { visibility: RoomVisibility; name?: string; description?: string; source?: string },
) =>
  post<{
    ok: boolean;
    roomId: string;
    visibility: RoomVisibility;
    name: string | null;
    description: string | null;
    error?: string;
  }>("/dataroom/room/visibility", { roomId, ...patch });

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

// ── Encrypted rooms vault (opaque ciphertext, indexed by a wallet-derived pseudonym handle) ──
export interface RoomsVaultBlob {
  magic: string;
  version: number;
  alg: string;
  iv: string;
  ct: string;
}
export const getRoomsVault = (handle: string) =>
  fetch(`${BASE}/dataroom/rooms-vault/${handle}`).then(j<{ found: boolean; blob: RoomsVaultBlob | null }>);
export const putRoomsVault = (handle: string, blob: RoomsVaultBlob) =>
  fetch(`${BASE}/dataroom/rooms-vault/${handle}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob }),
  }).then(j<{ ok: boolean }>);
export const deleteRoomsVault = (handle: string) =>
  fetch(`${BASE}/dataroom/rooms-vault/${handle}`, { method: "DELETE" }).then(j<{ ok: boolean; removed: boolean }>);

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

export interface ProveAccessArgs {
  roomId: string;
  idSecret: string;
  idTrapdoor: string;
  recipientPub?: string;
  minAnonSet?: number;
  /** Legacy: the backend signs the NEW-5 consent with this seed (server-minted demo identities). */
  holderSeed?: string;
  /** Preferred: the client signed the consent in-browser, so accessor_seed never leaves the device. Pass
   *  both `accessor` and `holderSig` together. */
  accessor?: string;
  holderSig?: string;
}

export const proveAccess = (a: ProveAccessArgs) =>
  post<ProveAccessResp>("/dataroom/membership/prove-access", {
    roomId: a.roomId,
    idSecret: a.idSecret,
    idTrapdoor: a.idTrapdoor,
    ...(a.recipientPub ? { recipientPub: a.recipientPub } : {}),
    ...(a.minAnonSet ? { minAnonSet: a.minAnonSet } : {}),
    ...(a.holderSeed ? { holderSeed: a.holderSeed } : {}),
    ...(a.accessor ? { accessor: a.accessor } : {}),
    ...(a.holderSig ? { holderSig: a.holderSig } : {}),
  });

export const requestAccess = (bundle: Bundle) =>
  post<RequestAccessResp>("/dataroom/membership/request-access", bundle);

// M7 — anonymous-access batching. Instead of submitting request_access immediately (which would let the room
// owner read the on-chain grant's timestamp + order and re-link the member by timing), the member hands the
// proven bundle to the relay, which flushes it SHUFFLED at the next fixed window boundary. Poll the ticket
// until it is submitted, then open. Latency is the price of breaking the timing link.
export type BatchStatus = "queued" | "submitted" | "error";

export interface QueueAccessResp {
  ok: boolean;
  ticket?: string;
  status?: BatchStatus;
  /** The window boundary (unix ms) this access lands at. */
  flushAt?: number;
  nextFlushAt?: number;
  windowMs?: number;
  queued?: number;
  error?: string;
}

export const queueAccess = (args: { bundle: Bundle; roomId: string; accessor: string; nullifier: string }) =>
  post<QueueAccessResp>("/dataroom/membership/queue-access", {
    seal: args.bundle.seal,
    image_id: args.bundle.image_id,
    journal: args.bundle.journal,
    roomId: args.roomId,
    accessor: args.accessor,
    nullifier: args.nullifier,
  });

export interface QueueStatusResp {
  ticket: string;
  status: BatchStatus;
  flushAt: number;
  nextFlushAt: number;
  windowMs: number;
  txHash: string | null;
  error: string | null;
}

export const getQueueStatus = (ticket: string) =>
  fetch(`${BASE}/dataroom/membership/queue-status/${ticket}`).then(j<QueueStatusResp>);

// M7 — a room's append-only grant log (public on-chain data). This is what shows the timing defense working:
// accesses recorded in one flush window land clustered in time + shuffled in order. Read-only, no wallet.
export interface GrantLogEntry {
  index: number;
  accessor: string;
  nullifier: string;
  eligibleRoot: string;
  ledger: number;
  timestamp: number;
}

export interface GrantsResp {
  roomId: string;
  count: number;
  grants: GrantLogEntry[];
  dataroomId: string;
}

export const getGrants = (roomId: string, limit = 24) =>
  fetch(`${BASE}/dataroom/membership/grants/${roomId}?limit=${limit}`).then(j<GrantsResp>);

// ── DR3: threshold-ECIES committee (key release) ──

export interface CommitteeKeyper {
  endpoint: string;
  ok: boolean;
  keyperIndex?: number;
  shares?: number;
  rpc?: string;
  /** The keeper's static x25519 key the browser dealer seals this keeper's share to (Model B). */
  sealPub?: string;
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

// ── M2: browser-dealer committee store (Model B) ──
// The browser does all the crypto and posts only ciphertext + SEALED shares; the relay never sees K.
export interface SealedShareWire {
  keyperIndex: number;
  eph_pub: string;
  ct: string;
  tag: string;
}
export interface DealSealedResp {
  ok: boolean;
  roomId?: string;
  docId?: string;
  contentHash?: string;
  blobPointer?: string;
  kCommitment?: string;
  dealt?: number;
  error?: string;
}

export const dealSealed = (payload: {
  roomId: string;
  docId: string;
  blobB64: string;
  kCommitment: string;
  sealedShares: SealedShareWire[];
  escrow?: { ephPub: string; ct: string; tag: string; recipientPub: string };
}) => post<DealSealedResp>("/dataroom/committee/deal-sealed", payload);

/** Owner-wallet-signed put_committee_document for a browser-dealt doc (or relay if no signer). */
export const committeeAnchor = (
  args: { roomId: string; docId: string; contentHash: string; kCommitment: string; blobPointer: string },
  signer?: TxSigner,
): Promise<WalletWriteResult> =>
  signer
    ? writeViaWallet("/dataroom/committee/anchor", args, signer)
    : post<WalletWriteResult>("/dataroom/committee/anchor", args);

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
  tokenSymbol: string; // the lock's token symbol (so a multi-token lock renders the right unit)
  tokenDecimals: number; // the lock's token decimals (defaults to 7)
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

export const getBondBalance = (owner: string) =>
  fetch(`${BASE}/escrow/balance?owner=${owner}`).then(
    j<{ owner: string; balance: string; bondTokenId: string }>,
  );

// Read any SEP-41 token's balance + decimals + symbol for an owner (used by the Deposit picker's
// "paste a contract address" path). Throws (4xx) if the contract is not a deployed SEP-41 token.
export const getTokenBalance = (owner: string, token: string) =>
  fetch(`${BASE}/escrow/token-balance?owner=${encodeURIComponent(owner)}&token=${encodeURIComponent(token)}`).then(
    j<{ owner: string; token: string; balance: string; decimals: number; symbol: string; issuer?: string | null }>,
  );

// Demo faucet: server-relayed mint of test zkUSD (the relay signer is the token admin), so a fresh wallet
// can try a deposit. Not wallet-signed.
export const escrowFaucet = (to: string): Promise<WalletWriteResult & { minted?: string }> =>
  post<WalletWriteResult & { minted?: string }>("/escrow/faucet", { to });

// ── Bonded Proofs: solvency proof that dies when you pull your collateral (BP3/BP4) ──
// Prove `reserves >= supply` (reserves PRIVATE) bound to a revocable lock; the gate reads that lock LIVE,
// so the grant flips ACTIVE -> VOID the instant you unbond. prove (worker-first) -> poll getProveStatus ->
// submitSolvency (the lock owner signs) -> poll getSolvencyStatus for the live badge.

export interface SolvencyInfo {
  solvencyGateId: string;
  solvencyImageId: string;
  auditorPub: string;
  escrowId: string;
  bondTokenId: string;
  supplyTokenId: string;
  claimType: number;
}

export interface SolvencyRecord {
  index: number;
  depositor: string;
  issuer_id: string;
  supply: string;
  lock_id: string;
  min_amount: string;
  expiry: string;
  nonce: string;
  ledger: number;
  timestamp: string;
}

export interface SolvencyStatus {
  depositor: string;
  is_granted: boolean;
  record: SolvencyRecord | null;
  solvencyGateId: string;
}

export const getSolvencyInfo = () => fetch(`${BASE}/bonded/solvency/info`).then(j<SolvencyInfo>);

export const getSolvencyStatus = (depositor: string) =>
  fetch(`${BASE}/bonded/solvency/status?depositor=${depositor}`).then(j<SolvencyStatus>);

export const proveSolvency = (lockId: number, opts?: { reserves?: string; min_amount?: string }) =>
  post<{ jobId: string; supply: string; lockId: number; minAmount: string; issuerId: string }>(
    "/bonded/solvency/prove",
    { lock_id: lockId, ...(opts ?? {}) },
  );

// Submit the bonded-solvency proof to the gate. Always wallet-signed: the gate requires the lock owner's
// auth (the ownership binding), and the connected wallet IS that owner.
export const submitSolvency = (bundle: Bundle, signer: TxSigner): Promise<WalletWriteResult> =>
  writeViaWallet("/bonded/solvency/submit", { ...bundle }, signer);

// ── Bonded Proofs: anonymous bonded tier / membership expiring at X (BP5) ──
// Prove you are an enrolled member AND control a qualifying non-revocable bonded lock (amount >= threshold,
// locked until >= X), WITHOUT revealing which wallet or how much. The grant is keyed to a fresh anonymous
// accessor. Submit is permissionless (the in-guest holder signature is the consent) — a relayer pays, so the
// member never signs from a funded wallet. enroll -> bond a qualifying lock -> prove (worker-first) ->
// poll getProveStatus -> submitTier (relay) -> poll getTierStatus for the badge.

export interface TierInfo {
  tierGateId: string | null;
  tierImageId: string;
  claimType: number;
  minAnonSet: number;
  enrolledCount: number;
  grantCount: number;
  escrowId: string;
  bondTokenId: string;
}

/** A demo tier identity minted by the backend (in production the member holds these client-side). */
export interface TierIdentity {
  idSecret: string;
  idTrapdoor: string;
  holderSeed: string;
  accessor: string;
  qualCommitment: string;
}

export interface TierQualSet {
  threshold: string;
  unlockAfter: number;
  anonSetSize: number;
  minAnonSet: number;
  belowMin: boolean;
  computedRoot: string;
  published: boolean;
  ringLen: number;
}

export interface TierGrant {
  index: number;
  accessor: string;
  threshold: string;
  unlock_after: string;
  context: string;
  nullifier: string;
  member_root: string;
  qual_root: string;
  ledger: number;
  timestamp: string;
}

export interface TierStatus {
  accessor: string;
  is_granted: boolean;
  grant: TierGrant | null;
  tierGateId: string;
}

export const getTierInfo = () => fetch(`${BASE}/bonded/tier/info`).then(j<TierInfo>);

export const enrollTier = () =>
  post<{ ok: boolean; memberIndex: number; memberCount: number; memberRoot: string; minted: TierIdentity }>(
    "/bonded/tier/enroll",
    { mint: true },
  );

export const getTierQualSet = (threshold: string, unlockAfter: number) =>
  fetch(`${BASE}/bonded/tier/qual-set?threshold=${threshold}&unlock_after=${unlockAfter}`).then(j<TierQualSet>);

export const proveTier = (body: {
  idSecret: string;
  idTrapdoor: string;
  holderSeed: string;
  threshold: string;
  unlock_after: number;
}) =>
  post<{ jobId: string; accessor: string; nullifier: string; qualRoot: string; memberRoot: string; anonSetSize: number }>(
    "/bonded/tier/prove",
    body,
  );

// Submit the tier proof to the gate. PERMISSIONLESS — the in-guest holder signature carries the accessor's
// consent, so the backend relays (the member never reveals or pays from a funded wallet).
export const submitTier = (bundle: Bundle) =>
  post<WalletWriteResult & { grant?: TierGrant }>("/bonded/tier/submit", { ...bundle });

export const getTierStatus = (accessor: string) =>
  fetch(`${BASE}/bonded/tier/status?accessor=${accessor}`).then(j<TierStatus>);

// ── Bonded Access (BA4/BA5): anonymous per-requirement bond gating wired into the Data Room ──
// The room owner sets ONE bond requirement (token, min amount, deadline); a reader opening any of the room's
// documents proves a qualifying anonymous bond, which ALSO proves room membership (Option A). Owner writes are
// wallet-signed (the contract requires room-owner auth); the reader's prove/submit mirrors the tier path.

export interface BondRequirement {
  found: boolean;
  scope?: "room" | "doc" | null;
  gate?: string;
  reqId?: string;
  token?: string;
  minAmount?: string; // base units
  deadline?: number; // unix seconds
  /** TRUE bond-only (no-approval) mode: a reader needs only a qualifying bond, no membership/approval. */
  bondOpen?: boolean;
  mode?: "open" | "membership";
}

export interface BondQualLockView {
  id: number;
  commitment: string;
  amount: string;
  unlock_time: number;
  depositor: string;
}

export interface BondQualSet {
  token: string;
  minAmount: string;
  deadline: number;
  reqId: string;
  anonSetSize: number;
  minAnonSet: number;
  belowMin: boolean;
  computedRoot: string;
  published: boolean;
  ringLen: number;
  locks: BondQualLockView[];
}

// Read the EFFECTIVE Bonded Access requirement for a room (or, with docId, the per-doc override falling back
// to the room one). found:false means the room/document is not bonded.
export const getBondRequirementApi = (roomId: string, docId?: string) =>
  fetch(`${BASE}/dataroom/bond-requirement/${roomId}${docId ? `?doc=${encodeURIComponent(docId)}` : ""}`).then(
    j<BondRequirement>,
  );

// Read the qualifying-bond set + the gate ring for a requirement (the reader's anonymity count + whether
// their own commitment qualifies — `locks[].commitment`).
export const getBondQualSet = (token: string, minAmount: string, deadline: number) =>
  fetch(
    `${BASE}/bonded/bond/qual-set?token=${encodeURIComponent(token)}&min_amount=${minAmount}&deadline=${deadline}`,
  ).then(j<BondQualSet>);

// Owner: set (or replace) the room-level bond requirement (wallet-signed; the contract requires room-owner
// auth). Returns the derived req_id + the room's approved-member count (0 => the bond leg fails closed).
export const setBondRequirement = (
  roomId: string,
  req: { token: string; minAmount: string; deadline: number },
  signer: TxSigner,
  // "open" = TRUE bond-only (no approval, no membership); "membership" = the legacy bond-implies-membership
  // path. Room Management uses "open".
  mode: "open" | "membership" = "open",
): Promise<WalletWriteResult & { reqId?: string; memberCount?: string; mode?: string }> =>
  writeViaWallet(
    "/dataroom/bond-requirement",
    { roomId, token: req.token, min_amount: req.minAmount, deadline: req.deadline, mode },
    signer,
  );

// Owner: clear the room-level bond requirement (wallet-signed). The room falls back to plain membership.
export const clearBondRequirement = (roomId: string, signer: TxSigner): Promise<WalletWriteResult> =>
  writeViaWallet("/dataroom/bond-requirement/clear", { roomId }, signer);

// Publish (or refresh) the qualifying-set root for a requirement on the bond gate (admin relay; refuses below
// the anonymity floor). Best-effort after the owner sets a requirement or a reader deposits.
export const publishBondQualRoot = (token: string, minAmount: string, deadline: number) =>
  post<{ ok: boolean; txHash?: string; reqId?: string; qualRoot?: string; anonSetSize?: number; minAnonSet?: number; error?: string }>(
    "/bonded/bond/qual-root",
    { token, min_amount: minAmount, deadline },
  );

// Reader: build + enqueue the bond proof (kind=bond) worker-first. The witness (id_secret/id_trapdoor/holder
// seed) reaches the self-hosted prover only. Poll getProveStatus(jobId), then submitBond(bundle).
export const proveBond = (body: {
  roomId: string;
  idSecret: string;
  idTrapdoor: string;
  holderSeed: string;
  token: string;
  minAmount: string;
  deadline: number;
  background?: boolean; // when true, the backend finishes (poll + submit) so the caller can leave
}) =>
  post<{ jobId?: string; roomId?: string; reqId?: string; memberRoot?: string; qualRoot?: string; nullifier?: string; accessor?: string; anonSetSize?: number; background?: boolean; error?: string }>(
    "/bonded/bond/prove",
    {
      roomId: body.roomId,
      idSecret: body.idSecret,
      idTrapdoor: body.idTrapdoor,
      holderSeed: body.holderSeed,
      token: body.token,
      min_amount: body.minAmount,
      deadline: body.deadline,
      background: body.background ?? false,
    },
  );

// Submit the bond proof to the gate. PERMISSIONLESS — the in-guest holder signature is the consent, so the
// backend relays (the reader never reveals or pays from a funded wallet). Grant or a contract error.
export const submitBond = (bundle: Bundle) =>
  post<WalletWriteResult & { grant?: unknown }>("/bonded/bond/submit", { ...bundle });

// Reader (TRUE bond-only): build + enqueue the bond-OPEN proof (kind=bond-open). NO membership/enrollment —
// the proof asserts only a qualifying bond + carries a proof-bound recipient_pub for the keepers. Poll
// getProveStatus(jobId), then submitBondOpen(bundle); or pass background:true to have the backend finish it.
export const proveBondOpen = (body: {
  idSecret: string;
  idTrapdoor: string;
  holderSeed: string;
  recipientPub: string;
  token: string;
  minAmount: string;
  deadline: number;
  background?: boolean;
}) =>
  post<{ jobId?: string; reqId?: string; qualRoot?: string; nullifier?: string; accessor?: string; recipientPub?: string; anonSetSize?: number; background?: boolean; error?: string }>(
    "/bonded/bond-open/prove",
    {
      idSecret: body.idSecret,
      idTrapdoor: body.idTrapdoor,
      holderSeed: body.holderSeed,
      recipientPub: body.recipientPub,
      token: body.token,
      min_amount: body.minAmount,
      deadline: body.deadline,
      background: body.background ?? false,
    },
  );

// Submit a bond-open proof to the gate (PERMISSIONLESS).
export const submitBondOpen = (bundle: Bundle) =>
  post<WalletWriteResult & { grant?: unknown }>("/bonded/bond-open/submit", { ...bundle });

// ── Bonded Access (standalone): the same per-requirement bond gate as the Data Room, but with its OWN member
// context, so a user can pick ANY token + amount + deadline, bond, and prove anonymously without a room. The
// anonymity set is still per req_id (everyone who bonded the same requirement), so it grows with adoption and
// the backend refuses to prove below the floor. enroll -> bond a qualifying lock -> prove -> submit -> status.

export interface BondInfo {
  bondGateId: string | null;
  imageId: string;
  minAnonSet: number;
  escrowId: string;
  standaloneSetId: string;
  standaloneEnrolledCount: number;
  standaloneMemberRoot: string | null;
  grantCount: number;
}

/** A demo bond identity minted by the backend (in production the member holds these client-side). Same shape
 *  + scheme as a tier identity. */
export interface BondIdentity {
  idSecret: string;
  idTrapdoor: string;
  holderSeed: string;
  accessor: string;
  qualCommitment: string;
}

export interface BondGrant {
  index: number;
  accessor: string;
  req_id: string;
  deadline: string;
  nullifier: string;
  member_root: string;
  qual_root: string;
  ledger: number;
  timestamp: string;
}

export interface BondStatus {
  accessor: string;
  reqId: string;
  is_granted: boolean;
  grant: BondGrant | null;
  bondGateId: string;
}

export const getBondInfo = () => fetch(`${BASE}/bonded/bond/info`).then(j<BondInfo>);

export const enrollBond = () =>
  post<{ ok: boolean; setId: string; memberIndex: number; memberCount: number; memberRoot: string; minted?: BondIdentity }>(
    "/bonded/bond/enroll",
    { mint: true },
  );

export const getBondStatus = (accessor: string, reqId: string) =>
  fetch(`${BASE}/bonded/bond/status?accessor=${accessor}&req_id=${reqId}`).then(j<BondStatus>);

// The Bonded Access handle vault: an opaque encrypted blob (the handle secret, encrypted in the browser under
// a wallet-signature-derived key) stored under a wallet-derived pseudonym, so the handle follows the wallet.
// Same opaque shape as the rooms vault blob.
export type BondHandleVaultBlob = RoomsVaultBlob;
export const getBondHandleVault = (handle: string) =>
  fetch(`${BASE}/bonded/bond/handle-vault/${handle}`).then(j<{ found: boolean; blob: BondHandleVaultBlob | null }>);
export const putBondHandleVault = (handle: string, blob: BondHandleVaultBlob) =>
  fetch(`${BASE}/bonded/bond/handle-vault/${handle}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob }),
  }).then(j<{ ok: boolean }>);
export const deleteBondHandleVault = (handle: string) =>
  fetch(`${BASE}/bonded/bond/handle-vault/${handle}`, { method: "DELETE" }).then(j<{ ok: boolean; removed: boolean }>);

// The Bonded Access "Your access" list vault: the handle's grant records, encrypted under the same wallet
// signature (distinct key/id) and stored under a wallet-derived pseudonym, so the list follows the wallet.
export type BondGrantsVaultBlob = RoomsVaultBlob;
export const getBondGrantsVault = (handle: string) =>
  fetch(`${BASE}/bonded/bond/grants-vault/${handle}`).then(j<{ found: boolean; blob: BondGrantsVaultBlob | null }>);
export const putBondGrantsVault = (handle: string, blob: BondGrantsVaultBlob) =>
  fetch(`${BASE}/bonded/bond/grants-vault/${handle}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob }),
  }).then(j<{ ok: boolean }>);
export const deleteBondGrantsVault = (handle: string) =>
  fetch(`${BASE}/bonded/bond/grants-vault/${handle}`, { method: "DELETE" }).then(j<{ ok: boolean; removed: boolean }>);
