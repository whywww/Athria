import { useEffect, useRef } from "react";
import { friendlyLabel, type Mesocycle } from "../view-models";
import { domainGlyph } from "./calendar-utils";
import "./target.css";

export interface ProgressionByDomainProps {
  progressions: Mesocycle["domainProgressions"];
  currentWeek: number;
  onSelectPhase?: (domain: Mesocycle["domainProgressions"][number]["domain"], phaseId: string, startWeek: number) => void;
}

function weekRangeLabel(startWeek: number, endWeek: number): string {
  return startWeek === endWeek ? `W${startWeek}` : `W${startWeek} ─ W${endWeek}`;
}

export function ProgressionByDomain({ progressions, currentWeek, onSelectPhase }: ProgressionByDomainProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[aria-current='true']")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentWeek]);

  return (
    <section className="mesocycle-card pdb-card">
      <div className="proposal-section">
        <h3 className="pdb-heading">Progression by Domain</h3>
        <div className="pdb-domains" ref={rootRef}>
          {progressions.map((progression) => (
            <section className="pdb-domain" key={progression.domain}>
              <h4><span aria-hidden="true">{domainGlyph(progression.domain)}</span>{friendlyLabel(progression.domain)}</h4>
              <div className="pdb-track">
                {[...progression.phases].sort((left, right) => left.startWeek - right.startWeek).map((phase, index) => {
                  const isCurrent = currentWeek >= phase.startWeek && currentWeek <= phase.endWeek;
                  const tooltip = [phase.focus, ...phase.progression].filter(Boolean).join("\n");
                  return (
                    <button
                      key={phase.id}
                      type="button"
                      className={`pdb-phase pt-tone-${index % 4}`}
                      style={{ flexGrow: phase.endWeek - phase.startWeek + 1 }}
                      aria-current={isCurrent ? "true" : undefined}
                      title={tooltip}
                      onClick={() => onSelectPhase?.(progression.domain, phase.id, phase.startWeek)}
                    >
                      <span className="pdb-phase-name">{phase.name}</span>
                      <span className="pdb-phase-range">{weekRangeLabel(phase.startWeek, phase.endWeek)}</span>
                      <span className="pdb-phase-focus">{phase.focus}</span>
                      {phase.progression.length > 0 && <ul>{phase.progression.map((item) => <li key={item}>{item}</li>)}</ul>}
                      {isCurrent && <span className="pdb-current"><span aria-hidden="true">▲</span> Current</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
