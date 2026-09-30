import { T, tr } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applyDatabaseVersion, type DatabaseVersion } from "./database-version";
import { addCustomAgent, api, changeVaultPassword, createNewProfile, disconnectConnection, getAgentIntegrationsStatus, getIntervalsStatus, getMcpStatus, getStartupStatus, getVaultStatus, getXunjiStatus, importXunjiSkill, installAgentIntegration, openIntervalsWebsite, openSkillArchiveFolder, pickNewProfileDestination, pickRestoreFile, reconcileAgentSkills, removeAgentIntegration, requireVaultPassword, resetVaultPassword, resolveAgentSkillUpdate, restoreBackup, setupVault, syncIntervals, syncXunji, testIntervals, testXunjiSkill, unlockVault, type AgentIntegrationResult, type AgentIntegrationStatus, type AgentKind, type AgentSkillUpdate, type AgentSkillUpdateFailure, type OfficialAgentKind, type SkillArchiveView, type SkillUpdateResult, type StartupStatus } from "./api";
import {
  cmToImperialHeight, connectionSources, dashboardPages, deviceTimezone, displayPreferredName, equipmentGroupState, filterAndSortTrainingHistory, formatDateTime, formatDuration, formatPersonalHeight, formatPersonalWeight, formatRaceCountdown, formatRaceDateShort, formatTimezoneLabel, formatTrainingRhythm, formatTrainingSource, friendlyLabel, imperialHeightToCm, isUntouchedDefaultProfile, kgToPounds, nextRaceDay, poundsToKg,
  paginateTrainingHistory, parseSyncRange, profilePayload, syncRangeOptions, timezoneOptions, PREFERENCE_MAX_LENGTH, RACE_SPORT_PRESETS,
  toggleEquipmentGroup,
  type AthleteProfile, type BackupPreview, type CurrentPlan, type DoctorResult, type HevyImportStatus, type ImportPreview,
  type AdjustmentReminder, type CalendarSession, type EquipmentCategory, type ImportResult, type NextTrainingDay, type PersonalInformation, type RaceDay, type SyncRange, type TrainingHistorySession, type TrainingHistorySort, type TrainingTaxonomy, type TrainingSummary, type UnitSystem, type WellnessRecord, type XunjiConnectionStatus,
} from "./view-models";
import { Card, EmptyState, ErrorBanner, Loading, PrimaryPageHeader, useModalDismiss, localizedWeekdays } from "./components";
import { CurrentPlanPage, NextTrainingDayCard, TemplateLibrary } from "./plan/CurrentPlanPage";
import { localDateForTimezone } from "./plan/view";
import { OverviewDashboard, overviewDateRange } from "./overview";
import { domainIconPath } from "./domain-icons";
import { AgentLogo } from "./agent-logos";
import { currentLanguage, useLanguage, useT } from "./i18n";
import hevyLogo from "./assets/trackers/hevy.webp";
import intervalsLogo from "./assets/trackers/intervalsicu.png";
import xunjiLogo from "./assets/trackers/xunji.webp";

type Page = (typeof dashboardPages)[number]["id"];
const commonGoals = ["general_fitness", "build_strength", "build_muscle", "improve_endurance", "fat_loss", "improve_competition_results", "body_recomposition", "improve_posture"];
const RACE_SPORT_OTHER = "__other__";
const emptyRaceDraft: { date: string; sport: string; custom: string } = { date: "", sport: "", custom: "" };

function DraggableDatabasePath({ path }: { path: string }) {
  const drag = useRef<{ x: number; scrollLeft: number } | undefined>(undefined);
  return <code
    title={path}
    onMouseDown={(event) => {
      if (event.button !== 0) return;
      drag.current = { x: event.clientX, scrollLeft: event.currentTarget.scrollLeft };
      event.currentTarget.classList.add("is-dragging");
      event.preventDefault();
    }}
    onMouseMove={(event) => {
      if (drag.current) event.currentTarget.scrollLeft = drag.current.scrollLeft - (event.clientX - drag.current.x);
    }}
    onMouseUp={(event) => {
      drag.current = undefined;
      event.currentTarget.classList.remove("is-dragging");
    }}
    onMouseLeave={(event) => {
      drag.current = undefined;
      event.currentTarget.classList.remove("is-dragging");
    }}
  >{path}</code>;
}

type IconName = "overview" | "training" | "profile" | "plan" | "devices" | "settings" | "help" | "globe" | "edit" | "target" | "preferences" | "rhythm" | "clock" | "equipment" | "sparkles" | "warning" | "notes" | "recovery" | "info" | "plus" | "refresh" | "database" | "upload" | "close" | "trophy" | "ellipsis" | "grid" | "chevron" | "copy" | "trash" | "check";

