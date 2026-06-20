import { Home, type LucideIcon } from "lucide-react";
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

// The groups the app sidebar exposes (the ZK operations), in DISPLAY ORDER: Data Room first, then the
// proofs. Verify & developer live on the public side. (Order here drives both the sidebar and the Home.)
export const APP_GROUP_KEYS = ["dataroom", "bonded", "prove"] as const;

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
];

function navFor(key: string, label?: string): NavItem {
  const c = capability(key)!;
  return { to: c.to, label: label ?? c.title, icon: c.icon };
}

// Mobile bottom-nav: the 3 most-used in-app destinations + a "More" sheet (BottomNav) for the rest.
export const MOBILE_PRIMARY: NavItem[] = [
  HOME,
  navFor("reserves", "Reserves"),
  navFor("dataroom", "Data Room"),
];

// Small outbound links to the public surfaces (rendered in the sidebar footer + the mobile "More" sheet).
export const MARKETING_LINKS: { to: string; label: string }[] = [
  { to: "/verify", label: "Verify it yourself" },
  { to: "/docs", label: "Documentation" },
];
