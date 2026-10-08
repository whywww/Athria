import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CalendarSession } from "../view-models";
import { SessionDetailDrawer } from "./SessionDetailDrawer";

const session: CalendarSession = {
  id: "easy-run", occurrenceId: "occ-run", revision: 1, scheduledDate: "2026-10-11", order: 0, weekNumber: 1,
  phaseRefs: [], templateRef: null, name: "Easy run", intent: "Keep it easy", durationMinutes: 60,
  recoveryDemand: "low", keySession: false, progressionNote: null, schedulingRationale: null,
  status: "planned", legacySnapshot: false, overrideReason: null, type: null, domain: "endurance",
  components: [{ id: "easy", name: "Easy work", prescription: { kind: "duration_only", notes: "Keep it easy" } }],
};

function render(value: CalendarSession) {
  return renderToStaticMarkup(createElement(SessionDetailDrawer, {
    session: value, templates: [], plan: null, today: "2026-10-08", onClose: () => undefined, onMutated: () => undefined,
  }));
}

describe("SessionDetailDrawer domain presentation", () => {
  it("puts the session domain beside the hour duration rather than in the drawer metadata", () => {
    const html = render(session);
    const aside = html.match(/<span class="rx-panel-aside">[\s\S]*?<span class="rx-panel-meta">1 hr<\/span><\/span>/)?.[0];
    const metadata = html.match(/<div class="sd-meta">[\s\S]*?<\/div>/)?.[0];
    expect(aside).toContain('data-domain-icon="endurance"');
    expect(aside).toContain(">Endurance</span>");
    expect(metadata).not.toContain("Endurance");
  });

  it("leaves unknown session domains unlabelled even with endurance content", () => {
    const html = render({ ...session, domain: null, components: [{ id: "run", name: "Steady work", prescription: { kind: "endurance", segments: [] } }] });
    expect(html).not.toContain("data-domain-icon");
    expect(html).toContain('class="rx-panel-meta">1 hr');
  });
});
