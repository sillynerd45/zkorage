# zkorage

**Verifiable claims on Stellar.** Prove a quantitative or boolean fact about *private, attested data*
(e.g. "reserves ≥ supply", "KYC-passed & not sanctioned", "revenue ≥ $X") **without revealing the
data** — and let anyone verify it **on-chain** on Soroban.

Engine: **RISC Zero zkVM → Groth16 (BN254) → bare on-chain `Groth16Verifier`** (rebuilt on
`soroban-sdk 26.1.0`). An ed25519-signed claim envelope from a trusted attester is checked *inside*
the zkVM guest, which also asserts the predicate; the proof is wrapped to Groth16 and verified by a
native BN254 pairing check on Stellar. The prover is **self-hosted** (the only party that ever sees the
private witness).

> Hackathon project — **Stellar Hacks: Real-World ZK**. The verifier is **unaudited; demo only.**

## Status — the full build is complete (testnet)
Weeks 1–8 (below) **and** the post-week-8 **Confidential Data Room (DR1–DR6)** are built, deployed, and
self-tested on Stellar testnet. A new **Bonded Proofs** pillar (a Soroban-native time-locked escrow plus a
live **solvency proof that dies when you pull your collateral**) is also live; see below. The whole stack
runs on **RISC Zero 5.0.0-rc.1** (GPU proving on a self-hosted box, with a CPU fallback). The frontend is a
single unified app — a **public marketing site** (`/` — landing, documentation, verify, explorer) plus a
**sidebar app** (`/app/*` — the five proofs, the Data Room, and Bonded Proofs) in the "Precision Ink"
design system.

**Live demo:** the app runs at **https://zkorage.wazowsky.id** (API at `https://apizk.wazowsky.id`), on
Stellar testnet. Connect **Freighter** (top right) to sign and submit your own proof transactions and pay
your own gas. Without a wallet, the backend relays every flow. Verification needs no wallet either way.

- **Bare Groth16 verifier (current):** `CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW`
  (selector `ef6cb709`, RISC0 `5.0.0-rc.1`). The Week-1 ID below (`CB75PMLN…`, params 3.0.0) was the
  original — during the **3.0.5 → 5.0.0-rc.1 migration** (to unblock GPU proving) all 8 guests were rebuilt
  and all 7 policy/gate contracts were re-pinned in place. Full record: `contract/deployment.testnet.json`.

## Layout
```
contract/   Soroban (Rust): bare RISC0 Groth16Verifier (sdk 26.1.0) + demo SEP-41 token + PoR policy.
prover/     RISC Zero zkVM guest + host (builds/runs on an x86 + Docker box, not Windows).
backend/    Node/TS orchestration API: mock custodian attester + prover proxy + on-chain verify/submit + REST.
frontend/   Vite + React + TS (Tailwind + shadcn, "Precision Ink"). Marketing site (/) + sidebar app (/app/*).
sdk/        zkorage-sdk: read-only, trust-minimized TS SDK (query + re-verify claims on the public chain).
mcp/        zkorage-mcp: read-only MCP server (agent tools) over the SDK. No key custody.
keyper/     DR3 threshold-ECIES keyper committee (3 services; 2-of-3 Shamir split of each Data Room doc key).
```

## Week 1 status — the spine is live on testnet
- **Verifier deployed (testnet):** `CB75PMLNOMDATZ7BMEYYJMQUEMPUIVZKBGMAHZKDJH6BBG57LI6DZ2JH`
  (selector `73c457ba`, RISC0 params `3.0.0`, WASM 15.9 KiB).
- On-chain `verify()` cost ≈ **30.3M CPU instructions** (~30% of the ~100M budget).
- A real RISC0 3.0.0 Groth16 proof verifies on-chain; tampered seal / tampered journal are rejected.

