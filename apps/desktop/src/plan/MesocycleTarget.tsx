import { T, tr } from "../i18n";
import { useState, type ReactNode } from "react";
import type { CurrentPlan } from "../view-models";
import { domainIconPath, type DomainIconId } from "../domain-icons";
import { addDays, formatShortDate, formatWeekRange } from "./view";
import "./target.css";

export type MesocycleTargetStatus = "upcoming" | "current" | "updated" | "review" | "completed";

export interface MesocycleTargetProps {
  plan: CurrentPlan;
  today: string;
  currentWeek: number;
  currentPhaseNames: string[];
  status?: MesocycleTargetStatus;
}

const statusLabels: Record<MesocycleTargetStatus, string> = {
  upcoming: "Upcoming plan",
  current: "Current plan",
  updated: "Updated",
  review: "Review proposed changes",
  completed: "Plan completed",
};

function LineIcon({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

function CalendarIcon() {
  return <LineIcon><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M8 3.5v4M16 3.5v4M4 9.5h16"/><path d="M8 13h2M14 13h2M8 16h2"/></LineIcon>;
}

function Chevron({ open = false }: { open?: boolean }) {
  return <LineIcon className={`mt-chevron${open ? " is-open" : ""}`}><path d="m7 9.5 5 5 5-5"/></LineIcon>;
}

function DetailIcon({ kind }: { kind: "details" | "supporting" | "maintenance" | "coordination" }) {
  const icon = kind === "details"
    ? <><rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8h1M13 8h2M9 12h1M13 12h2M9 16h1M13 16h2"/></>
    : kind === "supporting"
      ? <path d="M5 19h3v-6H5zM10.5 19h3V8h-3zM16 19h3V4h-3z"/>
      : kind === "maintenance"
        ? <><path d="M5 12a7 7 0 0 1 12-4.8L19 9"/><path d="M19 4v5h-5M19 12a7 7 0 0 1-12 4.8L5 15"/><path d="M5 20v-5h5"/></>
        : <><path d="M9 17.5h6M10 21h4"/><path d="M8.2 14.5A6 6 0 1 1 15.8 14.5c-1.1.8-1.5 1.6-1.5 3h-4.6c0-1.4-.4-2.2-1.5-3Z"/><path d="M12 3v2M5.6 5.6 7 7M18.4 5.6 17 7"/></>;
  return <span className="mt-detail-icon"><LineIcon>{icon}</LineIcon></span>;
}

function DomainIcon({ label }: { label: string }) {
  const key = label.split("·", 1)[0]?.trim().toLowerCase() ?? "";
  const domain: DomainIconId = key.includes("strength") ? "strength" : key.includes("endurance") ? "endurance" : key.includes("sport") ? "sport_skill" : key.includes("mind") ? "mind_body" : "recovery";
  const tone = domain === "sport_skill" ? "sport" : domain === "mind_body" ? "mind" : domain;
  return <span className={`mt-domain-icon mt-domain-${tone}`}><LineIcon>{domainIconPath(domain)}</LineIcon></span>;
}

function DetailSection({ kind, title, children }: { kind: "supporting" | "maintenance" | "coordination"; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const panelId = `mt-${kind}-panel`;
  return <section className={`mt-detail-section mt-detail-${kind}`}>
    <button type="button" className="mt-detail-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      <DetailIcon kind={kind}/><span>{title}</span><Chevron open={open}/>
    </button>
    {open && <div className="mt-detail-body" id={panelId}>{children}</div>}
  </section>;
}

export function MesocycleTarget({ plan, today, currentWeek, currentPhaseNames, status = "current" }: MesocycleTargetProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const target = plan.target;
  const durationWeeks = Math.max(1, plan.mesocycle.durationWeeks);
  const endDate = addDays(plan.effectiveStartDate, durationWeeks * 7 - 1);
  const range = formatWeekRange(plan.effectiveStartDate, endDate);
  const primary = target?.primaryGoal;
  const supporting = target?.supporting ?? [];
  const maintenance = target?.maintenance ?? [];
  const coordination = target?.coordinationStrategy;
  const hasDetails = supporting.length > 0 || maintenance.length > 0 || Boolean(coordination);

  return <section className="mesocycle-card mt-card">
    <span className="sr-only">{statusLabels[status]}</span>
    <header className="mt-heading">
      <div className="mt-title-group"><div className="mt-heading-text"><h2>{plan.title}</h2><p>{range}</p></div></div>
      <span className="mt-duration"><CalendarIcon/><strong>{durationWeeks} weeks</strong></span>
    </header>

    <div className="mt-progress">
      <span className="mt-progress-week"><strong>Week {currentWeek}</strong> of <strong>{durationWeeks}</strong></span>
      <div className="mt-progress-phases">{currentPhaseNames.map((name) => <span className="mt-progress-phase" key={name}><DomainIcon label={name}/>{name}</span>)}</div>
      <span className="mt-progress-asof">As of {formatShortDate(today)}</span>
    </div>

    <section className="mt-primary-section">
      <h3><T>{"Primary Goal"}</T></h3>
      {primary ? <div className="mt-primary"><p>{primary.label}</p>{(primary.baseline || primary.testDate) && <div className="mt-primary-meta">{primary.baseline && <span>当前基线：{primary.baseline}</span>}{primary.testDate && <span>目标测试 {primary.testDate}</span>}</div>}</div> : <p className="mt-fallback">{plan.summary || "本周期尚未提供结构化目标说明。"}</p>}
    </section>

    {hasDetails && <section className="mt-details-shell">
      <button type="button" className="mt-details-toggle" aria-expanded={detailsOpen} aria-controls="mt-details-panel" onClick={() => setDetailsOpen((value) => !value)}>
        <DetailIcon kind="details"/><span><T>{"Plan Details"}</T></span><Chevron open={detailsOpen}/>
      </button>
      {detailsOpen && <div className="mt-details-panel" id="mt-details-panel">
        {supporting.length > 0 && <DetailSection kind="supporting" title={tr("Supporting")}><ul className="mt-list">{supporting.map((item, index) => <li key={`supporting-${index}`}><span>{item.label}</span>{item.detail && <small>{item.detail}</small>}</li>)}</ul></DetailSection>}
        {maintenance.length > 0 && <DetailSection kind="maintenance" title={tr("Maintenance")}><ul className="mt-list">{maintenance.map((item, index) => <li key={`maintenance-${index}`}><span>{item.label}</span>{item.detail && <small>{item.detail}</small>}</li>)}</ul></DetailSection>}
        {coordination && <DetailSection kind="coordination" title={tr("Coordination Strategy")}><p className="mt-coordination">{coordination}</p></DetailSection>}
      </div>}
    </section>}
  </section>;
}
