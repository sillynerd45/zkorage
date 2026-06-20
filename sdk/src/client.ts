// ZkorageClient — read-only, trust-minimized access to the zkorage Proof-of-Reserves engine.
//
// Every method reads straight from a PUBLIC Soroban RPC + the public contracts via `simulateTransaction`
// — no backend, no private keys. `verifyBundle` recomputes the journal digest itself and asks the public
// verifier contract to confirm the Groth16 proof, so a third party never has to trust our server.
import {
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { TESTNET } from "./defaults.js";
import { decodeJournal, decodeIdentityJournal, decodeComplianceJournal, decodePayrollJournal, decodeDataroomSealJournal, decodeMembershipJournal, decodeDocauthJournal, decodeTierJournal, fromHex, toHex, bytesToHex, sha256Hex } from "./journal.js";
import { sha256 } from "@noble/hashes/sha256";
import { openDisclosure, type OpenedDisclosure } from "./disclosure.js";
import { recoverDocumentKey, aeadDecrypt } from "./dataroom.js";
import { openShare, reconstructWithCommitment, type SealedShareHex, type OpenedShare } from "./committee.js";
import type {
  AccessRecord,
  AuditBundle,
  AuditChecklist,
  Bundle,
  ComplianceAccessRecord,
  ComplianceAnswer,
  ComplianceChecklist,
  ComplianceConfig,
  ComplianceVerifyResult,
  DecodedComplianceJournal,
  DecodedIdentityJournal,
  DecodedPayrollJournal,
  GateConfig,
  IdentityChecklist,
  IdentityVerifyResult,
  IncomeAnswer,
  KycAnswer,
  PayrollAccessRecord,
  PayrollChecklist,
  PayrollConfig,
  PayrollVerifyResult,
  PolicyConfig,
  ReservesAnswer,
  VerifiedResult,
  VerifyResult,
  ZkorageConfig,
  AccreditedConfig,
  FundraiseConfig,
  RevenueRecord,
  InvestorAccess,
  RevenueChecklist,
  RevenueVerifyResult,
  AccreditedAnswer,
  FundraiseAccessAnswer,
  DecodedJournal,
  DataroomConfig,
  Room,
  DataroomDocument,
  OpenedDocument,
  CommitteeDocument,
  OpenedCommitteeDocument,
  DataroomSealChecklist,
  DataroomVerifyResult,
  DecodedDataroomSealJournal,
  DecodedMembershipJournal,
  MembershipGrant,
  MembershipChecklist,
  MembershipVerifyResult,
  DocumentFact,
  DecodedDocauthJournal,
  DocauthChecklist,
  DocauthVerifyResult,
  Teaser,
  TeaserChecklist,
  TeaserVerifyResult,
  RoomPolicy,
  Admission,
  RoomAccess,
  SolvencyConfig,
  SolvencyRecord,
  SolvencyAnswer,
  TierConfig,
  TierGrant,
  TierAnswer,
  DecodedTierJournal,
  RecomputedQualRoot,
  TierChecklist,
  TierVerifyResult,
} from "./types.js";

/** Constructor options — any field of `ZkorageConfig` may be overridden, including a subset of `contracts`. */
export type ZkorageOptions = Partial<Omit<ZkorageConfig, "contracts">> & {
  contracts?: Partial<ZkorageConfig["contracts"]>;
};

const scBytes = (hex: string): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
const scU32 = (n: number): xdr.ScVal => nativeToScVal(n >>> 0, { type: "u32" });
const scU64 = (v: bigint | string | number): xdr.ScVal => nativeToScVal(BigInt(v), { type: "u64" });
const scAddress = (g: string): xdr.ScVal => new Address(g).toScVal();

function normalizeResult(raw: unknown): VerifiedResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: r.index !== undefined ? Number(r.index) : undefined,
    result: Boolean(r.result),
    supply: String(r.supply),
    issuer_id: bytesToHex(r.issuer_id),
    claim_type: Number(r.claim_type),
    nonce: String(r.nonce),
    expiry: String(r.expiry),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizeAccess(raw: unknown): AccessRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: r.index !== undefined ? Number(r.index) : undefined,
    accessor: bytesToHex(r.accessor),
    issuer_id: bytesToHex(r.issuer_id),
    claim_type: Number(r.claim_type),
    nonce: String(r.nonce),
    expiry: String(r.expiry),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizeComplianceAccess(raw: unknown): ComplianceAccessRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: r.index !== undefined ? Number(r.index) : undefined,
    accessor: bytesToHex(r.accessor),
    issuer_id: bytesToHex(r.issuer_id),
    deny_root: bytesToHex(r.deny_root),
    claim_type: Number(r.claim_type),
    nonce: String(r.nonce),
    expiry: String(r.expiry),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizePayrollAccess(raw: unknown): PayrollAccessRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: r.index !== undefined ? Number(r.index) : undefined,
    accessor: bytesToHex(r.accessor),
    issuer_id: bytesToHex(r.issuer_id),
    threshold: String(r.threshold),
    auditor_pub: bytesToHex(r.auditor_pub),
    eph_pub: bytesToHex(r.eph_pub),
    ct: bytesToHex(r.ct),
    tag: bytesToHex(r.tag),
    claim_type: Number(r.claim_type),
    nonce: String(r.nonce),
    expiry: String(r.expiry),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizeRevenue(raw: unknown): RevenueRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    threshold: String(r.threshold),
    issuer_id: bytesToHex(r.issuer_id),
    claim_type: Number(r.claim_type),
    nonce: String(r.nonce),
    expiry: String(r.expiry),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizeSolvencyRecord(raw: unknown): SolvencyRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: r.index !== undefined ? Number(r.index) : undefined,
    depositor: String(r.depositor),
    issuer_id: bytesToHex(r.issuer_id),
    supply: String(r.supply),
    lock_id: String(r.lock_id),
    min_amount: String(r.min_amount),
    expiry: String(r.expiry),
    nonce: String(r.nonce),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizeTierGrant(raw: unknown): TierGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: r.index !== undefined ? Number(r.index) : undefined,
    accessor: bytesToHex(r.accessor),
    threshold: String(r.threshold),
    unlock_after: String(r.unlock_after),
    context: bytesToHex(r.context),
    nullifier: bytesToHex(r.nullifier),
    member_root: bytesToHex(r.member_root),
    qual_root: bytesToHex(r.qual_root),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

/** A rejection from `get_lock` on a nonexistent id is a CONTRACT error (LockNotFound = past the end of the
 *  scan); a network/RPC failure is not. Mirrors the backend indexer so the trustless audit treats the two
 *  the same way the published root was built. */
function isContractError(reason: unknown): boolean {
  return /contract/i.test(String((reason as Error)?.message ?? reason));
}

/** Fold a depth-20 sparse Merkle root over ordered leaves: node = sha256(0x01‖L‖R), empty leaf = 0^32.
 *  Matches the tier guest + the backend qual-tree builder (a root-only recompute for the trustless audit). */
function merkleRootDepth20(leaves: Uint8Array[]): Uint8Array {
  const DEPTH = 20;
  const node = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const buf = new Uint8Array(1 + a.length + b.length);
    buf[0] = 0x01;
    buf.set(a, 1);
    buf.set(b, 1 + a.length);
    return sha256(buf);
  };
  const zero: Uint8Array[] = [new Uint8Array(32)];
  for (let k = 1; k <= DEPTH; k++) zero[k] = node(zero[k - 1], zero[k - 1]);
  let level = new Map<number, Uint8Array>();
  leaves.forEach((c, i) => level.set(i, c));
  for (let d = 0; d < DEPTH; d++) {
    const next = new Map<number, Uint8Array>();
    const parents = new Set<number>();
    for (const idx of level.keys()) parents.add(idx >> 1);
    for (const p of parents) {
      const l = level.get(p * 2) ?? zero[d];
      const rr = level.get(p * 2 + 1) ?? zero[d];
      next.set(p, node(l, rr));
    }
    level = next;
  }
  return level.get(0) ?? zero[DEPTH];
}

function normalizeInvestorAccess(raw: unknown): InvestorAccess | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: r.index !== undefined ? Number(r.index) : undefined,
    accessor: bytesToHex(r.accessor),
    revenue_threshold: String(r.revenue_threshold),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizeRoom(raw: unknown): Room | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: Number(r.index),
    room_id: bytesToHex(r.room_id),
    owner: String(r.owner),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

/** Decode a blob_pointer (stored on-chain as the UTF-8 bytes of a string → hex here) back to its string. */
function decodeBlobPointer(v: unknown): string {
  const h = bytesToHex(v);
  if (/^([0-9a-f]{2})*$/i.test(h)) {
    try { return new TextDecoder().decode(fromHex(h)); } catch { /* fall through */ }
  }
  return h;
}

function normalizeDocument(raw: unknown): DataroomDocument | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: Number(r.index),
    room_id: bytesToHex(r.room_id),
    doc_id: bytesToHex(r.doc_id),
    recipient_pub: bytesToHex(r.recipient_pub),
    content_hash: bytesToHex(r.content_hash),
    eph_pub: bytesToHex(r.eph_pub),
    ct: bytesToHex(r.ct),
    tag: bytesToHex(r.tag),
    blob_pointer: decodeBlobPointer(r.blob_pointer),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizeGrant(raw: unknown): MembershipGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: Number(r.index),
    room_id: bytesToHex(r.room_id),
    accessor: bytesToHex(r.accessor),
    recipient_pub: bytesToHex(r.recipient_pub),
    eligible_root: bytesToHex(r.eligible_root),
    nullifier: bytesToHex(r.nullifier),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizeCommitteeDocument(raw: unknown): CommitteeDocument | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: Number(r.index),
    room_id: bytesToHex(r.room_id),
    doc_id: bytesToHex(r.doc_id),
    content_hash: bytesToHex(r.content_hash),
    k_commitment: bytesToHex(r.k_commitment),
    blob_pointer: decodeBlobPointer(r.blob_pointer),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizeDocumentFact(raw: unknown): DocumentFact | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: Number(r.index),
    room_id: bytesToHex(r.room_id),
    msg_digest: bytesToHex(r.msg_digest),
    field_tag: Number(r.field_tag),
    threshold: String(r.threshold),
    issuer_key_hash: bytesToHex(r.issuer_key_hash),
    attester: String(r.attester),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizeTeaser(raw: unknown): Teaser | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: Number(r.index),
    room_id: bytesToHex(r.room_id),
    doc_id: bytesToHex(r.doc_id),
    content_hash: bytesToHex(r.content_hash),
    field_tag: Number(r.field_tag),
    threshold: String(r.threshold),
    attester: bytesToHex(r.attester),
    expiry: String(r.expiry),
    asserter: String(r.asserter),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

function normalizeRoomPolicy(raw: unknown): RoomPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const gate = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    require_membership: Boolean(r.require_membership),
    compliance_gate: gate(r.compliance_gate),
    accredited_gate: gate(r.accredited_gate),
  };
}

function normalizeAdmission(raw: unknown): Admission | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    index: Number(r.index),
    room_id: bytesToHex(r.room_id),
    accessor: bytesToHex(r.accessor),
    required_compliance: Boolean(r.required_compliance),
    required_accredited: Boolean(r.required_accredited),
    ledger: Number(r.ledger),
    timestamp: String(r.timestamp),
  };
}

/** Options for the key-free committee opener `openCommitteeDocument`. */
export interface CommitteeOpenOpts {
  /** Custom share collector (highest precedence). */
  collectShares?: (roomIdHex: string, docIdHex: string, accessorHex: string) => Promise<{ recipientPub: string; shares: SealedShareHex[] }>;
  /** Hit each keyper's /share directly (the trust-clean path — no aggregator). */
  keyperEndpoints?: string[];
  /** The backend's committee aggregator base URL (POST /dataroom/committee/collect/:room/:doc). */
  committeeBaseUrl?: string;
  /** Reconstruction threshold (default 2). */
  threshold?: number;
  /** Blob source (same precedence as openDocument). */
  fetchBlob?: (contentHash: string) => Promise<Uint8Array>;
  blobBaseUrl?: string;
}

export class ZkorageClient {
  readonly cfg: ZkorageConfig;
  private srv: rpc.Server;

