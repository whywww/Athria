import { friendlyLabel, type EnduranceStep, type PlanComponent } from "../view-models";
import { formatRest } from "../components";

function duration(seconds?: number) {
  if (!seconds) return null;
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
}

function EnduranceTargets({ step }: { step: EnduranceStep }) {
  const values = [duration(step.durationSeconds), step.distanceMeters ? (step.distanceMeters >= 1000 ? `${step.distanceMeters / 1000} km` : `${step.distanceMeters} m`) : null, step.pace, step.heartRateZone, step.powerWatts, step.cadence, step.rpe ? `RPE ${step.rpe}` : null, step.talkTest].filter(Boolean);
  return <>{values.length > 0 && <span className="rx-targets">{values.join(" · ")}</span>}{step.notes && <small>{step.notes}</small>}</>;
}

export function Prescription({ component, variant = "detailed", fallbackNotes }: { component: PlanComponent; variant?: "detailed" | "compact"; fallbackNotes?: string }) {
  const prescription = component.prescription;
  if (prescription.kind === "strength") {
    if (variant === "compact") return <><strong>{component.name}</strong><ul>{prescription.exercises.map((exercise) => <li key={exercise.id}>{exercise.displayName}<span>{exercise.sets} × {exercise.repsMin === exercise.repsMax ? exercise.repsMin : `${exercise.repsMin}–${exercise.repsMax}`}</span></li>)}</ul></>;
    return <div className="exercise-table"><div className="exercise-row exercise-header"><span>Classification</span><span className="exercise-cell">Exercise</span><span>Prescription</span><span>Effort</span><span>Rest</span><span>Notes</span></div>{prescription.exercises.map((exercise, index) => { const movement = exercise.classification.primaryMovement?.value; const effort = [exercise.targetRpe ? `RPE ${exercise.targetRpe}` : null, exercise.targetRir != null ? `RIR ${exercise.targetRir}` : null].filter(Boolean).join(" / ") || "Controlled"; const notes = [exercise.tempo ? `Tempo ${exercise.tempo}` : null, exercise.notes || null, exercise.alternatives?.length ? `Alternatives: ${exercise.alternatives.join(", ")}` : null].filter(Boolean).join(" · "); return <div className="exercise-row" key={exercise.id}><span>{movement == null ? "-" : friendlyLabel(String(movement))}</span><span className="exercise-cell"><b>{index + 1}</b>{exercise.displayName}</span><span>{exercise.sets} × {exercise.repsMin === exercise.repsMax ? exercise.repsMin : `${exercise.repsMin}–${exercise.repsMax}`}{exercise.referenceLoad != null ? ` · ${exercise.referenceLoad} ${exercise.referenceLoadUnit ?? ""}` : ""}</span><span>{effort}</span><span>{formatRest(exercise.restSeconds)}</span><span className="exercise-notes">{notes || "—"}</span></div>; })}</div>;
  }
  if (prescription.kind === "endurance") return <ol className={`rx-segments ${variant}`}>{prescription.segments.map((segment, index) => segment.type === "repeat"
    ? <li className="rx-repeat" key={`${segment.name}-${index}`}><strong>{segment.repetitions} × {segment.name}</strong><div><span>Work · {segment.work.name}</span><EnduranceTargets step={segment.work}/>{segment.recovery && <><span>Recovery · {segment.recovery.name}</span><EnduranceTargets step={segment.recovery}/></>}</div>{segment.notes && <small>{segment.notes}</small>}</li>
    : <li key={`${segment.name}-${index}`}><strong>{friendlyLabel(segment.role)} · {segment.name}</strong><EnduranceTargets step={segment}/></li>)}</ol>;
  if (prescription.kind === "sport_skill") return <div className="rx-blocks"><strong>{friendlyLabel(prescription.sessionType)}</strong>{prescription.blocks.map((block, index) => <div className="rx-block" key={`${block.name}-${index}`}><b>{friendlyLabel(block.role)} · {block.name}</b><span>{[block.durationMinutes ? `${block.durationMinutes} min` : null, block.intensity].filter(Boolean).join(" · ")}</span>{block.instructions && <small>{block.instructions}</small>}</div>)}</div>;
  if (prescription.kind === "recovery" || prescription.kind === "mind_body") return <div className="rx-blocks">{prescription.blocks.map((block, index) => <div className="rx-block" key={`${block.name}-${index}`}><b>{block.name}</b>{block.durationMinutes && <span>{block.durationMinutes} min</span>}{block.instructions && <small>{block.instructions}</small>}</div>)}</div>;
  if (prescription.kind === "duration_only") return <p className="rx-legacy">{prescription.notes || fallbackNotes || "No structured prescription is available."}</p>;
  return null;
}