function AppIcon({ name, className = "" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    overview: <><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></>,
    training: <><path d="M4 20v-7M10 20V7M16 20V3"/></>,
    profile: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>,
    plan: <><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></>,
    devices: <><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.7 2.7 0 1 1 4.5 2c-1.2.8-2 1.3-2 3M12 18h.01"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
    edit: <><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z"/><path d="m13.5 7 3.5 3.5"/></>,
    target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="m14.5 9.5 5-5M16 4h3.5v3.5"/></>,
    preferences: <><circle cx="12" cy="12" r="3"/><path d="M19 12h2M3 12h2M12 3v2M12 19v2M17 7l1.5-1.5M5.5 18.5 7 17M17 17l1.5 1.5M5.5 5.5 7 7"/></>,
    rhythm: <><path d="M4 20v-5M10 20V9M16 20V4"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></>,
    equipment: <><path d="M6 9v6M3 10v4M18 9v6M21 10v4M6 12h12"/><path d="M8 7v10M16 7v10"/></>,
    sparkles: <><path d="m12 3 1.4 4.1L17.5 9l-4.1 1.4L12 14.5l-1.4-4.1L6.5 9l4.1-1.9L12 3ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15ZM5 3l.7 1.8L7.5 5.5l-1.8.7L5 8l-.7-1.8-1.8-.7 1.8-.7L5 3Z"/></>,
    warning: <><path d="M10.3 4.2 2.7 18a2 2 0 0 0 1.8 3h15a2 2 0 0 0 1.8-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></>,
    notes: <><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h6M9 16h6"/></>,
    recovery: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    refresh: <><path d="M20 7v5h-5"/><path d="M18.4 16a8 8 0 1 1 .1-8.1L20 12"/></>,
    database: <><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></>,
    upload: <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 15v5h14v-5"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    trophy: <><path d="M8 4h8v4a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5.5v.5a3 3 0 0 0 3 3M16 6h2.5v.5a3 3 0 0 1-3 3"/><path d="M12 11.5V20M9.5 16h5M7 20h10"/></>,
    ellipsis: <><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/></>,
    grid: <><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"/></>,
    trash: <><path d="M4 7h16M9.5 7V4.5h5V7"/><path d="m6.5 7 .8 12.5h9.4L17.5 7"/></>,
    check: <path d="m5 12.5 4.5 4.5L19 7"/>,
  };
  return <svg className={`app-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function goalTone(goal: string) {
  switch (goal) {
    case "build_strength":
    case "build_muscle": return "coral";
    case "improve_endurance": return "yellow";
    case "improve_competition_results": return "yellow";
    case "general_fitness": return "green";
    case "improve_posture": return "green";
    case "fat_loss": return "purple";
    case "body_recomposition": return "purple";
    default: return "blue";
  }
}

function ServiceStatus() {
  const health = useQuery({ queryKey: ["doctor"], queryFn: () => api<DoctorResult>("/api/system/doctor"), retry: 3, retryDelay: 500 });
  const label = tr(health.isPending ? "Starting…" : health.isError ? "Service Unavailable" : "Local Service");
  return <div className="service-status"><span className={`status ${health.isError ? "offline" : ""}`}><i/>{label}</span></div>;
}

function SettingsCardTitle({ title, description }: { title: string; description: string }) {
  return <span className="settings-card-title"><span className="settings-card-copy"><span className="settings-card-name">{title}</span><small>{description}</small></span></span>;
}

function Overview() {
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const today = profile.data ? localDateForTimezone(profile.data.timezone) : null;
  const range = today ? overviewDateRange(today) : null;
  const query = useQuery({ queryKey: ["summary", range?.weekStart, today], queryFn: () => api<TrainingSummary>(`/api/summary?days=7&from=${range!.weekStart}&to=${today}`), enabled: range !== null });
  // P0-5: Today/Next surfaces the next training day on Overview (§3, §19).
  const nextDay = useQuery({ queryKey: ["next-training-day", today], queryFn: () => api<NextTrainingDay>(`/api/plans/next-training-day?onOrAfterDate=${today}`), enabled: today !== null });
  const plan = useQuery({ queryKey: ["current-plan"], queryFn: () => api<CurrentPlan | null>("/api/plans/current") });
  const adjustment = useQuery({
    queryKey: ["plan-adjustment-review", plan.data?.revision],
    queryFn: () => api<AdjustmentReminder>("/api/plans/adjustment-review"),
    enabled: Boolean(plan.data),
  });
  const wellness = useQuery({ queryKey: ["wellness", 42], queryFn: () => api<WellnessRecord[]>("/api/wellness?days=42") });
  const history = useQuery({ queryKey: ["sessions", "overview-calendar"], queryFn: () => api<TrainingHistorySession[]>("/api/sessions?days=365") });
  const calendar = useQuery({ queryKey: ["calendar", "overview-all"], queryFn: () => api<CalendarSession[]>("/api/plans/calendar") });
  if (query.isPending || profile.isPending || wellness.isPending || history.isPending || calendar.isPending) return <Loading/>;
  const error = query.error ?? profile.error ?? wellness.error ?? history.error ?? calendar.error;
  if (error || !query.data || !profile.data || !today) return <ErrorBanner error={error}/>;
  return <>
    <OverviewDashboard summary={query.data} wellness={wellness.data ?? []} history={history.data ?? []} planned={calendar.data ?? []} today={today} timezone={profile.data.timezone} adjustment={adjustment.data?.showReminder ? adjustment.data.assessment : undefined}/>
    <div className="overview-next-day" id="overview-next-day">{plan.data && !nextDay.isPending && nextDay.data ? <NextTrainingDayCard value={nextDay.data} plan={plan.data} /> : !plan.data ? <EmptyState title={tr("No current plan")} description="Plans are created by your connected AI Agent — build one to see your next training day here."/> : null}</div>
  </>;
}

function GoalTag({ goal, selected = true, onClick, onDelete }: { goal: string; selected?: boolean; onClick?: () => void; onDelete?: () => void }) {
  const className = `goal-tag ${goalTone(goal)} ${selected ? "selected" : ""}`;
  const content = <><span className="goal-dot" aria-hidden="true"/>{friendlyLabel(goal)}</>;
  if (!onClick) return <span className={className}>{content}</span>;
  const tag = <button type="button" className={className} aria-pressed={selected} onClick={onClick}>{content}</button>;
  return onDelete
    ? <span className="goal-tag-control">{tag}<button type="button" className="goal-delete" aria-label={`Delete ${friendlyLabel(goal)} goal`} onClick={onDelete}>×</button></span>
    : tag;
}

export function Profile() {
  const client = useQueryClient();
  const profileQuery = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile & { profileHash: string }>("/api/profile") });
  const personalQuery = useQuery({ queryKey: ["personal-information"], queryFn: () => api<PersonalInformation>("/api/personal-information") });
  const taxonomy = useQuery({ queryKey: ["training-taxonomy"], queryFn: () => api<TrainingTaxonomy>("/api/training-taxonomy") });
  const [editing, setEditing] = useState(false);
  const [editingProfileHash, setEditingProfileHash] = useState<string | null>(null);
  const [form, setForm] = useState<AthleteProfile | null>(null);
  const [personalForm, setPersonalForm] = useState<PersonalInformation | null>(null);
  const [unit, setUnit] = useState<UnitSystem>("metric");
  const [weightText, setWeightText] = useState("");
  const [weightChanged, setWeightChanged] = useState(false);
  const [feetText, setFeetText] = useState("");
  const [inchesText, setInchesText] = useState("");
  const [heightTouched, setHeightTouched] = useState(false);
  const [customGoal, setCustomGoal] = useState("");
  const [availableGoals, setAvailableGoals] = useState<string[]>(commonGoals);
  const [raceDraft, setRaceDraft] = useState(emptyRaceDraft);
  const [saved, setSaved] = useState(false);
  const profile = profileQuery.data;
  const save = useMutation({
    mutationFn: (value: { profile: AthleteProfile; personalInformation: Record<string, unknown>; expectedProfileHash: string | null }) => api<AthleteProfile>("/api/profile/complete", { method: "PUT", body: JSON.stringify(value) }),
    onSuccess: () => { setForm(null); setPersonalForm(null); setAvailableGoals(commonGoals); setRaceDraft(emptyRaceDraft); setEditing(false); setSaved(true); void Promise.all(["profile", "personal-information", "state", "wellness"].map((key) => client.invalidateQueries({ queryKey: [key] }))); },
    onError: () => { void Promise.all(["profile", "personal-information"].map((key) => client.invalidateQueries({ queryKey: [key] }))); },
  });
  useEffect(() => {
    if (!saved) return;
    const timeout = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(timeout);
  }, [saved]);
  if (profileQuery.isPending || taxonomy.isPending || personalQuery.isPending) return <Loading/>;
  if (profileQuery.isError || taxonomy.isError || personalQuery.isError) return <ErrorBanner error={profileQuery.error ?? taxonomy.error ?? personalQuery.error}/>;
  if (!profile || !taxonomy.data || !personalQuery.data) return <Loading/>;
  const personal = personalQuery.data;

  const toggleList = (field: "goals" | "equipment", value: string) => setForm((current) => current ? { ...current, [field]: current[field].includes(value) ? current[field].filter((item) => item !== value) : [...current[field], value] } : current);
  const toggleTrainingDay = (weekday: number) => setForm((current) => current?.trainingRhythm.kind === "fixed_week" ? { ...current, trainingRhythm: { ...current.trainingRhythm, days: current.trainingRhythm.days.includes(weekday) ? current.trainingRhythm.days.filter((day) => day !== weekday) : [...current.trainingRhythm.days, weekday].sort((a, b) => a - b) } } : current);
  const addRaceDay = () => {
    const sport = raceDraft.sport === RACE_SPORT_OTHER ? raceDraft.custom.trim() : raceDraft.sport;
    if (!raceDraft.date || !sport) return;
    setForm((current) => current ? { ...current, raceDays: [...current.raceDays, { date: raceDraft.date, sport }].sort((left, right) => left.date.localeCompare(right.date)) } : current);
    setRaceDraft(emptyRaceDraft);
  };
  const removeRaceDay = (index: number) => setForm((current) => current ? { ...current, raceDays: current.raceDays.filter((_, itemIndex) => itemIndex !== index) } : current);
  const beginEdit = () => { save.reset(); setSaved(false); setEditingProfileHash(profile.profileHash); setCustomGoal(""); setRaceDraft(emptyRaceDraft); setAvailableGoals([...new Set([...commonGoals, ...profile.goals])]); setForm({ ...profile, timezone: isUntouchedDefaultProfile(profile) ? deviceTimezone() : profile.timezone, goals: [...profile.goals], trainingRhythm: profile.trainingRhythm.kind === "fixed_week" ? { ...profile.trainingRhythm, days: [...profile.trainingRhythm.days] } : { ...profile.trainingRhythm }, equipment: [...profile.equipment], raceDays: profile.raceDays.map((race: RaceDay) => ({ ...race })).sort((left: RaceDay, right: RaceDay) => left.date.localeCompare(right.date)) }); setPersonalForm({ ...personal }); setUnit(personal.unitSystem); setWeightText(personal.weightKg == null ? "" : String(personal.unitSystem === "metric" ? personal.weightKg : kgToPounds(personal.weightKg))); setWeightChanged(false); const height = personal.heightCm == null ? null : cmToImperialHeight(personal.heightCm); setFeetText(height ? String(height.feet) : ""); setInchesText(height ? String(height.inches) : ""); setHeightTouched(false); setEditing(true); };
  const cancelEdit = () => { setForm(null); setPersonalForm(null); setCustomGoal(""); setRaceDraft(emptyRaceDraft); setAvailableGoals(commonGoals); setEditing(false); save.reset(); };
  const switchUnit = (next: UnitSystem) => {
    if (!personalForm || next === unit) return;
    if (next === "imperial") {
      const height = personalForm.heightCm == null ? null : cmToImperialHeight(personalForm.heightCm);
      setFeetText(height ? String(height.feet) : ""); setInchesText(height ? String(height.inches) : ""); setHeightTouched(false);
      setWeightText((text) => text.trim() ? String(kgToPounds(Number(text))) : text);
    } else {
      if (heightTouched) setPersonalForm({ ...personalForm, heightCm: feetText.trim() || inchesText.trim() ? imperialHeightToCm(Number(feetText) || 0, Number(inchesText) || 0) : null });
      setHeightTouched(false); setWeightText((text) => text.trim() ? String(poundsToKg(Number(text))) : text);
    }
    setUnit(next);
  };
  const heightCmDraft = !personalForm ? null : unit === "metric" || !heightTouched ? personalForm.heightCm : feetText.trim() || inchesText.trim() ? imperialHeightToCm(Number(feetText) || 0, Number(inchesText) || 0) : null;
  const weightKgDraft = unit === "metric" ? Number(weightText) : poundsToKg(Number(weightText));
  const personalValid = (heightCmDraft === null || (heightCmDraft >= 50 && heightCmDraft <= 250)) && (!weightChanged || !weightText.trim() || (weightKgDraft >= 20 && weightKgDraft <= 500)) && (!personalForm?.birthDate || personalForm.birthDate <= new Date().toISOString().slice(0, 10));
  const submit = () => {
    if (!form || !personalForm) return;
    const preferredName = personalForm.preferredName.trim();
    const profileValue = { ...profilePayload(profile, form), preferredName, gender: personalForm.gender, heightCm: heightCmDraft, birthDate: personalForm.birthDate, unitSystem: unit };
    const personalInformation: Record<string, unknown> = { preferredName, gender: personalForm.gender, heightCm: heightCmDraft, birthDate: personalForm.birthDate, unitSystem: unit, expectedSnapshotHash: personalForm.snapshotHash };
    if (weightChanged) personalInformation.weightKg = weightText.trim() ? weightKgDraft : null;
    setSaved(false); save.mutate({ profile: profileValue, personalInformation, expectedProfileHash: editingProfileHash });
  };

  const rhythmValid = !form || (form.trainingRhythm.kind === "fixed_week" ? form.trainingRhythm.days.length > 0 : form.trainingRhythm.kind === "flexible_week" ? form.trainingRhythm.minDaysPerWeek >= 1 && form.trainingRhythm.minDaysPerWeek <= form.trainingRhythm.targetDaysPerWeek && form.trainingRhythm.targetDaysPerWeek <= form.trainingRhythm.maxDaysPerWeek && form.trainingRhythm.maxDaysPerWeek <= 7 : form.trainingRhythm.intervalDays >= 1 && form.trainingRhythm.intervalDays <= 30);
  const raceDraftSport = raceDraft.sport === RACE_SPORT_OTHER ? raceDraft.custom.trim() : raceDraft.sport;
  const raceDraftValid = Boolean(raceDraft.date && raceDraftSport);
  const profileActions = editing && form ? <div className="profile-actions"><label className="profile-timezone-field"><AppIcon name="globe"/><select className="profile-timezone-select" aria-label={tr("Time zone")} value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })}>{timezoneOptions(form.timezone).map((zone) => <option key={zone} value={zone}>{zone}{zone === deviceTimezone() ? ` (${tr("device")})` : ""}</option>)}</select></label><button type="button" className="secondary compact profile-cancel-button" disabled={save.isPending} onClick={cancelEdit}><T>{"Cancel"}</T></button><button type="button" className="compact profile-save-button" disabled={save.isPending || form.goals.length === 0 || !rhythmValid || !personalValid} onClick={submit}>{tr(save.isPending ? "Saving…" : "Save")}</button></div> : <div className="profile-actions"><span className="profile-timezone-pill"><AppIcon name="globe"/>{formatTimezoneLabel(profile.timezone)}</span><button type="button" className="secondary compact edit-button" onClick={beginEdit}><AppIcon name="edit"/><T>{"Edit"}</T></button></div>;
  const personalSection = <PersonalInformationSection value={personal} form={personalForm} setForm={setPersonalForm} unit={unit} switchUnit={switchUnit} weightText={weightText} setWeightText={setWeightText} setWeightChanged={setWeightChanged} feetText={feetText} setFeetText={setFeetText} inchesText={inchesText} setInchesText={setInchesText} setHeightTouched={setHeightTouched}/>;

  return <div className="profile-page">
    <PrimaryPageHeader preferredName={profile.preferredName} subtitle="Your training preferences — saved for the long term and built into every plan."/>
    <Card title={<span className="profile-card-title"><span><T>{"Training Profile"}</T><small><T>{"Your training setup and preferences"}</T></small></span></span>} className={`profile-board ${editing ? "is-editing" : ""}`} action={profileActions}>
      {editing && form ? <EditableProfileBoard profile={profile} form={form} setForm={setForm} personalSection={personalSection} customGoal={customGoal} setCustomGoal={setCustomGoal} availableGoals={availableGoals} setAvailableGoals={setAvailableGoals} toggleList={toggleList} toggleTrainingDay={toggleTrainingDay} raceDraft={raceDraft} setRaceDraft={setRaceDraft} raceDraftValid={raceDraftValid} addRaceDay={addRaceDay} removeRaceDay={removeRaceDay}/> : <ProfileBoard profile={profile} equipmentCategories={taxonomy.data.equipmentCategories} personalSection={personalSection}/>}
      <ErrorBanner error={save.error}/>
      {saved && <div className="success"><T>{"Profile saved! Your current plan may be affected — ask your AI agent to review and update it to match your new profile."}</T></div>}
    </Card>
    {editing && form && <Card title={null} className="profile-equipment-board"><EquipmentSelector categories={taxonomy.data.equipmentCategories} selected={form.equipment} onToggleItem={(id) => toggleList("equipment", id)} onToggleGroup={(ids) => setForm((current) => current ? { ...current, equipment: toggleEquipmentGroup(current.equipment, ids) } : current)}/></Card>}
    <Card title={<span className="profile-card-title"><span><T>{"Agent Suggestions"}</T><small><T>{"Personalized guidance based on your profile"}</T></small></span></span>} className="profile-suggestions">
      <AgentManagedDetails profile={profile}/>
      <p className="profile-disclaimer"><AppIcon name="info"/><T>{"AI-generated planning suggestions only, not medical advice — consult a qualified professional for any injury, diagnosis, or treatment."}</T></p>
    </Card>
  </div>;
}

type PersonalSectionProps = {
  value: PersonalInformation;
  form: PersonalInformation | null;
  setForm: React.Dispatch<React.SetStateAction<PersonalInformation | null>>;
  unit: UnitSystem;
  switchUnit: (unit: UnitSystem) => void;
  weightText: string;
  setWeightText: React.Dispatch<React.SetStateAction<string>>;
  setWeightChanged: React.Dispatch<React.SetStateAction<boolean>>;
  feetText: string;
  setFeetText: React.Dispatch<React.SetStateAction<string>>;
  inchesText: string;
  setInchesText: React.Dispatch<React.SetStateAction<string>>;
  setHeightTouched: React.Dispatch<React.SetStateAction<boolean>>;
};

function FixedDateInput({ value, max, ariaLabel, onChange }: { value: string; max?: string; ariaLabel?: string; onChange: (value: string) => void }) {
  return <span className={`fixed-date-input${value ? " has-value" : ""}`}>
    <input type="date" max={max} aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}/>
    {!value && <span className="fixed-date-placeholder" aria-hidden="true">yyyy/mm/dd</span>}
  </span>;
}

export function PersonalInformationSection({ value, form, setForm, unit, switchUnit, weightText, setWeightText, setWeightChanged, feetText, setFeetText, inchesText, setInchesText, setHeightTouched }: PersonalSectionProps) {
  return <section className="profile-personal-section">
    <div className="profile-personal-heading"><span className="profile-feature-icon" aria-hidden="true"><AppIcon name="profile"/></span><span className="profile-personal-copy"><strong><T>{"Personal Information"}</T></strong><small><T>{"Manage your basic information."}</T></small></span>{!form && <span className="profile-personal-unit">{tr("Units")}: {tr(value.unitSystem === "metric" ? "Metric" : "Imperial")}</span>}</div>
    {form ? <div className="personal-information-form">
      <div className="unit-row"><span className="unit-label"><T>{"Units"}</T></span><span className="unit-switch" role="group" aria-label={tr("Measurement units")}><button type="button" className={unit === "metric" ? "active" : ""} aria-pressed={unit === "metric"} onClick={() => switchUnit("metric")}><T>{"Metric"}</T></button><button type="button" className={unit === "imperial" ? "active" : ""} aria-pressed={unit === "imperial"} onClick={() => switchUnit("imperial")}><T>{"Imperial"}</T></button></span></div>
      <label><span><T>{"Preferred name"}</T></span><input maxLength={100} value={form.preferredName} onChange={(event) => setForm({ ...form, preferredName: event.target.value })}/></label>
      <label><span><T>{"Gender"}</T></span><select value={form.gender ?? ""} onChange={(event) => setForm({ ...form, gender: (event.target.value || null) as PersonalInformation["gender"] })}><option value=""><T>{"Not specified"}</T></option><option value="female"><T>{"Female"}</T></option><option value="male"><T>{"Male"}</T></option><option value="non_binary"><T>{"Non-binary"}</T></option><option value="prefer_not_to_say"><T>{"Prefer not to say"}</T></option></select></label>
      <label><span><T>{"Height"}</T> <em>{unit === "metric" ? "cm" : "ft / in"}</em></span>{unit === "metric"
        ? <input type="number" min="50" max="250" step="0.1" value={form.heightCm ?? ""} onChange={(event) => setForm({ ...form, heightCm: event.target.value ? Number(event.target.value) : null })}/>
        : <div className="imperial-height"><span className="imperial-field"><input type="number" min="0" max="8" step="1" aria-label={tr("Height feet")} value={feetText} onChange={(event) => { setFeetText(event.target.value); setHeightTouched(true); }}/><em>ft</em></span><span className="imperial-field"><input type="number" min="0" max="11.9" step="0.1" aria-label={tr("Height inches")} value={inchesText} onChange={(event) => { setInchesText(event.target.value); setHeightTouched(true); }}/><em>in</em></span></div>}</label>
      <label><span><T>{"Weight"}</T> <em>{unit === "metric" ? "kg" : "lb"}</em></span><input type="number" min={unit === "metric" ? "20" : "44"} max={unit === "metric" ? "500" : "1103"} step="0.1" value={weightText} onChange={(event) => { setWeightText(event.target.value); setWeightChanged(true); }}/></label>
      <label><span><T>{"Birth date"}</T></span><FixedDateInput max={new Date().toISOString().slice(0, 10)} value={form.birthDate ?? ""} onChange={(birthDate) => setForm({ ...form, birthDate: birthDate || null })}/></label>
    </div> : <dl className="personal-information-summary"><div><dt><T>{"Preferred name"}</T></dt><dd>{displayPreferredName(value.preferredName)}</dd></div><div><dt><T>{"Gender"}</T></dt><dd>{value.gender ? friendlyLabel(value.gender) : "-"}</dd></div><div><dt><T>{"Height"}</T></dt><dd>{value.heightCm == null ? "-" : formatPersonalHeight(value.heightCm, value.unitSystem)}</dd></div><div><dt><T>{"Weight"}</T> {value.weightDate && <small>{value.weightDate}</small>}</dt><dd>{value.weightKg == null ? "-" : formatPersonalWeight(value.weightKg, value.unitSystem)}</dd></div><div><dt><T>{"Birth date"}</T></dt><dd>{value.birthDate ?? "-"}</dd></div></dl>}
  </section>;
}

function GroupCheckbox({ state, label, onChange }: { state: "none" | "some" | "all"; label: string; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = state === "some"; }, [state]);
  return <label className="equipment-group-toggle"><input ref={input} type="checkbox" checked={state === "all"} onChange={onChange}/><span>{label}</span></label>;
}

export function EquipmentSelector({ categories, selected, onToggleItem, onToggleGroup }: { categories: EquipmentCategory[]; selected: string[]; onToggleItem?: (id: string) => void; onToggleGroup?: (ids: string[]) => void }) {
  const editable = Boolean(onToggleItem && onToggleGroup);
  const visibleCategories = editable ? categories : categories.map((category) => ({ ...category, groups: category.groups.map((group) => ({ ...group, items: group.items.filter((item) => selected.includes(item.id)) })).filter((group) => group.items.length) })).filter((category) => category.groups.length);
  return <section className={`profile-section equipment-section${editable ? "" : " readonly-equipment"}`}><div className="profile-section-heading"><AppIcon name="equipment"/><span><strong><T>{"Available Equipment"}</T></strong><small><T>{"Select equipment available to you"}</T></small></span></div>{visibleCategories.length ? <div className="equipment-categories">{visibleCategories.map((category) => <section className="equipment-category" key={category.id}><h3>{tr(category.label)}</h3><div className="equipment-groups">{category.groups.map((group) => {
    const ids = group.items.map((item) => item.id);
    return <div className="equipment-group" key={group.id}>{editable && onToggleGroup ? <GroupCheckbox state={equipmentGroupState(selected, ids)} label={tr(group.label === category.label ? "Select all" : group.label)} onChange={() => onToggleGroup(ids)}/> : <h4>{tr(group.label === category.label ? "Equipment" : group.label)}</h4>}<div className="equipment-items">{group.items.map((item) => {
      const isSelected = selected.includes(item.id);
      if (!editable) return <span className="equipment-item selected" key={item.id}>{tr(item.label)}</span>;
      return isSelected
        ? <span className="equipment-item selected" key={item.id}><span>{tr(item.label)}</span><button type="button" aria-label={`${tr("Remove")} ${tr(item.label)}`} onClick={() => onToggleItem?.(item.id)}>×</button></span>
        : <button type="button" className="equipment-item available" key={item.id} onClick={() => onToggleItem?.(item.id)}>+ {tr(item.label)}</button>;
    })}</div></div>;
  })}</div></section>)}</div> : <span className="muted-tag"><T>{"None"}</T></span>}</section>;
}

export function EditableProfileBoard({ profile, form, setForm, personalSection, customGoal, setCustomGoal, availableGoals, setAvailableGoals, toggleList, toggleTrainingDay, raceDraft, setRaceDraft, raceDraftValid, addRaceDay, removeRaceDay }: { profile: AthleteProfile; form: AthleteProfile; setForm: React.Dispatch<React.SetStateAction<AthleteProfile | null>>; personalSection?: React.ReactNode; customGoal: string; setCustomGoal: React.Dispatch<React.SetStateAction<string>>; availableGoals: string[]; setAvailableGoals: React.Dispatch<React.SetStateAction<string[]>>; toggleList: (field: "goals" | "equipment", value: string) => void; toggleTrainingDay: (weekday: number) => void; raceDraft: { date: string; sport: string; custom: string }; setRaceDraft: React.Dispatch<React.SetStateAction<{ date: string; sport: string; custom: string }>>; raceDraftValid: boolean; addRaceDay: () => void; removeRaceDay: (index: number) => void }) {
  const deleteCustomGoal = (goal: string) => {
    setAvailableGoals((current) => current.filter((item) => item !== goal));
    setForm((current) => current ? { ...current, goals: current.goals.filter((item) => item !== goal) } : current);
  };
  const changeRhythm = (kind: AthleteProfile["trainingRhythm"]["kind"]) => setForm((current) => current ? { ...current, trainingRhythm: kind === "fixed_week" ? { kind, days: [0, 2, 4] } : kind === "flexible_week" ? { kind, targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 } : { kind, intervalDays: 2 } } : current);
  const updateFlexibleRhythm = (field: "targetDaysPerWeek" | "minDaysPerWeek" | "maxDaysPerWeek", value: number) => setForm((current) => {
    if (current?.trainingRhythm.kind !== "flexible_week") return current;
    const rhythm = { ...current.trainingRhythm, [field]: value };
    if (field === "targetDaysPerWeek") { rhythm.minDaysPerWeek = Math.min(rhythm.minDaysPerWeek, value); rhythm.maxDaysPerWeek = Math.max(rhythm.maxDaysPerWeek, value); }
    if (field === "minDaysPerWeek") { rhythm.targetDaysPerWeek = Math.max(rhythm.targetDaysPerWeek, value); rhythm.maxDaysPerWeek = Math.max(rhythm.maxDaysPerWeek, value); }
    if (field === "maxDaysPerWeek") { rhythm.targetDaysPerWeek = Math.min(rhythm.targetDaysPerWeek, value); rhythm.minDaysPerWeek = Math.min(rhythm.minDaysPerWeek, value); }
    return { ...current, trainingRhythm: rhythm };
  });
  const updateIntervalRhythm = (intervalDays: number) => setForm((current) => current?.trainingRhythm.kind === "interval" ? { ...current, trainingRhythm: { ...current.trainingRhythm, intervalDays } } : current);
  return <div className="profile-content profile-editor">
    <section className="profile-top-summary">
      {personalSection}
      <section className="profile-goals-panel"><div className="editable-panel-content"><strong className="profile-editor-title"><T>{"Training Goals"}</T></strong><div className="goal-tags">{availableGoals.map((goal) => commonGoals.includes(goal) ? <GoalTag key={goal} goal={goal} selected={form.goals.includes(goal)} onClick={() => toggleList("goals", goal)}/> : <GoalTag key={goal} goal={goal} selected={form.goals.includes(goal)} onClick={() => toggleList("goals", goal)} onDelete={() => deleteCustomGoal(goal)}/>)}</div><div className="inline-input"><input aria-label={tr("Custom training goal")} placeholder={tr("Add another goal")} value={customGoal} onChange={(event) => setCustomGoal(event.target.value)}/><button type="button" className="secondary" disabled={!customGoal.trim()} onClick={() => { const goal = customGoal.trim(); setAvailableGoals((current) => current.includes(goal) ? current : [...current, goal]); setForm((current) => current && !current.goals.includes(goal) ? { ...current, goals: [...current.goals, goal] } : current); setCustomGoal(""); }}><T>{"Add"}</T></button></div></div></section>
      <div className="profile-summary-item profile-preferences-editor"><div className="profile-editor-heading"><span><strong className="profile-editor-title"><T>{"Preferences"}</T></strong><small className="profile-editor-subtitle"><T>{"Tell us more about your training"}</T></small></span></div><label className="profile-editor-control"><span className="sr-only"><T>{"Training preferences"}</T></span><span className="preference-input"><textarea aria-label={tr("Training preferences")} rows={4} maxLength={PREFERENCE_MAX_LENGTH} value={form.preference} onChange={(event) => setForm({ ...form, preference: event.target.value })} placeholder={tr("I prefer a varied mix of training styles.")}/><small>{form.preference.length}/{PREFERENCE_MAX_LENGTH}</small></span></label></div>
      <div className="profile-summary-item profile-race-editor"><div className="race-days-editor">
        <div className="profile-editor-heading"><span><strong className="profile-editor-title"><T>{"Race Days"}</T></strong><small className="profile-editor-subtitle"><T>{"Target races and events"}</T></small></span></div>
        {form.raceDays.length > 0 && <div className="race-list">{form.raceDays.map((race, index) => <div className="race-row" key={`${race.date}-${index}`}><span title={`${formatRaceDateShort(race.date)} · ${RACE_SPORT_PRESETS.includes(race.sport) ? tr(race.sport) : race.sport}`}>{formatRaceDateShort(race.date)} · {RACE_SPORT_PRESETS.includes(race.sport) ? tr(race.sport) : race.sport}</span><button type="button" aria-label={`Remove ${race.sport} on ${formatRaceDateShort(race.date)}`} onClick={() => removeRaceDay(index)}>×</button></div>)}</div>}
        <div className="race-inline-input">
          <FixedDateInput ariaLabel={tr("Race date")} value={raceDraft.date} onChange={(date) => setRaceDraft((draft) => ({ ...draft, date }))}/>
          <select aria-label={tr("Race sport")} value={raceDraft.sport} onChange={(event) => setRaceDraft((draft) => ({ ...draft, sport: event.target.value }))}><option value=""><T>{"Select…"}</T></option>{RACE_SPORT_PRESETS.map((sport) => <option key={sport} value={sport}>{tr(sport)}</option>)}<option value={RACE_SPORT_OTHER}><T>{"Other…"}</T></option></select>
          {raceDraft.sport === RACE_SPORT_OTHER && <input type="text" aria-label={tr("Race name")} maxLength={80} placeholder={tr("Race name")} value={raceDraft.custom} onChange={(event) => setRaceDraft((draft) => ({ ...draft, custom: event.target.value }))}/>}
          <button type="button" className="secondary" disabled={!raceDraftValid} onClick={addRaceDay}>+ {tr("Add race")}</button>
        </div>
      </div></div>
      <div className="profile-summary-item profile-rhythm-editor"><div className="profile-editor-heading"><span><strong className="profile-editor-title"><T>{"Training Rhythm"}</T></strong><small className="profile-editor-subtitle"><T>{"How often do you want to train?"}</T></small></span></div><div className="profile-rhythm-options">
        <div className="profile-rhythm-option"><label><input type="radio" name="training-rhythm" checked={form.trainingRhythm.kind === "fixed_week"} onChange={() => changeRhythm("fixed_week")}/><span><T>{"Fixed week"}</T></span></label>{form.trainingRhythm.kind === "fixed_week" && <div className="day-list">{localizedWeekdays().map((day, index) => <button type="button" key={index} className={form.trainingRhythm.kind === "fixed_week" && form.trainingRhythm.days.includes(index) ? "selected" : ""} aria-pressed={form.trainingRhythm.kind === "fixed_week" && form.trainingRhythm.days.includes(index)} onClick={() => toggleTrainingDay(index)}>{currentLanguage() === "en" ? day.slice(0, 3) : day.replace(/^星期/, "")}</button>)}</div>}</div>
        <div className="profile-rhythm-option"><label><input type="radio" name="training-rhythm" checked={form.trainingRhythm.kind === "flexible_week"} onChange={() => changeRhythm("flexible_week")}/><span><T>{"Flexible week"}</T></span></label>{form.trainingRhythm.kind === "flexible_week" && <div className="rhythm-parameters"><label><T>{"Target days"}</T><input type="number" min="1" max="7" value={form.trainingRhythm.targetDaysPerWeek} onChange={(event) => updateFlexibleRhythm("targetDaysPerWeek", Number(event.target.value))}/></label><label><T>{"Min"}</T><input type="number" min="1" max="7" value={form.trainingRhythm.minDaysPerWeek} onChange={(event) => updateFlexibleRhythm("minDaysPerWeek", Number(event.target.value))}/></label><label><T>{"Max"}</T><input type="number" min="1" max="7" value={form.trainingRhythm.maxDaysPerWeek} onChange={(event) => updateFlexibleRhythm("maxDaysPerWeek", Number(event.target.value))}/></label></div>}</div>
        <div className="profile-rhythm-option"><label><input type="radio" name="training-rhythm" checked={form.trainingRhythm.kind === "interval"} onChange={() => changeRhythm("interval")}/><span><T>{"Intervals"}</T></span></label>{form.trainingRhythm.kind === "interval" && <span className="interval-parameter"><T>{"Every"}</T> <input aria-label={tr("Interval days")} type="number" min="1" max="30" value={form.trainingRhythm.intervalDays} onChange={(event) => updateIntervalRhythm(Number(event.target.value))}/> <T>{"days"}</T></span>}</div>
      </div></div>
      <div className="profile-summary-item profile-duration-editor profile-max-session"><div className="profile-editor-heading"><span><strong className="profile-editor-title"><T>{"Max Session Length"}</T></strong><small className="profile-editor-subtitle"><T>{"How much time per session?"}</T></small></span></div><label className="profile-editor-control"><span className="sr-only"><T>{"Max Session Length"}</T></span><select aria-label={tr("Max Session Length")} value={form.maxSessionMinutes} onChange={(event) => setForm({ ...form, maxSessionMinutes: Number(event.target.value) })}>{[15, 30, 45, 60, 75, 90, 120, 180, 240].map((value) => <option key={value} value={value}>{value} {currentLanguage() === "zh-CN" ? "分钟" : "min"}</option>)}</select></label></div>
      <div className="profile-summary-item profile-duration-editor profile-mesocycle"><div className="profile-editor-heading"><span><strong className="profile-editor-title"><T>{"Mesocycle Length"}</T></strong><small className="profile-editor-subtitle"><T>{"How long should a mesocycle be?"}</T></small></span></div><label className="profile-editor-control"><span className="sr-only"><T>{"Mesocycle Length"}</T></span><select aria-label={tr("Mesocycle Length")} value={form.mesocycleDurationWeeks} onChange={(event) => setForm({ ...form, mesocycleDurationWeeks: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value} {tr(value === 1 ? "week" : "weeks")}</option>)}</select></label></div>
    </section>
  </div>;
}

export function AgentManagedDetails({ profile }: { profile: AthleteProfile }) {
  const rows: Array<{ label: string; description: string; icon: IconName; value?: string; notes?: string[]; tone?: "danger" | "caution" }> = [];
  if (profile.injuries.length) rows.push({ label: "Injuries", description: "These are taken into account when planning your training.", icon: "warning", notes: profile.injuries, tone: "danger" });
  if (profile.constraintNotes.length) rows.push({ label: "Constraint Notes", description: "These help guide exercise selection and programming.", icon: "notes", notes: profile.constraintNotes, tone: "caution" });
  if (profile.explicitRecoveryDays !== null) rows.push({ label: "Recovery Interval", description: "This guides spacing between demanding sessions.", icon: "recovery", value: `${profile.explicitRecoveryDays} day${profile.explicitRecoveryDays === 1 ? "" : "s"} between hard sessions` });
  if (profile.raceDays.length) {
    const today = localDateForTimezone(profile.timezone);
    const nextRace = nextRaceDay(profile.raceDays, today);
    const count = `${profile.raceDays.length} ${profile.raceDays.length === 1 ? "race" : "races"}`;
    rows.push({ label: "Race Focus", description: "Target races shape peaking and tapering in your plan.", icon: "trophy", value: nextRace ? `${count} on record. Next: ${nextRace.sport} on ${formatRaceDateShort(nextRace.date)}.` : `${count} on record, none upcoming.` });
  }
  if (!rows.length) return <EmptyState title={tr("No injuries or training constraints recorded.")}/>;
  return <div className="agent-managed-grid">{rows.map((row) => <article className="agent-managed-card" key={row.label}><span className={"agent-card-icon" + (row.tone ? " " + row.tone : "")}><AppIcon name={row.icon}/></span><div><strong>{row.label}</strong><p>{row.description}</p>{row.notes ? <ol className="agent-note-list">{row.notes.map((note, index) => <li key={index}>{note}</li>)}</ol> : <span className="agent-value">{row.value}</span>}</div></article>)}</div>;
}

export function ProfileBoard({ profile, equipmentCategories, personalSection }: { profile: AthleteProfile; equipmentCategories: EquipmentCategory[]; personalSection?: React.ReactNode }) {
  const today = localDateForTimezone(profile.timezone);
  const upcomingRaces = profile.raceDays.filter((race) => race.date >= today).sort((left, right) => left.date.localeCompare(right.date));
  const visibleRaces = upcomingRaces.slice(0, 3);
  return <div className="profile-content">
    <section className="profile-top-summary profile-readonly-summary">
      {personalSection}
      <section className="profile-goals-panel"><div><strong className="profile-editor-title"><T>{"Training Goals"}</T></strong>{profile.goals.length ? <div className="goal-tags">{profile.goals.map((goal) => <GoalTag key={goal} goal={goal}/>)}</div> : <p><T>{"No goals selected"}</T></p>}</div></section>
      <div className="profile-summary-item profile-preferences-summary"><div><span><T>{"Preferences"}</T></span>{profile.preference ? <strong>{profile.preference}</strong> : <p className="race-empty">{tr("Not set")}</p>}</div></div>
      <div className="profile-summary-item profile-race-summary"><div><span><T>{"Race Days"}</T></span>{visibleRaces.length ? <><div className="race-summary-list">{visibleRaces.map((race, index) => <div className="race-summary-row" key={`${race.date}-${index}`}><strong>{formatRaceDateShort(race.date)} · {RACE_SPORT_PRESETS.includes(race.sport) ? tr(race.sport) : race.sport}</strong><em className="race-countdown">{formatRaceCountdown(race.date, today)}</em></div>)}</div>{upcomingRaces.length > visibleRaces.length && <small className="race-more">+{upcomingRaces.length - visibleRaces.length} more scheduled</small>}</> : <p className="race-empty"><T>{"No upcoming races"}</T></p>}</div></div>
      <div className="profile-summary-item profile-rhythm-summary"><div><span><T>{"Training Rhythm"}</T></span><strong>{formatTrainingRhythm(profile.trainingRhythm)}</strong></div></div>
      <div className="profile-summary-item profile-max-session"><div><span><T>{"Max Session Length"}</T></span><strong>{profile.maxSessionMinutes} min</strong></div></div>
      <div className="profile-summary-item profile-mesocycle"><div><span><T>{"Mesocycle Length"}</T></span><strong>{profile.mesocycleDurationWeeks} {tr(profile.mesocycleDurationWeeks === 1 ? "week" : "weeks")}</strong></div></div>
    </section>
    <EquipmentSelector categories={equipmentCategories} selected={profile.equipment}/>
  </div>;
}

type ConnectionSource = "hevy" | "intervals" | "xunji";
type ConnectionDialog = ConnectionSource | null;

const providerLogos: Record<ConnectionSource, string> = { hevy: hevyLogo, intervals: intervalsLogo, xunji: xunjiLogo };

function ProviderLogo({ source }: { source: ConnectionSource }) {
  return <span className={`provider-logo ${source}-logo`} aria-hidden="true"><img src={providerLogos[source]} alt=""/></span>;
}

function SourceCard({ source, title, description, lastSyncLabel, lastSync, action, menuLabel, onMenuAction, feedback }: { source: ConnectionSource; title: string; description: string; lastSyncLabel: string; lastSync: string; action: React.ReactNode; menuLabel: string; onMenuAction: () => void; feedback?: React.ReactNode }) {
  return <article className="source-card"><div className="source-card-main"><ProviderLogo source={source}/><div className="source-title"><div><h2>{title}</h2></div><p>{tr(description)}</p></div><Metric icon="clock" label={lastSyncLabel} value={lastSync}/></div>{feedback}<footer>{action}<details className="source-menu"><summary aria-label={`${tr("More options for")} ${title}`}>•••</summary><div><button type="button" onClick={onMenuAction}>{tr(menuLabel)}</button></div></details></footer></article>;
}

function SyncRangeSelect({ label, value, options, onChange }: { label: string; value: SyncRange; options: typeof syncRangeOptions; onChange: (value: string) => void }) {
  const selectedLabel = tr(options.find((option) => option.value === value)?.label ?? "Sync range");
  return <div className="sync-range-control"><span aria-hidden="true">{selectedLabel}</span><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{tr(option.label)}</option>)}</select></div>;
}

type IntervalsFailure = { activityId: string; reason: string };
type IntervalsSyncResult = ImportResult & { sync?: { status?: string }; failedDates?: Array<{ date: string; failures: IntervalsFailure[] }>; undatedFailures?: IntervalsFailure[] };

export function IntervalsSyncIssues({ report }: { report: IntervalsSyncResult }) {
  const failedDates = report.failedDates ?? [];
  const undated = report.undatedFailures ?? [];
  const endpoints = Object.entries(report.errors ?? {});
  if (!failedDates.length && !undated.length && !endpoints.length) return null;
  return <div className="source-feedback warning-list" role="status"><strong>{tr("Some Intervals.icu data could not be imported")}</strong><ul className="sync-issue-list">
    {failedDates.map(({ date, failures }) => <li key={date}><strong>{date}</strong>: {failures.map(({ activityId, reason }) => `${tr("Activity")} ${activityId}: ${tr(reason)}`).join("; ")}</li>)}
    {undated.map(({ activityId, reason }, index) => <li key={`undated-${index}`}><strong>{tr("Unknown date")}</strong>: {tr("Activity")} {activityId}: {tr(reason)}</li>)}
    {endpoints.map(([source, reason]) => <li key={source}><strong>{source}</strong>: {reason}</li>)}
  </ul><small>{tr("Select a longer range to retry skipped dates.")}</small></div>;
}

export function XunjiSyncIssues({ sync }: { sync: XunjiConnectionStatus["sync"] }) {
  if (!sync || sync.status === "success") return null;
  const errors = sync.data.errors ?? [];
  const reasons = [...new Set(errors.map((error) => error.message).filter(Boolean))];
  return <div className="source-feedback warning-list" role="status"><strong>{tr("SynFit sync issues")}</strong><div>{tr("Failed days")}: {sync.data.failedDays ?? errors.length}</div>{reasons.length > 0 && <ul className="sync-issue-list">{reasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}</ul>}</div>;
}

function Metric({ icon, label, value }: { icon: "clock" | "database" | "upload"; label: string; value: string }) {
  return <div className="source-metric"><AppIcon name={icon}/><div><span>{tr(label)}</span><strong title={tr(value)}>{tr(value)}</strong></div></div>;
}

function AvailableSourceCard({ source, title, description, onConnect }: { source: ConnectionSource; title: string; description: string; onConnect: () => void }) {
  return <article className="available-source-card" role="button" tabIndex={0} aria-label={`${tr("Connect")} ${title}`} onClick={onConnect} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onConnect(); } }}><ProviderLogo source={source}/><div><h3>{title}</h3><p>{tr(description)}</p></div><span className="available-source-arrow" aria-hidden="true">›</span></article>;
}

function ConnectionModal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="connection-modal" role="dialog" aria-modal="true" aria-labelledby="connection-modal-title"><header><div><h2 id="connection-modal-title">{tr(title)}</h2>{description && <p>{tr(description)}</p>}</div><button type="button" className="modal-close" aria-label={tr("Close dialog")} onClick={onClose}><AppIcon name="close"/></button></header><div className="modal-body">{children}</div></section></div>;
}

function Connections() {
  const client = useQueryClient();
  const hevyStatus = useQuery({ queryKey: ["hevy-status"], queryFn: () => api<HevyImportStatus | null>("/api/imports/hevy/status") });
  const intervalsStatus = useQuery({ queryKey: ["intervals-status"], queryFn: getIntervalsStatus });
  const xunjiStatus = useQuery({ queryKey: ["xunji-status"], queryFn: () => getXunjiStatus<XunjiConnectionStatus>() });
  const [dialog, setDialog] = useState<ConnectionDialog>(null); const [xunjiSkill, setXunjiSkill] = useState("");
  const [preview, setPreview] = useState<ImportPreview>(); const [importResult, setImportResult] = useState<ImportResult>();
  const [hevyError, setHevyError] = useState<unknown>(); const [intervalsError, setIntervalsError] = useState<unknown>();
  const [intervalsMessage, setIntervalsMessage] = useState(""); const [intervalsBusy, setIntervalsBusy] = useState(false);
  const [intervalsReport, setIntervalsReport] = useState<IntervalsSyncResult>();
  const [xunjiError, setXunjiError] = useState<unknown>(); const [xunjiMessage, setXunjiMessage] = useState(""); const [xunjiBusy, setXunjiBusy] = useState(false);
  const [intervalsRange, setIntervalsRange] = useState<SyncRange>("incremental"); const [xunjiRange, setXunjiRange] = useState<SyncRange>(90);
  const [key, setKey] = useState(""); const [athleteId, setAthleteId] = useState("0");
  const onFile = async (file: File) => { try { setHevyError(undefined); setImportResult(undefined); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; bytes.forEach((byte) => { binary += String.fromCharCode(byte); }); setPreview(await api<ImportPreview>("/api/imports/hevy/preview", { method: "POST", body: JSON.stringify({ fileName: file.name, contentBase64: btoa(binary) }) })); } catch (value) { setHevyError(value); } };
  const closeDialog = () => { setDialog(null); setPreview(undefined); setXunjiSkill(""); setKey(""); setHevyError(undefined); setIntervalsError(undefined); setXunjiError(undefined); };
  useModalDismiss(closeDialog, Boolean(dialog));
  const openIntervals = () => { setAthleteId(intervalsStatus.data?.athleteId ?? "0"); setIntervalsMessage(""); setDialog("intervals"); };
  const commit = async () => { if (!preview?.previewToken) return; try { setHevyError(undefined); setImportResult(await api<ImportResult>("/api/imports/hevy/commit", { method: "POST", body: JSON.stringify({ previewToken: preview.previewToken }) })); setPreview(undefined); setDialog(null); await client.invalidateQueries({ queryKey: ["hevy-status"] }); } catch (value) { setHevyError(value); } };
  const saveIntervals = async () => { try { setIntervalsError(undefined); await testIntervals(key, athleteId); setIntervalsMessage("Connected. Your credentials were saved securely on this device."); setIntervalsReport(undefined); setKey(""); setDialog(null); await client.invalidateQueries({ queryKey: ["intervals-status"] }); } catch (value) { setIntervalsError(value); } };
  const sync = async (range: SyncRange) => { try { setIntervalsBusy(true); setIntervalsError(undefined); setIntervalsMessage(""); setIntervalsReport(undefined); const result = await syncIntervals(range) as IntervalsSyncResult; setIntervalsMessage(`Sync ${result.sync?.status ?? "complete"}: ${result.added ?? 0} added, ${result.updated ?? 0} updated.`); setIntervalsReport(result); await Promise.all([client.invalidateQueries({ queryKey: ["intervals-status"] }), client.invalidateQueries({ queryKey: ["sessions"] }), client.invalidateQueries({ queryKey: ["summary"] }), client.invalidateQueries({ queryKey: ["state"] })]); } catch (value) { setIntervalsError(value); } finally { setIntervalsBusy(false); } };
  const refreshXunjiViews = async () => { await Promise.all([client.invalidateQueries({ queryKey: ["xunji-status"] }), client.invalidateQueries({ queryKey: ["sessions"] }), client.invalidateQueries({ queryKey: ["summary"] }), client.invalidateQueries({ queryKey: ["state"] })]); };
  const connectXunji = async () => { try { setXunjiBusy(true); setXunjiError(undefined); if (xunji?.configured) { await testXunjiSkill(xunjiSkill); setXunjiMessage(tr("Connection updated. Your credentials were saved securely on this device.")); } else { const result = await importXunjiSkill(xunjiSkill, xunjiRange) as ImportResult & { sync?: { status?: string } }; setXunjiMessage(`Sync ${result.sync?.status ?? "complete"}: ${result.added ?? 0} added, ${result.updated ?? 0} updated.`); } setXunjiSkill(""); setDialog(null); await refreshXunjiViews(); } catch (value) { setXunjiError(value); } finally { setXunjiBusy(false); } };
  const runXunjiSync = async (range: SyncRange) => { try { setXunjiBusy(true); setXunjiError(undefined); const result = await syncXunji(range) as ImportResult & { sync?: { status?: string } }; setXunjiMessage(`Sync ${result.sync?.status ?? "complete"}: ${result.added ?? 0} added, ${result.updated ?? 0} updated.`); await refreshXunjiViews(); } catch (value) { setXunjiError(value); } finally { setXunjiBusy(false); } };
  const disconnect = async (source: "intervals" | "xunji") => {
    if (!window.confirm(`Disconnect ${source === "intervals" ? "Intervals.icu" : "SynFit"}? The encrypted API key will be removed.`)) return;
    try { await disconnectConnection(source); setDialog(null); await client.invalidateQueries({ queryKey: [source === "intervals" ? "intervals-status" : "xunji-status"] }); }
    catch (value) { source === "intervals" ? setIntervalsError(value) : setXunjiError(value); }
  };
  const intervals = intervalsStatus.data; const xunji = xunjiStatus.data;
  const sources = connectionSources(Boolean(intervals?.configured), Boolean(xunji?.configured));
  return <section className="connections-page">
    <section className="connections-section"><h2><T>{"Connected"}</T> ({sources.added.length})</h2><div className="connected-sources-grid">
      {intervals?.configured && <SourceCard source="intervals" title="Intervals.icu" description="Endurance activities and performance metrics." lastSyncLabel="Last synced" lastSync={intervals.sync?.lastSuccessAt ? formatDateTime(intervals.sync.lastSuccessAt) : "Not yet completed"} feedback={<><ErrorBanner error={intervalsStatus.error ?? intervalsError}/>{intervalsMessage && <div className={`source-feedback ${intervalsReport?.sync?.status === "partial" ? "warning-list" : "success"}`}>{intervalsMessage}</div>}{intervalsReport && <IntervalsSyncIssues report={intervalsReport}/>}</>} action={<div className="sync-controls"><SyncRangeSelect label={tr("Intervals.icu sync range")} value={intervalsRange} options={syncRangeOptions} onChange={(value) => setIntervalsRange(parseSyncRange(value))}/><button type="button" className="source-action primary" disabled={intervalsBusy || intervals.locked} onClick={() => void sync(intervalsRange)}><AppIcon name="refresh"/>{tr(intervals.locked ? "Database locked" : intervalsBusy ? "Syncing…" : "Sync now")}</button></div>} menuLabel="Edit connection" onMenuAction={openIntervals}/>}
      {xunji?.configured && <SourceCard source="xunji" title="SynFit" description="Strength and training records" lastSyncLabel="Last synced" lastSync={xunji.sync?.lastSuccessAt ? formatDateTime(xunji.sync.lastSuccessAt) : "Not yet completed"} feedback={<><ErrorBanner error={xunjiStatus.error ?? xunjiError}/>{xunjiMessage && <div className={`source-feedback ${xunji.sync?.status === "failed" || xunji.sync?.status === "partial" ? "warning-list" : "success"}`}>{xunjiMessage}</div>}<XunjiSyncIssues sync={xunji.sync ?? null}/></>} action={<div className="sync-controls"><SyncRangeSelect label={tr("SynFit sync range")} value={xunjiRange} options={syncRangeOptions.filter((option) => option.value !== "incremental")} onChange={(value) => setXunjiRange(parseSyncRange(value))}/><button type="button" className="source-action primary" disabled={xunjiBusy || xunji.locked} onClick={() => void runXunjiSync(xunjiRange)}><AppIcon name="refresh"/>{tr(xunji.locked ? "Database locked" : xunjiBusy ? "Syncing…" : "Sync now")}</button></div>} menuLabel="Edit connection" onMenuAction={() => setDialog("xunji")}/>}
      {!intervalsStatus.isPending && !xunjiStatus.isPending && sources.added.length === 0 && <EmptyState title={tr("No connections yet")} description="Choose one of the available connections below to get started."/>}
    </div></section>
    <section className="connections-section available-connections"><h2><T>{"Available Connections"}</T></h2>{sources.available.length ? <div className="available-sources-grid">
      {sources.available.includes("intervals") && <AvailableSourceCard source="intervals" title="Intervals.icu" description="Sync endurance activities and wellness data." onConnect={openIntervals}/>}
      {sources.available.includes("xunji") && <AvailableSourceCard source="xunji" title="SynFit" description="Sync strength and training records." onConnect={() => { setXunjiRange(90); setDialog("xunji"); }}/>}
    </div> : <EmptyState title={tr("All supported connections are connected")} description="Manage or sync them from the cards above."/>}</section>
    {dialog === "intervals" && <ConnectionModal title={intervals?.configured ? "Edit Intervals.icu" : "Connect Intervals.icu"} description="The API key is encrypted inside this database." onClose={closeDialog}><label><T>{"API key"}</T><input type="password" autoComplete="off" autoFocus placeholder={tr(intervals?.configured ? "Enter a new key to replace the saved key" : "Enter API key")} value={key} onChange={(event) => setKey(event.target.value)}/></label><label><T>{"Athlete ID"}</T><input value={athleteId} onChange={(event) => setAthleteId(event.target.value)}/></label><p className="helper intervals-helper">{tr("Find your API key and Athlete ID in")} <a href="https://intervals.icu" className="intervals-link" aria-label="Intervals.icu" onClick={(event) => { event.preventDefault(); void openIntervalsWebsite(); }}>Intervals.icu<span aria-hidden="true"> ↗</span></a>{tr("→ Settings → Developer Settings.")}</p><ErrorBanner error={intervalsError}/><div className="modal-actions">{intervals?.configured && <button type="button" className="danger-text" onClick={() => void disconnect("intervals")}><T>{"Disconnect"}</T></button>}<button type="button" className="secondary" onClick={closeDialog}><T>{"Cancel"}</T></button><button type="button" disabled={!key} onClick={() => void saveIntervals()}><T>{"Test and save"}</T></button></div></ConnectionModal>}
    {dialog === "xunji" && <ConnectionModal title={xunji?.configured ? "Edit SynFit" : "Connect SynFit"} description="Paste the complete training-data Skill exported by SynFit." onClose={closeDialog}><label><T>{"SynFit exported Skill"}</T><textarea rows={8} autoComplete="off" autoFocus spellCheck={false} placeholder={tr("Paste the complete Skill exported by SynFit")} value={xunjiSkill} onChange={(event) => setXunjiSkill(event.target.value)}/></label>{!xunji?.configured && <label><T>{"Sync range"}</T><select aria-label={tr("SynFit sync range")} value={xunjiRange} onChange={(event) => setXunjiRange(parseSyncRange(event.target.value))}>{syncRangeOptions.filter((option) => option.value !== "incremental").map((option) => <option key={option.value} value={option.value}>{tr(option.label)}</option>)}</select></label>}<p className="helper"><T>{"In SynFit, go to Me → Data Export and Import → Training → Copy Training Skill, then paste it above."}</T></p><ErrorBanner error={xunjiError}/><div className="modal-actions">{xunji?.configured && <button type="button" className="danger-text" onClick={() => void disconnect("xunji")}><T>{"Disconnect"}</T></button>}<button type="button" className="secondary" onClick={closeDialog}><T>{"Cancel"}</T></button><button type="button" disabled={!xunjiSkill.trim() || xunjiBusy} onClick={() => void connectXunji()}>{tr(xunjiBusy ? xunji?.configured ? "Testing and saving…" : "Connecting and syncing…" : xunji?.configured ? "Test and save" : "Connect and sync")}</button></div></ConnectionModal>}
    {dialog === "hevy" && <ConnectionModal title={tr("Import from Hevy")} description="Select a CSV export, review it, then import the workouts." onClose={closeDialog}><label><T>{"Hevy CSV export"}</T><input type="file" accept=".csv,text/csv" onChange={(event) => event.target.files?.[0] && void onFile(event.target.files[0])}/></label>{preview && <ImportSummary value={preview}><button type="button" onClick={() => void commit()}><T>{"Import reviewed workouts"}</T></button></ImportSummary>}<ErrorBanner error={hevyError}/></ConnectionModal>}
  </section>;
}

function MiniStats({ counts }: { counts: { sessions?: number; sets?: number; rows?: number } }) {
  return <div className="mini-stats"><span>{counts.sessions ?? 0}<small>workouts</small></span><span>{counts.sets ?? 0}<small>sets</small></span><span>{counts.rows ?? 0}<small>rows</small></span></div>;
}

function ImportSummary({ value, children }: { value: ImportPreview; children: React.ReactNode }) {
  return <div className="preview"><strong>{value.fileName}</strong><MiniStats counts={value.counts ?? {}}/>{Boolean(value.unknownColumns?.length) && <p>Ignored columns: {value.unknownColumns!.join(", ")}</p>}{Boolean(value.errors?.length) && <div className="warning-list"><strong>{value.errors!.length} rows need attention</strong>{value.errors!.map((item, index) => <span key={index}>{item}</span>)}</div>}{children}</div>;
}

function workoutLocalDate(item: TrainingHistorySession, fallbackTimezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: item.timezone ?? fallbackTimezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(item.startAt));
}

type TrainingDisplayType = "strength" | "endurance" | "sport_skill" | "mind_body" | "recovery" | "unclassified";
const trainingTypeOptions = ["strength", "endurance", "sport_skill", "mind_body", "recovery"] as const;

function trainingDisplayType(item: TrainingHistorySession): { id: TrainingDisplayType; label: string } {
  const domain = item.domains[0];
  if (domain === "strength" || domain === "endurance" || domain === "sport_skill" || domain === "mind_body" || domain === "recovery") return { id: domain, label: friendlyLabel(domain) };
  return { id: "unclassified", label: "Unclassified" };
}

function TrainingTypeIcon({ type }: { type: TrainingDisplayType }) {
  const path = type === "unclassified"
    ? <><circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16h.01"/></>
    : domainIconPath(type);
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>;
}

function workoutDateTime(item: TrainingHistorySession, fallbackTimezone: string): { date: string; time: string } {
  const timeZone = item.timezone ?? fallbackTimezone;
  const instant = new Date(item.startAt);
  const locale = currentLanguage() === "en" ? "en-GB" : "zh-CN";
  const date = new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short", year: "numeric" }).format(instant);
  const time = item.timePrecision === "date_only" ? "-" : new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit", hour12: currentLanguage() === "en" }).format(instant).toLocaleLowerCase();
  return { date, time };
}

function trainingHistorySourceLabel(source: string): string {
  return tr(({ manual: "Manual", xunji: "SynFit" } as Record<string, string>)[source] ?? formatTrainingSource(source));
}

function TimelineWorkout({ item, planned, revision, timezone, onMutated }: { item: TrainingHistorySession; planned: CalendarSession[]; revision: number; timezone: string; onMutated: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const [editing, setEditing] = useState(false); const [typeOpen, setTypeOpen] = useState(false); const rowRef = useRef<HTMLElement>(null); const menuRef = useRef<HTMLDetailsElement>(null);
  const editingSnapshotHash = useRef<string | undefined>(undefined);
  const [duration, setDuration] = useState(String(item.durationMinutes)); const [startAt, setStartAt] = useState("");
  const day = workoutLocalDate(item, timezone);
  const displayType = trainingDisplayType(item); const dateTime = workoutDateTime(item, timezone);
  const compatible = (session: CalendarSession) => session.components.some((component) => component.domain.value !== null && item.domains.includes(component.domain.value));
  const eligible = planned.filter((session) => session.scheduledDate === day && session.status !== "skipped").sort((left, right) => Number(compatible(right)) - Number(compatible(left)) || Number(Boolean(left.completedTrainingSessionId)) - Number(Boolean(right.completedTrainingSessionId)));
  useEffect(() => { if (!typeOpen) return; const close = (event: PointerEvent) => { if (!rowRef.current?.contains(event.target as Node)) setTypeOpen(false); }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, [typeOpen]);
  useEffect(() => {
    if (editing && error && item.snapshotHash && item.snapshotHash !== editingSnapshotHash.current) editingSnapshotHash.current = item.snapshotHash;
  }, [editing, error, item.snapshotHash]);
  const mutate = async (path: string, init: RequestInit): Promise<boolean> => { setBusy(true); setError(undefined); try { await api(path, init); await onMutated(); return true; } catch (value) { setError(value); return false; } finally { setBusy(false); } };
  const changeMatch = async (value: string) => {
    if (value === "__automatic__") return mutate(`/api/training-sessions/${encodeURIComponent(item.id)}/automatic-match`, { method: "POST", body: JSON.stringify({ confirmed: true, expectedSnapshotHash: item.snapshotHash }) });
    const target = eligible.find((session) => session.id === value);
    if (target?.completedTrainingSessionId && target.completedTrainingSessionId !== item.id && !window.confirm(`${target.name} is linked to another workout. Replace that link?`)) return;
    return mutate(`/api/training-sessions/${encodeURIComponent(item.id)}/plan-match`, { method: "PATCH", body: JSON.stringify({ plannedSessionId: value, expectedRevision: revision, confirmed: true, expectedSnapshotHash: item.snapshotHash }) });
  };
  const changeType = async (domain: Exclude<TrainingDisplayType, "unclassified">) => { if (domain === displayType.id) { setTypeOpen(false); return; } if (await mutate(`/api/training-sessions/${encodeURIComponent(item.id)}/type`, { method: "PATCH", body: JSON.stringify({ domain, confirmed: true, expectedSnapshotHash: item.snapshotHash }) })) setTypeOpen(false); };
  const resetManualDraft = () => { setDuration(String(item.durationMinutes)); setStartAt(""); };
  const beginManualEdit = () => { resetManualDraft(); editingSnapshotHash.current = item.snapshotHash; setEditing(true); };
  const cancelManualEdit = () => { resetManualDraft(); setEditing(false); };
  const saveManual = async () => {
    const parsedDuration = Number(duration); const payload: Record<string, unknown> = { confirmed: true, durationMinutes: parsedDuration, expectedSnapshotHash: editingSnapshotHash.current };
    if (startAt) payload.startAt = new Date(startAt).toISOString();
    if (await mutate(`/api/training-sessions/${encodeURIComponent(item.id)}/manual`, { method: "PATCH", body: JSON.stringify(payload) })) { setEditing(false); menuRef.current?.removeAttribute("open"); }
  };
  const removeManual = () => { if (window.confirm("Remove the manual workout record? Synced sources will be kept.")) void mutate(`/api/training-sessions/${encodeURIComponent(item.id)}/manual`, { method: "DELETE", body: JSON.stringify({ confirmed: true, expectedSnapshotHash: item.snapshotHash }) }); };
  const deleteRecord = () => { if (window.confirm("Delete this workout record and all of its source data? A synced workout may be imported again during a future sync.")) void mutate(`/api/training-sessions/${encodeURIComponent(item.id)}`, { method: "DELETE", body: JSON.stringify({ confirmed: true, expectedSnapshotHash: item.snapshotHash }) }); };
  const hasManual = item.sources.some((source) => source.source === "manual");
  const hasSynced = item.sources.some((source) => source.source !== "manual");
  const subtitle = item.sport || (item.domains.length > 1 ? item.domains.map(friendlyLabel).join(" + ") : `${displayType.label} workout`);
  return <article className="training-row" key={item.id} ref={rowRef}>
    <div className="training-workout-cell"><span className={`training-type-icon ${displayType.id}`}><TrainingTypeIcon type={displayType.id}/></span><span><strong>{item.name}</strong><small>{subtitle}</small></span></div>
    <div className="training-date-cell"><strong>{dateTime.date}</strong><small>{dateTime.time}</small></div>
    <div className="training-type-cell"><button type="button" className={`training-type-badge ${displayType.id}`} aria-expanded={typeOpen} aria-label={`Change type for ${item.name}`} disabled={busy} onClick={() => setTypeOpen((value) => !value)}>{displayType.label}</button></div>
    <div className="training-duration-cell"><AppIcon name="clock"/><span>{formatDuration(item.durationMinutes)}{item.timePrecision === "date_only" ? <small><T>{"Estimated"}</T></small> : null}</span></div>
    <div className="training-source-cell"><span>{trainingHistorySourceLabel(item.source)}</span></div>
    <div className="training-plan-cell"><span className={`training-plan-mark ${item.planMatch ? "matched" : ""}`} aria-label={item.planMatch ? `${item.name} is matched to a planned session` : `${item.name} is not matched to a planned session`} title={item.planMatch ? "Matched to a planned session" : undefined}>{item.planMatch ? "✓" : ""}</span></div>
    <div className="training-actions-cell"><details className={editing ? "training-row-menu editing" : "training-row-menu"} ref={menuRef} onToggle={(event) => { if (!event.currentTarget.open && editing) cancelManualEdit(); }}><summary aria-label={`Actions for ${item.name}`}>•••</summary><div>{editing ? <div className="training-row-menu-editor"><label><T>{"Duration (minutes)"}</T><input type="number" min="1" max="1440" disabled={busy} value={duration} onChange={(event) => setDuration(event.target.value)}/></label><label><T>{"Actual start time"}</T><input type="datetime-local" disabled={busy} value={startAt} onChange={(event) => setStartAt(event.target.value)}/></label><div className="training-row-menu-editor-actions"><button type="button" className="secondary" disabled={busy} onClick={cancelManualEdit}><T>{"Cancel"}</T></button><button type="button" className="training-row-menu-save" disabled={busy || !Number.isInteger(Number(duration)) || Number(duration) < 1} onClick={() => void saveManual()}>{busy ? "Saving…" : "Save"}</button></div></div> : <><label className="training-row-menu-plan"><span><T>{"Planned session"}</T></span><select aria-label={`Planned session for ${item.name}`} disabled={busy} value={item.planMatch?.plannedSessionId ?? ""} onChange={(event) => void changeMatch(event.target.value)}><option value="" disabled>-</option>{eligible.map((session) => <option key={session.id} value={session.id}>{session.name}{!compatible(session) ? " · different domain" : ""}{session.completedTrainingSessionId && session.completedTrainingSessionId !== item.id ? " · linked" : ""}</option>)}{item.isPlanMatchExcluded && <option value="__automatic__"><T>{"Allow automatic matching"}</T></option>}</select>{item.planMatch && <small>{item.planMatch.method === "manual" ? "Linked by you" : "Matched automatically"}</small>}</label>{hasManual && <button type="button" disabled={busy} onClick={beginManualEdit}><T>{"Edit manual details"}</T></button>}{hasManual && hasSynced && <button type="button" className="danger-text" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); removeManual(); }}><T>{"Remove manual source"}</T></button>}<button type="button" className="danger-text" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); deleteRecord(); }}><T>{"Delete record"}</T></button></>}</div></details></div>
    {typeOpen && <div className="training-type-options" role="group" aria-label={`Type options for ${item.name}`}>{trainingTypeOptions.map((domain) => <button type="button" key={domain} className={`training-type-option ${domain} ${displayType.id === domain ? "selected" : ""}`} aria-pressed={displayType.id === domain} disabled={busy} onClick={() => void changeType(domain)}>{friendlyLabel(domain)}</button>)}</div>}
    <ErrorBanner error={error}/>
  </article>;
}

export function Timeline() {
  const client = useQueryClient();
  const [search, setSearch] = useState(""); const [sort, setSort] = useState<TrainingHistorySort>("newest"); const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ["sessions"], queryFn: () => api<TrainingHistorySession[]>("/api/sessions?days=365") });
  const calendar = useQuery({ queryKey: ["calendar", "timeline"], queryFn: () => api<CalendarSession[]>("/api/plans/calendar") });
  const plan = useQuery({ queryKey: ["current-plan"], queryFn: () => api<CurrentPlan | null>("/api/plans/current") });
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: ["sessions"] }), client.invalidateQueries({ queryKey: ["calendar"] }), client.invalidateQueries({ queryKey: ["summary"] }), client.invalidateQueries({ queryKey: ["state"] }), client.invalidateQueries({ queryKey: ["next-training-day"] })]); };
  const error = query.error ?? calendar.error ?? plan.error ?? profile.error;
  const plannedNames = useMemo(() => Object.fromEntries((calendar.data ?? []).map((session: CalendarSession) => [session.id, session.name])), [calendar.data]);
  const filtered = useMemo(() => filterAndSortTrainingHistory(query.data ?? [], search, sort, plannedNames), [query.data, search, sort, plannedNames]);
  const pagination = paginateTrainingHistory(filtered, page);
  useEffect(() => { if (page !== pagination.page) setPage(pagination.page); }, [page, pagination.page]);
  const loading = query.isPending || calendar.isPending || plan.isPending || profile.isPending;
  return <section className="card training-history">
    <div className="training-history-header"><div><h2><T>{"Training History"}</T></h2><p><T>{"Your recent workouts, sessions and activities."}</T></p></div><div className="training-history-tools"><label className="training-search"><span className="sr-only"><T>{"Search workouts"}</T></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><input type="search" placeholder={tr("Search workouts...")} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }}/></label><label className="training-sort"><span className="sr-only"><T>{"Sort training history"}</T></span><select aria-label={tr("Sort training history")} value={sort} onChange={(event) => { setSort(event.target.value as TrainingHistorySort); setPage(1); }}><option value="newest"><T>{"Newest first"}</T></option><option value="oldest"><T>{"Oldest first"}</T></option></select></label></div></div>
    <ErrorBanner error={error}/>
    {loading ? <Loading/> : <><div className="training-table-scroll"><div className="training-table"><div className="training-table-heading" aria-hidden="true"><span><T>{"Workout"}</T></span><span><T>{"Date & time"}</T></span><span><T>{"Type"}</T></span><span><T>{"Duration"}</T></span><span><T>{"Source"}</T></span><span className="training-plan-heading"><T>{"Plan Matched"}</T></span><span/></div><div className="training-table-body">{pagination.items.map((item) => <TimelineWorkout key={item.id} item={item} planned={calendar.data ?? []} revision={plan.data?.revision ?? 0} timezone={profile.data?.timezone ?? "UTC"} onMutated={refresh}/>)}{!query.data?.length ? <EmptyState title={tr("No workouts imported yet.")}/> : !filtered.length ? <EmptyState title={tr("No workouts match your search.")}/> : null}</div></div></div><footer className="training-history-footer"><span>{currentLanguage() === "zh-CN" ? `显示第 ${pagination.start}–${pagination.end} 条，共 ${filtered.length} 条训练` : filtered.length ? `Showing ${pagination.start}–${pagination.end} of ${filtered.length} sessions` : "Showing 0 sessions"}</span><div><button type="button" aria-label={tr("Previous page")} disabled={pagination.page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>‹</button><button type="button" aria-label={tr("Next page")} disabled={pagination.page === pagination.totalPages} onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))}>›</button></div></footer></>}
  </section>;
}

export function Backup() {
  const client = useQueryClient();
  const doctor = useQuery({ queryKey: ["backup-doctor"], queryFn: () => api<DoctorResult>("/api/system/doctor") });
  const vault = useQuery({ queryKey: ["vault-status"], queryFn: getVaultStatus });
  const databasePath = (doctor.data as DoctorResult | undefined)?.databasePath;
  const [message, setMessage] = useState(""); const [error, setError] = useState<unknown>();
  const [preview, setPreview] = useState<BackupPreview>(); const [restoring, setRestoring] = useState(false); const [creating, setCreating] = useState(false);
  const [passwordModal, setPasswordModal] = useState(false); const [requireModal, setRequireModal] = useState(false); const [changing, setChanging] = useState(false); const [passwordDraft, setPasswordDraft] = useState({ currentPassword: "", password: "", confirmation: "" });
  const [currentPassword, setCurrentPassword] = useState("");
  const [profileTarget, setProfileTarget] = useState<string>();
  const chooseBackup = async () => {
    setError(undefined); setMessage(""); setPreview(undefined);
    try {
      const path = await pickRestoreFile();
      if (path) setPreview(await api<BackupPreview>("/api/system/backup/preview", { method: "POST", body: JSON.stringify({ path }) }));
    } catch (value) { setError(value); }
  };
  const confirmRestore = async () => {
    if (!preview) return;
    try { setRestoring(true); setError(undefined); await restoreBackup(preview.path); await client.cancelQueries(); client.clear(); window.location.reload(); }
    catch (value) { setRestoring(false); setError(value); }
  };
  const chooseProfileDestination = async () => {
    setError(undefined); setMessage("");
    try {
      const path = await pickNewProfileDestination();
      if (path) setProfileTarget(path);
    } catch (value) { setError(value); }
  };
  const createProfile = async () => {
    if (!profileTarget) return;
    try { setCreating(true); setError(undefined); await createNewProfile(profileTarget); await client.cancelQueries(); client.clear(); window.location.reload(); }
    catch (value) { setCreating(false); setError(value); }
  };
  const openChangePassword = () => { setError(undefined); setPasswordDraft({ currentPassword: "", password: "", confirmation: "" }); setPasswordModal(true); };
  const closeChangePassword = () => { setPasswordModal(false); setError(undefined); setPasswordDraft({ currentPassword: "", password: "", confirmation: "" }); };
  const updateVaultPassword = async () => {
    try {
      setChanging(true); setError(undefined); setMessage("");
      if (passwordDraft.password !== passwordDraft.confirmation) throw new Error("Passwords do not match.");
      await changeVaultPassword(passwordDraft.password, passwordDraft.currentPassword);
      closeChangePassword(); setMessage("Database password updated. Saved connection keys remain encrypted.");
    } catch (value) { setError(value); } finally { setChanging(false); }
  };
  const requirePassword = async () => {
    try {
      setChanging(true); setError(undefined); setMessage("");
      await requireVaultPassword(currentPassword);
      setRequireModal(false); setCurrentPassword("");
      await vault.refetch();
      setMessage("Password will be required the next time Athria starts.");
    } catch (value) { setError(value); } finally { setChanging(false); }
  };
  return <Card title={<SettingsCardTitle title={tr("Manage database")} description={tr("All your data is stored in one portable database. Your API keys are protected by your database password.")}/>} className="settings-card database-settings-card">
    {databasePath && <p className="data-location"><span className="data-location-label"><T>{"Local Database:"}</T></span><code>{databasePath}</code><button type="button" className="secondary compact" onClick={() => void chooseBackup()}><T>{"Switch Database"}</T></button></p>}
    {preview && <div className="restore-confirm">
          <strong><T>{"Switch to this database?"}</T></strong>
          <span className="restore-path">{preview.path}</span>
          <div className="restore-summary">
            <span><b>{preview.counts.workouts}</b><small>workouts</small></span>
            <span><b>{preview.counts.templates}</b><small>templates</small></span>
            <span><b>{preview.counts.plans}</b><small>plans</small></span>
          </div>
          <p><T>{"Athria will open this file as its active database. The current database file is left untouched."}</T></p>
          {preview.includesCredentials && <p><T>{"This database includes encrypted connections. Athria will ask for its password when it is opened on another computer."}</T></p>}
          <div className="restore-actions">
            <button type="button" className="secondary compact" disabled={restoring} onClick={() => setPreview(undefined)}><T>{"Cancel"}</T></button>
            <button type="button" className="compact" disabled={restoring} onClick={() => void confirmRestore()}>{restoring ? "Switching Database…" : "Switch Database"}</button>
          </div>
        </div>}
    {vault.data?.initialized && !vault.data.locked && <div className="section"><div className="section-heading"><div className="section-copy"><h3><T>{"Edit Password Settings"}</T></h3><p><T>{vault.data.canRemember ? "Change the database password or require it whenever Athria starts." : "Change the database password. Athria asks for it each time it starts."}</T></p></div><div className="section-actions"><button type="button" className="secondary compact" onClick={openChangePassword}><T>{"Change Password"}</T></button>{vault.data.canRemember && <button type="button" className="secondary compact" disabled={!vault.data.remembered} onClick={() => { setError(undefined); setCurrentPassword(""); setRequireModal(true); }}><T>{vault.data.remembered ? "Always Require Password" : "Password Required on Startup"}</T></button>}</div></div></div>}
    <div className="section"><div className="section-heading"><div className="section-copy"><h3><T>{"Create a New Profile"}</T></h3><p><T>{"Start fresh from a new empty profile. Athria will switch to it without restarting; the current database file is left untouched."}</T></p></div><div className="section-actions"><button type="button" className="secondary compact" disabled={creating} onClick={() => void chooseProfileDestination()}><AppIcon name="plus"/><T>{"Create Profile"}</T></button></div></div></div>
    {profileTarget && <NewProfileModal target={profileTarget} error={error} busy={creating} onClose={() => setProfileTarget(undefined)} onSubmit={() => void createProfile()}/>}
    {passwordModal && <ChangePasswordModal value={passwordDraft} error={error} busy={changing} onChange={setPasswordDraft} onClose={closeChangePassword} onSubmit={() => void updateVaultPassword()}/>}
    {vault.data?.canRemember && requireModal && <RequirePasswordModal value={currentPassword} error={error} busy={changing} onChange={setCurrentPassword} onClose={() => { setRequireModal(false); setCurrentPassword(""); setError(undefined); }} onSubmit={() => void requirePassword()}/>}
    {message && <div className="success">{message}</div>}
    <ErrorBanner error={doctor.error ?? error}/>
  </Card>;
}

export function ChangePasswordModal({ value, error, busy, onChange, onClose, onSubmit }: { value: { currentPassword: string; password: string; confirmation: string }; error: unknown; busy: boolean; onChange: (value: { currentPassword: string; password: string; confirmation: string }) => void; onClose: () => void; onSubmit: () => void; }) {
  const mismatch = value.password !== value.confirmation;
  useModalDismiss(onClose);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="connection-modal" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
    <header><div><h2 id="change-password-title"><T>{"Change Database Password"}</T></h2><p><T>{"This re-wraps the database master key; your saved connection keys do not need to be entered again."}</T></p></div><button type="button" className="modal-close" aria-label={tr("Close dialog")} onClick={onClose}><AppIcon name="close"/></button></header>
    <div className="modal-body">
      <label><T>{"Current password"}</T><input type="password" autoFocus autoComplete="current-password" value={value.currentPassword} onChange={(event) => onChange({ ...value, currentPassword: event.target.value })}/></label>
      <label><T>{"New password"}</T><input type="password" autoComplete="new-password" value={value.password} onChange={(event) => onChange({ ...value, password: event.target.value })}/></label>
      <label><T>{"Confirm password"}</T><input type="password" className={mismatch ? "invalid" : undefined} autoComplete="new-password" value={value.confirmation} onChange={(event) => onChange({ ...value, confirmation: event.target.value })}/>{mismatch && <span className="field-error"><T>{"Passwords do not match."}</T></span>}</label>
      <ErrorBanner error={error}/>
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}><T>{"Cancel"}</T></button><button type="button" disabled={busy || value.currentPassword.length === 0 || value.password.length === 0 || mismatch} onClick={onSubmit}><T>{busy ? "Changing Password…" : "Change Password"}</T></button></div>
    </div>
  </section></div>;
}

export function RequirePasswordModal({ value, error, busy, onChange, onClose, onSubmit }: { value: string; error: unknown; busy: boolean; onChange: (value: string) => void; onClose: () => void; onSubmit: () => void; }) {
  useModalDismiss(onClose);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="connection-modal" role="dialog" aria-modal="true" aria-labelledby="require-password-title">
    <header><div><h2 id="require-password-title"><T>{"Require Password on Startup"}</T></h2><p><T>{"Confirm your current password. Athria will ask for it the next time it starts."}</T></p></div><button type="button" className="modal-close" aria-label={tr("Close dialog")} onClick={onClose}><AppIcon name="close"/></button></header>
    <div className="modal-body"><label><T>{"Current password"}</T><input type="password" autoFocus autoComplete="current-password" value={value} onChange={(event) => onChange(event.target.value)}/></label><ErrorBanner error={error}/><div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}><T>{"Cancel"}</T></button><button type="button" disabled={busy || value.length === 0} onClick={onSubmit}><T>{busy ? "Updating…" : "Require Password"}</T></button></div></div>
  </section></div>;
}

export function NewProfileModal({ target, error, busy, onClose, onSubmit }: { target: string; error: unknown; busy: boolean; onClose: () => void; onSubmit: () => void; }) {
  useModalDismiss(onClose);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="connection-modal" role="dialog" aria-modal="true" aria-labelledby="new-profile-title">
    <header><div><h2 id="new-profile-title"><T>{"Create a New Profile"}</T></h2><p><T>{"Athria will create an empty database at this location and switch to it. You will set its database password when it opens."}</T></p></div><button type="button" className="modal-close" aria-label={tr("Close dialog")} onClick={onClose}><AppIcon name="close"/></button></header>
    <div className="modal-body"><p className="restore-path">{target}</p><ErrorBanner error={error}/><div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}><T>{"Cancel"}</T></button><button type="button" disabled={busy} onClick={onSubmit}><T>{busy ? "Creating Profile…" : "Create Profile"}</T></button></div></div>
  </section></div>;
}

type AgentState = "connected" | "update_available" | "needs_attention" | "skills_setup_required";

const agentStateLabels: Record<AgentState, string> = { connected: "Connected", update_available: "Update available", needs_attention: "Needs attention", skills_setup_required: "Skills setup required" };

function agentManaged({ mcp, skills }: Pick<AgentIntegrationStatus, "mcp" | "skills">): boolean {
  const linked = (status: AgentIntegrationStatus["mcp"]) => status === "installed" || status === "outdated" || status === "modified" || status === "conflict";
  return linked(mcp) || linked(skills);
}

/** A GUI-managed agent installs Skills in its own settings, so Athria prepares archives and waits for the handshake. */
function guiSkillsAwaitingSetup({ skills, skillsMode }: Pick<AgentIntegrationStatus, "skills" | "skillsMode">): boolean {
  return skillsMode === "gui_managed" && (skills === "unverified" || skills === "missing");
}

function agentState({ mcp, skills, skillsMode }: Pick<AgentIntegrationStatus, "mcp" | "skills" | "skillsMode">): AgentState {
  if (mcp === "conflict" || skills === "conflict" || skills === "modified") return "needs_attention";
  if (guiSkillsAwaitingSetup({ skills, skillsMode })) return "skills_setup_required";
  if (mcp === "outdated" || skills === "outdated") return "update_available";
  if (mcp === "installed" && (skills === "installed" || skills === "unsupported")) return "connected";
  return "needs_attention";
}

/** Skills location to show: the agent's Skills folder, or the archives Athria prepared for a GUI-managed agent. */
function agentSkillsLocation({ skillsPath, skillArchiveDir }: Pick<AgentIntegrationStatus, "skillsPath" | "skillArchiveDir">): string | undefined {
  return skillsPath ?? skillArchiveDir;
}

function AgentBadge({ integration }: { integration: AgentIntegrationStatus }) {
  const official = ["codex", "claude_code", "claude_desktop", "qoder_cn", "trae_cn", "cursor", "workbuddy"].includes(integration.agent);
  const initial = Array.from(integration.name.trim())[0]?.toLocaleUpperCase() ?? "?";
  return <span className={`agent-icon agent-${integration.agent.replace(/_/g, "-")}${official ? "" : " agent-custom"}`} aria-hidden="true">{official ? <AgentLogo agent={integration.agent as OfficialAgentKind}/> : <span className="agent-custom-initial">{initial}</span>}</span>;
}

function AgentMenu({ integration, state, busy, onUpdate, onRemove }: { integration: AgentIntegrationStatus; state: AgentState; busy: boolean; onUpdate: () => void; onRemove: () => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const home = useHomeDir();
  const [copied, setCopied] = useState<string>();
  const [flipped, setFlipped] = useState(false);
  const [aligned, setAligned] = useState(false);
  useEffect(() => {
    const element = menu.current;
    if (!element) return;
    const align = () => {
      if (!element.open) { setFlipped(false); setAligned(false); return; }
      const naturalLeft = element.getBoundingClientRect().right - (panel.current?.offsetWidth ?? 0);
      let bounds = element.parentElement;
      while (bounds && bounds !== document.body && getComputedStyle(bounds).overflowY === "visible") bounds = bounds.parentElement;
      setFlipped(naturalLeft < (bounds ?? document.documentElement).getBoundingClientRect().left + 8);
      setAligned(true);
    };
    element.addEventListener("toggle", align);
    return () => element.removeEventListener("toggle", align);
  }, []);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.removeAttribute("open"); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => (current === label ? undefined : current)), 1600);
    } catch { setCopied(undefined); }
  };
  const closeMenu = (event: React.MouseEvent<HTMLButtonElement>) => event.currentTarget.closest("details")?.removeAttribute("open");
  const skillsLocation = agentSkillsLocation(integration);
  return <details className="agent-menu" ref={menu}>
    <summary aria-label={`Options for ${integration.name}`}><AppIcon name="ellipsis"/></summary>
    <div ref={panel} className={[flipped ? "agent-menu-flipped" : undefined, aligned ? undefined : "agent-menu-hidden"].filter(Boolean).join(" ") || undefined}>
      <button type="button" className="agent-menu-path" title={integration.configPath} onClick={() => void copy("mcp", integration.configPath)}><span><small><T>{"MCP"}</T></small><code>{shortenHomePath(integration.configPath, home)}</code></span><AppIcon name={copied === "mcp" ? "check" : "copy"}/></button>
      {skillsLocation && <button type="button" className="agent-menu-path" title={skillsLocation} onClick={() => void copy("skills", skillsLocation)}><span><small><T>{"Skills"}</T></small><code>{shortenHomePath(skillsLocation, home)}</code></span><AppIcon name={copied === "skills" ? "check" : "copy"}/></button>}
      {integration.skillsMode === "gui_managed"
        ? <button type="button" className="agent-menu-item" disabled={busy} onClick={(event) => { closeMenu(event); onUpdate(); }}><AppIcon name="refresh"/><T>{"Update MCP / Skills"}</T></button>
        : state !== "connected" && <button type="button" className="agent-menu-item" disabled={busy} onClick={(event) => { closeMenu(event); onUpdate(); }}><AppIcon name="refresh"/>{state === "update_available" ? "Update" : "Repair"}</button>}
      <div className="agent-menu-divider"/>
      <button type="button" className="agent-menu-item danger-text" disabled={busy} onClick={(event) => { closeMenu(event); onRemove(); }}><AppIcon name="trash"/><T>{"Remove Agent"}</T></button>
    </div>
  </details>;
}

function AgentTile({ integration }: { integration: AgentIntegrationStatus }) {
  const client = useQueryClient();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [guide, setGuide] = useState<AgentGuide>();
  const install = useMutation({ mutationFn: () => installAgentIntegration(integration.agent) });
  const remove = useMutation({ mutationFn: () => removeAgentIntegration(integration.agent) });
  const busy = install.isPending || remove.isPending;
  const state = agentState(integration);
  const refresh = () => client.invalidateQueries({ queryKey: ["agent-integrations"] });
  const update = async () => {
    if (integration.skills === "modified") {
      window.dispatchEvent(new CustomEvent("athria-resolve-skill-update", { detail: integration.agent }));
      return;
    }
    try {
      setError(undefined); setMessage(undefined);
      const result = await install.mutateAsync();
      const next = guideFor(integration, result, true);
      if (next) setGuide(next); else setMessage(`Restart ${integration.name} to load the update.`);
      await refresh();
    } catch (value) { setError(value); }
  };
  const disconnect = async () => {
    if (!window.confirm(`Remove Athria from ${integration.name}? This deletes Athria's MCP entry and the Skills it manages. Your other settings are kept.`)) return;
    try {
      setError(undefined); setMessage(undefined);
      await remove.mutateAsync();
      await refresh();
    } catch (value) { setError(value); }
  };
  return <article className="agent-tile">
    <AgentBadge integration={integration}/>
    <div className="agent-tile-copy"><strong>{integration.name}</strong><span className={`agent-tile-state ${state}`}><i/>{agentStateLabels[state]}</span></div>
    <AgentMenu integration={integration} state={state} busy={busy} onUpdate={() => void update()} onRemove={() => void disconnect()}/>
    {message && <p className="agent-tile-note" role="status">{message}</p>}
    <ErrorBanner error={error}/>
    {guide && <SkillArchiveGuideModal guide={guide} onClose={() => setGuide(undefined)}/>}
  </article>;
}

