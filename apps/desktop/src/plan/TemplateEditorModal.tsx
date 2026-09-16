import { useEffect, useRef } from "react";
import { friendlyLabel, templateEditorErrors, type SessionTemplate, type StrengthTemplateSlot, type TemplateBlock, type TemplateComponentDomain, type TrainingTaxonomy } from "../view-models";
import { ErrorBanner, Loading } from "../components";

/**
 * Template Editor Modal.
 *
 * Create / Edit share one centered dialog laid over the Template Library
 * page. Node cards and property options reuse the Template Library chip language:
 * required variables are solid chips, optional variables are hairline "ghost"
 * chips, unselected options are dashed outlines. Escape / backdrop / close all
 * dismiss and discard unsaved edits, and focus returns to the trigger on unmount.
 */

export type TemplateEditorMode = "create" | "edit";
export interface TemplateEditorValue { template: SessionTemplate; mode: TemplateEditorMode }

export const componentDomains: TemplateComponentDomain[] = ["strength", "endurance", "sport_skill", "mind_body", "recovery"];
const roles: Record<TemplateComponentDomain, string[]> = { strength: ["primary", "secondary", "accessory", "trunk"], endurance: ["warm_up", "steady", "repeat_work_recovery", "cool_down"], sport_skill: ["preparation", "technical", "tactical", "small_sided_game", "match", "competition", "conditioning", "cool_down"], recovery: ["down_regulation", "mobility", "easy_movement"], mind_body: ["centering", "practice_flow", "breathing", "down_regulation"] };
export const emptyTemplate = (domain: TemplateComponentDomain = "strength"): SessionTemplate => {
  const variable = domain === "strength" ? "exercise_selection" : domain === "sport_skill" ? "drill" : domain === "mind_body" ? "technique" : domain === "recovery" ? "movement" : "duration";
  return { id: crypto.randomUUID(), name: "", intent: "", domain, nodes: [{ role: roles[domain][0]!, variables: [variable] }] } as SessionTemplate;
};

const modeTitles: Record<TemplateEditorMode, string> = { create: "Create template", edit: "Edit template" };
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function ModalCloseIcon() {
  return <svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>;
}

export interface TemplateEditorModalProps {
  value: TemplateEditorValue;
  taxonomy: TrainingTaxonomy | undefined;
  error: unknown;
  busy: boolean;
  onChange: (value: SessionTemplate) => void;
  onClose: () => void;
  onSave: () => void;
}

