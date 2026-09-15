import { friendlyLabel, templateNodeName, type SessionTemplate, type StrengthTemplateSlot } from "../view-models";

function Chips({ values, muted = false }: { values: string[]; muted?: boolean }) {
  return <div className={`template-node-chips${muted ? " muted" : ""}`}>{values.map((value) => <span key={value}>{friendlyLabel(value)}</span>)}</div>;
}

export function TemplateNodes({ template }: { template: SessionTemplate }) {
  return <ol className="template-node-grid" aria-label={`${template.name} structure`}>
    {template.nodes.map((node, index) => {
      const strength = template.domain === "strength" ? node as StrengthTemplateSlot : null;
      const variables = [...node.variables.map((value) => ({ value, optional: false })), ...(node.optionalVariables ?? []).map((value) => ({ value, optional: true }))];
      return <li className="template-node" key={index}>
        <div className="template-node-heading">
          <span className="template-node-index" aria-hidden="true">{index + 1}</span>
          <strong>{templateNodeName(node)}</strong>
          {node.optional && <small className="template-node-flag">Optional</small>}
        </div>
        {variables.length > 0 && <div className="template-node-chips">{variables.map(({ value, optional }) => <span key={value} className={optional ? "optional" : undefined} title={optional ? "Optional" : undefined}>{friendlyLabel(value)}</span>)}</div>}
        {strength?.movementPatternIds?.length ? <div className="template-node-meta"><small>Patterns</small><Chips values={strength.movementPatternIds} muted/></div> : null}
        {strength?.targetMuscleIds?.length ? <div className="template-node-meta"><small>Muscles</small><Chips values={strength.targetMuscleIds} muted/></div> : null}
        {strength?.matchPolicy === "all" && <div className="template-node-match">Match all</div>}
      </li>;
    })}
  </ol>;
}
