// Read-only SDK client (chain reads via testnet RPC + blobs via the backend's public routes) +
// demo secrets. Carried over from the prior Data Room pages' shared.tsx. The key never leaves the
// browser; the SDK custodies no keys.
import { ZkorageClient, sha256Hex } from "zkorage-sdk";

const API_BASE = (import.meta.env.VITE_BACKEND_URL as string | undefined) || "/api";

export const sdk = new ZkorageClient({ apiBaseUrl: API_BASE });

// Demo secrets, derived exactly as the backend/SDK derive them. Prefills so the key-free openers
// round-trip out of the box. A real recipient/auditor holds their own.
export const DEMO_RECIPIENT_SECRET = sha256Hex(new TextEncoder().encode("zkorage-demo-dataroom-recipient-key"));
export const DEMO_AUDITOR_SECRET = sha256Hex(new TextEncoder().encode("zkorage-demo-auditor-payroll-view-key"));