/** Athria's upload guidance for an agent that installs Skills in its own settings. */
type AgentGuide = { name: string; archiveDir?: string | undefined; archives: SkillArchiveView[]; updating: boolean };

function guideFor(integration: AgentIntegrationStatus, result: AgentIntegrationResult, updating: boolean): AgentGuide | undefined {
  if (integration.skillsMode !== "gui_managed") return undefined;
  return { name: integration.name, archiveDir: result.skillArchiveDir, archives: result.skillArchives, updating };
}

export function SkillArchiveGuideModal({ guide, onClose }: { guide: AgentGuide; onClose: () => void }) {
  useModalDismiss(onClose);
  const [error, setError] = useState<unknown>();
  const openArchives = async () => {
    try { setError(undefined); await openSkillArchiveFolder(); } catch (value) { setError(value); }
  };
  const count = guide.archives.length;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="connection-modal skill-archive-modal" role="dialog" aria-modal="true" aria-labelledby="skill-archive-title">
      <header><div><h2 id="skill-archive-title">{guide.updating ? `${guide.name} needs the refreshed Skills` : `Finish connecting ${guide.name}`}</h2><p>{guide.updating ? "Athria refreshed the MCP configuration and prepared the latest Skill archives." : "Athria connected the MCP server and prepared Athria's Skills for upload."}</p></div><button type="button" className="modal-close" aria-label={tr("Close dialog")} onClick={onClose}><AppIcon name="close"/></button></header>
      <div className="modal-body">
        <ol className="agent-manual-steps">
          <li><strong>Open Skills in {guide.name}</strong><span><T>{"Choose Customize, then Skills."}</T></span></li>
          <li><strong><T>{"Upload each Athria Skill"}</T></strong><span>Use Upload skill and choose {count > 0 ? `the ${count} ZIP file${count === 1 ? "" : "s"}` : "the ZIP files"} Athria prepared. {guide.name} accepts one Skill per ZIP.</span></li>
        </ol>
        {guide.archiveDir && <div className="agent-archive-path"><small><T>{"Skill archives"}</T></small><code title={guide.archiveDir}>{guide.archiveDir}</code></div>}
        {count > 0 && <ul className="agent-archive-list">{guide.archives.map((archive) => <li key={archive.name}><strong>{archive.name}</strong><span>{archive.version}</span></li>)}</ul>}
        <p className="agent-archive-note">Athria shows Connected once {guide.name} runs a Skill and reports the version it loaded.</p>
        <ErrorBanner error={error}/>
        <div className="modal-actions"><button type="button" className="secondary" disabled={!guide.archiveDir} onClick={() => void openArchives()}><T>{"Open ZIP folder"}</T></button><button type="button" onClick={onClose}><T>{"Done"}</T></button></div>
      </div>
    </section>
  </div>;
}

