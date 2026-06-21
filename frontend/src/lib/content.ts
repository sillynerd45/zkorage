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
  { key: "bonded", label: "Bonded Proofs", blurb: "Lock tokens until a chosen time. The escrow behind upcoming time-bound proofs." },
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
    blurb: "Upload sealed documents, admit members anonymously, release keys by committee, verify authenticity.",
    proves: "anonymous eligibility + key release",
    cta: "Open the Data Room",
  },
  {
    key: "bonded",
    title: "Bonded Proofs",
    to: "/app/bonded",
    group: "bonded",
    icon: Lock,
    blurb: "Lock tokens until a chosen time and manage your locks. The bond behind upcoming time-bound proofs.",
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
    blurb: "Store and open encrypted files, and browse the rooms you own.",
  },
  {
    slug: "membership",
    label: "Membership",
    blurb: "Request to join a room, or approve members of a room you own. Joining is by name; getting in stays anonymous.",
  },
  {
    slug: "eligibility",
    label: "Get in anonymously",
    blurb: "Prove you're allowed in without revealing who you are. Each pass works once.",
    star: true,
  },
  {
    slug: "access",
    label: "Open a shared document",
    blurb: "Prove a document's conditions, then its keepers release the key to you. Anonymous, key-free in your browser.",
  },
  {
    slug: "disclosure",
    label: "Share a masked copy",
    blurb: "Prove a fact about a sealed document, then share a masked copy with an auditor that's provably the real file.",
  },
  {
    slug: "authenticity",
    label: "Prove a signed fact",
    blurb: 'Prove a fact a bank signed for you (e.g. "balance ≥ X") without showing the statement or value.',
  },
];

export const dataroomTab = (slug: string) => DATAROOM_TABS.find((t) => t.slug === slug);

// Bonded Proofs sub-routes (the escrow pillar). `slug` is the path under /bonded ("" = index).
export interface BondedTab {
  slug: string;
  label: string;
  blurb: string;
}

export const BONDED_TABS: BondedTab[] = [
  { slug: "", label: "Overview", blurb: "What you can do here, and what comes next." },
  { slug: "balances", label: "My Balances", blurb: "The locks your connected wallet can act on." },
  { slug: "deposit", label: "Deposit", blurb: "Lock tokens until a time you choose." },
  { slug: "prove", label: "Prove Solvency", blurb: "Prove reserves cover supply, bonded to a lock that you can pull at any time." },
  { slug: "tier", label: "Anonymous Tier", blurb: "Prove you bonded enough to qualify for a tier, without revealing which wallet or how much." },
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
  { slug: "capabilities", label: "Capabilities", blurb: "What each proof does, and what stays private." },
  { slug: "verify", label: "Verify it yourself", blurb: "Re-check any proof against the public chain." },
  { slug: "developers", label: "Developers", blurb: "SDK, MCP server, and REST API." },
  { slug: "glossary", label: "Glossary", blurb: "Plain-language definitions." },
];

export const docsSection = (slug: string | undefined) =>
  DOCS_SECTIONS.find((s) => s.slug === (slug ?? ""));