## Week 2 status — Proof-of-Reserves MVP live on testnet
An issuer proves **reserves ≥ circulating supply** without revealing the reserve figure; the supply is
bound on-chain to a real SEP-41 token's `total_supply`, and the result is verified + persisted.
- **Demo SEP-41 token (`zUSD`, 7 dp):** `CC3JKNC4EKALMT7WALUMCTVBSH73ZZSP3AC4B7IQUAZ7UYYZCEIISQLA`
- **PoR policy:** `CCXIEYFULSORMXN3AW5ZK4DLRANLSCRMROBEFEAWF3CL6MZ3YWSYQCMT`
  (pins the canonical guest image_id, recomputes `sha256(journal)` on-chain, cross-calls the bare
  verifier, then asserts `journal.supply == token.total_supply()` and persists).
- **Canonical guest image_id** (deterministic Docker build): `5bb5644b…d1e76ce2`.
- `submit_proof_of_reserves` ≈ **0.04 XLM**. Acceptance: valid → persisted; supply mismatch → `#10`;
  tampered → `#5`; `R<S` → guest panics (no receipt). Browser e2e via Playwright.

## Week 3 status — verification channels (history + public verify page + REST API)
A verified claim is now **independently checkable by anyone, without trusting our server**, three ways:
- **On-chain, append-only history.** The policy was **redeployed** (now **upgradeable**) with an
  append-only log: `get_count` / `get_by_index` / `get_history(start,limit)`; each `VerifiedResult`
  carries an `index`. Events expire (~7 days) so the on-chain log is the durable record.
  - **PoR policy (Week 3):** `CDQ2PA27UTJDLPA4XTGG647SNTMUYO2KRFGS3SW5SMNBIWRB7JVCZXQ6`
    (admin-gated `upgrade()` → in-place WASM swap; supersedes the Week-2 policy `CCXIEYFUL…QCMT`).
- **Documented REST API.** `backend/` adds `/count`, `/history`, `/result/:issuer`, a shareable
  `/audit/:issuer` bundle, an independent re-verify `POST /audit/verify` (→ a ✓/✗ checklist), an
  embeddable `/badge.svg`, and an **OpenAPI spec** at `/openapi.yaml` + Swagger UI at `/docs`.
- **Public "verify it yourself" page** (`/verify/:issuer`, no wallet). It recomputes `sha256(journal)`,
  checks the image-id pin, then asks the **public** verifier/policy/token contracts (directly, via a
  public RPC — not our backend) to confirm the Groth16 proof and the supply binding, and shows the
  exact `stellar contract invoke` commands to reproduce every check. Plus an `/explorer` of the
  on-chain history.

### Verify it yourself (no zkorage server)
```bash
# 1) Read the persisted result + history straight from the chain:
stellar contract invoke --id CDQ2PA27UTJDLPA4XTGG647SNTMUYO2KRFGS3SW5SMNBIWRB7JVCZXQ6 \
  --network testnet --source <any-funded-account> -- get_latest_result
stellar contract invoke --id CDQ2PA27UTJDLPA4XTGG647SNTMUYO2KRFGS3SW5SMNBIWRB7JVCZXQ6 \
  --network testnet --source <any> -- get_history --start 0 --limit 10

# 2) Re-verify the Groth16 proof against the public verifier (bundle from GET /audit/latest):
stellar contract invoke --id CB75PMLNOMDATZ7BMEYYJMQUEMPUIVZKBGMAHZKDJH6BBG57LI6DZ2JH \
  --network testnet --source <any> -- verify --seal <hex> --image_id 82bbf7ee… --journal <sha256(journal)>
```

