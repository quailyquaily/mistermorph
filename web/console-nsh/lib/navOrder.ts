// The workspace navigation's pages in their order: the sidebar's and the phone's bottom bar (its
// first pages, then More's). Page transitions between them follow this order (lib/navMotion.ts).

/** The workspace navigation, as the sidebar and the mobile nav show it. */
export const NAV_ITEMS_META = [
  { id: "/chat", titleKey: "nav_chat", icon: "PhChats" },
  { id: "/contacts", titleKey: "nav_contacts", icon: "PhUsers" },
  { id: "/todo", titleKey: "nav_todo", icon: "PhListChecks" },
  { id: "/memories", titleKey: "nav_memories", icon: "PhBrain" },
  { id: "/skills", titleKey: "nav_skills", icon: "PhMagicWand" },
  { id: "__sep_primary", separator: true },
  { id: "/stats", titleKey: "nav_stats", icon: "PhChartBar" },
  { id: "/audit", titleKey: "nav_audit", icon: "PhFingerprint" },
  { id: "__sep_secondary", separator: true },
  { id: "/settings", titleKey: "nav_settings", icon: "PhGearSix" },
] as const;

/** The navigation's pages (no separators), in order. */
export const NAV_TAB_PATHS: string[] = NAV_ITEMS_META.filter((item) => !("separator" in item)).map((item) => item.id);
