import { friendlyLabel, templateNodeName, type SessionTemplate, type StrengthTemplateSlot } from "../view-models";

function Chips({ values, muted = false }: { values: string[]; muted?: boolean }) {
  return <div className={`template-node-chips${muted ? " muted" : ""}`}>{values.map((value) => <span key={value}>{friendlyLabel(value)}</span>)}</div>;
}

export function TemplateNodes({ template }: { template: SessionTemplate }) {
  return <ol className="template-node-grid" aria-label={`${template.name} structure`}>
    {template.nodes.map((node, index) => {
      const strength = template.domain === "strength" ? node as StrengthTemplateSlot : null;
      return <li className="template-node" key={index}>
        <div className="template-node-heading">
          <span aria-hidden="true">{index + 1}</span>
          <strong>{templateNodeName(node)}</strong>
          {node.optional && <small>Optional</small>}
        </div>
        {node.variables.length > 0 && <Chips values={node.variables}/>}
        {node.optionalVariables?.length ? <div className="template-node-optional"><small>Optional</small><Chips values={node.optionalVariables} muted/></div> : null}
        {strength?.movementPatternIds?.length ? <div className="template-node-meta"><small>Patterns</small><Chips values={strength.movementPatternIds} muted/></div> : null}
        {strength?.targetMuscleIds?.length ? <div className="template-node-meta"><small>Muscles</small><Chips values={strength.targetMuscleIds} muted/></div> : null}
        {strength?.matchPolicy === "all" && <div className="template-node-match">Match all</div>}
      </li>;
    })}
  </ol>;
}