const AGENT_TILE_WIDTH = 220;
const AGENT_TILE_GAP = 10;

export function agentTileColumns(width: number): number {
  return Math.max(1, Math.floor((width + AGENT_TILE_GAP) / (AGENT_TILE_WIDTH + AGENT_TILE_GAP)));
}

export function splitAgentTiles(agents: AgentIntegrationStatus[], columns: number | null): { visible: AgentIntegrationStatus[]; hidden: AgentIntegrationStatus[] } {
  if (columns === null || columns >= agents.length) return { visible: agents, hidden: [] };
  const visible = agents.slice(0, Math.max(1, columns - 1));
  return { visible, hidden: agents.slice(visible.length) };
}

export function AgentTiles({ agents, columns, onShowMore }: { agents: AgentIntegrationStatus[]; columns: number | null; onShowMore: () => void }) {
  const { visible, hidden } = splitAgentTiles(agents, columns);
  return <>
    {visible.map((integration) => <AgentTile key={integration.agent} integration={integration}/>)}
    {hidden.length > 0 && <button type="button" className="agent-tile agent-tile-more" onClick={onShowMore}><span className="agent-icon agent-icon-more"><AppIcon name="grid"/></span><span className="agent-tile-copy"><strong><T>{"More Agents"}</T></strong><small>{hidden.length} connected</small></span><AppIcon name="chevron" className="agent-chevron"/></button>}
  </>;
}

