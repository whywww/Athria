import type { ReactNode } from "react";

/**
 * Canonical training-domain icons.
 *
 * The Weekly Calendar chip glyphs (§7.4) are the single source of truth for how
 * a domain looks anywhere in the app — Plan, Overview and Training must all
 * render these exact paths so the same sport never appears in two shapes.
 */

/** The five training domains covered by the shared icon language. */
export type DomainIconId = "strength" | "endurance" | "sport_skill" | "mind_body" | "recovery";

const paths: Record<DomainIconId, ReactNode> = {
  strength: <><path d="M7 9v6M4.5 10.5v3M17 9v6M19.5 10.5v3M7 12h10"/><path d="M9.5 8v8M14.5 8v8"/></>,
  endurance: <><circle cx="13.5" cy="5.5" r="1.7"/><path d="m11.5 9 2.3 2.1 2.8.7M13.8 11.1l-2 3.2-3.5 1.2M11.8 14.3l3 4.2M10.8 9.2 8.5 12"/></>,
  sport_skill: <><circle cx="12" cy="12" r="7.5"/><path d="M12 4.5v15M4.5 12h15M6.7 6.7c2.8 2.7 2.8 7.9 0 10.6M17.3 6.7c-2.8 2.7-2.8 7.9 0 10.6"/></>,
  mind_body: <><circle cx="12" cy="6" r="1.8"/><path d="M12 8v4M12 10l-4 3M12 10l4 3M12 12l-3 5M12 12l3 5M7 18c2-1 3.5-.8 5 .8 1.5-1.6 3-1.8 5-.8"/></>,
  recovery: <><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></>,
};

/** Line-icon path for a domain; callers wrap it in their own sized `<svg>`. */
export function domainIconPath(domain: DomainIconId): ReactNode {
  return paths[domain];
}
