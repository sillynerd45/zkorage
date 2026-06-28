// The overview-led IA, in one place. Both variants render from this single registry:
//   Variant A → hero feature-card grid + a small top-bar.
//   Variant B → Dashboard cards + the grouped left sidebar (route→label→icon→group).
// Plain-language titles/blurbs carried over from the prior UX pass (re-skin, don't rewrite copy).
import {
  Landmark,
  UserCheck,
  ShieldCheck,
  Wallet,
  Rocket,
  FolderLock,
  BadgeCheck,
  Compass,
  Terminal,
  Lock,
  type LucideIcon,
} from "lucide-react";

export type CapabilityGroup = "prove" | "dataroom" | "bonded" | "verify" | "developer";

export interface GroupMeta {
  key: CapabilityGroup;
  label: string;
  blurb: string;
}

export const GROUPS: GroupMeta[] = [
  { key: "prove", label: "Prove a fact", blurb: "Prove something true about private data without revealing the data." },
  { key: "dataroom", label: "Data Room", blurb: "Share sealed documents and control who can open them, anonymously." },
  { key: "bonded", label: "Bonded Proofs", blurb: "Lock tokens until a chosen time, and prove facts that hold only while the bond stays locked." },
  { key: "verify", label: "Verify & explore", blurb: "Re-check any proof yourself, or browse every record on the public ledger." },
  { key: "developer", label: "Developer", blurb: "Use zkorage from your own code. There is an SDK, an MCP server, and a REST API." },
];

export interface Capability {
  key: string;
  title: string; // plain-language name
  to: string; // route
  group: CapabilityGroup;
  icon: LucideIcon;
  blurb: string; // one line: what it does
  proves: string; // short "what it proves" chip
  cta: string; // primary action label
}

export const CAPABILITIES: Capability[] = [
  {
    key: "reserves",
    title: "Proof-of-Reserves",
    to: "/app/reserves",
    group: "prove",
    icon: Landmark,
    blurb: "Prove reserves are at least the circulating supply. The reserve figure stays private.",
    proves: "reserves ≥ supply",
    cta: "Open Proof-of-Reserves",
  },
  {
    key: "identity",
    title: "Identity (KYC)",
    to: "/app/identity",
    group: "prove",
    icon: UserCheck,
    blurb: "Prove you passed KYC to gain access, without revealing who you are.",
    proves: "KYC passed · identity hidden",
    cta: "Open Identity",
  },
  {
    key: "compliance",
    title: "Compliance",
    to: "/app/compliance",
    group: "prove",
    icon: ShieldCheck,
    blurb: "Prove KYC passed AND you're not on a sanctions list, in one proof.",
    proves: "KYC ∧ not-sanctioned",
    cta: "Open Compliance",
  },
  {
    key: "payroll",
    title: "Confidential payroll",
    to: "/app/payroll",
    group: "prove",
    icon: Wallet,
    blurb: "Prove income is at or above a threshold; the exact salary stays private (an auditor holds a view key).",
    proves: "income ≥ threshold",
    cta: "Open Payroll",
  },
  {
    key: "fundraise",
    title: "Fundraise",
    to: "/app/fundraise",
    group: "prove",
    icon: Rocket,
    blurb: "Admit an investor only when they're accredited AND the raise clears its revenue floor.",
    proves: "accredited ∧ revenue ≥ X",
    cta: "Open Fundraise",
  },
  {
    key: "dataroom",
    title: "Data Room",
    to: "/app/dataroom",
    group: "dataroom",
    icon: FolderLock,
    blurb: "Share sealed documents and admit members anonymously. Files stay encrypted, and only a tamper-evident fingerprint goes on the public record.",
    proves: "anonymous eligibility + key release",
    cta: "Open the Data Room",
  },
  {
    key: "bonded",
    title: "Bonded Proofs",
    to: "/app/bonded",
    group: "bonded",
    icon: Lock,
    blurb: "Lock tokens until a chosen time, then prove a fact that holds only while the bond stays locked.",
    proves: "time-locked bond",
    cta: "Open Bonded Proofs",
  },
  {
    key: "verify",
    title: "Verify it yourself",
    to: "/verify",
    group: "verify",
    icon: BadgeCheck,
    blurb: "Re-check any proof against the public ledger and get the same answer. No account needed.",
    proves: "independent re-check",
    cta: "Verify a proof",
  },
  {
    key: "explorer",
    title: "Explorer",
    to: "/explorer",
    group: "verify",
    icon: Compass,
    blurb: "Browse every verified record posted to the public ledger.",
    proves: "on-chain history",
    cta: "Open Explorer",
  },
  {
    key: "developer",
    title: "Developer",
    to: "/docs/developers",
    group: "developer",
    icon: Terminal,
    blurb: "Read-only TypeScript SDK, MCP server, and REST API. No key custody.",
    proves: "SDK · MCP · REST",
    cta: "Open Developer",
  },
];