function useHomeDir(): string | undefined {
  const status = useQuery({ queryKey: ["mcp-status"], queryFn: getMcpStatus, retry: false });
  return status.data?.homeDir ?? undefined;
}

/** Shows paths inside the home folder as `~/…`. Display only: hover and copy keep the real path. */
export function shortenHomePath(path: string, home?: string | undefined): string {
  if (!home) return path;
  const base = home.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalized = path.replaceAll("\\", "/");
  const prefix = `${base}/`;
  const matched = /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase().startsWith(prefix.toLowerCase()) : normalized.startsWith(prefix);
  return matched ? `~${normalized.slice(base.length)}` : path;
}

function AgentPathRow({ label, path, home, empty = "Need manual install" }: { label: string; path?: string | undefined; home?: string | undefined; empty?: string }) {
  return <div className="agent-modal-path"><small>{label}</small>{path ? <code title={path}>{shortenHomePath(path, home)}</code> : <span className="agent-modal-unsupported">{empty}</span>}</div>;
}

export function AddAgentModal({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const integrations = useQuery({ queryKey: ["agent-integrations"], queryFn: getAgentIntegrationsStatus, retry: false });
  const [view, setView] = useState<"list" | "manual">("list");
  const [pending, setPending] = useState<AgentKind>();
  const [guide, setGuide] = useState<AgentGuide>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<unknown>();
  const manual = view === "manual";
  const dismiss = () => { if (manual) setView("list"); else onClose(); };
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if (event.key !== "Escape" || guide) return; if (view === "manual") setView("list"); else onClose(); }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, [onClose, view, guide]);
  const roster = sortAgentRoster(integrations.data ?? []);
  const home = useHomeDir();
  const connect = async (integration: AgentIntegrationStatus) => {
    try {
      setPending(integration.agent); setError(undefined); setMessage(undefined);
      const result = await installAgentIntegration(integration.agent);
      const next = guideFor(integration, result, false);
      if (next) setGuide(next); else setMessage(`Athria was added to ${integration.name}. Restart it to load Athria.`);
      await client.invalidateQueries({ queryKey: ["agent-integrations"] });
    } catch (value) { setError(value); } finally { setPending(undefined); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="connection-modal agent-modal" role="dialog" aria-modal="true" aria-labelledby="agent-modal-title">
      <header><div><h2 id="agent-modal-title"><T>{manual ? "Manual Setup" : "Add Agent"}</T></h2>{!manual && <p><T>{"Connect Athria to your AI agent on this computer."}</T></p>}</div><button type="button" className="modal-close" aria-label={tr(manual ? "Back to Add Agent" : "Close dialog")} onClick={dismiss}><AppIcon name="close"/></button></header>
      <div className="modal-body">
        {manual ? <ManualAgentSetup existing={roster} onConnected={() => { setView("list"); void client.invalidateQueries({ queryKey: ["agent-integrations"] }); }}/> : <>
          {integrations.isPending ? <Loading/> : integrations.isError ? <ErrorBanner error={integrations.error}/> : roster.length ? <ul className="agent-modal-list">{roster.map((integration) => <li className="agent-modal-row" key={integration.agent}><AgentBadge integration={integration}/><div className="agent-modal-copy"><strong>{integration.name}</strong><AgentPathRow label="MCP" path={integration.configPath} home={home}/>{integration.skillsMode === "gui_managed" ? <AgentPathRow label="Skills" path={agentSkillsLocation(integration)} home={home} empty="Athria prepares these when you Connect"/> : <AgentPathRow label="Skills" path={integration.skillsPath} home={home}/>}</div>{agentManaged(integration) ? (integration.skillsMode === "gui_managed" && agentState(integration) !== "connected" ? <span className="agent-modal-pending" role="img" aria-label={agentStateLabels[agentState(integration)]} title={agentStateLabels[agentState(integration)]}>{agentStateLabels[agentState(integration)]}</span> : <span className="agent-modal-connected" role="img" aria-label={tr("Connected")} title={tr("Connected")}><AppIcon name="check"/></span>) : <button type="button" className="secondary" disabled={!integration.available || pending === integration.agent} title={integration.available ? undefined : integration.diagnostic} onClick={() => void connect(integration)}>{tr(pending === integration.agent ? "Connecting…" : "Connect")}</button>}</li>)}</ul> : null}
          {message && <p className="success" role="status">{message}</p>}
          <ErrorBanner error={error}/>
          <div className="agent-modal-footer"><button type="button" className="text-button" onClick={() => setView("manual")}><T>{"Don't see your agents? Manually add them →"}</T></button></div>
        </>}
      </div>
      {guide && <SkillArchiveGuideModal guide={guide} onClose={() => setGuide(undefined)}/>}
    </section></div>;
}

export function MoreAgentsModal({ agents, onClose }: { agents: AgentIntegrationStatus[]; onClose: () => void }) {
  useModalDismiss(onClose);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="connection-modal agent-modal" role="dialog" aria-modal="true" aria-labelledby="agent-more-title">
      <header><div><h2 id="agent-more-title"><T>{"More Agents"}</T></h2><p><T>{"Connected agents that do not fit in the row above."}</T></p></div><button type="button" className="modal-close" aria-label={tr("Close dialog")} onClick={onClose}><AppIcon name="close"/></button></header>
      <div className="modal-body"><div className="agent-grid">{agents.map((integration) => <AgentTile key={integration.agent} integration={integration}/>)}</div></div>
  </section></div>;
}

export function SkillUpdateConflictModal({ conflict, result, busy, error, onResolve, onClose }: { conflict: AgentSkillUpdate; result: SkillUpdateResult | undefined; busy: boolean; error: unknown; onResolve: (action: "replace" | "backup_replace") => void; onClose: () => void }) {
  useModalDismiss(onClose, !busy);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <section className="connection-modal skill-update-modal" role="dialog" aria-modal="true" aria-labelledby="skill-update-title">
      <header><div><h2 id="skill-update-title">{result ? "Skills updated" : `${conflict.name} Skills were modified`}</h2><p>{result ? "The bundled Athria Skills are now installed." : "A newer Athria version is available, but these installed Skills contain local changes."}</p></div><button type="button" className="modal-close" aria-label={tr("Close dialog")} disabled={busy} onClick={onClose}><AppIcon name="close"/></button></header>
      <div className="modal-body">
        {result ? <>{result.backupPath && <div className="skill-update-backup"><strong><T>{"Backup saved"}</T></strong><code>{result.backupPath}</code></div>}</> : <>
          <ul className="skill-update-list">{conflict.skills.map((skill) => <li key={skill.name}><strong>{skill.name}</strong><span>{skill.installedVersion} → {skill.bundledVersion}</span></li>)}</ul>
          <p className="skill-update-warning"><T>{"Replace permanently discards the local changes. Backup & Replace saves the current copies first."}</T></p>
        </>}
        <ErrorBanner error={error}/>
        <div className="modal-actions">{result ? <button type="button" onClick={onClose}><T>{"Done"}</T></button> : <><button type="button" className="secondary" disabled={busy} onClick={onClose}><T>{"Not now"}</T></button><button type="button" className="secondary" disabled={busy} onClick={() => onResolve("replace")}>{busy ? "Updating…" : "Replace"}</button><button type="button" disabled={busy} onClick={() => onResolve("backup_replace")}>{busy ? "Updating…" : "Backup & Replace"}</button></>}</div>
      </div>
    </section>
  </div>;
}

export function AgentSkillUpdateCoordinator() {
  const client = useQueryClient();
  const started = useRef(false);
  const [conflicts, setConflicts] = useState<AgentSkillUpdate[]>([]);
  const [failures, setFailures] = useState<AgentSkillUpdateFailure[]>([]);
  const [result, setResult] = useState<SkillUpdateResult>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const scan = async (requestedAgent?: AgentKind) => {
    try {
      const response = await reconcileAgentSkills();
      setFailures(response.failures);
      if (response.updated.length > 0) await client.invalidateQueries({ queryKey: ["agent-integrations"] });
      const next = requestedAgent ? response.conflicts.filter((item) => item.agent === requestedAgent) : response.conflicts;
      setConflicts(next);
      setResult(undefined);
      setError(undefined);
    } catch (value) {
      setFailures([{ agent: requestedAgent ?? "codex", message: value instanceof Error ? value.message : String(value) }]);
    }
  };
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      void scan();
    }
    const open = (event: Event) => void scan((event as CustomEvent<AgentKind>).detail);
    window.addEventListener("athria-resolve-skill-update", open);
    return () => window.removeEventListener("athria-resolve-skill-update", open);
  }, []);
  const current = conflicts[0];
  const close = () => {
    setConflicts((items) => items.slice(1));
    setResult(undefined);
    setError(undefined);
  };
  const resolve = async (action: "replace" | "backup_replace") => {
    if (!current) return;
    try {
      setBusy(true); setError(undefined);
      setResult(await resolveAgentSkillUpdate(current.agent, action));
      await client.invalidateQueries({ queryKey: ["agent-integrations"] });
    } catch (value) { setError(value); } finally { setBusy(false); }
  };
  return <>{failures.length > 0 && <div className="skill-update-failures" role="alert"><span>{failures.map((failure) => failure.message).join(" ")}</span><button type="button" aria-label={tr("Dismiss Skill update error")} onClick={() => setFailures([])}>×</button></div>}{current && <SkillUpdateConflictModal conflict={current} result={result} busy={busy} error={error} onResolve={(action) => void resolve(action)} onClose={close}/>}</>;
}

