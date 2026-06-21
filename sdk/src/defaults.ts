import type { ZkorageConfig } from "./types.js";

/** Canonical (deterministic Docker build) PoR guest image_id the policy pins. Re-pinned in Week 5
 * (the `pk == issuer_id` soundness fix changed the guest bytes). */
export const CANONICAL_IMAGE_ID =
  "973c983125ad3a9f115b2f4d8d12ec39e3f1b107f15c57643f72baf36f923502";

/** Canonical identity (KYC) guest image_id the gate pins. */
export const IDENTITY_IMAGE_ID =
  "a5198a5a359359b08dc1b0faa260e253d413dea5035c1375d19b742f7deaeb3b";

/** Canonical compliance (KYC ∧ not-sanctioned) guest image_id the compliance gate pins. */
export const COMPLIANCE_IMAGE_ID =
  "54d5921c58280b63ef80905ffe6d4e506f77031b53ff2a347fe84ace423cb129";

/** The demo sanctions deny-list Merkle root (depth 20) pinned by the compliance gate. */
export const DENY_ROOT =
  "8cb45df8b0c8224c818ffc5e4d3c3d56cc6928d5c49f75528ba850def35fd18d";

/** Canonical payroll (proof-of-income) guest image_id the payroll gate pins. */
export const PAYROLL_IMAGE_ID =
  "2c9cc61b0dc261290209067783365842eca14b77981486eb535bbacfbd1e2785";

/** Identity / KYC claim_type (PoR = 2, generic = 1). */
export const CLAIM_TYPE_IDENTITY = 3;

/** Compliance (KYC ∧ not-sanctioned) claim_type. */
export const CLAIM_TYPE_COMPLIANCE = 4;

/** Payroll (proof-of-income) claim_type. */
export const CLAIM_TYPE_PAYROLL = 5;

/** Revenue (value≥threshold financial claim) claim_type — the financial leg of the fundraise (W8). */
export const CLAIM_TYPE_REVENUE = 6;

/** Accredited-investor (identity-style) claim_type — the identity leg of the fundraise (W8). */
export const CLAIM_TYPE_ACCREDITED = 7;

/** Canonical accredited-investor guest image_id the accredited gate pins (Week 8). */
export const ACCREDITED_IMAGE_ID =
  "26d743739468287991220d6da2cb891616aa7c6b90da2eda9836395f31bcc947";

/** The revenue claim REUSES the generic PoR guest image (value≥threshold) — claim_type 6 (W8). */
export const REVENUE_IMAGE_ID = CANONICAL_IMAGE_ID;

/** The public revenue floor `X` the fundraise pins (demo: $1,000,000, whole USD). */
export const FUNDRAISE_THRESHOLD = "1000000";

/** DR1 — Confidential Data Room: the canonical "seal" guest image_id the DataRoom contract pins. */
export const DATAROOM_IMAGE_ID =
  "8f24842d0647a0671ed1b898f6a42c2d104ff04b3f152067c93d9449bf65a3ce";

/** Data-room seal claim_type (PoR=2/KYC=3/compliance=4/payroll=5/revenue=6/accredited=7). */
export const CLAIM_TYPE_DATAROOM_SEAL = 8;

/** DR2 — anonymous eligibility: the canonical membership guest image_id the DataRoom contract pins for
 * `request_access` (ed25519+sha256, reproduces cross-machine). */
export const MEMBERSHIP_IMAGE_ID =
  "9550a12e84a9b26bc3926e79e271dc0f1a740f45d86f88c19d3e3e438939011c";

/** Membership claim_type (anonymous-eligibility proof; one access per identity per room). */
export const CLAIM_TYPE_MEMBERSHIP = 9;

/** DR4 — document-authenticity: the canonical docauth guest image_id the DataRoom contract pins for
 * `attest_document_fact`. Verifies a REAL third-party RSA-2048 signature in-zkVM (RSA+sha256, reproduces
 * cross-machine). */
export const DOCAUTH_IMAGE_ID =
  "e4f4a356cbacde61ef901500a6d396d2fa83a666b31224be2848fd69bbff8741";

