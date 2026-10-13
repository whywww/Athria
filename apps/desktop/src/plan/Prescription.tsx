import { T } from "../i18n";
import type { ReactNode } from "react";
import { friendlyLabel, type EnduranceStep, type SessionPrescription, type PrescriptionByDomain, type TemplateComponentDomain } from "../view-models";
import { domainIconPath } from "../domain-icons";
import { formatRest } from "../components";
import { currentLanguage, exerciseName, useLanguage } from "../i18n";

function duration(seconds?: number) {
  if (!seconds) return null;
  if (currentLanguage() === "zh-CN") return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
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
  const values = [duration(step.durationSeconds), distance(step.distanceMeters), step.pace, step.heartRateZone ? `Zone ${step.heartRateZone}` : null, step.powerWatts, step.cadence, step.rpe ? `RPE ${step.rpe}` : null, step.talkTest].filter(Boolean);
  return <>{values.length > 0 && <span className="rx-targets">{values.join(" · ")}</span>}{step.notes && <small>{step.notes}</small>}</>;
}

interface SessionPriorityProps { keySession?: boolean | undefined }

function PrescriptionPanel({ name, showTitle, sessionDomain, summary, meta, chip, keySession, children }: { name: string; showTitle?: boolean | undefined; sessionDomain?: TemplateComponentDomain | null | undefined; summary?: string | undefined; meta?: string | undefined; chip?: string | undefined; children: ReactNode } & SessionPriorityProps) {
  return <article className={`rx-panel${sessionDomain ? ` rx-panel-${sessionDomain}` : ""}`}>
    <header className="rx-panel-header">
      <div className="rx-panel-title-row">
        <div className="rx-panel-copy">{showTitle !== false && <h4>{name}</h4>}{summary && <span className="rx-panel-summary">{summary}</span>}</div>
        {(sessionDomain || meta || chip || keySession) && <span className="rx-panel-aside">{chip && <span className="rx-panel-chip">{chip}</span>}{keySession && <span className="rx-key-session"><T>{"Key Session"}</T></span>}{sessionDomain && <span className="rx-domain" title={friendlyLabel(sessionDomain)}><svg className="rx-domain-glyph" data-domain-icon={sessionDomain} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{domainIconPath(sessionDomain)}</svg><span>{friendlyLabel(sessionDomain)}</span></span>}{meta && <span className="rx-panel-meta">{meta}</span>}</span>}
      </div>
    </header>
    {children}
  </article>;
}

function StrengthPrescription({ prescription, name, showTitle, sessionDomain, summary, meta, keySession }: { prescription: PrescriptionByDomain["strength"]; name: string; showTitle?: boolean | undefined; sessionDomain?: TemplateComponentDomain | null | undefined; summary?: string | undefined; meta?: string | undefined } & SessionPriorityProps) {
  const { language } = useLanguage();
  const exerciseCount = prescription.blocks.length;
  return <PrescriptionPanel name={name} showTitle={showTitle} sessionDomain={sessionDomain} summary={summary ?? (currentLanguage() === "zh-CN" ? `${exerciseCount} 个动作` : `${exerciseCount} ${exerciseCount === 1 ? "exercise" : "exercises"}`)} meta={meta} keySession={keySession}>
    <div className="rx-table rx-strength-table" role="table" aria-label={`${name} exercises`}>
      <div className="rx-table-row rx-table-header" role="row">
        <span role="columnheader">#</span><span role="columnheader"><T>{"Exercise"}</T></span><span role="columnheader"><T>{"Sets × Reps"}</T></span><span role="columnheader"><T>{"Effort"}</T></span><span role="columnheader"><T>{"Rest"}</T></span><span role="columnheader"><T>{"Notes"}</T></span>
      </div>
      <div role="rowgroup">
        {prescription.blocks.map((exercise, index) => {
          const movement = exercise.classification.primaryMovement?.value;
          const reps = exercise.repsMin === exercise.repsMax ? exercise.repsMin : `${exercise.repsMin}–${exercise.repsMax}`;
          const load = exercise.referenceLoad == null ? null : `${exercise.referenceLoad}${exercise.referenceLoadUnit ? ` ${exercise.referenceLoadUnit}` : ""}`;
          const effort = exercise.targetRpe ? `RPE ${exercise.targetRpe}` : null;
          const details = [exercise.notes || null, exercise.tempo ? `Tempo ${exercise.tempo}` : null, exercise.alternatives?.length ? `Alternatives: ${exercise.alternatives.join(", ")}` : null].filter((value): value is string => Boolean(value));
          return <div className="rx-table-row rx-strength-row" role="row" key={exercise.id}>
            <span className="rx-index" data-label="#" role="cell">{index + 1}</span>
            <span className="rx-primary-cell" data-label="Exercise" role="cell"><strong>{exerciseName(exercise.canonicalKey, exercise.displayName, language)}</strong>{movement != null && <small>{friendlyLabel(String(movement))}</small>}</span>
            <span data-label="Sets × Reps" role="cell">{exercise.sets} × {reps}{load && <small>{load}</small>}</span>
            <span data-label="Effort" role="cell"><Values values={[effort]} empty="Controlled" /></span>
            <span data-label="Rest" role="cell">{formatRest(exercise.restSeconds)}</span>
            <span className="rx-notes-cell" data-label="Notes" role="cell"><Values values={details} /></span>
          </div>;
        })}
      </div>
    </div>
  </PrescriptionPanel>;
}

