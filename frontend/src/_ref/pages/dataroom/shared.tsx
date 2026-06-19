// Shared helpers + singletons for the decomposed Data Room routes (one capability per route).
import { ZkorageClient, sha256Hex } from "zkorage-sdk";

export const short = (h: string, n = 6) => (h && h.length > 2 * n ? `${h.slice(0, n)}…${h.slice(-n)}` : h);
export const isHex32 = (s: string) => /^[0-9a-fA-F]{64}$/.test(s.trim());
export const explorer = (kind: "contract" | "tx", id: string) =>
  `https://stellar.expert/explorer/testnet/${kind}/${id}`;

// Read-only SDK client (chain reads via testnet RPC + blobs via the backend's public routes).
const API_BASE = (import.meta.env.VITE_BACKEND_URL as string | undefined) || "/api";
export const sdk = new ZkorageClient({ apiBaseUrl: API_BASE });

// Demo secrets, derived exactly as the backend/SDK derive them — prefills so the key-free openers
// round-trip out of the box. A real recipient/auditor holds their own; the key never leaves the browser.
export const DEMO_RECIPIENT_SECRET = sha256Hex(new TextEncoder().encode("zkorage-demo-dataroom-recipient-key"));
export const DEMO_AUDITOR_SECRET = sha256Hex(new TextEncoder().encode("zkorage-demo-auditor-payroll-view-key"));