/** Docauth claim_type (signed-document fact: value >= threshold, the statement private). */
export const CLAIM_TYPE_DOCAUTH = 10;

/** DR5 — data-side teaser: the canonical guest image_id the DataRoom pins for `attest_teaser`. The teaser
 * REUSES the generic value>=threshold guest UNCHANGED (no new guest), so this == {@link CANONICAL_IMAGE_ID}. */
export const TEASER_IMAGE_ID = CANONICAL_IMAGE_ID;

/** Teaser claim_type (a public fact about a sealed doc: figure >= threshold, the figure private). Distinct
 * from the fundraise revenue (6) so a revenue proof can't be ingested as a teaser. */
export const CLAIM_TYPE_TEASER = 11;

/** The demo "data-room appraiser" teaser attester (= its ed25519 pubkey), allowlisted in the DataRoom. The
 * appraiser vouches a teaser figure; a self-minted key is rejected (`IssuerNotAllowed`). */
export const DEMO_TEASER_ATTESTER_ID =
  "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";

/** The demo recipient's x25519 PUBLIC key — the disclosure target a DR1 demo document key is sealed to.
 * The matching SECRET (which opens the seal) is held by the recipient only — never shipped in the SDK; it
 * is derived as sha256("zkorage-demo-dataroom-recipient-key")[..32] (see the smoke test). */
export const DEMO_RECIPIENT_PUB =
  "97a6b9254272845779e64fb5fadd721826bde996e09265cd099f726ad9b9282a";

/** A stable demo document anchored on testnet (room `zkorage-dataroom-demo` / doc `dr1-welcome-doc`,
 * sealed to {@link DEMO_RECIPIENT_PUB}), so the read + key-free open round-trip is reproducible. */
export const DEMO_DATAROOM = {
  roomId: "c1c33201dad189af07b344cc6b20a9a3e6b75601f04344e618d5281cefa46d75",
  docId: "7cb3ee5c7529aa68e2af62fdc684038f00b33d4a81d9bc7821c684e668f98438",
  content:
    "zkorage Confidential Data Room — DR1 demo document. If you can read this, the ECIES seal opened faithfully and the ciphertext matched its on-chain content hash. 🔒",
};

/** A stable demo COMMITTEE document (DR3) anchored on testnet: room `zkorage-dr3-committee-demo` / doc
 * `dr3-committee-welcome-doc`, granted to the demo member (accessor `ed4928c6…`). Its key K is Shamir-split
 * (2-of-3) across the keyper committee and released, on grant, sealed to {@link DEMO_RECIPIENT_PUB} — so the
 * collect → reconstruct → key-free open round-trip is reproducible (the recipient secret is the demo one). */
export const DEMO_DATAROOM_COMMITTEE = {
  roomId: "a17388e8fe6c1ea798522f463d095e8267ca28d1c52b6a2a9977b2a42c40a8c8",
  docId: "614664eba5e05904c98125425a8bd175f9908f74cab1fd4869143a0d1ebfe38a",
  accessor: "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1",
};

/** A stable demo DR4 document-authenticity FACT anchored on testnet (room `zkorage-dataroom-dr4-demo`): the
 * mock bank (issuer key `3d181231…`) RSA-signed a statement, and the docauth guest proved `balance >= X`
 * in-zkVM WITHOUT revealing the statement. The fact reveals only the predicate, the threshold, the issuer
 * key hash, and the document hash (`msgDigest`). Read it back / re-verify with `getDocumentFact` /
 * `verifyDocauthBundle`; the exact balance stays private. */
export const DEMO_DATAROOM_DOCAUTH = {
  roomId: "7114b21093db993fec02abec52e32610ac2baeb061ff16669f7bff52ee1b58e0",
  msgDigest: "3764e06dfd6236e853580d5db31b87cac89a2004e5fe5cd6486468e2f6f71ebf",
  issuerKeyHash: "3d1812311f69c609de6d57ba960e8dc4ca35c309b10f721b965ee415b0f05e51",
  threshold: "1000000",
  fieldTag: 1,
};

