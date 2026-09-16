import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionTemplate, TrainingTaxonomy } from "../view-models";
import { TemplateEditorModal, type TemplateEditorModalProps } from "./TemplateEditorModal";

const taxonomy: TrainingTaxonomy = {
  taxonomyVersion: "test",
  templateCatalogVersion: "test",
  equipmentCategories: [],
  strength: {
    movementPatterns: [{ id: "squat", label: "Squat", parentId: null, selectable: true }],
    muscleGroups: [{ id: "quadriceps", label: "Quadriceps", parentId: null, selectable: true }],
    equipment: [],
  },
  templateVariables: { strength: ["exercise_selection", "sets", "load"], endurance: ["duration", "distance", "rpe"], sport_skill: ["drill"], mind_body: ["technique"], recovery: ["movement"] },
};

const strengthTemplate: SessionTemplate = { id: "lower", name: "Lower Strength A", intent: "Own the squat pattern.", domain: "strength", nodes: [{ role: "primary", variables: ["exercise_selection"], optionalVariables: ["load"], movementPatternIds: ["squat"], matchPolicy: "all" }] };

function render(overrides: Partial<TemplateEditorModalProps> = {}): string {
  const props: TemplateEditorModalProps = { value: { template: strengthTemplate, mode: "edit" }, taxonomy, error: undefined, busy: false, onChange: () => {}, onClose: () => {}, onSave: () => {}, ...overrides };
  return renderToStaticMarkup(createElement(TemplateEditorModal, props));
}

describe("TemplateEditorModal", () => {
  it("titles the dialog per mode and keeps the a11y wiring", () => {
    const base = { taxonomy, error: undefined, busy: false, onChange: () => {}, onClose: () => {}, onSave: () => {} };
    const create = renderToStaticMarkup(createElement(TemplateEditorModal, { ...base, value: { template: strengthTemplate, mode: "create" } }));
    const edit = renderToStaticMarkup(createElement(TemplateEditorModal, { ...base, value: { template: strengthTemplate, mode: "edit" } }));
    expect(create).toContain('<h2 id="template-modal-title">Create template</h2>');
    expect(edit).toContain('<h2 id="template-modal-title">Edit template</h2>');
    for (const html of [create, edit]) {
      expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="template-modal-title"');
      expect(html).toContain("Define a stable single-domain pattern. Weekly Sessions own every executable dose.");
    }
  });

  it("renders library-style chips for selected and unselected variables", () => {
    const html = render();
    expect(html).toMatch(/class="template-chip on" aria-pressed="true">Exercise Selection<\/button>/);
    expect(html).toMatch(/class="template-chip optional on" aria-pressed="true">Load<\/button>/);
    expect(html).toMatch(/class="template-chip" aria-pressed="false">Sets<\/button>/);
    expect(html).toMatch(/class="template-chip optional" aria-pressed="false">Sets<\/button>/);
    expect(html).toContain("<small>Required</small>");
    expect(html).toContain("<small>Optional</small>");
  });

  it("renders pattern, muscle, and Match all toggles with their on state", () => {
    const html = render();
    expect(html).toMatch(/class="template-chip muted on" aria-pressed="true">Squat<\/button>/);
    expect(html).toMatch(/class="template-chip muted" aria-pressed="false">Quadriceps<\/button>/);
    expect(html).toMatch(/class="template-chip muted on" aria-pressed="true">Match all<\/button>/);
    const open = render({ value: { template: { ...strengthTemplate, nodes: [{ role: "primary", variables: ["exercise_selection"], movementPatternIds: ["squat"] }] }, mode: "edit" } });
    expect(open).toMatch(/class="template-chip muted" aria-pressed="false">Match all<\/button>/);
  });

  it("lists validation errors and disables saving", () => {
    const draft: SessionTemplate = { id: "draft", name: "", intent: "", domain: "endurance", nodes: [{ role: "warm_up", variables: [] }] };
    const html = render({ value: { template: draft, mode: "create" } });
    expect(html).toContain('class="editor-errors" role="alert"');
    expect(html).toContain("Enter a template name.");
    expect(html).toContain("Enter the training goal.");
    expect(html).toContain("Node 1 needs at least one variable.");
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Save template<\/button>/);
    const valid = render();
    expect(valid).not.toContain("editor-errors");
    expect(valid).toMatch(/<button type="button">Save template<\/button>/);
  });

  it("shows the busy label and keeps saving disabled", () => {
    const html = render({ busy: true });
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Saving…<\/button>/);
  });

  it("falls back to the loading state without taxonomy", () => {
    const html = render({ taxonomy: undefined });
    expect(html).toContain("Loading…");
    expect(html).not.toContain("Stable structure");
  });

  it("renders taxonomy load failures through the banner", () => {
    const html = render({ error: new Error("Taxonomy unavailable") });
    expect(html).toContain('class="error" role="alert"');
    expect(html).toContain("Taxonomy unavailable");
  });
});