export function TemplateEditorModal({ value, taxonomy, error, busy, onChange, onClose, onSave }: TemplateEditorModalProps) {
  const { template, mode } = value;
  const panelRef = useRef<HTMLElement>(null);
  const restoreTarget = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  // Capture the trigger before moving focus into the dialog, restore it on unmount.
  useEffect(() => {
    restoreTarget.current = document.activeElement as HTMLElement | null;
    return () => { const target = restoreTarget.current; if (target && typeof target.focus === "function" && document.contains(target)) target.focus({ preventScroll: true }); };
  }, []);

  // Focus the name field on open, falling back to the first focusable element.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(".template-basics input") ?? panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus({ preventScroll: true });
  }, []);

  // Escape dismisses; Tab is trapped inside the dialog.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !panel.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const nodes = template.nodes;
  const errors = templateEditorErrors(template);
  const variableOptions = taxonomy?.templateVariables[template.domain] ?? [];
  type NodePatch = { [Key in keyof StrengthTemplateSlot]?: StrengthTemplateSlot[Key] | undefined };
  const updateNodes = (next: Array<TemplateBlock | StrengthTemplateSlot>) => onChange({ ...template, nodes: next });
  const updateNode = (index: number, patch: NodePatch) => updateNodes(nodes.map((item, itemIndex) => {
    if (itemIndex !== index) return item;
    const next = { ...item } as Record<string, unknown>;
    Object.entries(patch).forEach(([key, value]) => { if (value === undefined) delete next[key]; else next[key] = value; });
    return next as unknown as StrengthTemplateSlot;
  }));
  const toggleAttribute = (index: number, key: "movementPatternIds" | "targetMuscleIds", id: string) => {
    const current = (nodes[index] as StrengthTemplateSlot)[key] ?? [];
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    updateNode(index, { [key]: next.length ? next : undefined });
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="template-modal" role="dialog" aria-modal="true" aria-labelledby="template-modal-title" ref={panelRef} tabIndex={-1}>
      <header className="template-modal-header">
        <div><h2 id="template-modal-title">{modeTitles[mode]}</h2><p>Define a stable single-domain pattern. Weekly Sessions own every executable dose.</p></div>
        <button type="button" className="modal-close" aria-label="Close dialog" onClick={onClose}><ModalCloseIcon/></button>
      </header>
      <div className="template-modal-body">
        <ErrorBanner error={error}/>
        {taxonomy ? <>
          <div className="template-basics">
            <label>Name<input required placeholder="e.g. Lower Strength A" value={template.name} onChange={(event) => onChange({ ...template, name: event.target.value })}/></label>
            <label>Purpose<textarea rows={2} value={template.intent} onChange={(event) => onChange({ ...template, intent: event.target.value })}/></label>
            <div className="template-field"><span className="template-field-label">Single training domain</span><div className="template-domain-options">{componentDomains.map((domain) => <button type="button" key={domain} className="template-domain-option" data-domain={domain} aria-pressed={domain === template.domain} onClick={() => { if (domain !== template.domain) onChange(emptyTemplate(domain)); }}>{friendlyLabel(domain)}</button>)}</div></div>
          </div>
          <div className="template-structure-heading"><div><h3>Stable structure</h3><p>Describe ordered roles and variables, never a concrete workout.</p></div><button type="button" className="secondary compact" onClick={() => updateNodes([...nodes, { role: roles[template.domain][0]!, variables: [variableOptions[0]!] }])}>+ Add node</button></div>
          <div className="template-node-editors">{nodes.map((node, index) => {
            const strength = template.domain === "strength" ? node as StrengthTemplateSlot : null;
            return <article className="template-node-editor" key={`${template.id}:${index}`}>
              <div className="template-node-editor-head">
                <span className="template-node-index" aria-hidden="true">{index + 1}</span>
                <label className="template-input"><span>Node name (optional)</span><input value={node.name ?? ""} placeholder={friendlyLabel(node.role)} onChange={(event) => updateNode(index, { name: event.target.value.trim() ? event.target.value : undefined })}/></label>
                <label className="template-input"><span>Role</span><select value={node.role} onChange={(event) => updateNode(index, { role: event.target.value })}>{roles[template.domain].map((role) => <option key={role} value={role}>{friendlyLabel(role)}</option>)}</select></label>
                <button type="button" className="template-node-optional" aria-pressed={Boolean(node.optional)} onClick={() => updateNode(index, { optional: node.optional ? undefined : true })}>Optional</button>
                <button type="button" className="icon-button remove-button" aria-label={`Remove node ${index + 1}`} disabled={nodes.length === 1} onClick={() => updateNodes(nodes.filter((_item, itemIndex) => itemIndex !== index))}>×</button>
              </div>
              {strength && <div className="template-node-editor-attributes">
                <div className="template-attr-row"><small>Patterns</small><div className="template-chip-group">{taxonomy.strength.movementPatterns.map((item) => <button type="button" key={item.id} className={`template-chip muted${strength.movementPatternIds?.includes(item.id) ? " on" : ""}`} aria-pressed={strength.movementPatternIds?.includes(item.id) ?? false} onClick={() => toggleAttribute(index, "movementPatternIds", item.id)}>{item.label}</button>)}</div></div>
                <div className="template-attr-row"><small>Muscles</small><div className="template-chip-group">{taxonomy.strength.muscleGroups.map((item) => <button type="button" key={item.id} className={`template-chip muted${strength.targetMuscleIds?.includes(item.id) ? " on" : ""}`} aria-pressed={strength.targetMuscleIds?.includes(item.id) ?? false} onClick={() => toggleAttribute(index, "targetMuscleIds", item.id)}>{item.label}</button>)}</div></div>
                <div className="template-attr-row"><small>Match</small><div className="template-chip-group"><button type="button" className={`template-chip muted${strength.matchPolicy === "all" ? " on" : ""}`} aria-pressed={strength.matchPolicy === "all"} onClick={() => updateNode(index, { matchPolicy: strength.matchPolicy === "all" ? undefined : "all" })}>Match all</button></div></div>
              </div>}
              <div className="template-node-editor-variables">
                <div className="template-attr-row"><small>Required</small><div className="template-chip-group">{variableOptions.map((key) => <button type="button" key={key} className={`template-chip${node.variables.includes(key) ? " on" : ""}`} aria-pressed={node.variables.includes(key)} onClick={() => updateNode(index, { variables: node.variables.includes(key) ? node.variables.filter((item) => item !== key) : [...node.variables, key], optionalVariables: node.optionalVariables?.filter((item) => item !== key) })}>{friendlyLabel(key)}</button>)}</div></div>
                <div className="template-attr-row"><small>Optional</small><div className="template-chip-group">{variableOptions.map((key) => { const selected = node.optionalVariables?.includes(key) ?? false; return <button type="button" key={key} className={`template-chip optional${selected ? " on" : ""}`} aria-pressed={selected} onClick={() => { const optionalVariables = selected ? node.optionalVariables?.filter((item) => item !== key) : [...(node.optionalVariables ?? []), key]; updateNode(index, { variables: node.variables.filter((item) => item !== key), optionalVariables: optionalVariables?.length ? optionalVariables : undefined }); }}>{friendlyLabel(key)}</button>; })}</div></div>
              </div>
            </article>;
          })}</div>
        </> : <Loading/>}
      </div>
      <footer className="template-modal-footer">
        {errors.length > 0 && <div className="editor-errors" role="alert"><strong>Complete these template details</strong><ul>{errors.map((message) => <li key={message}>{message}</li>)}</ul></div>}
        <div className="template-modal-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="button" disabled={errors.length > 0 || !taxonomy || busy} onClick={onSave}>{busy ? "Saving…" : "Save template"}</button>
        </div>
      </footer>
    </section>
  </div>;
}
