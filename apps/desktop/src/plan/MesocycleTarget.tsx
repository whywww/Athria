import { useState } from "react";
import type { CurrentPlan } from "../view-models";
import { addDays, formatShortDate, formatWeekRange } from "./view";
import "./target.css";

/**
 * Mesocycle Target card (UNIFIED_MULTISPORT_MESOCYCLE_DESIGN §5).
 *
 * The first layer of the Plan page: one screen answers *what* this plan is,
 * *where* the athlete currently sits, and *what the cycle is optimising for*.
 * The Primary Goal always carries the highest visual weight; the supporting
 * detail (Supporting / Maintenance / Coordination) collapses into a single
 * "Plan details" disclosure so mixed-training plans stay legible.
 *
 * All week/date maths is delegated to the pure helpers in `./view` — this
 * component never re-derives week numbers itself.
 */

/** Lifecycle state of the plan this card describes (§5.5). */
export type MesocycleTargetStatus = "upcoming" | "current" | "updated" | "review" | "completed";

export interface MesocycleTargetProps {
  plan: CurrentPlan;
  today: string;
  currentWeek: number;
  currentPhaseNames: string[];
  /** Defaults to `"current"`. P0 fully renders `current`; others show a badge only. */
  status?: MesocycleTargetStatus;
  storageKey?: string;
}

const statusLabels: Record<MesocycleTargetStatus, string> = {
  upcoming: "Upcoming plan",
  current: "Current plan",
  updated: "Updated",
  review: "Review proposed changes",
  completed: "Plan completed",
};

export function MesocycleTarget({ plan, today, currentWeek, currentPhaseNames, status = "current", storageKey }: MesocycleTargetProps) {
  // Disclosure preference persists for this session via component state (§5.4).
  const [detailsOpen, setDetailsOpen] = useState(() => storageKey ? sessionStorage.getItem(`${storageKey}:target`) !== "closed" : true);
  const toggleDetails = () => setDetailsOpen((open) => { const next = !open; if (storageKey) sessionStorage.setItem(`${storageKey}:target`, next ? "open" : "closed"); return next; });

  const target = plan.target;
  const durationWeeks = Math.max(1, plan.mesocycle.durationWeeks);
  const endDate = addDays(plan.effectiveStartDate, durationWeeks * 7 - 1);
  const range = formatWeekRange(plan.effectiveStartDate, endDate);

  const primary = target?.primaryGoal;
  const supporting = target?.supporting ?? [];
  const maintenance = target?.maintenance ?? [];
  const coordination = target?.coordinationStrategy;

  // Legacy plans (no `target`) degrade to title + summary and render no empty
  // Supporting / Maintenance / Coordination regions (§5.4).
  const hasDetails = supporting.length > 0 || maintenance.length > 0 || Boolean(coordination);

  return (
    <section className="mesocycle-card mt-card">
      <header className="proposal-heading mt-heading">
        <div>
          <span className="proposal-mark mt-mark" aria-hidden="true">◎</span>
          <div className="mt-heading-text">
            <h2>{plan.title}</h2>
            <p className="mt-range">{range}</p>
          </div>
        </div>
        <div className="proposal-facts mt-facts">
          <span className={`mt-status mt-status-${status}`}>
            <i aria-hidden="true" />
            {statusLabels[status]}
          </span>
          <span className="mt-fact">▣　{durationWeeks} weeks</span>
        </div>
      </header>

      <div className="mt-progress">
        <span className="mt-progress-week">
          Week {currentWeek} <em>of</em> {durationWeeks}
        </span>
        {currentPhaseNames.map((name) => <span className="mt-progress-phase" key={name}>{name}</span>)}
        <span className="mt-progress-asof">As of {formatShortDate(today)}</span>
      </div>

      <section className="proposal-section mt-primary-section">
        <h3 className="mt-eyebrow mt-eyebrow-primary">Primary Goal</h3>
        {primary ? (
          <div className="mt-primary">
            <p className="mt-primary-label">{primary.label}</p>
            {(primary.baseline || primary.testDate) && (
              <div className="mt-primary-meta">
                {primary.baseline && <span className="mt-baseline">当前基线：{primary.baseline}</span>}
                {primary.testDate && <span className="mt-testdate">目标测试 {primary.testDate}</span>}
              </div>
            )}
          </div>
        ) : (
          <p className="mt-fallback">{plan.summary || "本周期尚未提供结构化目标说明。"}</p>
        )}
      </section>

      {hasDetails && (
        <section className="proposal-section mt-details-section">
          <button
            type="button"
            className="mt-details-toggle"
            aria-expanded={detailsOpen}
            aria-controls="mt-details-panel"
            onClick={toggleDetails}
          >
            <span className="mt-eyebrow">Plan details</span>
            <span className="mt-toggle-icon" aria-hidden="true">{detailsOpen ? "−" : "+"}</span>
          </button>

          {detailsOpen && (
            <div className="mt-details" id="mt-details-panel">
              {(supporting.length > 0 || maintenance.length > 0) && (
                <div className="mt-columns">
                  {supporting.length > 0 && (
                    <div className="mt-column">
                      <h4 className="mt-eyebrow">Supporting</h4>
                      <ul className="mt-list">
                        {supporting.map((item, index) => (
                          <li key={`supporting-${index}`}>
                            <strong>{item.label}</strong>
                            {item.detail && <span>{item.detail}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {maintenance.length > 0 && (
                    <div className="mt-column">
                      <h4 className="mt-eyebrow">Maintenance</h4>
                      <ul className="mt-list mt-list-maintenance">
                        {maintenance.map((item, index) => (
                          <li key={`maintenance-${index}`}>
                            <strong>{item.label}</strong>
                            {item.detail && <span>{item.detail}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {coordination && (
                <div className="mt-block">
                  <h4 className="mt-eyebrow">Coordination Strategy</h4>
                  <p className="mt-coordination">{coordination}</p>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </section>
  );
}
