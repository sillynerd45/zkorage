// LIVE read-only e2e of openCommitteeDocumentAsOwner against the deployed backend + testnet.
//   cd sdk && npx tsx test/escrow-open-live.ts
// Opens the seeded demo Model B committee doc via its owner-escrow copy (sealed to the demo recipient key by
// scripts/m3-live-e2e.mjs). No writes: it reads the on-chain committee doc, fetches the escrow + blob from
// apizk, recovers K with the demo secret, verifies the blob hash, and decrypts. Proves the opener against
// real infra (the hermetic unit test proves the guards; this proves the wiring + a real decrypt).
import { ZkorageClient, sha256Hex, DEMO_MODELB_ROOM, DEMO_MODELB_DOC } from "../src/index.js";

const API = process.env.API_BASE || "https://apizk.wazowsky.id";
const DEMO_RECIPIENT_SECRET = sha256Hex(new TextEncoder().encode("zkorage-demo-dataroom-recipient-key"));

const sdk = new ZkorageClient({ apiBaseUrl: API });
const r = await sdk.openCommitteeDocumentAsOwner(DEMO_MODELB_ROOM, DEMO_MODELB_DOC, DEMO_RECIPIENT_SECRET);

let failures = 0;
const ok = (c: boolean, label: string) => { console.log(`${c ? "✓" : "✗"} ${label}`); if (!c) failures++; };
ok(r.found, "demo committee doc found on-chain");
ok(r.faithful, "escrow opened faithfully with the demo owner key");
ok(r.contentHashVerified, "fetched blob hash matched the on-chain content_hash");
ok(!!r.plaintextUtf8 && r.plaintextUtf8.length > 0, "decrypted plaintext recovered");
console.log("plaintext (first 100):", JSON.stringify(r.plaintextUtf8?.slice(0, 100) ?? null));

// a wrong owner key must NOT open it (unfaithful, no plaintext)
const wrong = await sdk.openCommitteeDocumentAsOwner(DEMO_MODELB_ROOM, DEMO_MODELB_DOC, sha256Hex(new TextEncoder().encode("not-the-owner")));
ok(wrong.found && !wrong.faithful && wrong.plaintext === null, "a wrong owner key opens unfaithful (no plaintext)");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
