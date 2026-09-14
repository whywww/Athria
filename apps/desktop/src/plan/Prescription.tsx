import type { ReactNode } from "react";
import { friendlyLabel, type EnduranceStep, type PlanComponent } from "../view-models";
import { formatRest } from "../components";
import { domainGlyph } from "./calendar-utils";

function duration(seconds?: number) {
  if (!seconds) return null;
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
}

function distance(meters?: number) {
  if (!meters) return null;
  return meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
}

function Values({ values, empty = "—" }: { values: Array<string | null | undefined>; empty?: string }) {
  const present = values.filter((value): value is string => Boolean(value));
  if (present.length === 0) return <span className="rx-empty-value">{empty}</span>;
  return <span className="rx-value-stack">{present.map((value, index) => <span key={`${value}-${index}`}>{value}</span>)}</span>;
}

function CompactEnduranceTargets({ step }: { step: EnduranceStep }) {
  const values = [duration(step.durationSeconds), distance(step.distanceMeters), step.pace, step.heartRateZone, step.powerWatts, step.cadence, step.rpe ? `RPE ${step.rpe}` : null, step.talkTest].filter(Boolean);
  return <>{values.length > 0 && <span className="rx-targets">{values.join(" · ")}</span>}{step.notes && <small>{step.notes}</small>}</>;
}

function PrescriptionPanel({ component, summary, children }: { component: PlanComponent; summary?: string; children: ReactNode }) {
  const domain = component.domain.value;
  return <article className={`rx-panel${domain ? ` rx-panel-${domain}` : ""}`}>
    <header className="rx-panel-header">
      <span className="rx-eyebrow">Prescription</span>
      <div className="rx-panel-title-row">
        <div className="rx-panel-copy"><h4>{component.name}</h4>{summary && <span className="rx-panel-summary">{summary}</span>}</div>
        {domain && <span className="rx-domain" title={friendlyLabel(domain)}><span aria-hidden="true">{domainGlyph(domain)}</span><span>{friendlyLabel(domain)}</span></span>}
      </div>
    </header>
    {children}
  </article>;
}

function StrengthPrescription({ component }: { component: PlanComponent & { prescription: Extract<PlanComponent["prescription"], { kind: "strength" }> } }) {
  const exerciseCount = component.prescription.exercises.length;
  const effortHeader = component.prescription.exercises.some((exercise) => exercise.targetRir != null) ? "Effort" : "RPE";
  return <PrescriptionPanel component={component} summary={`${exerciseCount} ${exerciseCount === 1 ? "exercise" : "exercises"}`}>
    <div className="rx-table rx-strength-table" role="table" aria-label={`${component.name} exercises`}>
      <div className="rx-table-row rx-table-header" role="row">
        <span role="columnheader">#</span><span role="columnheader">Exercise</span><span role="columnheader">Sets × Reps</span><span role="columnheader">{effortHeader}</span><span role="columnheader">Rest</span>
      </div>
      <div role="rowgroup">
        {component.prescription.exercises.map((exercise, index) => {
          const movement = exercise.classification.primaryMovement?.value;
          const reps = exercise.repsMin === exercise.repsMax ? exercise.repsMin : `${exercise.repsMin}–${exercise.repsMax}`;
          const load = exercise.referenceLoad == null ? null : `${exercise.referenceLoad}${exercise.referenceLoadUnit ? ` ${exercise.referenceLoadUnit}` : ""}`;
          const effort = [exercise.targetRpe ? `RPE ${exercise.targetRpe}` : null, exercise.targetRir != null ? `RIR ${exercise.targetRir}` : null];
          const details = [exercise.notes || null, exercise.tempo ? `Tempo ${exercise.tempo}` : null, exercise.alternatives?.length ? `Alternatives: ${exercise.alternatives.join(", ")}` : null].filter((value): value is string => Boolean(value));
          return <div className="rx-table-row rx-strength-row" role="row" key={exercise.id}>
            <span className="rx-index" data-label="#" role="cell">{index + 1}</span>
            <span className="rx-primary-cell rx-exercise-cell" data-label="Exercise" role="cell">{movement != null && <small className="rx-movement-pill">{friendlyLabel(String(movement))}</small>}<strong>{exercise.displayName}</strong></span>
            <span data-label="Sets × Reps" role="cell"><strong>{exercise.sets} × {reps}</strong>{load && <small>{load}</small>}</span>
            <span data-label={effortHeader} role="cell"><Values values={effort} empty="Controlled" /></span>
            <span data-label="Rest" role="cell">{formatRest(exercise.restSeconds)}</span>
            <span className="rx-strength-details" data-label="Notes" role="cell">{details.length ? details.map((value, detailIndex) => <span key={`${value}-${detailIndex}`}>{value}</span>) : <span className="rx-empty-value">—</span>}</span>
          </div>;
        })}
      </div>
    </div>
  </PrescriptionPanel>;
}

function EnduranceStepCells({ step, includePhase = false }: { step: EnduranceStep; includePhase?: boolean }) {
  const targets = [step.heartRateZone, step.rpe ? `RPE ${step.rpe}` : null, step.pace ? `Pace ${step.pace}` : null, step.powerWatts ? `Power ${step.powerWatts}` : null, step.cadence ? `Cadence ${step.cadence}` : null];
  const notes = [step.talkTest || null, step.notes || null];
  return <>
    {includePhase
      ? <span className="rx-repeat-prescription" data-label="Prescription" role="cell"><strong className="rx-repeat-phase">{friendlyLabel(step.role)}</strong><span className="rx-repeat-step-name">{step.name}</span></span>
      : <span className="rx-primary-cell" data-label="Prescription" role="cell"><strong>{friendlyLabel(step.role)}</strong><small>{step.name}</small></span>}
    <span className="rx-metric-cell" data-label="Duration" role="cell"><Values values={[duration(step.durationSeconds), distance(step.distanceMeters)]} /></span>
    <span className="rx-metric-cell" data-label="Effort" role="cell"><Values values={targets} /></span>
    <span className="rx-notes-cell" data-label="Notes" role="cell"><Values values={notes} /></span>
  </>;
}