/** A stable demo DR5 teaser + auditor redacted view anchored on testnet (room `zkorage-dataroom-dr5-demo`).
 * The appraiser ({@link DEMO_TEASER_ATTESTER_ID}) vouched `annual_revenue >= $1M` about the sealed FULL
 * statement (`fullDocId`) — figure private; read/re-verify with `getTeaser` / `verifyTeaserBundle`. The
 * `viewDocId` is a REDACTED view sealed to the demo auditor ({@link DEMO_AUDITOR_PUB}); the auditor opens it
 * key-free with `openDisclosure(roomId, viewDocId, auditorSecret)` (PCI/HIPAA/GDPR-masked private fields). */
export const DEMO_DATAROOM_TEASER = {
  roomId: "e4fec337908b737271e676adcc6b07de30f6a814aa4207ab57db471e1bad76c2",
  fullDocId: "c17d9f3c7355894889a5b9b72cfe7a0e940e59e67816b56a0955f894ff054642",
  viewDocId: "aac527e91a16d28ce92d19243d85b4e9cf636d41c80cc4a5b69af28c7850d404",
  threshold: "1000000",
  fieldTag: 1,
};

/** A stable demo DR6 private-policy-composition room anchored on testnet (`zkorage-dr6-policy-demo`): the
 * fixed demo member (accessor `ed4928c6…`) is ADMITTED under the composite policy `member ∧ compliance ∧
 * accredited` — proven anonymously (no identity / which-member / attribute revealed). `docId` is a committee
 * document for the key-rotation demo. Read the live composed decision with `canAccessRoom(roomId, accessor)`
 * (per-leg breakdown) or `isAdmitted`; the policy with `getRoomPolicy`. */
export const DEMO_DATAROOM_POLICY = {
  roomId: "db16742cf50b4443db1336b65ece5a532515487d7d4f7b6feab87bbb87396489",
  docId: "8b041fe3998194a15fab4bf9d32db0cc528ef12eec9a6b521ec5124ad66508a6",
  accessor: "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1",
};

/** Live Stellar testnet deployment. Verifier + token W1/W2; policy W3; gate W5; compliance W6;
 * payroll W7; accredited + fundraise W8; dataroom DR1–DR6. */
export const TESTNET: ZkorageConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contracts: {
    verifier: "CBAPC663PTWIWDLYNCG5WAD5MIZF4SKY43U6L2NM5ZUU5XFOS4JDYAFW",
    token: "CC3JKNC4EKALMT7WALUMCTVBSH73ZZSP3AC4B7IQUAZ7UYYZCEIISQLA",
    policy: "CDQ2PA27UTJDLPA4XTGG647SNTMUYO2KRFGS3SW5SMNBIWRB7JVCZXQ6",
    gate: "CCTHDSEQFMAOPJXI5GVSUTMXO5DHZUJS7YQYAEIGKFMOAMTNDKSL4FWT",
    compliance: "CDSA3PUL7OZ5HKLIT73ZTG64TLYK4QTO5ZHZKHA3JBS76R5L5Q2EO4FV",
    payroll: "CA6XYNHYR3GS3TQ24Z2Y45SXRNQDA5Z4L2PU54YM2WUKSMPVWVMYZCDA",
    accredited: "CCLSXZBOPCAJQS6L54EAGZQHTD5QUES2OSYCFX5XJT6ZXSICRPS4QKQZ",
    fundraise: "CDEV4METH74Z42DFV6HC3VLF3PWACXVIIS7C3PLK6CZT2B6L5I3YBC2L",
    dataroom: "CDUQITRVJOPJNVWBUINLZFI2LHPOLVFW2I7354WEFDG2W3VIG627HLNN",
    solvencyGate: "CDHUG4NFTDIO4HX2MZH3PR77EKYUAU47HVKH4UO2WG7GSKDEF4ABWMLA",
    escrow: "CAMQKJKAJTOMT66N5N3E3VIRTN5ACDKV6P3Z2HLYVJHLAVRGJKHZFOXC",
    bondToken: "CCFHRZAP7GYUBNJ4RN7NBZL5GS7Q32F4CIXDTWTTIGPYEDWRIS2TUPA5",
    // BP5 tier-gate (deployment.testnet.json -> tier_gate_BP5). Overridable via config.
    tierGate: "CASSJSBMFDS3BCUBYKXG52SUS7GIHBCHDUM5FGQO4LY5VOWPUPPUFKZP",
  },
  // Any existing funded testnet account works as the read-only sim source (it never signs).
  readSource: "GDLECNXD76OZQROASQGWEP4KAMJWTJXZW2LN7OJGYPXIJDRXACWGXZY6",
  decimals: 7,
};

