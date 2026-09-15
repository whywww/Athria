import { useEffect, useRef, type ReactNode } from "react";
import { friendlyLabel, type Mesocycle } from "../view-models";
import "./target.css";

export interface ProgressionByDomainProps {
  progressions: Mesocycle["domainProgressions"];
  currentWeek: number;
  onSelectPhase?: (domain: Mesocycle["domainProgressions"][number]["domain"], phaseId: string, startWeek: number) => void;
}

function weekRangeLabel(startWeek: number, endWeek: number): string {
  return startWeek === endWeek ? `W${startWeek}` : `W${startWeek} ─ W${endWeek}`;
}

function LineIcon({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

function DomainIcon({ domain }: { domain: Mesocycle["domainProgressions"][number]["domain"] }) {
  const icon = domain === "strength"
    ? <><path d="M6.5 9v6M3.5 10.5v3M17.5 9v6M20.5 10.5v3M6.5 12h11"/><path d="M9 8v8M15 8v8"/></>
    : domain === "endurance"
      ? <><circle cx="14" cy="5" r="1.8"/><path d="m12 9 3 2 2 4M12 9l-3 4-4 1M10 13l-1 6M15 12l-4 3 4 4"/></>
      : domain === "sport_skill"
        ? <><circle cx="12" cy="12" r="7.5"/><path d="M12 4.5v15M4.5 12h15"/></>
        : domain === "mind_body"
          ? <><circle cx="12" cy="6" r="1.8"/><path d="M12 8v4M12 10l-4 3M12 10l4 3M12 12l-3 5M12 12l3 5"/></>
          : <><path d="M5 18c1-8 6-12 14-12-1 8-5 13-12 12"/><path d="M7 18c3-4 6-7 10-9"/></>;
  return <span className="pdb-domain-icon"><LineIcon>{icon}</LineIcon></span>;
}

function ArrowIcon({ className = "" }: { className?: string }) {
  return <LineIcon className={className}><path d="m9 6 6 6-6 6"/></LineIcon>;
}

export function ProgressionByDomain({ progressions, currentWeek, onSelectPhase }: ProgressionByDomainProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[aria-current='true']")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentWeek]);

  return (
    <section className="pdb-section">
      <h3 className="pdb-heading">Progression by Domain</h3>
      <div className="pdb-domains" ref={rootRef}>
        {progressions.map((progression) => {
          const phases = [...progression.phases].sort((left, right) => left.startWeek - right.startWeek);
          return (
            <section className="pdb-domain" key={progression.domain}>
              <header className="pdb-domain-heading">
                <DomainIcon domain={progression.domain}/>
                <h4>{friendlyLabel(progression.domain)}</h4>
                <ArrowIcon className="pdb-domain-chevron"/>
              </header>
              <div className="pdb-track" role="list">
                {phases.map((phase, index) => {
                  const isCurrent = currentWeek >= phase.startWeek && currentWeek <= phase.endWeek;
                  const tooltip = phase.progression[0];
                  return (
                    <div className="pdb-track-item" role="listitem" key={phase.id}>
                      <button
                        type="button"
                        className="pdb-phase"
                        aria-current={isCurrent ? "true" : undefined}
                        title={tooltip}
                        onClick={() => onSelectPhase?.(progression.domain, phase.id, phase.startWeek)}
                      >
                        <span className="pdb-phase-topline">
                          <span className="pdb-phase-name">{phase.name}</span>
                          {isCurrent && <span className="pdb-current">Current</span>}
                        </span>
                        <span className="pdb-phase-range">{weekRangeLabel(phase.startWeek, phase.endWeek)}</span>
                        {phase.progression[0] && <span className="pdb-phase-progression">{phase.progression[0]}</span>}
                      </button>
                      {index < phases.length - 1 && <span className="pdb-phase-arrow" aria-hidden="true"><ArrowIcon/></span>}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