function EndurancePrescription({ component }: { component: PlanComponent & { prescription: Extract<PlanComponent["prescription"], { kind: "endurance" }> } }) {
  const moduleCount = component.prescription.segments.length;
  return <PrescriptionPanel component={component} summary={`${moduleCount} ${moduleCount === 1 ? "module" : "modules"}`}>
    <div className="rx-table rx-endurance-table" role="table" aria-label={`${component.name} modules`}>
      <div className="rx-table-row rx-table-header" role="row">
        <span role="columnheader">Module</span><span role="columnheader">Prescription</span><span role="columnheader">Duration</span><span role="columnheader">Effort</span><span role="columnheader">Notes</span>
      </div>
      <div role="rowgroup">
        {component.prescription.segments.map((segment, index) => segment.type === "repeat"
          ? <div className="rx-repeat-group" key={`${segment.name}-${index}`}>
            <div className="rx-table-row rx-endurance-row rx-repeat-summary" role="row">
              <span className="rx-index" data-label="Module" role="cell">{index + 1}</span>
              <span className="rx-primary-cell" data-label="Prescription" role="cell"><span className="rx-repeat-heading"><strong>{segment.name}</strong><span className="rx-repeat-count" aria-label={`${segment.repetitions} repetitions`}>×{segment.repetitions}</span></span></span>
              <span data-label="Duration" role="cell" className="rx-empty-value rx-metric-cell">—</span>
              <span data-label="Effort" role="cell" className="rx-empty-value rx-metric-cell">—</span>
              <span className="rx-notes-cell" data-label="Notes" role="cell"><Values values={[segment.notes || null]} /></span>
            </div>
            <div className="rx-repeat-panel">
              <div className="rx-repeat-row" role="row"><EnduranceStepCells step={segment.work} includePhase /></div>
              {segment.recovery && <div className="rx-repeat-row" role="row"><EnduranceStepCells step={segment.recovery} includePhase /></div>}
            </div>
          </div>
          : <div className="rx-table-row rx-endurance-row" role="row" key={`${segment.name}-${index}`}>
            <span className="rx-index" data-label="Module" role="cell">{index + 1}</span><EnduranceStepCells step={segment} />
          </div>)}
      </div>
    </div>
  </PrescriptionPanel>;
}

export function Prescription({ component, variant = "detailed", fallbackNotes }: { component: PlanComponent; variant?: "detailed" | "compact"; fallbackNotes?: string }) {
  const prescription = component.prescription;
  if (prescription.kind === "strength") {
    if (variant === "compact") return <><strong>{component.name}</strong><ul>{prescription.exercises.map((exercise) => <li key={exercise.id}>{exercise.displayName}<span>{exercise.sets} × {exercise.repsMin === exercise.repsMax ? exercise.repsMin : `${exercise.repsMin}–${exercise.repsMax}`}</span></li>)}</ul></>;
    return <StrengthPrescription component={component as PlanComponent & { prescription: typeof prescription }} />;
  }
  if (prescription.kind === "endurance") {
    if (variant === "detailed") return <EndurancePrescription component={component as PlanComponent & { prescription: typeof prescription }} />;
    return <ol className="rx-segments compact">{prescription.segments.map((segment, index) => segment.type === "repeat"
      ? <li className="rx-repeat" key={`${segment.name}-${index}`}><strong>{segment.repetitions} × {segment.name}</strong><div><span>Work · {segment.work.name}</span><CompactEnduranceTargets step={segment.work}/>{segment.recovery && <><span>Recovery · {segment.recovery.name}</span><CompactEnduranceTargets step={segment.recovery}/></>}</div>{segment.notes && <small>{segment.notes}</small>}</li>
      : <li key={`${segment.name}-${index}`}><strong>{friendlyLabel(segment.role)} · {segment.name}</strong><CompactEnduranceTargets step={segment}/></li>)}</ol>;
  }
  let content: ReactNode;
  if (prescription.kind === "sport_skill") content = <div className="rx-blocks"><strong>{friendlyLabel(prescription.sessionType)}</strong>{prescription.blocks.map((block, index) => <div className="rx-block" key={`${block.name}-${index}`}><b>{friendlyLabel(block.role)} · {block.name}</b><span>{[block.durationMinutes ? `${block.durationMinutes} min` : null, block.intensity].filter(Boolean).join(" · ")}</span>{block.instructions && <small>{block.instructions}</small>}</div>)}</div>;
  else if ("blocks" in prescription) content = <div className="rx-blocks">{prescription.blocks.map((block, index) => <div className="rx-block" key={`${block.name}-${index}`}><b>{block.name}</b>{block.durationMinutes && <span>{block.durationMinutes} min</span>}{block.instructions && <small>{block.instructions}</small>}</div>)}</div>;
  else content = <p className="rx-legacy">{prescription.notes || fallbackNotes || "No structured prescription is available."}</p>;
  return variant === "detailed" ? <PrescriptionPanel component={component}><div className="rx-simple-content">{content}</div></PrescriptionPanel> : content;
}
