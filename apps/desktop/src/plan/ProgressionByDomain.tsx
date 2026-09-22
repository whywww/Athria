import { useEffect, useState, type ReactNode } from "react";
import { friendlyLabel, type Mesocycle } from "../view-models";
import { domainIconPath } from "../domain-icons";
import "./target.css";

type Domain = Mesocycle["domainProgressions"][number]["domain"];
type Phases = Mesocycle["domainProgressions"][number]["phases"];

const VISIBLE_PHASES = 3;

export interface ProgressionByDomainProps {
  progressions: Mesocycle["domainProgressions"];
  currentWeek: number;
  onSelectPhase?: (domain: Domain, phaseId: string, startWeek: number) => void;
}

function weekRangeLabel(startWeek: number, endWeek: number): string {
  return startWeek === endWeek ? `W${startWeek}` : `W${startWeek} – W${endWeek}`;
}

function LineIcon({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

function DomainIcon({ domain }: { domain: Domain }) {
  return <span className="pdb-domain-icon"><LineIcon>{domainIconPath(domain)}</LineIcon></span>;
}

function ArrowIcon({ className = "" }: { className?: string }) {
  return <LineIcon className={className}><path d="m9 6 6 6-6 6"/></LineIcon>;
}

function DomainTrack({ domain, phases, currentWeek, onSelectPhase }: {
  domain: Domain;
  phases: Phases;
  currentWeek: number;
  onSelectPhase?: ProgressionByDomainProps["onSelectPhase"];
}) {
  const currentIndex = Math.max(0, phases.findIndex((phase) => currentWeek >= phase.startWeek && currentWeek <= phase.endWeek));
  const lastStart = Math.max(0, phases.length - VISIBLE_PHASES);
  const [start, setStart] = useState(() => Math.min(currentIndex, lastStart));

  useEffect(() => { setStart(Math.min(currentIndex, lastStart)); }, [currentIndex, lastStart]);

  const canForward = start < lastStart;
  const canBack = phases.length > VISIBLE_PHASES && start > 0;
  const visiblePhases = phases.slice(start, start + VISIBLE_PHASES);

  return (
    <section className="pdb-domain" data-domain={domain}>
      <div className="pdb-domain-info">
        <DomainIcon domain={domain}/>
        <h4 className="pdb-domain-name">{friendlyLabel(domain)}</h4>
      </div>
      <div className="pdb-track">
        {canBack
          ? <button type="button" className="pdb-nav-back" aria-label="Show earlier phases" onClick={() => setStart(start - 1)}><ArrowIcon className="pdb-arrow-back"/></button>
          : <span className="pdb-nav-spacer" aria-hidden="true"/>}
        <div className="pdb-track-list" role="list">
          {visiblePhases.map((phase, offset) => {
            const index = start + offset;
            const isCurrent = currentWeek >= phase.startWeek && currentWeek <= phase.endWeek;
            const isTail = index === phases.length - 1;
            const tooltip = phase.progression[0];
            return (
              <div className="pdb-track-item" role="listitem" key={phase.id} data-tail={isTail ? "true" : undefined}>
                <button
                  type="button"
                  className="pdb-phase"
                  aria-current={isCurrent ? "true" : undefined}
                  title={tooltip}
                  onClick={() => onSelectPhase?.(domain, phase.id, phase.startWeek)}
                >
                  <span className="pdb-phase-marker-row" aria-hidden="true">
                    <span className="pdb-phase-marker"/>
                    <span className="pdb-phase-line"/>
                  </span>
                  <span className="pdb-phase-name-row">
                    <span className="pdb-phase-name">{phase.name}</span>
                    <span className="pdb-phase-range">{weekRangeLabel(phase.startWeek, phase.endWeek)}</span>
                  </span>
                  {phase.progression[0] && <span className="pdb-phase-progression">{phase.progression[0]}</span>}
                </button>
                {!isTail && (canForward
                  ? <button type="button" className="pdb-phase-arrow" aria-label="Show later phases" onClick={() => setStart(start + 1)}><ArrowIcon/></button>
                  : <span className="pdb-phase-arrow" aria-hidden="true"><ArrowIcon/></span>)}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function ProgressionByDomain({ progressions, currentWeek, onSelectPhase }: ProgressionByDomainProps) {
  return (
    <section className="pdb-section">
      <h3 className="pdb-heading">Progression by Domain</h3>
      <p className="pdb-subheading">Training phases and focus for each domain</p>
      <div className="pdb-domains">
        {progressions.map((progression) => {
          const phases = [...progression.phases].sort((left, right) => left.startWeek - right.startWeek);
          return <DomainTrack key={progression.domain} domain={progression.domain} phases={phases} currentWeek={currentWeek} onSelectPhase={onSelectPhase}/>;
        })}
      </div>
    </section>
  );
}