export const byGroup = (g: CapabilityGroup) => CAPABILITIES.filter((c) => c.group === g);
export const capability = (key: string) => CAPABILITIES.find((c) => c.key === key);

// Data Room sub-routes (carried-over plain-language labels/blurbs from the prior UX pass). `slug` is the
// path under /dataroom ("" = index). `star` marks the marquee load-bearing-ZK flow.
export interface DataroomTab {
  slug: string;
  label: string;
  blurb: string;
  star?: boolean;
}

export const DATAROOM_TABS: DataroomTab[] = [
  { slug: "", label: "Overview", blurb: "What you can do here. Pick a task." },
  {
    slug: "documents",
    label: "Documents",
    blurb: "Open a room you're approved for, store a document, or browse your own files.",
  },
  {
    slug: "membership",
    label: "Membership",
    blurb: "Request to join a room, or approve members of a room you own. Joining is by name; getting in stays anonymous.",
  },
  {
    slug: "manage",
    label: "Room Management",
    blurb: "Settings for a room you own: how readers get in (approved membership, or a bond anyone can lock) and who can find it.",
  },
  {
    slug: "discover",
    label: "Discover",
    blurb: "Browse rooms that opted into the public directory, or look one up by its id, then ask to join.",
  },
  // "Get in anonymously" (eligibility), "Share a masked copy" (disclosure), and "Prove a signed fact"
  // (authenticity) are retired from the nav to keep the focus on the room flow + Bonded Proofs. The routes,
  // pages, and their specs stay (deep-linkable), so this is reversible: add the entries back to show them.
];

export const dataroomTab = (slug: string) => DATAROOM_TABS.find((t) => t.slug === slug);

// Bonded Proofs sub-routes (the escrow pillar). `slug` is the path under /bonded ("" = index).
export interface BondedTab {
  slug: string;
  label: string;
  blurb: string;
}

// Prove Solvency is intentionally NOT listed here: it needs an off-chain auditor signature on the reserve
// figure, which is out of scope for the no-attester focus. Its route (/app/bonded/prove) stays live and the
// hide is reversible (re-add the entry to re-show the tab).
export const BONDED_TABS: BondedTab[] = [
  { slug: "", label: "Overview", blurb: "What you can do here." },
  { slug: "balances", label: "My Balances", blurb: "The locks your connected wallet can act on." },
  { slug: "deposit", label: "Deposit", blurb: "Lock tokens until a time you choose." },
  { slug: "tier", label: "Bonded Access", blurb: "Lock a bond, then prove you hold one without showing your wallet or your amount." },
  { slug: "access", label: "Your access", blurb: "The requirements your handle can open, and ones that have ended." },
];

export const bondedTab = (slug: string) => BONDED_TABS.find((t) => t.slug === slug);

// ---- Documentation side-rail registry (public /docs) ----
// `slug` is the path under /docs ("" = the index / Overview). Content nav, distinct from the app sidebar.
export interface DocsSection {
  slug: string;
  label: string;
  blurb: string;
}

export const DOCS_SECTIONS: DocsSection[] = [
  { slug: "", label: "Overview", blurb: "What zkorage is and how the engine works." },
  { slug: "data-room", label: "Data Room", blurb: "How a sealed room stores and opens a document, and how access works." },
  { slug: "bonded-proofs", label: "Bonded Proofs", blurb: "How a bond is created, and how it opens a room." },
  { slug: "verify", label: "Verify it yourself", blurb: "Re-check any proof, room, or bond against the public chain." },
  { slug: "developers", label: "Developers", blurb: "SDK, MCP server, and REST API." },
  { slug: "glossary", label: "Glossary", blurb: "Plain-language definitions." },
];

export const docsSection = (slug: string | undefined) =>
  DOCS_SECTIONS.find((s) => s.slug === (slug ?? ""));
