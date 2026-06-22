import { Home, FileText, type LucideIcon } from "lucide-react";
import { CAPABILITIES, GROUPS, capability } from "@/lib/content";

// Single source of truth for the app sidebar (Blank/BlockWallet pattern: route→label→icon→group).
// Derived from the shared IA registry so adding a capability updates the sidebar automatically. Only the
// in-app groups appear here. Verify/Explorer/Developer are public (top-bar / docs), reached via footer links.
export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}
export interface NavSection {
  key: string;
  label?: string;
  items: NavItem[];
}

const HOME: NavItem = { to: "/app", label: "Home", icon: Home, end: true };

// The Contracts reference page (read-only): the deployed Stellar testnet contract ids for the Data Room and
// Bonded Proofs, with links to the public explorer. A standalone nav item, not a capability group.
const CONTRACTS: NavItem = { to: "/app/contracts", label: "Contracts", icon: FileText };

// The groups the app sidebar exposes, in DISPLAY ORDER: Data Room first, then Bonded Proofs. The five
// "Prove a fact" proofs are hidden from the app nav so the focus stays on these two pillars (their routes
// and pages stay live, reachable by URL, so this is reversible: add "prove" back to show them).
export const APP_GROUP_KEYS = ["dataroom", "bonded"] as const;

export const NAV_SECTIONS: NavSection[] = [
  { key: "home", items: [HOME] },
  ...APP_GROUP_KEYS.map((key) => GROUPS.find((g) => g.key === key)!).map((g) => ({
    key: g.key,
    label: g.label,
    items: CAPABILITIES.filter((c) => c.group === g.key).map((c) => ({
      to: c.to,
      label: c.title,
      icon: c.icon,
    })),
  })),
  { key: "reference", label: "Reference", items: [CONTRACTS] },
];

function navFor(key: string, label?: string): NavItem {
  const c = capability(key)!;
  return { to: c.to, label: label ?? c.title, icon: c.icon };
}

// Mobile bottom-nav: the 3 most-used in-app destinations + a "More" sheet (BottomNav) for the rest.
export const MOBILE_PRIMARY: NavItem[] = [
  HOME,
  navFor("dataroom", "Data Room"),
  navFor("bonded", "Bonded"),
];

// Small outbound links to the public surfaces (rendered in the sidebar footer + the mobile "More" sheet).
export const MARKETING_LINKS: { to: string; label: string }[] = [
  { to: "/verify", label: "Verify it yourself" },
  { to: "/docs", label: "Documentation" },
];