## Week 4 status — TypeScript SDK + read-only MCP server
A verified claim is now **agent- and developer-consumable** — query + re-verify it with no keys and no
trust in our server.
- **`zkorage-sdk`** (`sdk/`): read-only, env-agnostic (Node + browser). Trustless on-chain reads
  (`getLatestResult`, `getHistory`, `getCount`, …), a full Groth16 re-verify (`verifyBundle` →
  9-check verdict against the public verifier), and the headline `isReservesGteSupply(issuer?)`.
  Testnet contract IDs baked in. `cd sdk && npm i && npm run smoke` → all green vs live testnet.
  **It is the single verification implementation** — the backend, the `/verify` page, and the MCP
  server all use it, so **build it first** (`cd sdk && npm i && npm run build`); backend + frontend
  consume it via `file:../sdk`.
- **`zkorage-mcp`** (`mcp/`): a **read-only MCP server** (stdio) exposing the SDK as agent tools —
  `is_reserves_ge_supply`, `get_history`, `verify_proof_bundle`, … — with **no key custody**. Self-test:
  `cd mcp && npm i && npm run build && npm run selftest` (a programmatic MCP client calls every tool).
  Wire it into Claude Desktop/Code via the snippet in `mcp/README.md`.
- **Frontend `/developer`**: dogfoods the SDK live in the browser (runs `isReservesGteSupply()` +
  `verifyBundle()` against the public RPC) + SDK/MCP quickstarts + OpenAPI link.

**Acceptance:** an MCP client asks *"is issuer X's reserves ≥ supply?"* → on-chain-verified answer
(`answer:true, fresh:true`), and `verify_proof_bundle` re-verifies the Groth16 proof (`verdict:true`) —
all with no keys held server-side.

## Week 5 status — KYC selective disclosure (identity gate) live on testnet
A user proves they are **KYC-verified by an allow-listed provider — without revealing their identity**,
and the proof grants on-chain access to a chosen Stellar account. The KYC provider signs a credential
containing the subject's identity; the zkVM proves "`kyc = passed` by an allow-listed issuer" while the
`subject_id` **stays private** (it is never committed to the journal). A second, accessor-bound guest +
a **relying-party gate** contract make this a second use-case on the same engine.
- **KYC gate:** `CCTHDSEQFMAOPJXI5GVSUTMXO5DHZUJS7YQYAEIGKFMOAMTNDKSL4FWT` — pins the canonical identity
  guest image_id, recomputes `sha256(journal)` on-chain, cross-calls the bare verifier, checks the
  identity policy (result, `claim_type=3`, allow-listed KYC issuer, freshness), then **grants access to
  the public `accessor`** the proof is bound to (append-only history; `is_granted` / `get_access`).
- **Identity guest image_id** (deterministic Docker build): `99e3fdb8…2d810ac2`. The 85-byte journal
  commits `{result, claim_type, issuer_id, accessor, nonce, expiry}` — **`subject_id` is absent**.