/** The demo custodian issuer (= its ed25519 pubkey), allow-listed in the PoR policy. */
export const DEMO_ISSUER_ID =
  "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";

/** The demo KYC provider (= its ed25519 pubkey), allow-listed in the gate. */
export const DEMO_KYC_ISSUER_ID =
  "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618";

/** The deterministic demo "user wallet" — the accessor the demo KYC proof grants access to. */
export const DEMO_USER = {
  g: "GABF456WZDNHKUVWA6BBAYLACD3QTMZA745AVRSBK7IYOBQ5NQJ3HGRC",
  accessorHex: "025e77d6c8da7552b6078210616010f709b320ff3a0ac64157d187061d6c13b3",
};

/** The mock payroll attester (= its ed25519 pubkey), allow-listed in the payroll gate. */
export const DEMO_PAYROLL_ATTESTER_ID =
  "66be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a";

/** The demo auditor's x25519 PUBLIC key (the disclosure target, allow-listed in the payroll gate). The
 * matching secret (the view key) is held by the auditor only — never in the SDK. */
export const DEMO_AUDITOR_PUB =
  "c275cf79ef891f9d1a725a7ecd74047854754b4445c92b75f193725f6376a83f";

/** The mock accreditation provider (= its ed25519 pubkey), allow-listed in the accredited gate (W8). */
export const DEMO_ACCREDITED_ISSUER_ID =
  "91a28a0b74381593a4d9469579208926afc8ad82c8839b7644359b9eba9a4b3a";

/** The mock revenue auditor (= its ed25519 pubkey), allow-listed in the fundraise contract (W8). */
export const DEMO_REVENUE_ATTESTER_ID =
  "d9bf2148748a85c89da5aad8ee0b0fc2d105fd39d41a4c796536354f0ae2900c";

/** BP3 — Bonded Proofs solvency gate: the canonical solvency guest image_id the gate pins. */
export const SOLVENCY_IMAGE_ID =
  "d0a2f137812e05084aa79d0f7353d3fb7785da25facadd140494b94bed10e267";

/** Solvency-bonded claim_type (reserves >= supply, bound to a revocable escrow lock). */
export const CLAIM_TYPE_SOLVENCY = 12;

/** The mock bonded reserve auditor (= its ed25519 pubkey), allow-listed in the solvency gate. */
export const DEMO_SOLVENCY_AUDITOR_ID =
  "66cd608b928b88e50e0efeaa33faf1c43cefe07294b0b87e9fe0aba6a3cf7633";

/** BP5 — Bonded Proofs tier gate: the canonical tier guest image_id the gate pins (anonymous bonded tier). */
export const TIER_IMAGE_ID =
  "2671938b59598c129913fee8e0ef29159e6475dd61c37c503429bdaf0fba4e69";

/** Anonymous bonded-tier claim_type (enrolled member ∧ qualifying bonded lock, expiring at X). */
export const CLAIM_TYPE_TIER = 13;

/** A stable demo anonymous-tier GRANT anchored on testnet (gate `tier_gate_BP5`). The fixed demo member
 * (id 0x11/0x22, holder 0x03 -> accessor `ed4928c6`, the same demo member as DR2/DR3/DR6) proved the demo
 * tier ANONYMOUSLY: an enrolled member AND a non-revocable qualifying bond (floor 100 zkUSD, locked until X).
 * Read the live decision with `isTierGranted(DEMO_TIER.accessor)`; the grant reveals neither which member nor
 * which lock. Seed / re-seed with `backend/scripts/bp5-tier-anchor-demo.mjs` (idempotent). */
export const DEMO_TIER = {
  accessor: "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1",
  threshold: "1000000000", // 100 zkUSD (1e9 base units)
  unlockAfter: 1800000000, // ~2027-01-15 (the shared demo deadline X)
};
