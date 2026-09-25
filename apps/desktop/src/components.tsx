import { T } from "./i18n";
import { useEffect } from "react";
import { friendlyLabel, validationMessage, type PlanValidation } from "./view-models";
import { currentLanguage, errorText, tr, weekdayName, useLanguage } from "./i18n";

export const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export function localizedWeekdays() { return Array.from({ length: 7 }, (_, index) => weekdayName(index, currentLanguage())); }

/** Closes a dialog on Escape. `enabled` lets always-mounted gates opt out until they are visible. */
export function useModalDismiss(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, enabled]);
}

export const Card = ({ title, children, className = "", action }: { title: React.ReactNode; children: React.ReactNode; className?: string; action?: React.ReactNode }) => <section className={`card ${className}`}><div className="card-heading"><h2>{title}</h2>{action}</div>{children}</section>;
export const ErrorBanner = ({ error }: { error: unknown }) => error ? <div className="error" role="alert">{errorText(error, currentLanguage())}</div> : null;
export const Loading = () => <p className="muted"><T>{"Loading…"}</T></p>;
export const EmptyState = ({ title, description }: { title: string; description?: string }) => <div className="empty-state"><strong>{tr(title)}</strong>{description && <p>{tr(description)}</p>}</div>;

export function PrimaryPageHeader({ preferredName, subtitle, actions }: { preferredName?: string | null | undefined; subtitle: string; actions?: React.ReactNode }) {
  const { language } = useLanguage();
  return <header className="primary-page-header"><div><h1>{language === "zh-CN" ? `你好，${preferredName || "运动员"}！` : `Hi, ${preferredName || "Athlete"}!`} <span aria-hidden="true">👋</span></h1><p>{tr(subtitle)}</p></div>{actions}</header>;
}

export function ChoiceChip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={`chip ${selected ? "selected" : ""}`} aria-pressed={selected} onClick={onClick}>{children}</button>;
}

export function ValidationSummary({ validation }: { validation: PlanValidation }) {
  const blockers = validation.results.filter((item) => item.enforcement === "blocker" && (item.status === "fail" || item.status === "unknown"));
  const advisories = validation.results.filter((item) => item.enforcement === "advisory" && item.status !== "pass" && item.status !== "not_applicable");
  const unknown = validation.results.filter((item) => item.status === "unknown");
  const coverage = validation.coverage;
  const percent = (resolved: number, total: number) => total ? Math.round(resolved / total * 100) : 100;
  return <div className={`validation ${blockers.length ? "blocked" : advisories.length ? "warning" : "valid"}`}><strong>{blockers.length ? "Changes required before approval" : advisories.length ? "Ready with recommendations" : "Plan checks passed"}</strong>{coverage && <span>Hard checks resolved: {coverage.hardChecksResolved}/{coverage.hardChecksTotal} · Classification coverage: movement {percent(coverage.movementFactsResolved, coverage.movementFactsTotal)}%, muscle {percent(coverage.muscleFactsResolved, coverage.muscleFactsTotal)}%, equipment {percent(coverage.equipmentFactsResolved, coverage.equipmentFactsTotal)}%</span>}{blockers.map((item, index) => <span key={`blocker-${item.reasonCode}-${index}`}>Blocker · {validationMessage(item)}</span>)}{advisories.map((item, index) => <span key={`advisory-${item.reasonCode}-${index}`}>Advisory · {validationMessage(item)}</span>)}{unknown.filter((item) => item.enforcement !== "blocker").map((item, index) => <span key={`unknown-${item.reasonCode}-${index}`}>Unknown · {validationMessage(item)}</span>)}{validation.dataGaps.length > 0 && <span>Missing information: {validation.dataGaps.map((gap) => `${friendlyLabel(gap.factPath)} (${friendlyLabel(gap.resolution)})`).join(", ")}</span>}</div>;
}

export function formatRest(seconds: number): string {
  if (currentLanguage() === "zh-CN") return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
  if (seconds < 60) return `${seconds} sec`;
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes} min` : `${seconds} sec`;
}