- **Not redirectable** without a nullifier: `accessor` is fixed inside the proof, so re-submitting a
  bundle only ever grants the accessor the holder chose. (Note: `accessor` is *not* authenticated by
  the proof — a grant proves a valid KYC credential exists and its holder chose this accessor, not
  that the accessor's owner is the subject; nullifier + accessor-auth are deferred to Week 6+.)
- **Soundness fix (this week):** the shared guest now asserts `pk == issuer_id` (the committed issuer
  must be the key that actually signed). This changed the **PoR guest image_id → `82bbf7ee…1c6f3d54`**;
  the live PoR policy was re-pinned in place (`set_image_id`) and a fresh PoR proof re-submitted.
- **SDK + MCP** gained the identity surface: `isKycVerified(accessor)`, `getAccess`, `getAccessHistory`,
  `verifyIdentityBundle`, and the MCP tools `is_kyc_verified`, `get_access`, `get_access_history`,
  `verify_identity_bundle`. **Frontend `/identity`** drives the prove → grant → relying-party flow.

**Acceptance:** a KYC'd user is granted access (no identity on-chain — `subject_id` never appears); an
un-granted account, a non-allow-listed issuer (`#8`), a tampered seal (`#5`), a wrong image (`#3`), and
a *failed* KYC (guest panics → no receipt) are all denied.

## Week 6 status — Compliance (KYC ∧ not-sanctioned) live on testnet
A user proves they are **KYC-verified AND not in a sanctions deny-list — in one proof, identity hidden**,
and the proof grants on-chain access to a chosen account. A single combined guest verifies the KYC
credential **and** proves the (private) `subject_id` is absent from a sanctions deny-list via a
**SHA-256 Indexed-Merkle-Tree non-membership** path, committing only the deny-list **root** (which the
gate pins). Because both predicates run in one guest, they bind to the **same** hidden identity.
- **Compliance gate:** `CDSA3PUL7OZ5HKLIT73ZTG64TLYK4QTO5ZHZKHA3JBS76R5L5Q2EO4FV` — like the KYC gate
  plus a pinned **`deny_root`**; `request_access` adds `deny_root == Config.deny_root` (`#11`
  `DenyRootMismatch`). `is_granted` re-checks both expiry **and** the deny-root, so an admin
  `set_deny_root` (a new sanction) **immediately revokes** stale grants.
- **Compliance guest image_id** (deterministic Docker build): `eba31f8e…21005916`. The 117-byte journal
  commits `{result, claim_type=4, issuer_id, deny_root, accessor, nonce, expiry}` — **`subject_id` is absent**.
- **Why SHA-256, not Poseidon:** RISC0 has a sha256 precompile, so a depth-20 non-membership path is
  ~1 segment (combined proof ≈ 2 segments / ~12 min on CPU); Poseidon-BN254 measured ~28 segments (no
  BN254 field precompile in the zkVM). The gate compares roots only (no on-chain hashing), so the hash
  is a sound off-chain↔guest choice. The deny-list (a Soroban contract pins the root; the backend
  `denylist.ts` IMT builder is the off-chain authority) holds a few mock sanctioned identities.
- **SDK + MCP** gained the compliance surface: `isCompliant(accessor)`, `getComplianceAccess`,
  `getComplianceHistory`, `verifyComplianceBundle`, and the MCP tools `is_compliant`,
  `get_compliance_access`, `get_compliance_history`, `verify_compliance_bundle`. **Frontend
  `/compliance`** drives the prove → grant → relying-party flow (pick "Mallory" for the sanctioned ✗).

**Acceptance:** a KYC'd & not-sanctioned user is granted (identity never on-chain); a **sanctioned**
subject cannot produce a non-membership proof (no receipt); a stale `deny_root` (`#11`), a tampered seal
(`#5`), a wrong image (`#3`), and a failed KYC (no receipt) are all denied. Adversarial review **SOUND**;
Codex review **clean**. The prover is **worker-first for all kinds** (multi-core worker when online, multi-core
VM fallback), both emitting the contract-pinned image_ids.

## Week 7 status — Confidential payroll (proof-of-income + auditor view-key) live on testnet
An employee proves **"paid ≥ a threshold"** while the **salary stays fully private** — the contracted
figure is confidential between employee and company. The guest verifies an attester-signed payroll
record, asserts `salary ≥ threshold`, and **encrypts the salary in-guest to an allow-listed auditor's
x25519 key** (ECIES). The public sees only `✓ paid ≥ X` + an opaque ciphertext; an **auditor's view
key** unlocks the exact figures — *provably the signed salary* (the proof binds the ciphertext).
- **Payroll gate:** `CA6XYNHYR3GS3TQ24Z2Y45SXRNQDA5Z4L2PU54YM2WUKSMPVWVMYZCDA` — like the KYC gate
  (claim_type 5) plus an **auditor-key allowlist**; `submit_payroll_proof` adds `auditor_pub ∈ allowlist`
  (`#11` `AuditorNotAllowed`) and stores the disclosure (`eph_pub`/`ct`/`tag`) in each grant. It only
  RECORDS the cleared threshold — no on-chain "market rate" (the rate is confidential). Reuses the bare
  verifier (no redeploy).
- **Payroll guest image_id** (deterministic Docker build): `b9c97e6b…f0a9432f`. The 229-byte journal
  commits `{result, claim_type=5, issuer_id, threshold, accessor, auditor_pub, eph_pub, ct(40), tag(32),
  nonce, expiry}` — **the salary is absent**.
- **Auditor disclosure (Option B — in-guest ECIES):** `eph_pub = X25519(eph, BASE)`,
  `shared = X25519(eph, auditor_pub)`, a sha256 counter-mode keystream encrypts `salary‖blinding`, and
  `tag = sha256(DOMAIN_TAG ‖ salary ‖ blinding)` gives the auditor a definitive "faithful ✓" after
  decrypt (and detects a wrong key). The in-guest X25519 was **measured at ~3 segments** (the curve25519
  precompile accelerates it — no Poseidon-style blowup). The salary never leaves the prover in clear.
- **SDK + MCP** gained the payroll surface: `isIncomeVerified(accessor)`, `getPayrollAccess/History`,
  `verifyPayrollBundle`, `openPayrollDisclosure(accessor, viewKey)` (pure, key-free — the SDK never
  custodies a key), and the MCP tools `is_income_verified`, `get_payroll_access`, `get_payroll_history`,
  `verify_payroll_bundle`. **Frontend `/payroll`** drives the employee prove→grant flow + an auditor view
  that unlocks per-employee salaries + the payroll total (each with a faithful badge).

**Acceptance:** an employee is income-verified with the salary hidden (only the boolean + ciphertext are
public); the **auditor** unlocks the exact salary (6000) + the deduped payroll total via the view key
(faithful ✓), a **wrong key** yields faithful ✗, a salary below the threshold produces no receipt, a
tampered seal is denied (`#5`), and a non-allow-listed auditor is denied (`#11`). Adversarial review
**SOUND**; code review APPROVE; a 2nd deeper pass added `/payroll/audit` full-log pagination + a
frontend/gateway hardening; **Codex review clean**. `submit_payroll_proof` ≈ 0.037 XLM.

## Week 8 status — Fundraising (the composition finale) live on testnet
A fundraise admits an investor **only by proving BOTH** — (a) they are an **accredited investor** (an
identity-style proof; identity hidden) **AND** (b) the fundraise has **revenue ≥ X** (a value≥threshold
financial proof; the real revenue hidden). Two independent ZK proofs about two **different** parties,
**AND'd on-chain**. This is the same engine as every other page — composed.
- **Accredited gate:** `CCLSXZBOPCAJQS6L54EAGZQHTD5QUES2OSYCFX5XJT6ZXSICRPS4QKQZ` — a faithful clone of
  the KYC gate (`claim_type=7`), grants an "accredited = yes" credential to an `accessor`; identity hidden.
  **Accredited guest image_id** `04fe8d3e…54cd66ab` (deterministic Docker build; NEW-2 domain-separated
  signature `zkorage-accredited-v1\0`).
- **Fundraise contract:** `CDEV4METH74Z42DFV6HC3VLF3PWACXVIIS7C3PLK6CZT2B6L5I3YBC2L` — ingests the
  revenue proof itself (`submit_revenue_proof`: the **generic PoR guest** `82bbf7ee…` reused for
  `claim_type=6`, binds the proven floor `== X` and the auditor allowlist), then
  `request_investor_access(accessor)` = the **AND**: `is_revenue_verified()` (freshness- + X-consistent)
  **cross-calls** the accredited gate's `is_granted(accessor)` (`try_is_granted`, fail-closed) → admits.
  `can_access` is the live read of the same AND. Both legs drop when either proof/credential expires.
  `request_investor_access` ≈ **0.017 XLM**. Demo `X = $1,000,000`.
- **SDK + MCP (v0.8.0)** gained the composition surface: `isAccredited(accessor)`,
  `isFundraiseRevenueVerified()`, **`canAccessFundraise(accessor)`** (the composed AND, on-chain),
  `verifyAccreditedBundle` / `verifyRevenueBundle`, and the MCP tools `is_accredited`,
  `can_access_fundraise`, `get_fundraise_info`, `verify_accredited_bundle`, `verify_revenue_bundle`.
  **Frontend `/fundraise`** drives the company prove-revenue + investor prove-accredited flows and shows
  the composition banner (per-leg ✓/✗ → ACCESS GRANTED/DENIED).

**Acceptance:** only a **proven-accredited** investor can access a fundraise that **proves revenue ≥ X** —
both required. Negatives: accredited-but-no-revenue → `#11 RevenueNotVerified`; revenue-but-not-accredited
→ `#12 NotAccredited`. Verified live on testnet (positive + both negatives + a full backend e2e for a fresh
investor). **Two review passes:** adversarial **SOUND** (no Critical/High) + code review **Ship-it** —
7 fixes applied (incl. `try_is_granted` totality, revenue X-consistency, MCP env overrides, an empty-input
guard, a fail-closed worker job-build); the fundraise was upgraded in-place. **Codex review CLEAN.** The
8-week build is complete and reviewed.

## Confidential Data Room (post-Week-8 — DR1–DR6) live on testnet
A confidential document room built on the same engine. The marquee load-bearing ZK is **anonymous
eligibility**: you get into a room **only by proving you're on its approved list, without revealing which
member you are, and only once** (a per-room nullifier). DataRoom contract
`CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN` (upgraded in place across DR1–DR6):
- **DR1 — store a document:** encrypt a file, keep it private, post only a tamper-evident fingerprint
  on-chain; an in-guest ECIES seal binds a per-doc key to a recipient's x25519 key.
- **DR2 — get in anonymously ⭐:** depth-20 SHA-256 Merkle membership over a per-room approved-set root +
  a per-room nullifier; identity is absent from the record (the load-bearing ZK).
- **DR3 — release the key:** each per-doc key is **Shamir-split 2-of-3** across an independent keyper
  committee (`keyper/`) — no single server holds it; the recipient collects ≥2 sealed shares and
  reconstructs + decrypts client-side.
- **DR4 — prove a signed fact:** re-verify a real **RSA-2048** issuer signature **inside the zkVM** and
  prove "value ≥ threshold" about the signed statement without revealing it (allow-listed issuer key).
- **DR5 — share a masked copy:** prove a fact about a sealed document and hand an auditor a redacted copy
  that's provably the genuine file.
- **DR6 — meet all conditions:** admit someone only if they satisfy a composite policy
  (member ∧ KYC ∧ accredited ∧ not-sanctioned), each an independent proof AND'd on-chain; plus surgical
  per-accessor revocation and committee key rotation.
- **Pattern 2, open a shared document (per-document self-serve access):** an owner attaches a per-document
  policy (member, KYC, accredited) to a committee document; a reader proves it anonymously, the 2-of-3
  keepers release the key to their proof-bound key, and they decrypt in-browser. On-chain `set_doc_policy` /
  `is_doc_admitted` / `get_doc_policy` (additive upgrade, no new guest); the keepers gate share release on
  `is_doc_admitted`. The owner side also gained a Documents submenu, a "Browse = rooms your wallet owns"
  view (on-chain ownership), and dropped the redundant contents column.

The SDK/MCP gained the read-only Data Room surface (no key custody); the frontend `/app/dataroom` (v0.7.0)
drives all of it. Reviewed clean across the slices (adversarial SOUND + code-review Ship-it).

## Bonded Proofs (escrow) — live on testnet
A second direction, motivated by Stellar's Claimable Balances. The research (in `development/`, gitignored)
found that a classic Claimable Balance can't anchor a ZK proof — a Soroban contract can't read one, and a CB
is fully public — so the load-bearing design is a **zkorage-owned, Soroban-native time-locked escrow**: lock
any SEP-41/SAC token until a chosen time, with a revocable self-bond or a non-revocable one-way send, and a
gate-readable `is_locked()` / `get_lock()`. It carries the first of two ZK products — a **solvency proof that
dies when you pull your collateral** (LIVE) — with an **anonymous tier that expires at X** still to come.

- **Escrow (testnet):** `CAMQKJKAJTOMT66N5N3E3VIRTN5ACDKV6P3Z2HLYVJHLAVRGJKHZFOXC` (immutable, no admin over
  funds; only a lock's depositor/claimant can move it). Bond token `CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5`
  (a demo "zkUSD"). Two adversarial reviews; 22/22 contract tests. Full record: `contract/deployment.testnet.json → escrow_BP1`.
- **Solvency proof that dies when you pull your collateral (LIVE).** An issuer proves `reserves ≥ supply`
  (the reserve figure stays private, attested by a mock reserve auditor) bound to a revocable escrow lock.
  The **solvency gate** `CDHUG4NFTDIO4HX2MZH3PR77EKYUAU47HVKH4UO2WG7GSKDEF4ABWMLA` (`claim_type=12`) verifies
  the Groth16 proof, binds the proven supply to the live zUSD `total_supply()`, requires the lock owner's
  auth, then reads `escrow.get_lock` **live** on every `is_granted` call — so the grant flips **SOLVENT →
  VOID the instant the issuer un-bonds**. New guest `solvency_predicate` (image `d0a2f137…`, a 173-byte
  journal whose first 61 bytes are byte-identical to the PoR journal). Reviewed across three passes (security
  auditor SOUND + code reviewer Ship-it + a third fix-hunt pass) + **Codex CLEAN**.
- **Shipped:** the `/app/bonded` pillar (Overview · My Balances · Deposit · **Prove Solvency**, frontend
  **v0.9.1**) with a live ACTIVE→VOID badge; the `backend /escrow/*` + `/bonded/solvency/*` REST surface; a
  9th `solvency` prover kind (gateway + GPU worker); SDK/MCP **v0.16.0** (`isSolvent`, key-free). Full record:
  `contract/deployment.testnet.json → solvency_gate_BP3 / guest_solvency`.

## Run the Week-2 slice
```bash
# Contracts (Windows/any): deploy the demo token + the PoR policy to testnet
contract/scripts/deploy_token.sh             # -> .token_id.testnet (+ mint initial supply)
contract/scripts/deploy_policy.sh            # -> .policy_id.testnet (init w/ verifier+token+image_id)

# Backend (fill .env from .env.example: token/policy IDs + SIGNER_SECRET)
cd backend && npm install && npm run dev     # :8787  /supply /prove-reserves /submit /result /mint /burn

# Frontend — issuer dashboard
cd frontend && npm install && npm run dev     # Verify on-chain -> ✓ ; Mint -> re-Verify -> ✗ supply mismatch
cd frontend && npx playwright test            # headed Chromium e2e (verify -> mint -> mismatch -> burn -> verify)
```

## Run the Week-1 slice
```bash
# 1) Contract (Windows/any): build + deploy + verify the bundled fixture
contract/scripts/deploy.sh           # deploy to testnet, prints contractId + selector
contract/scripts/measure.sh          # on-chain verify cost

# 2) Prover (on the x86 VM): generate a real proof bundle
#    cd prover && RUST_LOG=info cargo run --release -p host   -> proof.txt + bundle.json
#    copy bundle.json to backend/data/bundle.json

# 3) Backend
cd backend && cp .env.example .env && npm install && npm run dev   # :8787

# 4) Frontend
cd frontend && npm install && npm run dev                          # :5173 -> click "Verify on-chain"
```

See `development/Build-Plan/` (local-only) for the full 8-week plan and per-week progress.
