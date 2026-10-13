import { T, tr } from "../i18n";
import { useEffect, useId, useState, type ReactNode } from "react";
import { friendlyLabel, type Mesocycle } from "../view-models";
import { domainIconPath } from "../domain-icons";
import "./target.css";

type Domain = Mesocycle["domainProgressions"][number]["domain"];
type Phases = Mesocycle["domainProgressions"][number]["phases"];

const VISIBLE_PHASES = 3;
const EXPANDED_STORAGE_KEY = "athria:plan:progression-by-domain:expanded";

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

function Chevron({ open }: { open: boolean }) {
  return <LineIcon className={`pdb-chevron${open ? " is-open" : ""}`}><path d="m7 9.5 5 5 5-5"/></LineIcon>;
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
          ? <button type="button" className="pdb-nav-back" aria-label={tr("Show earlier phases")} onClick={() => setStart(start - 1)}><ArrowIcon className="pdb-arrow-back"/></button>
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
                  ? <button type="button" className="pdb-phase-arrow" aria-label={tr("Show later phases")} onClick={() => setStart(start + 1)}><ArrowIcon/></button>
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
  const panelId = useId();
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(EXPANDED_STORAGE_KEY) !== "false"; } catch { return true; }
  });
  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(EXPANDED_STORAGE_KEY, String(next)); } catch { /* Keep the toggle usable when storage is unavailable. */ }
  };
  return (
    <section className="pdb-section" data-collapsed={open ? undefined : "true"}>
      <h3 className="pdb-heading">
        <button type="button" className="pdb-toggle" aria-expanded={open} aria-controls={panelId} onClick={toggleOpen}>
          <span className="pdb-heading-text">
            <span className="pdb-heading-title"><T>{"Progression by Domain"}</T></span>
            <span className="pdb-subheading"><T>{"Training phases and focus for each domain"}</T></span>
          </span>
          <Chevron open={open}/>
        </button>
      </h3>
      {open && <div className="pdb-domains" id={panelId}>
        {progressions.map((progression) => {
          const phases = [...progression.phases].sort((left, right) => left.startWeek - right.startWeek);
          return <DomainTrack key={progression.domain} domain={progression.domain} phases={phases} currentWeek={currentWeek} onSelectPhase={onSelectPhase}/>;
        })}
      </div>}
    </section>
  );
}