export function AgentIntegrations() {
  const integrations = useQuery({ queryKey: ["agent-integrations"], queryFn: getAgentIntegrationsStatus, retry: false });
  const [adding, setAdding] = useState(false);
  const [more, setMore] = useState(false);
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState<number | null>(null);
  useEffect(() => {
    if (!grid) return;
    const update = () => { if (grid.clientWidth > 0) setColumns(agentTileColumns(grid.clientWidth)); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [grid]);
  const connected = sortAgentRoster((integrations.data ?? []).filter(agentManaged));
  const hidden = splitAgentTiles(connected, columns).hidden;
  return <Card title={<SettingsCardTitle title={tr("Connect to Your AI Agents")} description={tr("Connect the AI agents on this computer. Athria backs up your settings before each change.")}/>} className="settings-card agent-integrations-card" action={<button type="button" className="secondary compact agent-add" onClick={() => setAdding(true)}><AppIcon name="plus"/><T>{"Add Agent"}</T></button>}>
    {integrations.isPending ? <Loading/> : integrations.isError ? <ErrorBanner error={integrations.error}/> : connected.length ? <div className="agent-grid" ref={setGrid}><AgentTiles agents={connected} columns={columns} onShowMore={() => setMore(true)}/></div> : <EmptyState title={tr("No agents connected yet")} description="Use Add Agent to connect an AI agent on this computer."/>}
    {adding && <AddAgentModal onClose={() => setAdding(false)}/>}
    {more && hidden.length > 0 && <MoreAgentsModal agents={hidden} onClose={() => setMore(false)}/>}
  </Card>;
}

export function Settings() {
  const { language, setLanguage } = useLanguage();
  const t = useT();
  const [templateLibrary, setTemplateLibrary] = useState(false);
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  if (templateLibrary) return <TemplateLibrary onBack={() => setTemplateLibrary(false)} preferredName={profile.data?.preferredName}/>;
  return <><PrimaryPageHeader preferredName={profile.data?.preferredName} subtitle="Manage your language, system status, and local database."/><div className="settings-page"><Card title={<SettingsCardTitle title={t("Language")} description={t("Change the display language.")}/>} className="settings-card language-settings" action={<label className="profile-timezone-field language-select"><AppIcon name="globe"/><select className="profile-timezone-select" aria-label={t("Language")} value={language} onChange={(event) => setLanguage(event.target.value as "en" | "zh-CN")}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>}>{null}</Card><Card title={<SettingsCardTitle title={t("System Status")} description={t("Athria runs locally and keeps your training data on this device.")}/>} className="settings-card system-card" action={<ServiceStatus/>}>{null}</Card><AgentIntegrations/><Backup/><Card title={<SettingsCardTitle title={t("Session Templates")} description={t("Manage reusable workout patterns for your training sessions.")}/>} className="settings-card session-templates-settings" action={<button type="button" className="secondary compact" onClick={() => setTemplateLibrary(true)}>{t("View all templates")}</button>}>{null}</Card></div></>;
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      window.setTimeout(() => setState("idle"), 2000);
    } catch { setState("failed"); }
  };
  return <><button type="button" className="secondary compact" onClick={() => void copy()}>{tr(state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy")}</button><span className="sr-only" aria-live="polite">{state === "copied" ? tr(`${label} copied.`) : state === "failed" ? tr(`${label} could not be copied.`) : ""}</span></>;
}

function PromptBlock({ label, value }: { label: string; value: string }) {
  return <div className="agent-prompt">
    <div className="agent-prompt-text"><code>{value}</code></div>
    <CopyButton label={label} value={value}/>
  </div>;
}

export function sortAgentRoster(agents: AgentIntegrationStatus[]): AgentIntegrationStatus[] {
  return [...agents].sort((left, right) => Number(right.available) - Number(left.available) || left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

const PATH_PROMPT = "Tell me your agent name, the absolute path to your MCP config file, and the absolute path to your Skills folder.";

export function ManualAgentSetup({ existing = [], onConnected = () => {} }: { existing?: AgentIntegrationStatus[]; onConnected?: () => void }) {
  const [name, setName] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [skillsPath, setSkillsPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const trimmedName = name.trim();
  const duplicate = existing.some((agent) => agent.name.localeCompare(trimmedName, undefined, { sensitivity: "base" }) === 0);
  const valid = Boolean(trimmedName && configPath.trim() && skillsPath.trim() && !duplicate);
  const connect = async () => {
    try {
      setBusy(true); setError(undefined);
      await addCustomAgent(trimmedName, configPath.trim(), skillsPath.trim());
      onConnected();
    } catch (value) { setError(value); } finally { setBusy(false); }
  };
  return <div className="agent-manual">
    <p className="agent-manual-intro"><T>{"Copy the text below and ask your AI assistant, then paste the MCP config file and Skills folder paths into the fields below."}</T></p>
    <PromptBlock label="Path request prompt" value={tr(PATH_PROMPT)}/>
    <div className="agent-manual-fields">
      <label><T>{"Agent name"}</T><input value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder={tr("My Agent")}/>{duplicate && <span className="field-error"><T>{"An agent with this name already exists."}</T></span>}</label>
      <label><T>{"MCP config file"}</T><input value={configPath} onChange={(event) => setConfigPath(event.target.value)} placeholder="~/path/to/mcp.json"/></label>
      <label><T>{"Skills folder"}</T><input value={skillsPath} onChange={(event) => setSkillsPath(event.target.value)} placeholder="~/path/to/skills"/></label>
    </div>
    <ErrorBanner error={error}/>
    <div className="modal-actions"><button type="button" disabled={!valid || busy} onClick={() => void connect()}>{tr(busy ? "Testing…" : "Test connection")}</button></div>
  </div>;
}

export function Help() {
  return <>
    <Card title={tr("Help & Support")} className="help-card">
      <p><T>{"Athria is your local-first training companion. Use Connections to connect data sources, Profile to confirm your preferences, and Plan to review Agent-created training plans."}</T></p>
      <div className="help-faq">
        <details className="faq-item"><summary><span><T>{"How do I create a new plan?"}</T></span></summary><div className="faq-answer"><p><T>{"Plans are created by your connected AI agent. Connect an agent in Settings under AI Agents, then ask it to build your plan — it uses your Profile, training history and synced workouts. Open Plan to review the Weekly Sessions it saves. Reusable Session Templates can be built in the Plan page's Template Library."}</T></p></div></details>
        <details className="faq-item"><summary><span><T>{"How do I import my training data?"}</T></span></summary><div className="faq-answer"><p><T>{"Open Connections and pick Intervals.icu (endurance activities) or SynFit (strength and training records). Then use Sync now whenever you want to pull in new workouts."}</T></p></div></details>
        <details className="faq-item"><summary><span><T>{"How do I back up my data and sync it with my own cloud?"}</T></span></summary><div className="faq-answer"><p><T>{"Athria does not have its own cloud service. Your data is stored in a password-protected database file. You can find its location in Settings. To back it up, first quit Athria and any connected AI clients, then copy the file. You can store it anywhere, including your own cloud drive. To restore it, select the file and enter its database password."}</T></p></div></details>
      </div>
    </Card>
    <Card title={tr("Glossary")} className="help-card">
      <h3 className="glossary-heading"><T>{"AI & Data"}</T></h3>
      <div className="help-grid glossary-grid">
        <section><strong><T>{"AI agent"}</T></strong><span><T>{"A desktop AI app (e.g., Claude, ChatGPT) that you connect to Athria. It reads your data and writes plans only when you ask."}</T></span></section>
        <section><strong><T>{"MCP"}</T></strong><span><T>{"Model Context Protocol — the open standard your AI agent uses to talk to Athria. The connection stays on this computer."}</T></span></section>
        <section><strong><T>{"Local-first"}</T></strong><span><T>{"All Athria data lives on this device and works without an account or an Athria server."}</T></span></section>
      </div>
      <h3 className="glossary-heading"><T>{"Training"}</T></h3>
      <div className="help-grid glossary-grid">
        <section><strong><T>{"Mesocycle"}</T></strong><span><T>{"Your multi-week plan: start date, Weekly Sessions, phase progressions and adjustment rules."}</T></span></section>
        <section><strong><T>{"Template"}</T></strong><span><T>{"A reusable single-domain pattern, such as \"Lower Strength A\". Templates carry structure only — no exercises or sets."}</T></span></section>
        <section><strong><T>{"Training domain"}</T></strong><span><T>{"The five training types Athria plans around: strength, endurance, sport skill, mind-body and recovery."}</T></span></section>
        <section><strong><T>{"RPE"}</T></strong><span><T>{"Rates how hard a set felt, usually 1–10. Drives load autoregulation."}</T></span></section>
        <section><strong><T>{"Heart rate zone"}</T></strong><span><T>{"A personal heart-rate range used to indicate effort level. Check your zone ranges in your watch or fitness app."}</T></span></section>
      </div>
    </Card>
  </>;
}

const views: Record<Page, () => React.ReactElement> = { Overview, Training: Timeline, Profile, Plan: CurrentPlanPage, Connections, Settings, Help };

export function DatabaseSwitchModal({ preview, error, busy, onClose, onSubmit }: { preview: BackupPreview; error: unknown; busy: boolean; onClose: () => void; onSubmit: () => void; }) {
  useModalDismiss(onClose);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="connection-modal database-gate database-switch-modal" role="dialog" aria-modal="true" aria-labelledby="database-switch-title">
    <header><div><h2 id="database-switch-title"><T>{"Switch to this database?"}</T></h2><p><T>{"Review the selected database before Athria switches to it."}</T></p></div><button type="button" className="modal-close" aria-label={tr("Close dialog")} onClick={onClose}><AppIcon name="close"/></button></header>
    <div className="modal-body">
      <div className="restore-confirm database-switch-confirm">
        <span className="restore-path">{preview.path}</span>
        <div className="restore-summary"><span><b>{preview.counts.workouts}</b><small>workouts</small></span><span><b>{preview.counts.templates}</b><small>templates</small></span><span><b>{preview.counts.plans}</b><small>plans</small></span></div>
        <p><T>{"Athria will switch to this database. The current database file is left untouched."}</T></p>
        <ErrorBanner error={error}/>
      </div>
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}><T>{"Cancel"}</T></button><button type="button" disabled={busy} onClick={onSubmit}><T>{busy ? "Switching database…" : "Switch database"}</T></button></div>
    </div>
  </section></div>;
}

export function DatabaseGate() {
  const client = useQueryClient();
  const vault = useQuery({ queryKey: ["vault-status"], queryFn: getVaultStatus });
  const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [remember, setRemember] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(); const [busy, setBusy] = useState(false); const [resetting, setResetting] = useState(false);
  const [preview, setPreview] = useState<BackupPreview>();
  if (!vault.data || (vault.data.initialized && !vault.data.locked)) return null;
  const setup = !vault.data.initialized;
  const rememberChoice = vault.data?.canRemember === false ? false : remember ?? setup;
  const mismatch = (setup || resetting) && password !== confirmation;
  const submit = async () => {
    try {
      setBusy(true); setError(undefined);
      if (setup) {
        if (password !== confirmation) throw new Error("Passwords do not match.");
        await setupVault(password, rememberChoice);
      } else if (resetting) {
        if (password !== confirmation) throw new Error("Passwords do not match.");
        await resetVaultPassword(password);
      } else await unlockVault(password, rememberChoice);
      setPassword(""); setConfirmation("");
      await Promise.all([client.invalidateQueries({ queryKey: ["vault-status"] }), client.invalidateQueries({ queryKey: ["intervals-status"] }), client.invalidateQueries({ queryKey: ["xunji-status"] })]);
    } catch (value) { setError(value); } finally { setBusy(false); }
  };
  const chooseDatabase = async () => {
    try {
      setError(undefined); setPreview(undefined);
      const path = await pickRestoreFile();
      if (path) setPreview(await api<BackupPreview>("/api/system/backup/preview", { method: "POST", body: JSON.stringify({ path }) }));
    } catch (value) { setError(value); }
  };
  const switchDatabase = async () => {
    if (!preview) return;
    try { setBusy(true); setError(undefined); await restoreBackup(preview.path); await client.cancelQueries(); client.clear(); window.location.reload(); }
    catch (value) { setBusy(false); setError(value); }
  };
  if (preview) return <DatabaseSwitchModal preview={preview} error={error} busy={busy} onClose={() => { setPreview(undefined); setError(undefined); }} onSubmit={() => void switchDatabase()}/>;
  return <div className="modal-backdrop"><section className="connection-modal database-gate" role="dialog" aria-modal="true" aria-labelledby="database-gate-title">
    <header><div><h2 id="database-gate-title">{tr(setup ? "Set Database Password" : resetting ? "Reset the database password" : "Unlock this database")}</h2><p>{tr(setup ? "Set the password that protects your data in Athria and encrypts your saved connection keys." : resetting ? "Set a new database password. Your training data stays intact." : "This database has not been unlocked on this computer. Enter its database password to continue.")}</p></div></header>
    <form className="modal-body" onSubmit={(event) => { event.preventDefault(); if (!busy && !((setup || resetting) && (password.length === 0 || password !== confirmation))) void submit(); }}>
      <div className="gate-database-location"><span><T>{"Database"}</T></span><DraggableDatabasePath path={vault.data.databasePath}/></div>
      {resetting && <div className="database-reset-warning" role="alert"><strong><T>{"Connections are removed"}</T></strong><span><T>{"Saved connection keys are protected by the old password and will be permanently removed. Reconnect them in Connections afterwards."}</T></span></div>}
      <div className="gate-fields">
        <label>{tr(resetting ? "New password" : "Database password")}<input type="password" autoFocus autoComplete={setup || resetting ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)}/></label>
        {(setup || resetting) && <label><T>{"Confirm password"}</T><input type="password" className={mismatch ? "invalid" : undefined} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}/>{mismatch && <span className="field-error"><T>{"Passwords do not match."}</T></span>}</label>}
      </div>
      {!resetting && vault.data.canRemember && <label className="remember-field"><input type="checkbox" checked={rememberChoice} onChange={(event) => setRemember(event.target.checked)}/><T>{"Remember on this computer"}</T></label>}
      {setup && vault.data.legacySources.length > 0 && <p className="helper"><T>{"Credentials saved on this computer by an earlier Athria version will be moved into this database securely."}</T></p>}
      <ErrorBanner error={error}/>
      <div className="modal-actions"><button type="button" className="secondary gate-switch" disabled={busy} onClick={() => void chooseDatabase()}><T>{"Switch database"}</T></button>{!setup && !resetting && <button type="button" className="text-button gate-forgot" onClick={() => { setResetting(true); setPassword(""); setConfirmation(""); setError(undefined); }}><T>{"Forgot password?"}</T></button>}{resetting && <button type="button" className="text-button gate-forgot" onClick={() => { setResetting(false); setPassword(""); setConfirmation(""); setError(undefined); }}><T>{"Back to unlock"}</T></button>}<button type="submit" disabled={busy || ((setup || resetting) && (password.length === 0 || password !== confirmation))}>{tr(busy ? "Working…" : setup ? "Set password" : resetting ? "Reset password" : "Unlock")}</button></div>
    </form>
  </section></div>;
}

export async function previewRecoverySelection(
  pick: () => Promise<string | null>,
  preview: (path: string) => Promise<BackupPreview>,
): Promise<BackupPreview | undefined> {
  const path = await pick();
  return path ? preview(path) : undefined;
}

export function DatabaseRecovery({ status }: { status: StartupStatus }) {
  const client = useQueryClient();
  const [error, setError] = useState<unknown>();
  const [preview, setPreview] = useState<BackupPreview>();
  const [target, setTarget] = useState<string>();
  const [busy, setBusy] = useState(false);
  const recovered = async (action: () => Promise<unknown>) => {
    try { setBusy(true); setError(undefined); await action(); await client.cancelQueries(); client.clear(); window.location.reload(); }
    catch (value) { setError(value); setBusy(false); }
  };
  const chooseExisting = async () => {
    try {
      setError(undefined);
      const selected = await previewRecoverySelection(pickRestoreFile, (path) => api<BackupPreview>("/api/system/backup/preview", { method: "POST", body: JSON.stringify({ path }) }));
      if (selected) setPreview(selected);
    } catch (value) { setError(value); }
  };
  const chooseNew = async () => {
    try { setError(undefined); const path = await pickNewProfileDestination(); if (path) setTarget(path); }
    catch (value) { setError(value); }
  };
  return <><div className="modal-backdrop"><section className="connection-modal database-gate" role="alertdialog" aria-modal="true" aria-labelledby="database-recovery-title">
    <header><div><h2 id="database-recovery-title"><T>{"Choose a database to continue"}</T></h2><p><T>{"Athria could not open the configured database. Your original file has not been replaced."}</T></p></div></header>
    <div className="modal-body">
      <div className="gate-database-location"><span>{status.databasePath.endsWith(".json") ? tr("Configuration") : tr("Database")}</span><DraggableDatabasePath path={status.databasePath}/></div>
      <div role="alert" className="database-reset-warning"><T>{status.error ?? ""}</T></div>
      <ErrorBanner error={error}/>
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void chooseExisting()}><T>{"Choose existing database"}</T></button><button type="button" disabled={busy} onClick={() => void chooseNew()}><T>{"Create new database"}</T></button></div>
    </div>
  </section></div>
  {preview && <DatabaseSwitchModal preview={preview} error={error} busy={busy} onClose={() => { setPreview(undefined); setError(undefined); }} onSubmit={() => void recovered(() => restoreBackup(preview.path))}/>}
  {target && <NewProfileModal target={target} error={error} busy={busy} onClose={() => { setTarget(undefined); setError(undefined); }} onSubmit={() => void recovered(() => createNewProfile(target))}/>}
  </>;
}

export function App() {
  useEffect(() => {
    const preventPageZoom = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (["+", "=", "-", "_"].includes(event.key) || ["NumpadAdd", "NumpadSubtract"].includes(event.code)) event.preventDefault();
    };
    window.addEventListener("keydown", preventPageZoom, { capture: true });
    return () => window.removeEventListener("keydown", preventPageZoom, { capture: true });
  }, []);
  const startup = useQuery({ queryKey: ["startup-status"], queryFn: getStartupStatus, retry: false });
  if (startup.isPending) return <Loading/>;
  if (startup.isError) return <div className="startup-error"><ErrorBanner error={startup.error}/></div>;
  if (!startup.data.ready) return <DatabaseRecovery status={startup.data}/>;
  return <ReadyApp/>;
}