  constructor(cfg: ZkorageOptions = {}) {
    this.cfg = {
      ...TESTNET,
      ...cfg,
      contracts: { ...TESTNET.contracts, ...(cfg.contracts ?? {}) },
    };
    this.srv = new rpc.Server(this.cfg.rpcUrl, { allowHttp: this.cfg.rpcUrl.startsWith("http://") });
  }

  /** Simulate a read-only call against the public RPC; returns the decoded native value. */
  private async simRead(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<unknown> {
    const src = await this.srv.getAccount(this.cfg.readSource);
    const tx = new TransactionBuilder(src, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.srv.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
    const ret = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    return ret ? scValToNative(ret) : null;
  }

  // ---- trustless on-chain reads ----

  async getConfig(): Promise<PolicyConfig> {
    const c = (await this.simRead(this.cfg.contracts.policy, "get_config")) as Record<string, unknown>;
    return {
      admin: String(c.admin),
      verifier: String(c.verifier),
      token: String(c.token),
      image_id: bytesToHex(c.image_id),
      claim_type: Number(c.claim_type),
    };
  }

  async getSupply(): Promise<string> {
    return String(await this.simRead(this.cfg.contracts.token, "total_supply"));
  }

  async getCount(): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.policy, "get_count")) ?? 0);
  }

  async getLatestResult(): Promise<VerifiedResult | null> {
    return normalizeResult(await this.simRead(this.cfg.contracts.policy, "get_latest_result"));
  }

  async getResult(issuerIdHex: string): Promise<VerifiedResult | null> {
    return normalizeResult(
      await this.simRead(this.cfg.contracts.policy, "get_result", [scBytes(issuerIdHex)]),
    );
  }

  async getByIndex(index: number): Promise<VerifiedResult | null> {
    return normalizeResult(
      await this.simRead(this.cfg.contracts.policy, "get_by_index", [scU32(index)]),
    );
  }

  async getHistory(start = 0, limit = 50): Promise<VerifiedResult[]> {
    const rows = (await this.simRead(this.cfg.contracts.policy, "get_history", [
      scU32(start),
      scU32(Math.min(50, Math.max(1, limit))),
    ])) as unknown[];
    return (rows ?? []).map(normalizeResult).filter((r): r is VerifiedResult => r !== null);
  }

  async isIssuerAllowed(issuerIdHex: string): Promise<boolean> {
    return (await this.simRead(this.cfg.contracts.policy, "is_issuer_allowed", [scBytes(issuerIdHex)])) === true;
  }

  // ---- gate (KYC identity) trustless on-chain reads ----

  async getGateConfig(): Promise<GateConfig> {
    const c = (await this.simRead(this.cfg.contracts.gate, "get_config")) as Record<string, unknown>;
    return {
      admin: String(c.admin),
      verifier: String(c.verifier),
      image_id: bytesToHex(c.image_id),
      claim_type: Number(c.claim_type),
    };
  }

  /** True iff this accessor (32-byte hex) holds a CURRENTLY-VALID KYC grant — the on-chain gate
   * re-checks the credential's expiry against ledger time, so an expired grant returns false.
   * (`getAccess` returns the raw record regardless of expiry.) */
  async isGranted(accessorHex: string): Promise<boolean> {
    return (await this.simRead(this.cfg.contracts.gate, "is_granted", [scBytes(accessorHex)])) === true;
  }

  async getAccess(accessorHex: string): Promise<AccessRecord | null> {
    return normalizeAccess(await this.simRead(this.cfg.contracts.gate, "get_access", [scBytes(accessorHex)]));
  }

  async getLatestAccess(): Promise<AccessRecord | null> {
    return normalizeAccess(await this.simRead(this.cfg.contracts.gate, "get_latest_access"));
  }

  async getAccessCount(): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.gate, "get_count")) ?? 0);
  }

  async getAccessHistory(start = 0, limit = 50): Promise<AccessRecord[]> {
    const rows = (await this.simRead(this.cfg.contracts.gate, "get_history", [
      scU32(start),
      scU32(Math.min(50, Math.max(1, limit))),
    ])) as unknown[];
    return (rows ?? []).map(normalizeAccess).filter((r): r is AccessRecord => r !== null);
  }

  async isGateIssuerAllowed(issuerIdHex: string): Promise<boolean> {
    return (await this.simRead(this.cfg.contracts.gate, "is_issuer_allowed", [scBytes(issuerIdHex)])) === true;
  }

  // ---- compliance gate (KYC ∧ not-sanctioned) trustless on-chain reads ----

  async getComplianceConfig(): Promise<ComplianceConfig> {
    const c = (await this.simRead(this.cfg.contracts.compliance, "get_config")) as Record<string, unknown>;
    return {
      admin: String(c.admin),
      verifier: String(c.verifier),
      image_id: bytesToHex(c.image_id),
      claim_type: Number(c.claim_type),
      deny_root: bytesToHex(c.deny_root),
    };
  }

  /** The authoritative sanctions deny-list Merkle root the compliance gate pins (32-byte hex). */
  async getDenyRoot(): Promise<string> {
    return bytesToHex(await this.simRead(this.cfg.contracts.compliance, "get_deny_root"));
  }

  /** True iff this accessor holds a CURRENTLY-VALID "KYC'd & not-sanctioned" grant (expiry re-checked
   * on-chain). `getComplianceAccess` returns the raw record regardless of expiry. */
  async isComplianceGranted(accessorHex: string): Promise<boolean> {
    return (await this.simRead(this.cfg.contracts.compliance, "is_granted", [scBytes(accessorHex)])) === true;
  }

  async getComplianceAccess(accessorHex: string): Promise<ComplianceAccessRecord | null> {
    return normalizeComplianceAccess(await this.simRead(this.cfg.contracts.compliance, "get_access", [scBytes(accessorHex)]));
  }

  async getLatestComplianceAccess(): Promise<ComplianceAccessRecord | null> {
    return normalizeComplianceAccess(await this.simRead(this.cfg.contracts.compliance, "get_latest_access"));
  }

  async getComplianceCount(): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.compliance, "get_count")) ?? 0);
  }

  async getComplianceHistory(start = 0, limit = 50): Promise<ComplianceAccessRecord[]> {
    const rows = (await this.simRead(this.cfg.contracts.compliance, "get_history", [
      scU32(start),
      scU32(Math.min(50, Math.max(1, limit))),
    ])) as unknown[];
    return (rows ?? []).map(normalizeComplianceAccess).filter((r): r is ComplianceAccessRecord => r !== null);
  }

  async isComplianceIssuerAllowed(issuerIdHex: string): Promise<boolean> {
    return (await this.simRead(this.cfg.contracts.compliance, "is_issuer_allowed", [scBytes(issuerIdHex)])) === true;
  }

  // ---- payroll gate (proof-of-income + auditor view-key) trustless on-chain reads ----

  async getPayrollConfig(): Promise<PayrollConfig> {
    const c = (await this.simRead(this.cfg.contracts.payroll, "get_config")) as Record<string, unknown>;
    return {
      admin: String(c.admin),
      verifier: String(c.verifier),
      image_id: bytesToHex(c.image_id),
      claim_type: Number(c.claim_type),
    };
  }

  /** True iff this accessor holds a CURRENTLY-VALID income-verified grant (expiry re-checked on-chain).
   * `getPayrollAccess` returns the raw record regardless of expiry. The salary stays hidden either way. */
  async isPayrollGranted(accessorHex: string): Promise<boolean> {
    return (await this.simRead(this.cfg.contracts.payroll, "is_granted", [scBytes(accessorHex)])) === true;
  }

  async getPayrollAccess(accessorHex: string): Promise<PayrollAccessRecord | null> {
    return normalizePayrollAccess(await this.simRead(this.cfg.contracts.payroll, "get_access", [scBytes(accessorHex)]));
  }

  async getLatestPayrollAccess(): Promise<PayrollAccessRecord | null> {
    return normalizePayrollAccess(await this.simRead(this.cfg.contracts.payroll, "get_latest_access"));
  }

  async getPayrollCount(): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.payroll, "get_count")) ?? 0);
  }

  async getPayrollHistory(start = 0, limit = 50): Promise<PayrollAccessRecord[]> {
    const rows = (await this.simRead(this.cfg.contracts.payroll, "get_history", [
      scU32(start),
      scU32(Math.min(50, Math.max(1, limit))),
    ])) as unknown[];
    return (rows ?? []).map(normalizePayrollAccess).filter((r): r is PayrollAccessRecord => r !== null);
  }

  async isPayrollIssuerAllowed(issuerIdHex: string): Promise<boolean> {
    return (await this.simRead(this.cfg.contracts.payroll, "is_issuer_allowed", [scBytes(issuerIdHex)])) === true;
  }

  async isAuditorAllowed(auditorPubHex: string): Promise<boolean> {
    return (await this.simRead(this.cfg.contracts.payroll, "is_auditor_allowed", [scBytes(auditorPubHex)])) === true;
  }

  /**
   * AUDITOR VIEW-KEY: open an accessor's on-chain disclosure with the auditor's view-key secret →
   * `{ salary, faithful }`. Reads the disclosure straight from the chain; the decrypt + tag-verify is
   * local. The caller supplies their own `viewKeyHex` — the SDK NEVER custodies it. `faithful=false`
   * means a wrong key or tampered ciphertext. Returns null if there's no grant for the accessor.
   */
  async openPayrollDisclosure(accessorHex: string, viewKeyHex: string): Promise<OpenedDisclosure | null> {
    const rec = await this.getPayrollAccess(accessorHex);
    if (!rec) return null;
    return openDisclosure({ ephPub: rec.eph_pub, ct: rec.ct, tag: rec.tag }, viewKeyHex);
  }

  // ---- the headline agent question ----

  /**
   * Is the (latest, or a specific issuer's) verified claim currently `reserves ≥ supply`?
   * Answers from the on-chain persisted result PLUS a live freshness check (the bound supply must
   * still equal the live circulating supply — i.e. no mint/burn since proving). For a full Groth16
   * re-verification use {@link verifyBundle}.
   */
  async isReservesGteSupply(issuerIdHex?: string): Promise<ReservesAnswer> {
    const result = issuerIdHex ? await this.getResult(issuerIdHex) : await this.getLatestResult();
    if (!result) return { answer: false, boundSupply: null, liveSupply: null, fresh: false, result: null };
    const liveSupply = await this.getSupply();
    const fresh = result.supply === liveSupply;
    const notExpired = BigInt(result.expiry) > BigInt(Math.floor(Date.now() / 1000));
    // The claim is currently valid iff it verified true, its bound supply still equals live supply,
    // and the attestation hasn't expired since it was submitted.
    return { answer: result.result === true && fresh && notExpired, boundSupply: result.supply, liveSupply, fresh, result };
  }

  /**
   * Is this accessor currently KYC-gated? `answer` is the AUTHORITATIVE on-chain `is_granted` decision
   * (the gate re-checks the credential's expiry against ledger time); the raw `record` is returned too
   * for audit. Mirrors {@link isCompliant} so the SDK answer always tracks on-chain truth even if the
   * gate's `is_granted` later gains richer checks. For a full Groth16 re-verification use
   * {@link verifyIdentityBundle}.
   */
  async isKycVerified(accessorHex: string): Promise<KycAnswer> {
    const [answer, record] = await Promise.all([
      this.isGranted(accessorHex),
      this.getAccess(accessorHex),
    ]);
    return { answer, accessor: accessorHex, record };
  }

  /**
   * Is this accessor currently compliant (KYC'd AND not-sanctioned)? `answer` is the AUTHORITATIVE
   * on-chain `is_granted` decision — the gate re-checks both the credential expiry AND that the grant
   * was verified against the CURRENT sanctions deny-list root (so a re-pin of the list revokes stale
   * grants). The raw `record` is returned too (for audit). For a full Groth16 re-verification of a proof
   * bundle use {@link verifyComplianceBundle}.
   */
  async isCompliant(accessorHex: string): Promise<ComplianceAnswer> {
    const [answer, record] = await Promise.all([
      this.isComplianceGranted(accessorHex),
      this.getComplianceAccess(accessorHex),
    ]);
    return { answer, accessor: accessorHex, record };
  }

  /**
   * Is this accessor currently income-verified (a signed salary ≥ the recorded threshold)? `answer` is
   * the AUTHORITATIVE on-chain `is_granted` decision (expiry re-checked). The raw `record` (incl. the
   * cleared `threshold` and the opaque auditor disclosure) is returned too. The salary stays hidden —
   * only the auditor's view key opens it ({@link openPayrollDisclosure}). For a full Groth16 re-verify of
   * a bundle use {@link verifyPayrollBundle}.
   */
  async isIncomeVerified(accessorHex: string): Promise<IncomeAnswer> {
    const [answer, record] = await Promise.all([
      this.isPayrollGranted(accessorHex),
      this.getPayrollAccess(accessorHex),
    ]);
    return { answer, accessor: accessorHex, record };
  }

  // ---- full independent re-verification of a proof bundle ----

  /**
   * Re-verify a proof bundle entirely against the public chain: recompute sha256(journal), check the
   * image-id pin + journal policy fields, ask the bare verifier to confirm the Groth16 proof, and
   * check the supply binding against live supply. Returns a per-check checklist + overall verdict.
   */
  async verifyBundle(bundle: Bundle): Promise<VerifyResult> {
    const notes: string[] = [];
    const cl: AuditChecklist = {
      journalWellFormed: false, digestMatches: false, imagePinned: false, resultTrue: false,
      claimTypeOk: false, issuerAllowed: false, notExpired: false, proofValidOnChain: false,
      supplyBoundMatches: false, verdict: false,
    };
    const dj = decodeJournal(bundle.journal);
    if (!dj) {
      notes.push("journal malformed");
      return { verdict: false, checklist: cl, decodedJournal: { result: false, claimType: 0, issuerId: "", supply: "0", nonce: "0", expiry: "0" }, recomputedDigest: "", liveSupply: null, notes };
    }
    cl.journalWellFormed = true;
    cl.resultTrue = dj.result === true;
    cl.notExpired = BigInt(dj.expiry) > BigInt(Math.floor(Date.now() / 1000));
    const recomputed = sha256Hex(fromHex(bundle.journal));
    cl.digestMatches = !bundle.journal_digest || bundle.journal_digest.toLowerCase() === recomputed;

    try {
      const cfg = await this.getConfig();
      cl.imagePinned = cfg.image_id.toLowerCase() === bundle.image_id.toLowerCase();
      cl.claimTypeOk = dj.claimType === cfg.claim_type;
    } catch (e) { notes.push("get_config: " + msg(e)); }

    try { cl.issuerAllowed = await this.isIssuerAllowed(dj.issuerId); }
    catch (e) { notes.push("is_issuer_allowed: " + msg(e)); }

    try {
      await this.simRead(this.cfg.contracts.verifier, "verify", [
        scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(recomputed),
      ]);
      cl.proofValidOnChain = true; // simulate succeeded → verifier returned Ok
    } catch (e) { notes.push("verify: " + msg(e)); }

    let liveSupply: string | null = null;
    try { liveSupply = await this.getSupply(); cl.supplyBoundMatches = liveSupply === dj.supply; }
    catch (e) { notes.push("total_supply: " + msg(e)); }

    cl.verdict = cl.journalWellFormed && cl.digestMatches && cl.imagePinned && cl.resultTrue &&
      cl.claimTypeOk && cl.issuerAllowed && cl.notExpired && cl.proofValidOnChain && cl.supplyBoundMatches;
    return { verdict: cl.verdict, checklist: cl, decodedJournal: dj, recomputedDigest: recomputed, liveSupply, notes };
  }

  /**
   * Re-verify an IDENTITY (KYC) proof bundle against the public chain: recompute sha256(journal),
   * check the gate's image-id pin + journal policy (result, claim_type, allow-listed KYC issuer,
   * freshness), and ask the bare verifier to confirm the Groth16 proof. No supply binding — the
   * accessor is the binding, and the subject stays hidden. Returns a per-check checklist + verdict.
   */
  async verifyIdentityBundle(bundle: Bundle): Promise<IdentityVerifyResult> {
    const notes: string[] = [];
    const cl: IdentityChecklist = {
      journalWellFormed: false, digestMatches: false, imagePinned: false, resultTrue: false,
      claimTypeOk: false, issuerAllowed: false, notExpired: false, proofValidOnChain: false, verdict: false,
    };
    const empty: DecodedIdentityJournal = { result: false, claimType: 0, issuerId: "", accessor: "", nonce: "0", expiry: "0" };
    const dj = decodeIdentityJournal(bundle.journal);
    if (!dj) {
      notes.push("identity journal malformed");
      return { verdict: false, checklist: cl, decodedJournal: empty, recomputedDigest: "", notes };
    }
    cl.journalWellFormed = true;
    cl.resultTrue = dj.result === true;
    cl.notExpired = BigInt(dj.expiry) > BigInt(Math.floor(Date.now() / 1000));
    const recomputed = sha256Hex(fromHex(bundle.journal));
    cl.digestMatches = !bundle.journal_digest || bundle.journal_digest.toLowerCase() === recomputed;

    try {
      const cfg = await this.getGateConfig();
      cl.imagePinned = cfg.image_id.toLowerCase() === bundle.image_id.toLowerCase();
      cl.claimTypeOk = dj.claimType === cfg.claim_type;
    } catch (e) { notes.push("gate get_config: " + msg(e)); }

    try { cl.issuerAllowed = await this.isGateIssuerAllowed(dj.issuerId); }
    catch (e) { notes.push("gate is_issuer_allowed: " + msg(e)); }

    try {
      await this.simRead(this.cfg.contracts.verifier, "verify", [
        scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(recomputed),
      ]);
      cl.proofValidOnChain = true; // simulate succeeded → verifier returned Ok
    } catch (e) { notes.push("verify: " + msg(e)); }

    cl.verdict = cl.journalWellFormed && cl.digestMatches && cl.imagePinned && cl.resultTrue &&
      cl.claimTypeOk && cl.issuerAllowed && cl.notExpired && cl.proofValidOnChain;
    return { verdict: cl.verdict, checklist: cl, decodedJournal: dj, recomputedDigest: recomputed, notes };
  }

  /**
   * Re-verify a COMPLIANCE (KYC ∧ not-sanctioned) proof bundle against the public chain: recompute
   * sha256(journal), check the compliance gate's image-id pin + journal policy (result, claim_type,
   * `deny_root` equals the gate's pinned sanctions root, allow-listed KYC issuer, freshness), and ask
   * the bare verifier to confirm the Groth16 proof. The subject stays hidden. The `denyRootMatches`
   * check is what proves the non-membership was against the CURRENT sanctions list.
   */
  async verifyComplianceBundle(bundle: Bundle): Promise<ComplianceVerifyResult> {
    const notes: string[] = [];
    const cl: ComplianceChecklist = {
      journalWellFormed: false, digestMatches: false, imagePinned: false, resultTrue: false,
      claimTypeOk: false, denyRootMatches: false, issuerAllowed: false, notExpired: false,
      proofValidOnChain: false, verdict: false,
    };
    const empty: DecodedComplianceJournal = { result: false, claimType: 0, issuerId: "", denyRoot: "", accessor: "", nonce: "0", expiry: "0" };
    const dj = decodeComplianceJournal(bundle.journal);
    if (!dj) {
      notes.push("compliance journal malformed");
      return { verdict: false, checklist: cl, decodedJournal: empty, recomputedDigest: "", notes };
    }
    cl.journalWellFormed = true;
    cl.resultTrue = dj.result === true;
    cl.notExpired = BigInt(dj.expiry) > BigInt(Math.floor(Date.now() / 1000));
    const recomputed = sha256Hex(fromHex(bundle.journal));
    cl.digestMatches = !bundle.journal_digest || bundle.journal_digest.toLowerCase() === recomputed;

    try {
      const cfg = await this.getComplianceConfig();
      cl.imagePinned = cfg.image_id.toLowerCase() === bundle.image_id.toLowerCase();
      cl.claimTypeOk = dj.claimType === cfg.claim_type;
      cl.denyRootMatches = cfg.deny_root.toLowerCase() === dj.denyRoot.toLowerCase();
    } catch (e) { notes.push("compliance get_config: " + msg(e)); }

    try { cl.issuerAllowed = await this.isComplianceIssuerAllowed(dj.issuerId); }
    catch (e) { notes.push("compliance is_issuer_allowed: " + msg(e)); }

    try {
      await this.simRead(this.cfg.contracts.verifier, "verify", [
        scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(recomputed),
      ]);
      cl.proofValidOnChain = true; // simulate succeeded → verifier returned Ok
    } catch (e) { notes.push("verify: " + msg(e)); }

    cl.verdict = cl.journalWellFormed && cl.digestMatches && cl.imagePinned && cl.resultTrue &&
      cl.claimTypeOk && cl.denyRootMatches && cl.issuerAllowed && cl.notExpired && cl.proofValidOnChain;
    return { verdict: cl.verdict, checklist: cl, decodedJournal: dj, recomputedDigest: recomputed, notes };
  }

  /**
   * Re-verify a PAYROLL (proof-of-income) proof bundle against the public chain: recompute sha256(journal),
   * check the payroll gate's image-id pin + journal policy (result, claim_type, allow-listed attester,
   * allow-listed auditor target, freshness), and ask the bare verifier to confirm the Groth16 proof. The
   * salary stays hidden; the `auditorAllowed` check confirms the disclosure targets an authorized auditor.
   */
  async verifyPayrollBundle(bundle: Bundle): Promise<PayrollVerifyResult> {
    const notes: string[] = [];
    const cl: PayrollChecklist = {
      journalWellFormed: false, digestMatches: false, imagePinned: false, resultTrue: false,
      claimTypeOk: false, issuerAllowed: false, auditorAllowed: false, notExpired: false,
      proofValidOnChain: false, verdict: false,
    };
    const empty: DecodedPayrollJournal = {
      result: false, claimType: 0, issuerId: "", threshold: "0", accessor: "", auditorPub: "",
      ephPub: "", ct: "", tag: "", nonce: "0", expiry: "0",
    };
    const dj = decodePayrollJournal(bundle.journal);
    if (!dj) {
      notes.push("payroll journal malformed");
      return { verdict: false, checklist: cl, decodedJournal: empty, recomputedDigest: "", notes };
    }
    cl.journalWellFormed = true;
    cl.resultTrue = dj.result === true;
    cl.notExpired = BigInt(dj.expiry) > BigInt(Math.floor(Date.now() / 1000));
    const recomputed = sha256Hex(fromHex(bundle.journal));
    cl.digestMatches = !bundle.journal_digest || bundle.journal_digest.toLowerCase() === recomputed;

    try {
      const cfg = await this.getPayrollConfig();
      cl.imagePinned = cfg.image_id.toLowerCase() === bundle.image_id.toLowerCase();
      cl.claimTypeOk = dj.claimType === cfg.claim_type;
    } catch (e) { notes.push("payroll get_config: " + msg(e)); }

    try { cl.issuerAllowed = await this.isPayrollIssuerAllowed(dj.issuerId); }
    catch (e) { notes.push("payroll is_issuer_allowed: " + msg(e)); }

    try { cl.auditorAllowed = await this.isAuditorAllowed(dj.auditorPub); }
    catch (e) { notes.push("payroll is_auditor_allowed: " + msg(e)); }

    try {
      await this.simRead(this.cfg.contracts.verifier, "verify", [
        scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(recomputed),
      ]);
      cl.proofValidOnChain = true; // simulate succeeded → verifier returned Ok
    } catch (e) { notes.push("verify: " + msg(e)); }

    cl.verdict = cl.journalWellFormed && cl.digestMatches && cl.imagePinned && cl.resultTrue &&
      cl.claimTypeOk && cl.issuerAllowed && cl.auditorAllowed && cl.notExpired && cl.proofValidOnChain;
    return { verdict: cl.verdict, checklist: cl, decodedJournal: dj, recomputedDigest: recomputed, notes };
  }

  // ---- REST convenience (the proof bundle is not on-chain) ----

  /** Fetch the shareable audit bundle (proof + on-chain result + CLI recipe) from the REST API. */
  async getAuditBundle(issuerIdHex?: string): Promise<AuditBundle> {
    if (!this.cfg.apiBaseUrl) throw new Error("apiBaseUrl not configured (needed to fetch the proof bundle)");
    const url = `${this.cfg.apiBaseUrl.replace(/\/$/, "")}/audit/${issuerIdHex ?? "latest"}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`audit fetch failed: HTTP ${r.status}`);
    return (await r.json()) as AuditBundle;
  }

  /** Embeddable on-chain-state badge URL (served by the REST API). */
  getBadgeUrl(issuerIdHex?: string): string {
    const base = (this.cfg.apiBaseUrl ?? "").replace(/\/$/, "");
    return `${base}/badge${issuerIdHex ? `/${issuerIdHex}` : ""}.svg`;
  }

  // ---- Week 8: accredited gate (identity leg) trustless on-chain reads ----

  async getAccreditedConfig(): Promise<AccreditedConfig> {
    const c = (await this.simRead(this.cfg.contracts.accredited, "get_config")) as Record<string, unknown>;
    return { admin: String(c.admin), verifier: String(c.verifier), image_id: bytesToHex(c.image_id), claim_type: Number(c.claim_type) };
  }

  async isAccreditedGranted(accessorHex: string): Promise<boolean> {
    return (await this.simRead(this.cfg.contracts.accredited, "is_granted", [scBytes(accessorHex)])) === true;
  }

  async getAccreditedAccess(accessorHex: string): Promise<AccessRecord | null> {
    return normalizeAccess(await this.simRead(this.cfg.contracts.accredited, "get_access", [scBytes(accessorHex)]));
  }

  async getLatestAccreditedAccess(): Promise<AccessRecord | null> {
    return normalizeAccess(await this.simRead(this.cfg.contracts.accredited, "get_latest_access"));
  }

  async getAccreditedCount(): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.accredited, "get_count")) ?? 0);
  }

  async getAccreditedHistory(start = 0, limit = 50): Promise<AccessRecord[]> {
    const rows = (await this.simRead(this.cfg.contracts.accredited, "get_history", [
      scU32(start), scU32(Math.min(50, Math.max(1, limit))),
    ])) as unknown[];
    return (rows ?? []).map(normalizeAccess).filter((r): r is AccessRecord => r !== null);
  }

  async isAccreditedIssuerAllowed(issuerIdHex: string): Promise<boolean> {
    return (await this.simRead(this.cfg.contracts.accredited, "is_issuer_allowed", [scBytes(issuerIdHex)])) === true;
  }

  /**
   * Is this accessor a currently-accredited investor? `answer` is the AUTHORITATIVE on-chain
   * `is_granted` decision (credential expiry re-checked). The identity stays hidden (selective
   * disclosure). For a full Groth16 re-verify of a bundle use {@link verifyAccreditedBundle}.
   */
  async isAccredited(accessorHex: string): Promise<AccreditedAnswer> {
    const [answer, record] = await Promise.all([
      this.isAccreditedGranted(accessorHex),
      this.getAccreditedAccess(accessorHex),
    ]);
    return { answer, accessor: accessorHex, record };
  }

  // ---- Week 8: fundraise (the composition) trustless on-chain reads ----

  async getFundraiseConfig(): Promise<FundraiseConfig> {
    const c = (await this.simRead(this.cfg.contracts.fundraise, "get_config")) as Record<string, unknown>;
    return {
      admin: String(c.admin), verifier: String(c.verifier), accredited_gate: String(c.accredited_gate),
      revenue_image_id: bytesToHex(c.revenue_image_id), revenue_claim_type: Number(c.revenue_claim_type),
      revenue_threshold: String(c.revenue_threshold),
    };
  }

  async isFundraiseRevenueVerified(): Promise<boolean> {
    return (await this.simRead(this.cfg.contracts.fundraise, "is_revenue_verified")) === true;
  }

  async getRevenueRecord(): Promise<RevenueRecord | null> {
    return normalizeRevenue(await this.simRead(this.cfg.contracts.fundraise, "get_revenue_record"));
  }

  async getFundraiseAccess(accessorHex: string): Promise<InvestorAccess | null> {
    return normalizeInvestorAccess(await this.simRead(this.cfg.contracts.fundraise, "get_investor_access", [scBytes(accessorHex)]));
  }

  async getFundraiseCount(): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.fundraise, "get_count")) ?? 0);
  }

  async getFundraiseHistory(start = 0, limit = 50): Promise<InvestorAccess[]> {
    const rows = (await this.simRead(this.cfg.contracts.fundraise, "get_history", [
      scU32(start), scU32(Math.min(50, Math.max(1, limit))),
    ])) as unknown[];
    return (rows ?? []).map(normalizeInvestorAccess).filter((r): r is InvestorAccess => r !== null);
  }

  /**
   * **THE composition decision.** Can this accessor access the fundraise? Reads the fundraise's
   * on-chain `can_access` (which itself AND's `is_revenue_verified` ∧ the accredited gate's
   * `is_granted`), plus each leg separately so a caller sees WHICH leg is missing. Always-live (drops
   * if either the revenue proof or the accreditation credential expires). The admission `record` (if
   * `request_investor_access` was called) is returned too, for audit.
   */
  async canAccessFundraise(accessorHex: string): Promise<FundraiseAccessAnswer> {
    const [answer, revenueVerified, accredited, record] = await Promise.all([
      this.simRead(this.cfg.contracts.fundraise, "can_access", [scBytes(accessorHex)]).then((v) => v === true),
      this.isFundraiseRevenueVerified(),
      this.isAccreditedGranted(accessorHex),
      this.getFundraiseAccess(accessorHex),
    ]);
    return { answer, accessor: accessorHex, revenueVerified, accredited, record };
  }

  // ---- BP3: solvency gate (a solvency proof that dies when you pull your collateral) ----

  async getSolvencyConfig(): Promise<SolvencyConfig> {
    const c = (await this.simRead(this.cfg.contracts.solvencyGate, "get_config")) as Record<string, unknown>;
    return {
      admin: String(c.admin), verifier: String(c.verifier),
      escrow: String(c.escrow), escrow_id: bytesToHex(c.escrow_id),
      supply_token: String(c.supply_token), supply_token_id: bytesToHex(c.supply_token_id),
      bond_token: String(c.bond_token), bond_token_id: bytesToHex(c.bond_token_id),
      image_id: bytesToHex(c.image_id), claim_type: Number(c.claim_type),
    };
  }

  /**
   * Is this depositor's solvency proof CURRENTLY live? `answer` is the AUTHORITATIVE on-chain `is_granted`
   * decision — the gate re-reads the escrow lock + the supply on every call, so it returns false the
   * instant the depositor unbonds (or the lock unlocks / the supply changes / the attestation expires).
   * The reserve figure stays hidden either way. `depositorG` is the bond owner's Stellar address.
   */
  async isSolvent(depositorG: string): Promise<SolvencyAnswer> {
    const [answer, record] = await Promise.all([
      this.simRead(this.cfg.contracts.solvencyGate, "is_granted", [scAddress(depositorG)]).then((v) => v === true),
      this.getSolvencyRecord(depositorG),
    ]);
    return { answer, depositor: depositorG, record };
  }

  /** The raw stored solvency record for a depositor (regardless of current validity — use {@link isSolvent}
   * for the live decision). The real reserve figure is never stored, only the supply it cleared. */
  async getSolvencyRecord(depositorG: string): Promise<SolvencyRecord | null> {
    return normalizeSolvencyRecord(await this.simRead(this.cfg.contracts.solvencyGate, "get_record", [scAddress(depositorG)]));
  }

  // ---- BP5: tier gate (an anonymous bonded tier / membership expiring at X) ----

  async getTierConfig(): Promise<TierConfig> {
    const c = (await this.simRead(this.cfg.contracts.tierGate, "get_config")) as Record<string, unknown>;
    return { admin: String(c.admin), verifier: String(c.verifier), image_id: bytesToHex(c.image_id), claim_type: Number(c.claim_type) };
  }

  /** True iff this accessor holds a CURRENTLY-valid tier grant (grant exists AND now < X). The on-chain
   *  decision; deadline-encoded (sound because qualifying locks are non-revocable). `accessorHex` is the
   *  32-byte accessor key the proof committed (a fresh anonymous key, not a funded wallet). */
  async isTierGranted(accessorHex: string): Promise<boolean> {
    return Boolean(await this.simRead(this.cfg.contracts.tierGate, "is_granted", [scBytes(accessorHex)]));
  }

  /** The live tier answer for an accessor: the on-chain is_granted decision + the raw grant. */
  async tierAnswer(accessorHex: string): Promise<TierAnswer> {
    const [answer, grant] = await Promise.all([this.isTierGranted(accessorHex), this.getTierGrant(accessorHex)]);
    return { answer, accessor: accessorHex, grant };
  }

  /** The raw stored tier grant for an accessor, or null. Reveals neither identity nor which lock. */
  async getTierGrant(accessorHex: string): Promise<TierGrant | null> {
    return normalizeTierGrant(await this.simRead(this.cfg.contracts.tierGate, "get_grant", [scBytes(accessorHex)]));
  }

  /** True iff `nullifier` has already been spent (a repeat from the same identity + context is rejected). */
  async isTierNullifierUsed(nullifierHex: string): Promise<boolean> {
    return Boolean(await this.simRead(this.cfg.contracts.tierGate, "is_nullifier_used", [scBytes(nullifierHex)]));
  }

  /** The gate's pinned enrolled-member root (hex), or null if none pinned. */
  async getTierMemberRoot(): Promise<string | null> {
    const v = await this.simRead(this.cfg.contracts.tierGate, "get_member_root");
    return v ? bytesToHex(v) : null;
  }

  /** The gate's accepted `qual_root` ring (oldest first) for a tier (threshold, X). */
  async getTierQualRing(threshold: bigint | string | number, unlockAfter: number): Promise<string[]> {
    const v = await this.simRead(this.cfg.contracts.tierGate, "get_qual_ring", [scU64(threshold), scU64(unlockAfter)]);
    return Array.isArray(v) ? (v as unknown[]).map((x) => bytesToHex(x)) : [];
  }

  async isTierQualRootAccepted(threshold: bigint | string | number, unlockAfter: number, qualRootHex: string): Promise<boolean> {
    return Boolean(await this.simRead(this.cfg.contracts.tierGate, "is_qual_root_accepted", [scU64(threshold), scU64(unlockAfter), scBytes(qualRootHex)]));
  }

  /**
   * The TRUSTLESS audit of the gate's qualifying-set root. Independently rebuilds `qual_root` from the
   * escrow's PUBLIC `get_lock` state — no secrets, no trust in the indexer. Scans locks, keeps the
   * non-revocable, still-locked, bond-token locks with amount >= threshold ∧ unlock_time >= X ∧ a non-zero
   * commitment, dedupes by commitment, and folds the depth-20 Merkle root. `accepted` says whether this
   * recomputed root is in the gate's accepted ring — if true, the gate's published anonymity set is honest.
   */
  async recomputeQualRoot(threshold: bigint | string | number, unlockAfter: number, opts: { maxScan?: number } = {}): Promise<RecomputedQualRoot> {
    const thr = BigInt(threshold);
    const maxScan = opts.maxScan ?? 200;
    const now = Math.floor(Date.now() / 1000);
    const bond = this.cfg.contracts.bondToken;
    const found: { id: number; commitment: string }[] = [];
    const seen = new Set<string>();
    const batchSize = 8;
    let complete = false; // set true when a fully-not-found batch ends the scan (vs hitting the cap)
    for (let start = 1; start <= maxScan; start += batchSize) {
      const ids: number[] = [];
      for (let i = 0; i < batchSize && start + i <= maxScan; i++) ids.push(start + i);
      const settled = await Promise.allSettled(ids.map((id) => this.simRead(this.cfg.contracts.escrow, "get_lock", [scU64(id)])));
      let anyFound = false;
      let transient = false; // a network/RPC failure (NOT a LockNotFound contract error)
      settled.forEach((r, i) => {
        if (r.status === "rejected") {
          if (!isContractError(r.reason)) transient = true;
          return;
        }
        if (!r.value) return;
        anyFound = true;
        const l = r.value as Record<string, unknown>;
        const commitment = bytesToHex(l.commitment).toLowerCase();
        const isLocked = !Boolean(l.released) && now < Number(l.unlock_time);
        if (
          isLocked &&
          !Boolean(l.revocable) &&
          String(l.token) === bond &&
          BigInt(String(l.amount)) >= thr &&
          Number(l.unlock_time) >= unlockAfter &&
          !/^0*$/.test(commitment) &&
          !seen.has(commitment)
        ) {
          seen.add(commitment);
          found.push({ id: ids[i], commitment });
        }
      });
      // A transient RPC failure must NOT be read as "past the end" — that would silently drop qualifying
      // locks and report the gate's HONEST root as dishonest (a false anti-rug negative). Fail loudly instead.
      if (transient && !anyFound) {
        throw new Error("could not reach the network while recomputing the qualifying set");
      }
      if (!anyFound) {
        complete = true;
        break;
      }
    }
    found.sort((a, b) => a.id - b.id);
    const commitments = found.map((f) => f.commitment);
    const root = toHex(merkleRootDepth20(commitments.map((h) => fromHex(h))));
    let accepted = false;
    try { accepted = await this.isTierQualRootAccepted(thr, unlockAfter, root); } catch { /* gate not configured */ }
    return { root, size: commitments.length, commitments, accepted, complete };
  }

  /** Re-verify a TIER proof bundle against the public chain: recompute sha256(journal), check the gate's
   *  image-id pin + journal policy (result, claim_type 13, member root pinned, qual root accepted, deadline
   *  future), and ask the bare verifier to confirm the Groth16 proof. The identity / which lock stay hidden.
   *  `nullifierFresh` is surfaced separately (a spent nullifier is still a sound proof). */
  async verifyTierBundle(bundle: Bundle): Promise<TierVerifyResult> {
    const notes: string[] = [];
    const cl: TierChecklist = {
      journalWellFormed: false, digestMatches: false, imagePinned: false, resultTrue: false,
      claimTypeOk: false, memberRootPinned: false, qualRootAccepted: false, deadlineFuture: false,
      nullifierFresh: false, proofValidOnChain: false, verdict: false,
    };
    const empty: DecodedTierJournal = {
      result: false, claimType: 0, memberRoot: "", qualRoot: "", threshold: "0", unlockAfter: "0", context: "", nullifier: "", accessor: "",
    };
    const dj = decodeTierJournal(bundle.journal);
    if (!dj) {
      notes.push("tier journal malformed");
      return { verdict: false, checklist: cl, decodedJournal: empty, recomputedDigest: "", notes };
    }
    cl.journalWellFormed = true;
    cl.resultTrue = dj.result === true;
    cl.claimTypeOk = dj.claimType === 13;
    const recomputed = sha256Hex(fromHex(bundle.journal));
    cl.digestMatches = !bundle.journal_digest || bundle.journal_digest.toLowerCase() === recomputed;
    try {
      const cfg = await this.getTierConfig();
      cl.imagePinned = cfg.image_id.toLowerCase() === bundle.image_id.toLowerCase();
    } catch (e) { notes.push("get_config: " + msg(e)); }
    try {
      const mr = await this.getTierMemberRoot();
      cl.memberRootPinned = !!mr && mr.toLowerCase() === dj.memberRoot.toLowerCase();
      if (!mr) notes.push("gate has no pinned member root");
    } catch (e) { notes.push("get_member_root: " + msg(e)); }
    try {
      cl.qualRootAccepted = await this.isTierQualRootAccepted(dj.threshold, Number(dj.unlockAfter), dj.qualRoot);
    } catch (e) { notes.push("is_qual_root_accepted: " + msg(e)); }
    cl.deadlineFuture = BigInt(dj.unlockAfter) > BigInt(Math.floor(Date.now() / 1000));
    try {
      cl.nullifierFresh = !(await this.isTierNullifierUsed(dj.nullifier));
    } catch (e) { notes.push("is_nullifier_used: " + msg(e)); }
    try {
      await this.simRead(this.cfg.contracts.verifier, "verify", [scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(recomputed)]);
      cl.proofValidOnChain = true;
    } catch (e) { notes.push("verify: " + msg(e)); }
    cl.verdict = cl.journalWellFormed && cl.digestMatches && cl.imagePinned && cl.resultTrue && cl.claimTypeOk && cl.memberRootPinned && cl.qualRootAccepted && cl.deadlineFuture && cl.proofValidOnChain;
    return { verdict: cl.verdict, checklist: cl, decodedJournal: dj, recomputedDigest: recomputed, notes };
  }

  // ---- Week 8: full independent re-verification of the two legs ----

  /**
   * Re-verify an ACCREDITED-INVESTOR proof bundle against the public chain: recompute sha256(journal),
   * check the accredited gate's image-id pin + journal policy (result, claim_type 7, allow-listed
   * accreditation provider, freshness), and ask the bare verifier to confirm the Groth16 proof. The
   * investor's identity stays hidden (the accessor is the binding). Same 85-byte journal shape as KYC.
   */
  async verifyAccreditedBundle(bundle: Bundle): Promise<IdentityVerifyResult> {
    const notes: string[] = [];
    const cl: IdentityChecklist = {
      journalWellFormed: false, digestMatches: false, imagePinned: false, resultTrue: false,
      claimTypeOk: false, issuerAllowed: false, notExpired: false, proofValidOnChain: false, verdict: false,
    };
    const empty: DecodedIdentityJournal = { result: false, claimType: 0, issuerId: "", accessor: "", nonce: "0", expiry: "0" };
    const dj = decodeIdentityJournal(bundle.journal);
    if (!dj) {
      notes.push("accredited journal malformed");
      return { verdict: false, checklist: cl, decodedJournal: empty, recomputedDigest: "", notes };
    }
    cl.journalWellFormed = true;
    cl.resultTrue = dj.result === true;
    cl.notExpired = BigInt(dj.expiry) > BigInt(Math.floor(Date.now() / 1000));
    const recomputed = sha256Hex(fromHex(bundle.journal));
    cl.digestMatches = !bundle.journal_digest || bundle.journal_digest.toLowerCase() === recomputed;
    try {
      const cfg = await this.getAccreditedConfig();
      cl.imagePinned = cfg.image_id.toLowerCase() === bundle.image_id.toLowerCase();
      cl.claimTypeOk = dj.claimType === cfg.claim_type;
    } catch (e) { notes.push("accredited get_config: " + msg(e)); }
    try { cl.issuerAllowed = await this.isAccreditedIssuerAllowed(dj.issuerId); }
    catch (e) { notes.push("accredited is_issuer_allowed: " + msg(e)); }
    try {
      await this.simRead(this.cfg.contracts.verifier, "verify", [scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(recomputed)]);
      cl.proofValidOnChain = true;
    } catch (e) { notes.push("verify: " + msg(e)); }
    cl.verdict = cl.journalWellFormed && cl.digestMatches && cl.imagePinned && cl.resultTrue &&
      cl.claimTypeOk && cl.issuerAllowed && cl.notExpired && cl.proofValidOnChain;
    return { verdict: cl.verdict, checklist: cl, decodedJournal: dj, recomputedDigest: recomputed, notes };
  }

  /**
   * Re-verify a REVENUE (value≥threshold) proof bundle against the public chain: recompute
   * sha256(journal), check the fundraise's revenue image-id pin + journal policy (result, claim_type 6,
   * allow-listed revenue auditor, the proven floor equals the fundraise's pinned X, freshness), and ask
   * the bare verifier to confirm the Groth16 proof. The revenue itself stays hidden — only "≥ X".
   */
  async verifyRevenueBundle(bundle: Bundle): Promise<RevenueVerifyResult> {
    const notes: string[] = [];
    const cl: RevenueChecklist = {
      journalWellFormed: false, digestMatches: false, imagePinned: false, resultTrue: false,
      claimTypeOk: false, issuerAllowed: false, thresholdMatches: false, notExpired: false,
      proofValidOnChain: false, verdict: false,
    };
    const empty: DecodedJournal = { result: false, claimType: 0, issuerId: "", supply: "0", nonce: "0", expiry: "0" };
    const dj = decodeJournal(bundle.journal);
    if (!dj) {
      notes.push("revenue journal malformed");
      return { verdict: false, checklist: cl, decodedJournal: empty, recomputedDigest: "", thresholdX: null, notes };
    }
    cl.journalWellFormed = true;
    cl.resultTrue = dj.result === true;
    cl.notExpired = BigInt(dj.expiry) > BigInt(Math.floor(Date.now() / 1000));
    const recomputed = sha256Hex(fromHex(bundle.journal));
    cl.digestMatches = !bundle.journal_digest || bundle.journal_digest.toLowerCase() === recomputed;
    let thresholdX: string | null = null;
    try {
      const cfg = await this.getFundraiseConfig();
      cl.imagePinned = cfg.revenue_image_id.toLowerCase() === bundle.image_id.toLowerCase();
      cl.claimTypeOk = dj.claimType === cfg.revenue_claim_type;
      thresholdX = cfg.revenue_threshold;
      cl.thresholdMatches = dj.supply === cfg.revenue_threshold; // journal "threshold" field == pinned X
    } catch (e) { notes.push("fundraise get_config: " + msg(e)); }
    try { cl.issuerAllowed = (await this.simRead(this.cfg.contracts.fundraise, "is_issuer_allowed", [scBytes(dj.issuerId)])) === true; }
    catch (e) { notes.push("fundraise is_issuer_allowed: " + msg(e)); }
    try {
      await this.simRead(this.cfg.contracts.verifier, "verify", [scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(recomputed)]);
      cl.proofValidOnChain = true;
    } catch (e) { notes.push("verify: " + msg(e)); }
    cl.verdict = cl.journalWellFormed && cl.digestMatches && cl.imagePinned && cl.resultTrue &&
      cl.claimTypeOk && cl.issuerAllowed && cl.thresholdMatches && cl.notExpired && cl.proofValidOnChain;
    return { verdict: cl.verdict, checklist: cl, decodedJournal: dj, recomputedDigest: recomputed, thresholdX, notes };
  }

  // ── DR1 — Confidential Data Room (data plane: rooms + anchored documents + the key-free opener) ──

  async getDataroomConfig(): Promise<DataroomConfig> {
    const c = (await this.simRead(this.cfg.contracts.dataroom, "get_config")) as Record<string, unknown>;
    return {
      admin: String(c.admin),
      verifier: String(c.verifier),
      seal_image_id: bytesToHex(c.seal_image_id),
      claim_type: Number(c.claim_type),
    };
  }

  /** Total number of rooms created. */
  async getRoomCount(): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.dataroom, "get_room_count")) ?? 0);
  }

  async getRoom(roomIdHex: string): Promise<Room | null> {
    return normalizeRoom(await this.simRead(this.cfg.contracts.dataroom, "get_room", [scBytes(roomIdHex)]));
  }

  /** Number of documents anchored in a room. */
  async getDocCount(roomIdHex: string): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.dataroom, "get_doc_count", [scBytes(roomIdHex)])) ?? 0);
  }

  async getDocument(roomIdHex: string, docIdHex: string): Promise<DataroomDocument | null> {
    return normalizeDocument(await this.simRead(this.cfg.contracts.dataroom, "get_document", [scBytes(roomIdHex), scBytes(docIdHex)]));
  }

  /** The document at the room's append-only log position `index` (0-based), if any. */
  async getDocByIndex(roomIdHex: string, index: number): Promise<DataroomDocument | null> {
    return normalizeDocument(await this.simRead(this.cfg.contracts.dataroom, "get_doc_by_index", [scBytes(roomIdHex), scU32(index)]));
  }

  /** A page of a room's anchored documents (the append-only log). Clamped to [start, count). */
  async listDocuments(roomIdHex: string, start = 0, limit = 50): Promise<DataroomDocument[]> {
    const count = await this.getDocCount(roomIdHex);
    const from = Math.max(0, start);
    const end = Math.min(count, from + Math.max(1, Math.min(50, limit)));
    const idxs: number[] = [];
    for (let i = from; i < end; i++) idxs.push(i);
    // Fetch the page in parallel (the contract has no batch read; one simulate per index).
    const docs = await Promise.all(idxs.map((i) => this.getDocByIndex(roomIdHex, i)));
    return docs.filter((d): d is DataroomDocument => d !== null);
  }

  /**
   * RECIPIENT OPENER (key-free): read the on-chain document, recover the document key `K` with the
   * recipient's x25519 SECRET (hex), verify the faithful tag, then fetch the ciphertext blob (by content
   * hash) and AES-256-GCM-decrypt it. The SDK never custodies the secret — the caller supplies it.
   * The blob source is, in order of precedence: `opts.fetchBlob` (a custom fetcher), `opts.blobBaseUrl`,
   * or `cfg.apiBaseUrl` — fetching `${base}/dataroom/blob/${content_hash}`. `faithful` needs only chain
   * reads (no blob); `plaintext`/`contentHashVerified` additionally need the blob.
   *
   * Return-vs-throw contract: returns a structured result for the expected outcomes (`found:false`,
   * `faithful:false`); THROWS only on an exceptional blob problem (no blob source configured, the fetch
   * fails, or the fetched bytes don't match `content_hash`) — i.e. when it cannot safely produce plaintext.
   */
  async openDocument(
    roomIdHex: string,
    docIdHex: string,
    recipientSecretHex: string,
    opts: { fetchBlob?: (contentHash: string) => Promise<Uint8Array>; blobBaseUrl?: string } = {},
  ): Promise<OpenedDocument> {
    const doc = await this.getDocument(roomIdHex, docIdHex);
    if (!doc) {
      return { found: false, faithful: false, contentHashVerified: false, contentHash: "", recipientPub: "", plaintext: null, plaintextUtf8: null };
    }
    // Verify the faithful tag against the DOCUMENT's OWN room_id/doc_id (not the caller's args) — keeps the
    // check self-consistent against the object being authenticated.
    const rec = recoverDocumentKey(
      { ephPub: doc.eph_pub, ct: doc.ct, tag: doc.tag, contentHash: doc.content_hash, roomId: doc.room_id, docId: doc.doc_id },
      recipientSecretHex,
    );
    if (!rec.faithful) {
      return { found: true, faithful: false, contentHashVerified: false, contentHash: doc.content_hash, recipientPub: doc.recipient_pub, plaintext: null, plaintextUtf8: null };
    }
    const blob = await this.fetchBlob(doc.content_hash, opts);
    const contentHashVerified = sha256Hex(blob) === doc.content_hash;
    if (!contentHashVerified) throw new Error("fetched blob hash mismatch — refusing to decrypt");
    const plaintext = await aeadDecrypt(blob, rec.k);
    let plaintextUtf8: string | null = null;
    try { plaintextUtf8 = new TextDecoder("utf-8", { fatal: true }).decode(plaintext); } catch { /* binary */ }
    return { found: true, faithful: true, contentHashVerified: true, contentHash: doc.content_hash, recipientPub: doc.recipient_pub, plaintext, plaintextUtf8 };
  }

  private async fetchBlob(
    contentHash: string,
    opts: { fetchBlob?: (contentHash: string) => Promise<Uint8Array>; blobBaseUrl?: string },
  ): Promise<Uint8Array> {
    if (opts.fetchBlob) return opts.fetchBlob(contentHash);
    const base = (opts.blobBaseUrl ?? this.cfg.apiBaseUrl ?? "").replace(/\/$/, "");
    if (!base) throw new Error("no blob source: pass opts.fetchBlob or opts.blobBaseUrl, or set cfg.apiBaseUrl");
    const res = await fetch(`${base}/dataroom/blob/${contentHash}`);
    if (!res.ok) throw new Error(`blob fetch failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Independently re-verify a DR1 seal proof bundle against the PUBLIC chain: recompute the journal
   * digest, check the DataRoom's image-id pin, confirm the Groth16 proof on the verifier contract, and
   * check the policy (result, claim_type == 8). DR1 is commitment-only (no issuer/attester allowlist).
   */
  async verifyDataroomBundle(bundle: Bundle): Promise<DataroomVerifyResult> {
    const notes: string[] = [];
    const cl: DataroomSealChecklist = {
      journalWellFormed: false, digestMatches: false, imagePinned: false, resultTrue: false,
      claimTypeOk: false, proofValidOnChain: false, verdict: false,
    };
    const empty: DecodedDataroomSealJournal = {
      result: false, claimType: 0, roomId: "", docId: "", recipientPub: "", contentHash: "", ephPub: "", ct: "", tag: "",
    };
    const dj = decodeDataroomSealJournal(bundle.journal);
    if (!dj) {
      notes.push("dataroom seal journal malformed");
      return { verdict: false, checklist: cl, decodedJournal: empty, recomputedDigest: "", notes };
    }
    cl.journalWellFormed = true;
    cl.resultTrue = dj.result === true;
    const recomputed = sha256Hex(fromHex(bundle.journal));
    cl.digestMatches = !bundle.journal_digest || bundle.journal_digest.toLowerCase() === recomputed;
    try {
      const cfg = await this.getDataroomConfig();
      cl.imagePinned = cfg.seal_image_id.toLowerCase() === bundle.image_id.toLowerCase();
      cl.claimTypeOk = dj.claimType === cfg.claim_type;
    } catch (e) { notes.push("dataroom get_config: " + msg(e)); }
    try {
      await this.simRead(this.cfg.contracts.verifier, "verify", [scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(recomputed)]);
      cl.proofValidOnChain = true;
    } catch (e) { notes.push("verify: " + msg(e)); }
    cl.verdict = cl.journalWellFormed && cl.digestMatches && cl.imagePinned && cl.resultTrue && cl.claimTypeOk && cl.proofValidOnChain;
    return { verdict: cl.verdict, checklist: cl, decodedJournal: dj, recomputedDigest: recomputed, notes };
  }

  // ── DR2 — anonymous eligibility (membership + nullifier). READ-ONLY, NO key custody. ──

  /** The pinned canonical membership guest image_id (claim_type 9), or null if membership isn't enabled. */
  async getMembershipImageId(): Promise<string | null> {
    const v = await this.simRead(this.cfg.contracts.dataroom, "get_membership_image_id");
    return v ? bytesToHex(v) : null;
  }

  /** A room's pinned eligible-set Merkle root (hex), or null if none pinned. */
  async getEligibleRoot(roomIdHex: string): Promise<string | null> {
    const v = await this.simRead(this.cfg.contracts.dataroom, "get_eligible_root", [scBytes(roomIdHex)]);
    return v ? bytesToHex(v) : null;
  }

  /** True iff `accessor` holds a currently-valid grant in the room (grant exists AND was proven against
   *  the room's CURRENT eligible root — re-pinning the root revokes stale grants). The live access decision.
   *  (Named `isRoomGranted` to disambiguate from the single-arg gate `isGranted`.) */
  async isRoomGranted(roomIdHex: string, accessorHex: string): Promise<boolean> {
    return Boolean(await this.simRead(this.cfg.contracts.dataroom, "is_granted", [scBytes(roomIdHex), scBytes(accessorHex)]));
  }

  /** True iff `nullifier` has already been spent in the room (a repeat access from the same identity is
   *  rejected). */
  async isNullifierUsed(roomIdHex: string, nullifierHex: string): Promise<boolean> {
    return Boolean(await this.simRead(this.cfg.contracts.dataroom, "is_nullifier_used", [scBytes(roomIdHex), scBytes(nullifierHex)]));
  }

  /** The raw stored grant for (room, accessor), or null. Reveals neither identity nor which member. */
  async getGrant(roomIdHex: string, accessorHex: string): Promise<MembershipGrant | null> {
    return normalizeGrant(await this.simRead(this.cfg.contracts.dataroom, "get_grant", [scBytes(roomIdHex), scBytes(accessorHex)]));
  }

  /** Number of access grants in a room's append-only grant log. */
  async getGrantCount(roomIdHex: string): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.dataroom, "get_grant_count", [scBytes(roomIdHex)])) ?? 0);
  }

  // ── DR3 — threshold-ECIES committee documents (reads + the key-free committee opener) ──

  /** The committee document anchored at (room, doc) — content_hash + sha256(K) commitment + pointer. */
  async getCommitteeDocument(roomIdHex: string, docIdHex: string): Promise<CommitteeDocument | null> {
    return normalizeCommitteeDocument(await this.simRead(this.cfg.contracts.dataroom, "get_committee_document", [scBytes(roomIdHex), scBytes(docIdHex)]));
  }

  /** Number of committee documents anchored in a room. */
  async getCommitteeDocCount(roomIdHex: string): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.dataroom, "get_committee_doc_count", [scBytes(roomIdHex)])) ?? 0);
  }

  /** The committee document at the room's committee-doc-log position `index` (0-based), if any. */
  async getCommitteeDocByIndex(roomIdHex: string, index: number): Promise<CommitteeDocument | null> {
    return normalizeCommitteeDocument(await this.simRead(this.cfg.contracts.dataroom, "get_committee_doc_by_index", [scBytes(roomIdHex), scU32(index)]));
  }

  /** Collect SEALED shares for a granted accessor from the committee. No secret involved — each keyper
   *  gates on the on-chain grant and seals to the proof-bound recipient_pub. Source precedence:
   *  `opts.collectShares` → `opts.keyperEndpoints` (hit each keyper /share directly, the trust-clean path) →
   *  `opts.committeeBaseUrl`/`cfg.apiBaseUrl` (the backend's /dataroom/committee/collect aggregator). */
  private async collectSealedShares(
    roomIdHex: string,
    docIdHex: string,
    accessorHex: string,
    opts: CommitteeOpenOpts,
  ): Promise<{ recipientPub: string; shares: SealedShareHex[] }> {
    if (opts.collectShares) return opts.collectShares(roomIdHex, docIdHex, accessorHex);
    if (opts.keyperEndpoints && opts.keyperEndpoints.length) {
      const recipients = new Set<string>();
      const shares: SealedShareHex[] = [];
      await Promise.all(
        opts.keyperEndpoints.map(async (ep) => {
          const r = await fetch(`${ep.replace(/\/$/, "")}/share`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ room_id: roomIdHex, doc_id: docIdHex, accessor: accessorHex }),
          });
          if (!r.ok) return; // not granted / no share / down — simply contributes no share
          const j = (await r.json()) as Record<string, string>;
          shares.push({ keyperIndex: Number(j.keyper_index), ephPub: j.eph_pub, ct: j.ct, tag: j.tag });
          if (j.recipient_pub) recipients.add(j.recipient_pub);
        }),
      );
      if (recipients.size > 1) throw new Error("keypers disagree on recipient_pub");
      return { recipientPub: [...recipients][0] ?? "", shares };
    }
    const base = (opts.committeeBaseUrl ?? this.cfg.apiBaseUrl ?? "").replace(/\/$/, "");
    if (!base) throw new Error("no share source: pass opts.collectShares, opts.keyperEndpoints, opts.committeeBaseUrl, or set cfg.apiBaseUrl");
    const r = await fetch(`${base}/dataroom/committee/collect/${roomIdHex}/${docIdHex}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessor: accessorHex }),
    });
    const j = (await r.json()) as { recipientPub?: string; shares?: SealedShareHex[]; error?: string };
    if (!r.ok) return { recipientPub: "", shares: [] }; // 403 (not granted) etc. → no shares
    return { recipientPub: j.recipientPub ?? "", shares: j.shares ?? [] };
  }

  /**
   * COMMITTEE RECIPIENT OPENER (key-free): collect the sealed shares the keyper committee released to a
   * granted accessor, ECIES-open each with the recipient's x25519 SECRET (hex), Lagrange-reconstruct `K`
   * (commitment-gated, robust to one bad share), fetch the ciphertext blob, and AES-256-GCM-decrypt it. The
   * SDK NEVER custodies the secret — the caller supplies it; share collection (no secret) and opening (with
   * the secret) are cleanly separated. `threshold` defaults to 2. Blob source: same precedence as
   * `openDocument` (`opts.fetchBlob` → `opts.blobBaseUrl` → `cfg.apiBaseUrl`).
   *
   * Returns a structured result for the expected outcomes (`found:false`, `released:false`,
   * `reconstructed:false`); THROWS only on an exceptional blob problem (no source, fetch fails, or the bytes
   * don't match `content_hash`).
   */
  async openCommitteeDocument(
    roomIdHex: string,
    docIdHex: string,
    accessorHex: string,
    recipientSecretHex: string,
    opts: CommitteeOpenOpts = {},
  ): Promise<OpenedCommitteeDocument> {
    const threshold = opts.threshold ?? 2;
    const empty: OpenedCommitteeDocument = {
      found: false, released: false, faithfulShares: 0, reconstructed: false, contentHashVerified: false,
      contentHash: "", kCommitment: "", recipientPub: "", reconstructedFromPair: null, plaintext: null, plaintextUtf8: null,
    };
    const doc = await this.getCommitteeDocument(roomIdHex, docIdHex);
    if (!doc) return empty;

    // The AUTHORITATIVE recipient_pub is the one the DR2 grant recorded on-chain (proof-bound by NEW-5) —
    // read it ourselves, never trust the value a share aggregator reports. Opening against the chain key
    // means a malicious aggregator can at worst cause a FAILED open (unfaithful shares), never a wrong decrypt.
    const grant = await this.getGrant(roomIdHex, accessorHex);
    const recipientPub = grant?.recipient_pub ?? "";
    const { shares } = await this.collectSealedShares(roomIdHex, docIdHex, accessorHex, opts);
    if (shares.length < threshold || !recipientPub) {
      return { ...empty, found: true, released: false, contentHash: doc.content_hash, kCommitment: doc.k_commitment, recipientPub };
    }
    // Open each sealed share with the recipient secret (verifying the tag against the on-chain recipient_pub).
    const opened: OpenedShare[] = shares.map((s) => openShare(s, recipientSecretHex, roomIdHex, docIdHex, recipientPub));
    const faithful = opened.filter((o) => o.faithful);
    const base = { ...empty, found: true, released: true, faithfulShares: faithful.length, contentHash: doc.content_hash, kCommitment: doc.k_commitment, recipientPub };
    if (faithful.length < threshold) return base; // wrong recipient key, or too few honest shares

    const { k, pair } = reconstructWithCommitment(faithful, doc.k_commitment);
    const blob = await this.fetchBlob(doc.content_hash, opts);
    const contentHashVerified = sha256Hex(blob) === doc.content_hash;
    if (!contentHashVerified) throw new Error("fetched blob hash mismatch — refusing to decrypt");
    const plaintext = await aeadDecrypt(blob, k);
    let plaintextUtf8: string | null = null;
    try { plaintextUtf8 = new TextDecoder("utf-8", { fatal: true }).decode(plaintext); } catch { /* binary */ }
    return { ...base, reconstructed: true, reconstructedFromPair: pair, contentHashVerified: true, plaintext, plaintextUtf8 };
  }

  /**
   * Independently re-verify a DR2 membership proof bundle against the PUBLIC chain: decode + check the
   * 165-byte journal, recompute the digest, confirm the DataRoom's membership-image pin, run the Groth16
   * proof on the verifier, then check policy (result, claim_type==9), that the committed `eligible_root`
   * equals the room's on-chain pinned root, and that the nullifier is still fresh (a fresh proof WOULD
   * grant). `nullifierFresh:false` means a valid proof whose access was already taken — still a sound proof.
   */
  async verifyMembershipBundle(bundle: Bundle): Promise<MembershipVerifyResult> {
    const notes: string[] = [];
    const cl: MembershipChecklist = {
      journalWellFormed: false, digestMatches: false, imagePinned: false, resultTrue: false,
      claimTypeOk: false, rootPinned: false, nullifierFresh: false, proofValidOnChain: false, verdict: false,
    };
    const empty: DecodedMembershipJournal = {
      result: false, claimType: 0, roomId: "", eligibleRoot: "", nullifier: "", accessor: "", recipientPub: "",
    };
    const dj = decodeMembershipJournal(bundle.journal);
    if (!dj) {
      notes.push("membership journal malformed");
      return { verdict: false, checklist: cl, decodedJournal: empty, recomputedDigest: "", notes };
    }
    cl.journalWellFormed = true;
    cl.resultTrue = dj.result === true;
    cl.claimTypeOk = dj.claimType === 9;
    const recomputed = sha256Hex(fromHex(bundle.journal));
    cl.digestMatches = !bundle.journal_digest || bundle.journal_digest.toLowerCase() === recomputed;
    try {
      const pinnedImage = await this.getMembershipImageId();
      cl.imagePinned = !!pinnedImage && pinnedImage.toLowerCase() === bundle.image_id.toLowerCase();
    } catch (e) { notes.push("get_membership_image_id: " + msg(e)); }
    try {
      const root = await this.getEligibleRoot(dj.roomId);
      cl.rootPinned = !!root && root.toLowerCase() === dj.eligibleRoot.toLowerCase();
      if (!root) notes.push("room has no pinned eligible root");
    } catch (e) { notes.push("get_eligible_root: " + msg(e)); }
    try {
      cl.nullifierFresh = !(await this.isNullifierUsed(dj.roomId, dj.nullifier));
    } catch (e) { notes.push("is_nullifier_used: " + msg(e)); }
    try {
      await this.simRead(this.cfg.contracts.verifier, "verify", [scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(recomputed)]);
      cl.proofValidOnChain = true;
    } catch (e) { notes.push("verify: " + msg(e)); }
    // The proof's soundness verdict does NOT include nullifierFresh (a spent nullifier is still a valid
    // proof — its access was just already taken); freshness is surfaced separately for "would this grant?".
    cl.verdict = cl.journalWellFormed && cl.digestMatches && cl.imagePinned && cl.resultTrue && cl.claimTypeOk && cl.rootPinned && cl.proofValidOnChain;
    return { verdict: cl.verdict, checklist: cl, decodedJournal: dj, recomputedDigest: recomputed, notes };
  }

  // ── DR4 — document-authenticity (signed-PDF / zkPDF fact). READ-ONLY, NO key custody. ──

  /** The pinned canonical docauth guest image_id (claim_type 10), or null if DR4 isn't enabled. */
  async getDocauthImageId(): Promise<string | null> {
    const v = await this.simRead(this.cfg.contracts.dataroom, "get_docauth_image_id");
    return v ? bytesToHex(v) : null;
  }

  /** True iff `issuerKeyHash` (= sha256 of an RSA modulus) is an allowlisted third-party issuer. The
   *  allowlist is the trust anchor: only facts signed by a KNOWN issuer key are accepted (third-party truth). */
  async isDocauthIssuerAllowed(issuerKeyHashHex: string): Promise<boolean> {
    return Boolean(await this.simRead(this.cfg.contracts.dataroom, "is_docauth_issuer_allowed", [scBytes(issuerKeyHashHex)]));
  }

  /** The proven document fact for (room, msg_digest), if any — only the predicate, threshold, issuer key
   *  hash, and document hash; never the statement or exact value. */
  async getDocumentFact(roomIdHex: string, msgDigestHex: string): Promise<DocumentFact | null> {
    return normalizeDocumentFact(await this.simRead(this.cfg.contracts.dataroom, "get_document_fact", [scBytes(roomIdHex), scBytes(msgDigestHex)]));
  }

  /** Number of document facts anchored in a room. */
  async getDocFactCount(roomIdHex: string): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.dataroom, "get_doc_fact_count", [scBytes(roomIdHex)])) ?? 0);
  }

  /** The document fact at the room's fact-log position `index` (0-based), if any. */
  async getDocFactByIndex(roomIdHex: string, index: number): Promise<DocumentFact | null> {
    return normalizeDocumentFact(await this.simRead(this.cfg.contracts.dataroom, "get_doc_fact_by_index", [scBytes(roomIdHex), scU32(index)]));
  }

  /** A page of a room's document facts (the append-only log). Clamped to [start, count). */
  async listDocumentFacts(roomIdHex: string, start = 0, limit = 50): Promise<DocumentFact[]> {
    const count = await this.getDocFactCount(roomIdHex);
    const from = Math.max(0, start);
    const end = Math.min(count, from + Math.max(1, Math.min(50, limit)));
    const idxs: number[] = [];
    for (let i = from; i < end; i++) idxs.push(i);
    const facts = await Promise.all(idxs.map((i) => this.getDocFactByIndex(roomIdHex, i)));
    return facts.filter((d): d is DocumentFact => d !== null);
  }

  /**
   * Independently re-verify a DR4 docauth proof bundle against the PUBLIC chain: recompute the journal
   * digest, check the DataRoom's docauth image-id pin, confirm the Groth16 proof on the verifier contract,
   * check the policy (result, claim_type == 10), AND confirm the committed `issuer_key_hash` is on-chain
   * allowlisted — the last is what makes the fact third-party truth (a self-minted RSA key fails here).
   * NOTE: statement freshness (issued_at/expiry) is intentionally NOT checked — the guest signs but does
   * not gate on it (a documented DR6 hardening), and the private dates are not on-chain to check against.
   */
  async verifyDocauthBundle(bundle: Bundle): Promise<DocauthVerifyResult> {
    const notes: string[] = [];
    const cl: DocauthChecklist = {
      journalWellFormed: false, digestMatches: false, imagePinned: false, resultTrue: false,
      claimTypeOk: false, issuerAllowlisted: false, proofValidOnChain: false, verdict: false,
    };
    const empty: DecodedDocauthJournal = {
      result: false, claimType: 0, fieldTag: 0, threshold: "0", issuerKeyHash: "", roomId: "", msgDigest: "",
    };
    const dj = decodeDocauthJournal(bundle.journal);
    if (!dj) {
      notes.push("docauth journal malformed");
      return { verdict: false, checklist: cl, decodedJournal: empty, recomputedDigest: "", notes };
    }
    cl.journalWellFormed = true;
    cl.resultTrue = dj.result === true;
    cl.claimTypeOk = dj.claimType === 10;
    const recomputed = sha256Hex(fromHex(bundle.journal));
    cl.digestMatches = !bundle.journal_digest || bundle.journal_digest.toLowerCase() === recomputed;
    try {
      const pinned = await this.getDocauthImageId();
      cl.imagePinned = pinned !== null && pinned.toLowerCase() === bundle.image_id.toLowerCase();
    } catch (e) { notes.push("get_docauth_image_id: " + msg(e)); }
    try {
      cl.issuerAllowlisted = await this.isDocauthIssuerAllowed(dj.issuerKeyHash);
      if (!cl.issuerAllowlisted) notes.push("issuer_key_hash not allowlisted (would be IssuerNotAllowed on-chain)");
    } catch (e) { notes.push("is_docauth_issuer_allowed: " + msg(e)); }
    try {
      await this.simRead(this.cfg.contracts.verifier, "verify", [scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(recomputed)]);
      cl.proofValidOnChain = true;
    } catch (e) { notes.push("verify: " + msg(e)); }
    cl.verdict = cl.journalWellFormed && cl.digestMatches && cl.imagePinned && cl.resultTrue && cl.claimTypeOk && cl.issuerAllowlisted && cl.proofValidOnChain;
    return { verdict: cl.verdict, checklist: cl, decodedJournal: dj, recomputedDigest: recomputed, notes };
  }

  // ── DR5 — faithful disclosure / data-side teaser. READ-ONLY, NO key custody. ──

  /** The pinned canonical teaser guest image_id (the generic value>=threshold guest, claim_type 11), or
   *  null if DR5 teasers aren't enabled. */
  async getTeaserImageId(): Promise<string | null> {
    const v = await this.simRead(this.cfg.contracts.dataroom, "get_teaser_image_id");
    return v ? bytesToHex(v) : null;
  }

  /** True iff `attester` (an ed25519 public key) is an allowlisted teaser appraiser. The allowlist is the
   *  trust anchor: only figures vouched by a KNOWN appraiser are accepted (a self-minted key is rejected). */
  async isTeaserAttesterAllowed(attesterHex: string): Promise<boolean> {
    return Boolean(await this.simRead(this.cfg.contracts.dataroom, "is_teaser_attester_allowed", [scBytes(attesterHex)]));
  }

  /** The teaser anchored for (room, doc) — only the predicate, threshold, appraiser key, and document hash;
   *  never the exact figure. */
  async getTeaser(roomIdHex: string, docIdHex: string): Promise<Teaser | null> {
    return normalizeTeaser(await this.simRead(this.cfg.contracts.dataroom, "get_teaser", [scBytes(roomIdHex), scBytes(docIdHex)]));
  }

  /** True iff a teaser exists for (room, doc) AND it has not expired (the live "is this fact still
   *  advertised" decision; `getTeaser` returns the raw record regardless of expiry). For a fully-live trust
   *  decision also cross-check `isTeaserAttesterAllowed(getTeaser(..).attester)` — appraiser removal revokes
   *  only FUTURE teasers (existing ones persist until expiry), mirroring DR4's issuer-removal behavior. */
  async isTeaserValid(roomIdHex: string, docIdHex: string): Promise<boolean> {
    return Boolean(await this.simRead(this.cfg.contracts.dataroom, "is_teaser_valid", [scBytes(roomIdHex), scBytes(docIdHex)]));
  }

  /** Number of teasers anchored in a room. */
  async getTeaserCount(roomIdHex: string): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.dataroom, "get_teaser_count", [scBytes(roomIdHex)])) ?? 0);
  }

  /** The teaser at the room's teaser-log position `index` (0-based), if any. */
  async getTeaserByIndex(roomIdHex: string, index: number): Promise<Teaser | null> {
    return normalizeTeaser(await this.simRead(this.cfg.contracts.dataroom, "get_teaser_by_index", [scBytes(roomIdHex), scU32(index)]));
  }

  /** A page of a room's teasers (the append-only log). Clamped to [start, count). */
  async listTeasers(roomIdHex: string, start = 0, limit = 50): Promise<Teaser[]> {
    const count = await this.getTeaserCount(roomIdHex);
    const from = Math.max(0, start);
    const end = Math.min(count, from + Math.max(1, Math.min(50, limit)));
    const idxs: number[] = [];
    for (let i = from; i < end; i++) idxs.push(i);
    const teasers = await Promise.all(idxs.map((i) => this.getTeaserByIndex(roomIdHex, i)));
    return teasers.filter((t): t is Teaser => t !== null);
  }

  /**
   * Independently re-verify a DR5 teaser proof bundle against the PUBLIC chain: recompute the journal
   * digest, check the DataRoom's teaser image-id pin (the generic value>=threshold guest), confirm the
   * Groth16 proof on the verifier contract, check the policy (result, claim_type == 11), AND confirm the
   * committed appraiser key (`issuer_id`) is on-chain allowlisted — the last is what makes the public fact
   * appraiser truth (a self-minted appraiser key fails here). The exact figure is absent from the journal.
   *
   * SCOPE: this verifies the FIGURE fact + appraiser provenance only. The journal carries NO room_id/doc_id,
   * so it does NOT prove WHICH document the figure is about — that linkage is the room owner's on-chain
   * assertion in `attest_teaser` (bound to the doc's content_hash there). Read `getTeaser` for the binding.
   */
  async verifyTeaserBundle(bundle: Bundle): Promise<TeaserVerifyResult> {
    const notes: string[] = [];
    const cl: TeaserChecklist = {
      journalWellFormed: false, digestMatches: false, imagePinned: false, resultTrue: false,
      claimTypeOk: false, attesterAllowlisted: false, proofValidOnChain: false, verdict: false,
    };
    const empty: DecodedJournal = { result: false, claimType: 0, issuerId: "", supply: "0", nonce: "0", expiry: "0" };
    const dj = decodeJournal(bundle.journal);
    if (!dj) {
      notes.push("teaser journal malformed");
      return { verdict: false, checklist: cl, decodedJournal: empty, recomputedDigest: "", notes };
    }
    cl.journalWellFormed = true;
    cl.resultTrue = dj.result === true;
    cl.claimTypeOk = dj.claimType === 11;
    const recomputed = sha256Hex(fromHex(bundle.journal));
    cl.digestMatches = !bundle.journal_digest || bundle.journal_digest.toLowerCase() === recomputed;
    try {
      const pinned = await this.getTeaserImageId();
      cl.imagePinned = pinned !== null && pinned.toLowerCase() === bundle.image_id.toLowerCase();
    } catch (e) { notes.push("get_teaser_image_id: " + msg(e)); }
    try {
      cl.attesterAllowlisted = await this.isTeaserAttesterAllowed(dj.issuerId);
      if (!cl.attesterAllowlisted) notes.push("appraiser not allowlisted (would be IssuerNotAllowed on-chain)");
    } catch (e) { notes.push("is_teaser_attester_allowed: " + msg(e)); }
    try {
      await this.simRead(this.cfg.contracts.verifier, "verify", [scBytes(bundle.seal), scBytes(bundle.image_id), scBytes(recomputed)]);
      cl.proofValidOnChain = true;
    } catch (e) { notes.push("verify: " + msg(e)); }
    cl.verdict = cl.journalWellFormed && cl.digestMatches && cl.imagePinned && cl.resultTrue && cl.claimTypeOk && cl.attesterAllowlisted && cl.proofValidOnChain;
    return { verdict: cl.verdict, checklist: cl, decodedJournal: dj, recomputedDigest: recomputed, notes };
  }

  /**
   * AUDITOR OPENER (key-free): open a redacted-disclosure document sealed to the auditor. It is exactly
   * `openDocument` with the auditor's view secret, then parses the recovered plaintext as the DR5
   * redacted-disclosure JSON (`{ document, redaction_log }`). The SDK never custodies the secret. Returns
   * the base `OpenedDocument` plus the parsed `disclosure` (null if not the expected JSON shape).
   */
  async openDisclosure(
    roomIdHex: string,
    docIdHex: string,
    auditorSecretHex: string,
    opts: { fetchBlob?: (contentHash: string) => Promise<Uint8Array>; blobBaseUrl?: string } = {},
  ): Promise<OpenedDocument & { disclosure: { document: Record<string, unknown>; redaction_log: unknown[] } | null }> {
    const opened = await this.openDocument(roomIdHex, docIdHex, auditorSecretHex, opts);
    let disclosure: { document: Record<string, unknown>; redaction_log: unknown[] } | null = null;
    if (opened.faithful && opened.plaintextUtf8) {
      try {
        const parsed = JSON.parse(opened.plaintextUtf8);
        if (parsed && typeof parsed === "object" && parsed.document) disclosure = parsed;
      } catch { /* not the expected JSON — leave null */ }
    }
    return { ...opened, disclosure };
  }

  // ── DR6 — private-policy composition + revocation/rotation (reads; no key custody) ──

  /** A room's composite-admission policy (which legs apply), or null if unset. */
  async getRoomPolicy(roomIdHex: string): Promise<RoomPolicy | null> {
    return normalizeRoomPolicy(await this.simRead(this.cfg.contracts.dataroom, "get_room_policy", [scBytes(roomIdHex)]));
  }

  /** The live composed admission decision: true iff the room has a policy AND `accessor` currently
   *  satisfies every enabled leg (membership ∧ compliance ∧ accredited, cross-called live, fail-closed).
   *  Drops the moment any leg is revoked or expires. */
  async isAdmitted(roomIdHex: string, accessorHex: string): Promise<boolean> {
    return Boolean(await this.simRead(this.cfg.contracts.dataroom, "is_admitted", [scBytes(roomIdHex), scBytes(accessorHex)]));
  }

  // ── Pattern 2 — prove-a-policy self-serve, PER-DOCUMENT access (reads; no key custody) ──

  /** A committee document's PER-DOCUMENT access policy (which legs apply), or null if unset — in which case
   *  access falls back to the room policy, then to bare DR2 membership (see `isDocAdmitted`). */
  async getDocPolicy(roomIdHex: string, docIdHex: string): Promise<RoomPolicy | null> {
    return normalizeRoomPolicy(await this.simRead(this.cfg.contracts.dataroom, "get_doc_policy", [scBytes(roomIdHex), scBytes(docIdHex)]));
  }

  /** The live PER-DOCUMENT admission decision (Pattern 2 self-serve key release): true iff `accessor`
   *  currently satisfies the document's effective policy (the doc policy if set, else the room policy, else
   *  bare DR2 membership), with the same live leg AND as `isAdmitted`. This is exactly what the DR3 keypers
   *  gate committee-share release on, so it is the right read for "can I open this document?". */
  async isDocAdmitted(roomIdHex: string, docIdHex: string, accessorHex: string): Promise<boolean> {
    return Boolean(await this.simRead(this.cfg.contracts.dataroom, "is_doc_admitted", [scBytes(roomIdHex), scBytes(docIdHex), scBytes(accessorHex)]));
  }

  /** Like `canAccessRoom`, but for a specific committee DOCUMENT (Pattern 2). Reads the document's effective
   *  policy (the per-doc policy if set, else the room policy; if neither, the contract falls back to bare
   *  membership) so a reader UI can show WHAT to prove and which legs are satisfied, plus the authoritative
   *  on-chain `is_doc_admitted` AND the keypers gate share release on. GATE ON `admitted`; the per-leg
   *  booleans are advisory display only and may briefly disagree under a concurrent revocation. */
  async canOpenDocument(roomIdHex: string, docIdHex: string, accessorHex: string): Promise<RoomAccess> {
    const docPolicy = await this.getDocPolicy(roomIdHex, docIdHex);
    const policy = docPolicy ?? (await this.getRoomPolicy(roomIdHex));
    const [admitted, revoked] = await Promise.all([
      this.isDocAdmitted(roomIdHex, docIdHex, accessorHex),
      this.isAccessRevoked(roomIdHex, accessorHex),
    ]);
    // No policy at any level → the contract falls back to bare membership.
    const requireMembership = policy ? policy.require_membership : true;
    const membership = requireMembership === false ? true : await this.isRoomGranted(roomIdHex, accessorHex);
    const gateGranted = async (gate: string | null | undefined): Promise<boolean | null> =>
      gate ? Boolean(await this.simRead(gate, "is_granted", [scBytes(accessorHex)])) : null;
    const [compliance, accredited] = await Promise.all([
      gateGranted(policy?.compliance_gate),
      gateGranted(policy?.accredited_gate),
    ]);
    return { admitted, membership, compliance, accredited, revoked, policy };
  }

  /** True iff `accessor` has been surgically revoked in this room (`revoke_access`). */
  async isAccessRevoked(roomIdHex: string, accessorHex: string): Promise<boolean> {
    return Boolean(await this.simRead(this.cfg.contracts.dataroom, "is_access_revoked", [scBytes(roomIdHex), scBytes(accessorHex)]));
  }

  /** The raw stored admission record for (room, accessor), or null. AUDIT ONLY — never gate access on this:
   *  it persists after revocation / leg expiry. Always gate on `isAdmitted` (the live on-chain AND). */
  async getAdmission(roomIdHex: string, accessorHex: string): Promise<Admission | null> {
    return normalizeAdmission(await this.simRead(this.cfg.contracts.dataroom, "get_admission", [scBytes(roomIdHex), scBytes(accessorHex)]));
  }

  /** Number of admissions in a room's append-only admission log. */
  async getAdmissionCount(roomIdHex: string): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.dataroom, "get_admission_count", [scBytes(roomIdHex)])) ?? 0);
  }

  /** The admission at the room's admission-log position `index` (0-based), if any. */
  async getAdmissionByIndex(roomIdHex: string, index: number): Promise<Admission | null> {
    return normalizeAdmission(await this.simRead(this.cfg.contracts.dataroom, "get_admission_by_index", [scBytes(roomIdHex), scU32(index)]));
  }

  /** A committee document's current key-rotation epoch (0 = original; bumped on each rotate). */
  async getCommitteeKeyEpoch(roomIdHex: string, docIdHex: string): Promise<number> {
    return Number((await this.simRead(this.cfg.contracts.dataroom, "get_committee_key_epoch", [scBytes(roomIdHex), scBytes(docIdHex)])) ?? 0);
  }

  /** The composed admission decision broken out by leg (for UIs that show WHY). Reads the room's policy to
   *  learn WHICH gates apply, then reads each leg's live state + the on-chain `is_admitted` AND. The per-leg
   *  gates are read at the EXACT addresses the policy pins (not SDK defaults). GATE ON `admitted` (the
   *  authoritative on-chain AND); the per-leg booleans are advisory display only and, because they are read
   *  in separate calls, may briefly disagree with `admitted` under a concurrent revocation. */
  async canAccessRoom(roomIdHex: string, accessorHex: string): Promise<RoomAccess> {
    const policy = await this.getRoomPolicy(roomIdHex);
    const [admitted, revoked] = await Promise.all([
      this.isAdmitted(roomIdHex, accessorHex),
      this.isAccessRevoked(roomIdHex, accessorHex),
    ]);
    const membership = policy?.require_membership === false ? true : await this.isRoomGranted(roomIdHex, accessorHex);
    const gateGranted = async (gate: string | null | undefined): Promise<boolean | null> =>
      gate ? Boolean(await this.simRead(gate, "is_granted", [scBytes(accessorHex)])) : null;
    const [compliance, accredited] = await Promise.all([
      gateGranted(policy?.compliance_gate),
      gateGranted(policy?.accredited_gate),
    ]);
    return { admitted, membership, compliance, accredited, revoked, policy };
  }
}

function msg(e: unknown): string {
  return String((e as Error)?.message ?? e);
}
