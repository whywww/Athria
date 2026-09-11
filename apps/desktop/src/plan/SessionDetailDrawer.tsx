import { useEffect, useRef, useState, type RefObject } from "react";
import { formatDuration, friendlyLabel, type CalendarSession, type CurrentPlan, type StoredSessionTemplate } from "../view-models";
import { api } from "../api";
import { ErrorBanner } from "../components";
import { Prescription } from "./Prescription";
import { addDays } from "./view";
import { domainGlyph, formatDayLabel, phaseLabelsForSession, sessionStatusLabel, sessionTone } from "./calendar-utils";
import "./calendar.css";

/**
 * Session Detail Drawer (UNIFIED_MULTISPORT_MESOCYCLE_DESIGN §8).
 *
 * A right-hand modal sheet that answers *why* a session exists, *what* it
 * contains and lets the athlete action a `planned` session. It is controlled by
 * the parent through the `session` prop: `null` renders nothing, and swapping one
 * session for another replaces the content in place (never closing first, §7.8).
 *
 * Focus management is self-contained: on open the first focusable element is
 * focused, Escape / backdrop / close button dismiss, and on unmount focus is
 * returned to the trigger element (via `returnFocusRef` when supplied, otherwise
 * the element that was focused when the drawer opened).
 */

export interface SessionDetailDrawerProps {
  session: CalendarSession | null;
  templates: StoredSessionTemplate[];
  plan: CurrentPlan | null;
  today: string;
  onClose: () => void;
  onMutated: () => void;
  /** Optional element to refocus when the drawer closes (§7.8). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DrawerPanelProps extends Omit<SessionDetailDrawerProps, "session"> {
  session: CalendarSession;
}

function DrawerPanel({ session, templates, plan, today, onClose, onMutated, returnFocusRef }: DrawerPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveDate, setMoveDate] = useState(() => addDays(session.scheduledDate, 1));

  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTarget = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Capture where focus should return *before* moving it into the sheet, and
  // restore it only when the panel truly unmounts (i.e. the drawer closes, not
  // when the session prop is swapped) — §7.8.
  useEffect(() => {
    restoreTarget.current = returnFocusRef?.current ?? (document.activeElement as HTMLElement | null);
    return () => {
      const target = restoreTarget.current;
      if (target && typeof target.focus === "function" && document.contains(target)) target.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the first focusable element on open without disturbing calendar scroll.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus({ preventScroll: true });
  }, []);

  // Escape closes; Tab is trapped within the sheet for keyboard users (§16.4).
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  // Reset transient action state whenever a different session is shown.
  useEffect(() => {
    setError(undefined);
    setBusy(false);
    setMoveOpen(false);
    setMoveDate(addDays(session.scheduledDate, 1));
  }, [session.id, session.scheduledDate]);

  const act = async (update: Record<string, unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/planned-sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ ...update, expectedRevision: session.revision }),
      });
      onMutated();
    } catch (value) {
      setError(value);
    } finally {
      setBusy(false);
    }
  };

  const tone = sessionTone(session, today);
  const phaseLabels = plan ? phaseLabelsForSession(plan.mesocycle.domainProgressions, session) : [];
  const template = session.templateRef ? templates.find((item) => item.id === session.templateRef?.id) : undefined;

  return (
    <div className="sd-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="sd-sheet" role="dialog" aria-modal="true" aria-label={session.name} ref={panelRef} tabIndex={-1}>
        <header className="sd-header">
          <div className="sd-header-text">
            <h2 className="sd-title">{session.name}</h2>
            <p className="sd-date">{formatDayLabel(session.scheduledDate)}</p>
          </div>
          <button type="button" className="sd-close" aria-label="Close session details" onClick={onClose}>×</button>
        </header>

        <div className="sd-meta">
          <span className={`sd-status sd-status-${tone}`}>
            {tone === "completed" && <span aria-hidden="true">✓ </span>}
            {sessionStatusLabel(tone)}
          </span>
          <span className="sd-meta-item">Week {session.weekNumber}</span>
          {phaseLabels.map((label) => <span className="sd-meta-item" key={label}>{label}</span>)}
          <span className="sd-meta-item">{formatDuration(session.durationMinutes)}</span>
          {session.keySession && <span className="sd-meta-item">Key session</span>}
        </div>

        <div className="sd-body">
          <ErrorBanner error={error} />

          {session.intent && (
            <section className="sd-section">
              <h3 className="sd-eyebrow">Purpose</h3>
              <p className="sd-purpose">{session.intent}</p>
            </section>
          )}

          {/* Base template renders only when it resolves (§8.3) — never an empty block. */}
          {template && (
            <section className="sd-section">
              <h3 className="sd-eyebrow">Base template</h3>
              <div className="sd-template">
                <span className="sd-template-name">{template.name}</span>
                <span className="sd-template-meta">{template.origin === "builtin" ? "Built-in" : `Revision ${template.revision}`}</span>
              </div>
              <p className="sd-hint">The template records provenance only; the executable prescription belongs to this session.</p>
            </section>
          )}

          {session.legacySnapshot && <section className="sd-section sd-legacy"><h3 className="sd-eyebrow">Needs structured review</h3><p>This legacy prescription is preserved as written and can be converted by a connected Agent.</p></section>}

          <section className="sd-section">
            <h3 className="sd-eyebrow">Prescription</h3>
            {session.components.length > 0 ? (
              <div className="sd-prescriptions">
                {session.components.map((component) => (
                  <div className="sd-prescription" key={component.id}>
                    <div className="sd-prescription-head">
                      <span className="sd-prescription-name">{component.name}</span>
                      {component.domain.value !== null && (
                        <span className="wc-domain" title={friendlyLabel(component.domain.value)}>
                          <span aria-hidden="true">{domainGlyph(component.domain.value)}</span>
                          <span className="wc-domain-label">{friendlyLabel(component.domain.value)}</span>
                        </span>
                      )}
                    </div>
                    <Prescription component={component} variant="detailed" fallbackNotes={session.intent} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="sd-empty">No structured prescription is available for this session.</p>
            )}
          </section>

          {session.progressionNote && <section className="sd-section"><h3 className="sd-eyebrow">This week's progression</h3><p>{session.progressionNote}</p></section>}
          {session.schedulingRationale && <section className="sd-section"><h3 className="sd-eyebrow">Why this day</h3><p>{session.schedulingRationale}</p>{plan?.mesocycle.schedule.kind === "interval" && <small>Rotation interval: every {plan.mesocycle.schedule.intervalDays} days.</small>}</section>}
        </div>

        {session.status === "planned" && (
          <footer className="sd-actions">
            <div className="sd-actions-row">
              <button type="button" className="sd-action" disabled={busy} onClick={() => void act({ action: "complete" })}>✓ Mark complete</button>
              <button type="button" className="sd-action secondary" disabled={busy} onClick={() => void act({ action: "skip" })}>Skip</button>
              <button
                type="button"
                className="sd-action secondary"
                disabled={busy}
                aria-expanded={moveOpen}
                aria-controls="sd-move-panel"
                onClick={() => setMoveOpen((open) => !open)}
              >
                Move
              </button>
            </div>
            {moveOpen && (
              <div className="sd-move" id="sd-move-panel">
                <label>
                  Move to date
                  <input type="date" value={moveDate} onChange={(event) => setMoveDate(event.target.value)} />
                </label>
                <button
                  type="button"
                  className="sd-action secondary"
                  disabled={busy || !moveDate || moveDate === session.scheduledDate}
                  onClick={() => void act({ action: "move_occurrence", scheduledDate: moveDate })}
                >
                  Confirm move
                </button>
              </div>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

export function SessionDetailDrawer(props: SessionDetailDrawerProps) {
  const { session } = props;
  // The panel mounts only while a session is open, so its unmount is exactly the
  // "drawer closed" moment used to restore focus.
  if (!session) return null;
  return <DrawerPanel {...props} session={session} />;
}