function EnduranceStepCells({ step, includePhase = false }: { step: EnduranceStep; includePhase?: boolean }) {
  const targets = [step.heartRateZone ? `Zone ${step.heartRateZone}` : null, step.rpe ? `RPE ${step.rpe}` : null, step.pace ? `Pace ${step.pace}` : null, step.powerWatts ? `Power ${step.powerWatts}` : null, step.cadence ? `Cadence ${step.cadence}` : null];
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

function EndurancePrescription({ prescription, name, showTitle, sessionDomain, summary, meta, keySession }: { prescription: PrescriptionByDomain["endurance"]; name: string; showTitle?: boolean | undefined; sessionDomain?: TemplateComponentDomain | null | undefined; summary?: string | undefined; meta?: string | undefined } & SessionPriorityProps) {
  const moduleCount = prescription.blocks.length;
  return <PrescriptionPanel name={name} showTitle={showTitle} sessionDomain={sessionDomain} summary={summary ?? (currentLanguage() === "zh-CN" ? `${moduleCount} 个模块` : `${moduleCount} ${moduleCount === 1 ? "module" : "modules"}`)} meta={meta} keySession={keySession}>
    <div className="rx-table rx-endurance-table" role="table" aria-label={`${name} modules`}>
      <div className="rx-table-row rx-table-header" role="row">
        <span role="columnheader"><T>{"Module"}</T></span><span role="columnheader"><T>{"Prescription"}</T></span><span role="columnheader"><T>{"Duration"}</T></span><span role="columnheader"><T>{"Effort"}</T></span><span role="columnheader"><T>{"Notes"}</T></span>
      </div>
      <div role="rowgroup">
        {prescription.blocks.map((segment, index) => segment.type === "repeat"
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

const blockColumns = { sport_skill: { column: "Drill", noun: "drill" }, mind_body: { column: "Technique", noun: "technique" }, mobility: { column: "Movement", noun: "movement" }, functional: { column: "Movement", noun: "movement" } } as const;

function BlockList({ prescription, sessionDomain }: { sessionDomain?: TemplateComponentDomain | null | undefined; prescription: PrescriptionByDomain["sport_skill" | "mobility" | "mind_body" | "functional"] }) {
  const sport = prescription as PrescriptionByDomain["sport_skill"];
  if (sessionDomain === "sport_skill") return <div className="rx-blocks"><strong>{friendlyLabel(sport.sessionType)}</strong>{sport.blocks.map((block, index) => <div className="rx-block" key={`${block.name}-${index}`}><b>{friendlyLabel(block.role)} · {block.name}</b><span>{[block.durationMinutes ? `${block.durationMinutes} min` : null, block.intensity].filter(Boolean).join(" · ")}</span>{block.instructions && <small>{block.instructions}</small>}</div>)}</div>;
  return <div className="rx-blocks">{prescription.blocks.map((block, index) => <div className="rx-block" key={`${block.name}-${index}`}><b>{block.name}</b>{block.durationMinutes && <span>{block.durationMinutes} min</span>}{block.instructions && <small>{block.instructions}</small>}</div>)}</div>;
}

function BlocksPrescription({ prescription, name, showTitle, sessionDomain, summary, meta, keySession }: { prescription: PrescriptionByDomain["sport_skill" | "mobility" | "mind_body" | "functional"]; name: string; showTitle?: boolean | undefined; sessionDomain?: TemplateComponentDomain | null | undefined; summary?: string | undefined; meta?: string | undefined } & SessionPriorityProps) {
  const isSport = sessionDomain === "sport_skill";
  const sport = prescription as PrescriptionByDomain["sport_skill"];
  const blocks = prescription.blocks;
  const count = blocks.length;
  const { column, noun } = blockColumns[sessionDomain === "sport_skill" || sessionDomain === "mind_body" || sessionDomain === "mobility" ? sessionDomain : "functional"];
  return <PrescriptionPanel name={name} showTitle={showTitle} sessionDomain={sessionDomain} summary={summary ?? `${count} ${count === 1 ? noun : `${noun}s`}`} meta={meta} chip={isSport ? friendlyLabel(sport.sessionType) : undefined} keySession={keySession}>
    <div className={`rx-table rx-blocks-table${isSport ? "" : " rx-blocks-table-plain"}`} role="table" aria-label={`${name} blocks`}>
      <div className="rx-table-row rx-table-header" role="row">
        <span role="columnheader">#</span><span role="columnheader">{column}</span><span role="columnheader"><T>{"Duration"}</T></span>{isSport && <span role="columnheader"><T>{"Intensity"}</T></span>}<span role="columnheader"><T>{"Notes"}</T></span>
      </div>
      <div role="rowgroup">
        {blocks.map((block, index) => <div className="rx-table-row rx-blocks-row" role="row" key={`${block.name}-${index}`}>
          <span className="rx-index" data-label="#" role="cell">{index + 1}</span>
          <span className="rx-primary-cell" data-label={column} role="cell">{"role" in block ? <><strong>{friendlyLabel(block.role)}</strong><small>{block.name}</small></> : <strong>{block.name}</strong>}</span>
          <span className="rx-metric-cell" data-label="Duration" role="cell"><Values values={[block.durationMinutes ? `${block.durationMinutes} min` : null]}/></span>
          {isSport && <span className="rx-metric-cell" data-label="Intensity" role="cell"><Values values={["intensity" in block ? block.intensity : null]}/></span>}
          <span className="rx-notes-cell" data-label="Notes" role="cell"><Values values={[block.instructions]}/></span>
        </div>)}
      </div>
    </div>
  </PrescriptionPanel>;
}

export function Prescription({ prescription, name, showTitle, sessionDomain, variant = "detailed", fallbackNotes, summary, meta, keySession }: { prescription: SessionPrescription | null; name: string; showTitle?: boolean | undefined; sessionDomain?: TemplateComponentDomain | null | undefined; variant?: "detailed" | "compact"; fallbackNotes?: string | undefined; summary?: string | undefined; meta?: string | undefined } & SessionPriorityProps) {
  if (prescription === null) {
    const empty = <p className="rx-empty"><T>{"No structured prescription is available for this session."}</T></p>;
    return variant === "detailed" ? <PrescriptionPanel name={name} showTitle={showTitle} sessionDomain={sessionDomain} summary={summary} meta={meta} keySession={keySession}><div className="rx-simple-content">{empty}</div></PrescriptionPanel> : empty;
  }
  if (sessionDomain === "strength") {
    const strength = prescription as PrescriptionByDomain["strength"];
    if (variant === "compact") return <>{showTitle !== false && <strong>{name}</strong>}<ul>{strength.blocks.map((exercise) => <li key={exercise.id}>{exerciseName(exercise.canonicalKey, exercise.displayName, currentLanguage())}<span>{exercise.sets} × {exercise.repsMin === exercise.repsMax ? exercise.repsMin : `${exercise.repsMin}–${exercise.repsMax}`}</span></li>)}</ul></>;
    return <StrengthPrescription prescription={strength} name={name} showTitle={showTitle} sessionDomain={sessionDomain} summary={summary} meta={meta} keySession={keySession}/>;
  }
  if (sessionDomain === "endurance") {
    const endurance = prescription as PrescriptionByDomain["endurance"];
    if (variant === "detailed") return <EndurancePrescription prescription={endurance} name={name} showTitle={showTitle} sessionDomain={sessionDomain} summary={summary} meta={meta} keySession={keySession}/>;
    return <ol className="rx-segments compact">{endurance.blocks.map((segment, index) => segment.type === "repeat"
      ? <li className="rx-repeat" key={`${segment.name}-${index}`}><strong>{segment.repetitions} × {segment.name}</strong><div><span>Work · {segment.work.name}</span><CompactEnduranceTargets step={segment.work}/>{segment.recovery && <><span>Recovery · {segment.recovery.name}</span><CompactEnduranceTargets step={segment.recovery}/></>}</div>{segment.notes && <small>{segment.notes}</small>}</li>
      : <li key={`${segment.name}-${index}`}><strong>{friendlyLabel(segment.role)} · {segment.name}</strong><CompactEnduranceTargets step={segment}/></li>)}</ol>;
  }
  if (sessionDomain === "sport_skill" || sessionDomain === "mobility" || sessionDomain === "mind_body" || sessionDomain === "functional") {
    const blocks = prescription as PrescriptionByDomain["sport_skill" | "mobility" | "mind_body" | "functional"];
    if (variant === "detailed") return <BlocksPrescription prescription={blocks} name={name} showTitle={showTitle} sessionDomain={sessionDomain} summary={summary} meta={meta} keySession={keySession}/>;
    return <BlockList prescription={blocks} sessionDomain={sessionDomain}/>;
  }
  const unavailable = <p className="rx-empty">{fallbackNotes || "No structured prescription is available for this session."}</p>;
  return variant === "detailed" ? <PrescriptionPanel name={name} showTitle={showTitle} sessionDomain={sessionDomain} summary={summary} meta={meta} keySession={keySession}>{unavailable}</PrescriptionPanel> : unavailable;
}