function ReadyApp() {
  const t = useT();
  const [page, setPage] = useState<Page>("Overview"); const View = views[page];
  const client = useQueryClient();
  const seenDatabaseVersion = useRef<DatabaseVersion | null>(null);
  const databaseVersion = useQuery({ queryKey: ["database-version"], queryFn: () => api<DatabaseVersion>("/api/system/database-version"), refetchInterval: 3000 });
  useEffect(() => {
    if (databaseVersion.data) seenDatabaseVersion.current = applyDatabaseVersion(client, seenDatabaseVersion.current, databaseVersion.data);
  }, [client, databaseVersion.data]);
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const primaryPages = dashboardPages.filter((item) => item.group === "primary");
  const supportPages = dashboardPages.filter((item) => item.group === "support");
  useEffect(() => { const openTraining = () => setPage("Training"); const openConnections = () => setPage("Connections"); window.addEventListener("athria-open-training", openTraining); window.addEventListener("athria-open-connections", openConnections); return () => { window.removeEventListener("athria-open-training", openTraining); window.removeEventListener("athria-open-connections", openConnections); }; }, []);
  const navIcons: Record<Page, IconName> = { Overview: "overview", Training: "training", Profile: "profile", Plan: "plan", Connections: "devices", Settings: "settings", Help: "help" };
  const NavItems = ({ items }: { items: typeof dashboardPages[number][] }) => <>{items.map((item) => <button key={item.id} className={item.id === page ? "active" : ""} aria-current={item.id === page ? "page" : undefined} onClick={() => setPage(item.id)}><AppIcon name={navIcons[item.id]}/>{t(item.label)}</button>)}</>;
  const preferredName = profile.data?.preferredName;
  return <><DatabaseGate/><AgentSkillUpdateCoordinator/><div className="shell"><aside><div className="brand"><img src="/athria-logo.svg" alt="Athria" /></div><nav aria-label={t("Main navigation")}><NavItems items={primaryPages}/></nav><div className="sidebar-lower"><nav className="support-nav" aria-label={t("Support navigation")}><NavItems items={supportPages}/></nav></div></aside><main className="primary-main">{page !== "Plan" && page !== "Profile" && page !== "Settings" && <PrimaryPageHeader preferredName={preferredName} subtitle={t(page === "Overview" ? "Let's keep the momentum going. Here's your overview for today." : page === "Training" ? "All your training in one place — every domain, every workout." : page === "Connections" ? "Sync your data from the apps and devices you use. Keep everything in one place." : page === "Help" ? "Guides for plans, training data, backups and connecting your AI agent." : "Your AI fitness hub. Local-first. Data you own.")}/>}<View/></main></div></>;
}
