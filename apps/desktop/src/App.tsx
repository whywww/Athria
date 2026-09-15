import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, changeDatabaseFile, getIntervalsStatus, getMcpStatus, getXunjiStatus, importXunjiSkill, pickBackupDestination, pickDatabaseFile, pickRestoreFile, restoreBackup, syncIntervals, syncXunji, testIntervals } from "./api";
import { mcpConfig, mcpGuides } from "./mcp-guides";
import {
  connectionSources, connectionStatusPresentation, dashboardPages, deviceTimezone, equipmentGroupState, filterAndSortTrainingHistory, formatDateTime, formatDuration, formatTimezoneLabel, formatTrainingRhythm, formatTrainingSource, friendlyLabel, isUntouchedDefaultProfile,
  paginateTrainingHistory, parseSyncRange, profilePayload, syncRangeOptions, timezoneOptions, PREFERENCE_MAX_LENGTH,
  toggleEquipmentGroup,
  type AthleteProfile, type BackupPreview, type CurrentPlan, type DoctorResult, type HevyImportStatus, type ImportPreview,
  type CalendarSession, type EquipmentCategory, type ImportResult, type NextTrainingDay, type PersonalInformation, type SyncRange, type TrainingHistorySession, type TrainingHistorySort, type TrainingTaxonomy, type TrainingSummary, type WellnessRecord, type XunjiConnectionStatus,
} from "./view-models";
import { Card, Empty, ErrorBanner, Loading, PrimaryPageHeader, weekdays } from "./components";
import { CurrentPlanPage, NextTrainingDayCard } from "./plan/CurrentPlanPage";
import { localDateForTimezone } from "./plan/view";
import { OverviewDashboard, overviewDateRange } from "./overview";

type Page = (typeof dashboardPages)[number]["id"];
const commonGoals = ["general_fitness", "build_strength", "build_muscle", "improve_endurance", "fat_loss"];

type IconName = "overview" | "training" | "profile" | "plan" | "devices" | "settings" | "help" | "globe" | "edit" | "target" | "preferences" | "rhythm" | "clock" | "equipment" | "sparkles" | "warning" | "notes" | "recovery" | "info" | "plus" | "refresh" | "database" | "upload" | "close";

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
  };
  return <svg className={`app-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function goalTone(goal: string) {
  switch (goal) {
    case "build_strength":
    case "build_muscle": return "coral";
    case "improve_endurance": return "yellow";
    case "general_fitness": return "green";
    case "fat_loss": return "purple";
    default: return "blue";
  }
}

function ServiceStatus() {
  const health = useQuery({ queryKey: ["doctor"], queryFn: () => api<DoctorResult>("/api/system/doctor"), retry: 3, retryDelay: 500 });
  const label = health.isPending ? "Starting…" : health.isError ? "Service unavailable" : "Local service";
  return <span className={`status ${health.isError ? "offline" : ""}`}><i/>{label}</span>;
}

function Overview() {
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const today = profile.data ? localDateForTimezone(profile.data.timezone) : null;
  const range = today ? overviewDateRange(today) : null;
  const query = useQuery({ queryKey: ["summary", range?.weekStart, today], queryFn: () => api<TrainingSummary>(`/api/summary?days=7&from=${range!.weekStart}&to=${today}`), enabled: range !== null });
  // P0-5: Today/Next surfaces the next training day on Overview (§3, §19).
  const nextDay = useQuery({ queryKey: ["next-training-day", today], queryFn: () => api<NextTrainingDay>(`/api/plans/next-training-day?onOrAfterDate=${today}`), enabled: today !== null });
  const plan = useQuery({ queryKey: ["current-plan"], queryFn: () => api<CurrentPlan | null>("/api/plans/current") });
  const wellness = useQuery({ queryKey: ["wellness", 42], queryFn: () => api<WellnessRecord[]>("/api/wellness?days=42") });
  const history = useQuery({ queryKey: ["sessions", "overview-calendar"], queryFn: () => api<TrainingHistorySession[]>("/api/sessions?days=365") });
  const calendar = useQuery({ queryKey: ["calendar", "overview-all"], queryFn: () => api<CalendarSession[]>("/api/plans/calendar") });
  if (query.isPending || profile.isPending || wellness.isPending || history.isPending || calendar.isPending) return <Loading/>;
  const error = query.error ?? profile.error ?? wellness.error ?? history.error ?? calendar.error;
  if (error || !query.data || !profile.data || !today) return <ErrorBanner error={error}/>;
  return <>
    <OverviewDashboard summary={query.data} wellness={wellness.data ?? []} history={history.data ?? []} planned={calendar.data ?? []} today={today} timezone={profile.data.timezone}/>
    <div className="overview-next-day">{plan.data && !nextDay.isPending && nextDay.data ? <NextTrainingDayCard value={nextDay.data} plan={plan.data} /> : !plan.data ? <div className="overview-plan-empty"><strong>No current plan</strong><span>Create a plan to see your next training day here.</span></div> : null}</div>
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

function Profile() {
  const client = useQueryClient();
  const profileQuery = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const taxonomy = useQuery({ queryKey: ["training-taxonomy"], queryFn: () => api<TrainingTaxonomy>("/api/training-taxonomy") });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<AthleteProfile | null>(null);
  const [customGoal, setCustomGoal] = useState("");
  const [availableGoals, setAvailableGoals] = useState<string[]>(commonGoals);
  const [saved, setSaved] = useState(false);
  const profile = profileQuery.data;
  const save = useMutation({
    mutationFn: (value: AthleteProfile) => api<AthleteProfile>("/api/profile", { method: "PUT", body: JSON.stringify(value) }),
    onSuccess: () => { setForm(null); setAvailableGoals(commonGoals); setEditing(false); setSaved(true); void client.invalidateQueries({ queryKey: ["profile"] }); },
  });
  useEffect(() => {
    if (!saved) return;
    const timeout = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(timeout);
  }, [saved]);
  if (profileQuery.isPending || taxonomy.isPending) return <Loading/>;
  if (profileQuery.isError || taxonomy.isError) return <ErrorBanner error={profileQuery.error ?? taxonomy.error}/>;
  if (!profile || !taxonomy.data) return <Loading/>;

  const toggleList = (field: "goals" | "equipment", value: string) => setForm((current) => current ? { ...current, [field]: current[field].includes(value) ? current[field].filter((item) => item !== value) : [...current[field], value] } : current);
  const toggleTrainingDay = (weekday: number) => setForm((current) => current?.trainingRhythm.kind === "fixed_week" ? { ...current, trainingRhythm: { ...current.trainingRhythm, days: current.trainingRhythm.days.includes(weekday) ? current.trainingRhythm.days.filter((day) => day !== weekday) : [...current.trainingRhythm.days, weekday].sort((a, b) => a - b) } } : current);
  const beginEdit = () => { setSaved(false); setCustomGoal(""); setAvailableGoals([...new Set([...commonGoals, ...profile.goals])]); setForm({ ...profile, timezone: isUntouchedDefaultProfile(profile) ? deviceTimezone() : profile.timezone, goals: [...profile.goals], trainingRhythm: profile.trainingRhythm.kind === "fixed_week" ? { ...profile.trainingRhythm, days: [...profile.trainingRhythm.days] } : { ...profile.trainingRhythm }, equipment: [...profile.equipment] }); setEditing(true); };
  const cancelEdit = () => { setForm(null); setCustomGoal(""); setAvailableGoals(commonGoals); setEditing(false); save.reset(); };

  const rhythmValid = !form || (form.trainingRhythm.kind === "fixed_week" ? form.trainingRhythm.days.length > 0 : form.trainingRhythm.kind === "flexible_week" ? form.trainingRhythm.minDaysPerWeek >= 1 && form.trainingRhythm.minDaysPerWeek <= form.trainingRhythm.targetDaysPerWeek && form.trainingRhythm.targetDaysPerWeek <= form.trainingRhythm.maxDaysPerWeek && form.trainingRhythm.maxDaysPerWeek <= 7 : form.trainingRhythm.intervalDays >= 1 && form.trainingRhythm.intervalDays <= 30);
  const profileActions = editing && form ? <div className="profile-actions"><label className="profile-timezone-field"><AppIcon name="globe"/><select className="profile-timezone-select" aria-label="Time zone" value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })}>{timezoneOptions(form.timezone).map((zone) => <option key={zone} value={zone}>{zone}{zone === deviceTimezone() ? " (device)" : ""}</option>)}</select></label><button type="button" className="secondary compact profile-cancel-button" onClick={cancelEdit}>Cancel</button><button type="button" className="compact profile-save-button" disabled={save.isPending || form.goals.length === 0 || !rhythmValid} onClick={() => { setSaved(false); save.mutate(profilePayload(profile, form)); }}>{save.isPending ? "Saving…" : "Save"}</button></div> : <div className="profile-actions"><span className="profile-timezone-pill"><AppIcon name="globe"/>{formatTimezoneLabel(profile.timezone)}</span><button type="button" className="secondary compact edit-button" onClick={beginEdit}><AppIcon name="edit"/>Edit</button></div>;

  return <div className="profile-page">
    <PrimaryPageHeader preferredName={profile.preferredName} subtitle="Your AI fitness hub. Local-first. Data you own."/>
    <Card title={<span className="profile-card-title"><span>Training Profile<small>Your training setup and preferences</small></span></span>} className={`profile-board ${editing ? "is-editing" : ""}`} action={profileActions}>
      <div className="profile-board-art" aria-hidden="true"><i/><i/><i/></div>
      {editing && form ? <EditableProfileBoard profile={profile} form={form} setForm={setForm} customGoal={customGoal} setCustomGoal={setCustomGoal} availableGoals={availableGoals} setAvailableGoals={setAvailableGoals} toggleList={toggleList} toggleTrainingDay={toggleTrainingDay}/> : <ProfileBoard profile={profile} equipmentCategories={taxonomy.data.equipmentCategories}/>}
      <ErrorBanner error={save.error}/>
      {saved && <div className="success">Profile saved! Your current plan may be affected — ask your AI agent to review and update it to match your new profile.</div>}
    </Card>
    {editing && form && <Card title={null} className="profile-equipment-board"><EquipmentSelector categories={taxonomy.data.equipmentCategories} selected={form.equipment} onToggleItem={(id) => toggleList("equipment", id)} onToggleGroup={(ids) => setForm((current) => current ? { ...current, equipment: toggleEquipmentGroup(current.equipment, ids) } : current)}/></Card>}
    <Card title={<span className="profile-card-title suggestions-title"><span className="profile-title-icon"><AppIcon name="sparkles"/></span><span>Agent Suggestions<small>Personalized guidance based on your profile</small></span></span>} className="profile-suggestions">
      <AgentManagedDetails profile={profile}/>
      <p className="profile-disclaimer"><AppIcon name="info"/>AI-generated planning suggestions only, not medical advice — consult a qualified professional for any injury, diagnosis, or treatment.</p>
    </Card>
  </div>;
}

function GroupCheckbox({ state, label, onChange }: { state: "none" | "some" | "all"; label: string; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = state === "some"; }, [state]);
  return <label className="equipment-group-toggle"><input ref={input} type="checkbox" checked={state === "all"} onChange={onChange}/><span>{label}</span></label>;
}

function EquipmentSelector({ categories, selected, onToggleItem, onToggleGroup }: { categories: EquipmentCategory[]; selected: string[]; onToggleItem?: (id: string) => void; onToggleGroup?: (ids: string[]) => void }) {
  const editable = Boolean(onToggleItem && onToggleGroup);
  const selectedItems = categories.flatMap((category) => category.groups.flatMap((group) => group.items)).filter((item) => selected.includes(item.id));
  if (!editable) return <section className="profile-section equipment-section"><div className="profile-section-heading"><AppIcon name="equipment"/><span><strong>Available equipment</strong><small>Select equipment available to you</small></span></div>{selectedItems.length ? <div className="equipment-items readonly-equipment">{selectedItems.map((item) => <span className="equipment-item selected" key={item.id}>{item.label}</span>)}</div> : <span className="muted-tag">None</span>}</section>;
  const visibleCategories = editable ? categories : categories.map((category) => ({ ...category, groups: category.groups.map((group) => ({ ...group, items: group.items.filter((item) => selected.includes(item.id)) })).filter((group) => group.items.length) })).filter((category) => category.groups.length);
  return <section className="profile-section equipment-section"><div className="profile-section-heading"><AppIcon name="equipment"/><span><strong>Available equipment</strong><small>Select equipment available to you</small></span></div>{visibleCategories.length ? <div className="equipment-categories">{visibleCategories.map((category) => <section className="equipment-category" key={category.id}><h3>{category.label}</h3><div className="equipment-groups">{category.groups.map((group) => {
    const ids = group.items.map((item) => item.id);
    return <div className="equipment-group" key={group.id}>{editable && onToggleGroup ? <GroupCheckbox state={equipmentGroupState(selected, ids)} label={group.label === category.label ? "Select all" : group.label} onChange={() => onToggleGroup(ids)}/> : <h4>{group.label === category.label ? "Equipment" : group.label}</h4>}<div className="equipment-items">{group.items.map((item) => {
      const isSelected = selected.includes(item.id);
      if (!editable) return <span className="equipment-item selected" key={item.id}>{item.label}</span>;
      return isSelected
        ? <span className="equipment-item selected" key={item.id}><span>{item.label}</span><button type="button" aria-label={`Remove ${item.label}`} onClick={() => onToggleItem?.(item.id)}>×</button></span>
        : <button type="button" className="equipment-item available" key={item.id} onClick={() => onToggleItem?.(item.id)}>+ {item.label}</button>;
    })}</div></div>;
  })}</div></section>)}</div> : <span className="muted-tag">None</span>}</section>;
}

function EditableProfileBoard({ profile, form, setForm, customGoal, setCustomGoal, availableGoals, setAvailableGoals, toggleList, toggleTrainingDay }: { profile: AthleteProfile; form: AthleteProfile; setForm: React.Dispatch<React.SetStateAction<AthleteProfile | null>>; customGoal: string; setCustomGoal: React.Dispatch<React.SetStateAction<string>>; availableGoals: string[]; setAvailableGoals: React.Dispatch<React.SetStateAction<string[]>>; toggleList: (field: "goals" | "equipment", value: string) => void; toggleTrainingDay: (weekday: number) => void }) {
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
      <section className="profile-goals-panel"><span className="profile-feature-icon" aria-hidden="true"><AppIcon name="target"/></span><div className="editable-panel-content"><strong>Training Goals</strong><small>What do you want to focus on?</small><div className="goal-tags">{availableGoals.map((goal) => commonGoals.includes(goal) ? <GoalTag key={goal} goal={goal} selected={form.goals.includes(goal)} onClick={() => toggleList("goals", goal)}/> : <GoalTag key={goal} goal={goal} selected={form.goals.includes(goal)} onClick={() => toggleList("goals", goal)} onDelete={() => deleteCustomGoal(goal)}/>)}</div><div className="inline-input"><input aria-label="Custom training goal" placeholder="Add another goal" value={customGoal} onChange={(event) => setCustomGoal(event.target.value)}/><button type="button" className="secondary" disabled={!customGoal.trim()} onClick={() => { const goal = customGoal.trim(); setAvailableGoals((current) => current.includes(goal) ? current : [...current, goal]); setForm((current) => current && !current.goals.includes(goal) ? { ...current, goals: [...current.goals, goal] } : current); setCustomGoal(""); }}>Add</button></div></div></section>
      <div className="profile-summary-item profile-preferences-editor"><div className="profile-editor-heading"><AppIcon name="preferences"/><span><strong className="profile-editor-title">Preferences</strong><small className="profile-editor-subtitle">Tell us more about your training</small></span></div><label className="profile-editor-control"><span className="sr-only">Training preferences</span><span className="preference-input"><textarea aria-label="Training preferences" rows={4} maxLength={PREFERENCE_MAX_LENGTH} value={form.preference} onChange={(event) => setForm({ ...form, preference: event.target.value })} placeholder="I prefer a varied mix of training styles."/><small>{form.preference.length}/{PREFERENCE_MAX_LENGTH}</small></span></label></div>
      <div className="profile-summary-item profile-rhythm-editor"><div className="profile-editor-heading"><AppIcon name="rhythm"/><span><strong className="profile-editor-title">Training rhythm</strong><small className="profile-editor-subtitle">How often do you want to train?</small></span></div><div className="profile-rhythm-options">
        <div className="profile-rhythm-option"><label><input type="radio" name="training-rhythm" checked={form.trainingRhythm.kind === "fixed_week"} onChange={() => changeRhythm("fixed_week")}/><span>Fixed week</span></label>{form.trainingRhythm.kind === "fixed_week" && <div className="day-list">{weekdays.map((day, index) => <button type="button" key={day} className={form.trainingRhythm.kind === "fixed_week" && form.trainingRhythm.days.includes(index) ? "selected" : ""} aria-pressed={form.trainingRhythm.kind === "fixed_week" && form.trainingRhythm.days.includes(index)} onClick={() => toggleTrainingDay(index)}>{day.slice(0, 3)}{form.trainingRhythm.kind === "fixed_week" && form.trainingRhythm.days.includes(index) ? " ✓" : ""}</button>)}</div>}</div>
        <div className="profile-rhythm-option"><label><input type="radio" name="training-rhythm" checked={form.trainingRhythm.kind === "flexible_week"} onChange={() => changeRhythm("flexible_week")}/><span>Flexible week</span></label>{form.trainingRhythm.kind === "flexible_week" && <div className="rhythm-parameters"><label>Target days<input type="number" min="1" max="7" value={form.trainingRhythm.targetDaysPerWeek} onChange={(event) => updateFlexibleRhythm("targetDaysPerWeek", Number(event.target.value))}/></label><label>Min<input type="number" min="1" max="7" value={form.trainingRhythm.minDaysPerWeek} onChange={(event) => updateFlexibleRhythm("minDaysPerWeek", Number(event.target.value))}/></label><label>Max<input type="number" min="1" max="7" value={form.trainingRhythm.maxDaysPerWeek} onChange={(event) => updateFlexibleRhythm("maxDaysPerWeek", Number(event.target.value))}/></label></div>}</div>
        <div className="profile-rhythm-option"><label><input type="radio" name="training-rhythm" checked={form.trainingRhythm.kind === "interval"} onChange={() => changeRhythm("interval")}/><span>Intervals</span></label>{form.trainingRhythm.kind === "interval" && <span className="interval-parameter">Every <input aria-label="Interval days" type="number" min="1" max="30" value={form.trainingRhythm.intervalDays} onChange={(event) => updateIntervalRhythm(Number(event.target.value))}/> days</span>}</div>
      </div></div>
      <div className="profile-summary-item profile-duration-editor"><div className="profile-editor-heading"><AppIcon name="clock"/><span><strong className="profile-editor-title">Max session length</strong><small className="profile-editor-subtitle">How much time per session?</small></span></div><label className="profile-editor-control"><span className="sr-only">Max session length</span><select aria-label="Max session length" value={form.maxSessionMinutes} onChange={(event) => setForm({ ...form, maxSessionMinutes: Number(event.target.value) })}>{[15, 30, 45, 60, 75, 90, 120, 180, 240].map((value) => <option key={value} value={value}>{value} min</option>)}</select></label></div>
    </section>
  </div>;
}

function ReadonlyTags({ values, empty = "None" }: { values: string[]; empty?: string }) {
  return <div className="readonly-tags">{values.length ? values.map((value) => <span key={value}>{friendlyLabel(value)}</span>) : <span className="muted-tag">{empty}</span>}</div>;
}

function AgentManagedDetails({ profile }: { profile: AthleteProfile }) {
  const rows: Array<{ label: string; description: string; icon: IconName; value?: string; notes?: string[] }> = [];
  if (profile.injuries.length) rows.push({ label: "Injuries", description: "These are taken into account when planning your training.", icon: "warning", notes: profile.injuries });
  if (profile.constraintNotes.length) rows.push({ label: "Constraint notes", description: "These help guide exercise selection and programming.", icon: "notes", notes: profile.constraintNotes });
  if (profile.explicitRecoveryDays !== null) rows.push({ label: "Recovery interval", description: "This guides spacing between demanding sessions.", icon: "recovery", value: `${profile.explicitRecoveryDays} day${profile.explicitRecoveryDays === 1 ? "" : "s"} between hard sessions` });
  if (!rows.length) return <div className="agent-managed-empty">No injuries or training constraints recorded.</div>;
  return <div className="agent-managed-grid">{rows.map((row) => <article className="agent-managed-card" key={row.label}><span className="agent-card-icon"><AppIcon name={row.icon}/></span><div><strong>{row.label}</strong><p>{row.description}</p>{row.notes ? <ol className="agent-note-list">{row.notes.map((note, index) => <li key={index}>{note}</li>)}</ol> : <span className="agent-value">{row.value}</span>}</div></article>)}</div>;
}

function ProfileBoard({ profile, equipmentCategories }: { profile: AthleteProfile; equipmentCategories: EquipmentCategory[] }) {
  return <div className="profile-content">
    <section className="profile-top-summary profile-readonly-summary">
      <section className="profile-goals-panel"><span className="profile-feature-icon" aria-hidden="true"><AppIcon name="target"/></span><div><strong>Training Goals</strong><small>What do you want to focus on?</small>{profile.goals.length ? <div className="goal-tags">{profile.goals.map((goal) => <GoalTag key={goal} goal={goal}/>)}</div> : <p>No goals selected</p>}</div></section>
      <div className="profile-summary-item"><AppIcon name="preferences"/><div><span>Preferences</span><strong>{profile.preference || "Not set"}</strong></div></div>
      <div className="profile-summary-item profile-rhythm-summary"><AppIcon name="rhythm"/><div><span>Training rhythm</span><strong>{formatTrainingRhythm(profile.trainingRhythm)}</strong></div></div>
      <div className="profile-summary-item"><AppIcon name="clock"/><div><span>Max session length</span><strong>{profile.maxSessionMinutes} min</strong></div></div>
    </section>
    <EquipmentSelector categories={equipmentCategories} selected={profile.equipment}/>
  </div>;
}

type ConnectionDialog = "hevy" | "intervals" | "xunji" | null;

function ProviderLogo({ source }: { source: "hevy" | "intervals" | "xunji" }) {
  if (source === "intervals") return <span className="provider-logo intervals-logo" aria-hidden="true"><i/><i/><i/></span>;
  if (source === "xunji") return <span className="provider-logo xunji-logo" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="m12 11 25 26M36 11 11 36"/></svg></span>;
  return <span className="provider-logo hevy-logo" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M12 18v12M8 20v8M36 18v12M40 20v8M12 24h24M17 15v18M31 15v18"/></svg></span>;
}

function SourceBadge({ tone, children }: { tone: "connected" | "partial" | "failed" | "neutral"; children: React.ReactNode }) {
  return <span className={`source-status ${tone}`}><i/>{children}</span>;
}

function SourceCard({ source, title, description, badge, lastSyncLabel, lastSync, action, menuLabel, onMenuAction, feedback }: { source: "hevy" | "intervals" | "xunji"; title: string; description: string; badge: React.ReactNode; lastSyncLabel: string; lastSync: string; action: React.ReactNode; menuLabel: string; onMenuAction: () => void; feedback?: React.ReactNode }) {
  return <article className="source-card"><div className="source-card-main"><ProviderLogo source={source}/><div className="source-title"><div><h2>{title}</h2>{badge}</div><p>{description}</p></div><Metric icon="clock" label={lastSyncLabel} value={lastSync}/></div>{feedback}<footer>{action}<details className="source-menu"><summary aria-label={`More options for ${title}`}>•••</summary><div><button type="button" onClick={onMenuAction}>{menuLabel}</button></div></details></footer></article>;
}

function Metric({ icon, label, value }: { icon: "clock" | "database" | "upload"; label: string; value: string }) {
  return <div className="source-metric"><AppIcon name={icon}/><div><span>{label}</span><strong title={value}>{value}</strong></div></div>;
}

function AvailableSourceCard({ source, title, description, onConnect }: { source: "hevy" | "intervals" | "xunji"; title: string; description: string; onConnect: () => void }) {
  return <article className="available-source-card"><ProviderLogo source={source}/><div><h3>{title}</h3><p>{description}</p><button type="button" className="connect-source-button" onClick={onConnect}><AppIcon name="plus"/>Connect</button></div><span className="available-source-arrow" aria-hidden="true">›</span></article>;
}

function ConnectionModal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="connection-modal" role="dialog" aria-modal="true" aria-labelledby="connection-modal-title"><header><div><h2 id="connection-modal-title">{title}</h2>{description && <p>{description}</p>}</div><button type="button" className="modal-close" aria-label="Close dialog" onClick={onClose}><AppIcon name="close"/></button></header><div className="modal-body">{children}</div></section></div>;
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
  const [xunjiError, setXunjiError] = useState<unknown>(); const [xunjiMessage, setXunjiMessage] = useState(""); const [xunjiBusy, setXunjiBusy] = useState(false);
  const [intervalsRange, setIntervalsRange] = useState<SyncRange>("incremental"); const [xunjiRange, setXunjiRange] = useState<SyncRange>("incremental");
  const [key, setKey] = useState(""); const [athleteId, setAthleteId] = useState("0");
  const onFile = async (file: File) => { try { setHevyError(undefined); setImportResult(undefined); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; bytes.forEach((byte) => { binary += String.fromCharCode(byte); }); setPreview(await api<ImportPreview>("/api/imports/hevy/preview", { method: "POST", body: JSON.stringify({ fileName: file.name, contentBase64: btoa(binary) }) })); } catch (value) { setHevyError(value); } };
  const closeDialog = () => { setDialog(null); setPreview(undefined); setXunjiSkill(""); setKey(""); setHevyError(undefined); setIntervalsError(undefined); setXunjiError(undefined); };
  useEffect(() => { if (!dialog) return; const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeDialog(); }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, [dialog]);
  const openIntervals = () => { setAthleteId(intervalsStatus.data?.athleteId ?? "0"); setIntervalsMessage(""); setDialog("intervals"); };
  const commit = async () => { if (!preview?.previewToken) return; try { setHevyError(undefined); setImportResult(await api<ImportResult>("/api/imports/hevy/commit", { method: "POST", body: JSON.stringify({ previewToken: preview.previewToken }) })); setPreview(undefined); setDialog(null); await client.invalidateQueries({ queryKey: ["hevy-status"] }); } catch (value) { setHevyError(value); } };
  const saveIntervals = async () => { try { setIntervalsError(undefined); await testIntervals(key, athleteId); setIntervalsMessage("Connected. Your credentials were saved securely on this device."); setKey(""); setDialog(null); await client.invalidateQueries({ queryKey: ["intervals-status"] }); } catch (value) { setIntervalsError(value); } };
  const sync = async (range: SyncRange = "incremental", closeOnSuccess = false) => { try { setIntervalsBusy(true); setIntervalsError(undefined); const result = await syncIntervals(range) as ImportResult & { sync?: { status?: string } }; setIntervalsMessage(`Sync ${result.sync?.status ?? "complete"}: ${result.added ?? 0} added, ${result.updated ?? 0} updated.`); await Promise.all([client.invalidateQueries({ queryKey: ["intervals-status"] }), client.invalidateQueries({ queryKey: ["sessions"] }), client.invalidateQueries({ queryKey: ["summary"] }), client.invalidateQueries({ queryKey: ["state"] })]); if (closeOnSuccess) setDialog(null); } catch (value) { setIntervalsError(value); } finally { setIntervalsBusy(false); } };
  const refreshXunjiViews = async () => { await Promise.all([client.invalidateQueries({ queryKey: ["xunji-status"] }), client.invalidateQueries({ queryKey: ["sessions"] }), client.invalidateQueries({ queryKey: ["summary"] }), client.invalidateQueries({ queryKey: ["state"] })]); };
  const connectXunji = async () => { try { setXunjiBusy(true); setXunjiError(undefined); const result = await importXunjiSkill(xunjiSkill) as ImportResult & { sync?: { status?: string } }; setXunjiMessage(`Sync ${result.sync?.status ?? "complete"}: ${result.added ?? 0} added, ${result.updated ?? 0} updated.`); setXunjiSkill(""); setDialog(null); await refreshXunjiViews(); } catch (value) { setXunjiError(value); } finally { setXunjiBusy(false); } };
  const runXunjiSync = async (range: SyncRange = "incremental", closeOnSuccess = false) => { try { setXunjiBusy(true); setXunjiError(undefined); const result = await syncXunji(range) as ImportResult & { sync?: { status?: string } }; setXunjiMessage(`Sync ${result.sync?.status ?? "complete"}: ${result.added ?? 0} added, ${result.updated ?? 0} updated.`); await refreshXunjiViews(); if (closeOnSuccess) setDialog(null); } catch (value) { setXunjiError(value); } finally { setXunjiBusy(false); } };
  const intervals = intervalsStatus.data; const xunji = xunjiStatus.data;
  const sources = connectionSources(Boolean(intervals?.configured), Boolean(xunji?.configured), Boolean(hevyStatus.data));
  return <section className="connections-page">
    <header className="connections-header"><h1>Connections</h1><p>Sync your data from the apps and devices you use. Keep everything in one place.</p></header>
    <section className="connections-section"><h2>Connected ({sources.added.length})</h2><div className="connected-sources-grid">
      {hevyStatus.data && <SourceCard source="hevy" title="Hevy" description="Strength training workouts" badge={<SourceBadge tone="connected">Imported</SourceBadge>} lastSyncLabel="Last imported" lastSync={formatDateTime(hevyStatus.data.importedAt)} feedback={<><ErrorBanner error={hevyStatus.error ?? hevyError}/>{importResult && <div className="source-feedback success">Import complete: {importResult.added ?? 0} added, {importResult.updated ?? 0} updated.</div>}</>} action={<button type="button" className="source-action primary" onClick={() => setDialog("hevy")}><AppIcon name="upload"/>Import again</button>} menuLabel="Choose another CSV" onMenuAction={() => setDialog("hevy")}/>}
      {intervals?.configured && <SourceCard source="intervals" title="Intervals.icu" description="Endurance activities and performance metrics." badge={<SourceBadge tone={connectionStatusPresentation(intervals.sync?.status).tone}>{connectionStatusPresentation(intervals.sync?.status).label}</SourceBadge>} lastSyncLabel="Last synced" lastSync={intervals.sync?.lastSuccessAt ? formatDateTime(intervals.sync.lastSuccessAt) : "Not yet completed"} feedback={<><ErrorBanner error={intervalsStatus.error ?? intervalsError}/>{intervalsMessage && <div className="source-feedback success">{intervalsMessage}</div>}</>} action={<button type="button" className="source-action primary" disabled={intervalsBusy} onClick={() => void sync()}><AppIcon name="refresh"/>{intervalsBusy ? "Syncing…" : "Sync now"}</button>} menuLabel="Edit connection" onMenuAction={openIntervals}/>}
      {xunji?.configured && <SourceCard source="xunji" title="Xunji" description="Strength and training records" badge={<SourceBadge tone={connectionStatusPresentation(xunji.sync?.status).tone}>{connectionStatusPresentation(xunji.sync?.status).label}</SourceBadge>} lastSyncLabel="Last synced" lastSync={xunji.sync?.lastSuccessAt ? formatDateTime(xunji.sync.lastSuccessAt) : "Not yet completed"} feedback={<><ErrorBanner error={xunjiStatus.error ?? xunjiError}/>{xunjiMessage && <div className="source-feedback success">{xunjiMessage}</div>}</>} action={<button type="button" className="source-action primary" disabled={xunjiBusy} onClick={() => void runXunjiSync()}><AppIcon name="refresh"/>{xunjiBusy ? "Syncing…" : "Sync now"}</button>} menuLabel="Edit connection" onMenuAction={() => setDialog("xunji")}/>}
      {!intervalsStatus.isPending && !xunjiStatus.isPending && !hevyStatus.isPending && sources.added.length === 0 && <div className="connections-empty"><span><AppIcon name="plus"/></span><strong>No connections yet</strong><p>Choose one of the available connections below to get started.</p></div>}
    </div></section>
    <section className="connections-section available-connections"><h2>Available Connections</h2>{sources.available.length ? <div className="available-sources-grid">
      {sources.available.includes("hevy") && <AvailableSourceCard source="hevy" title="Hevy" description="Import strength workouts from a CSV export." onConnect={() => setDialog("hevy")}/>}
      {sources.available.includes("intervals") && <AvailableSourceCard source="intervals" title="Intervals.icu" description="Sync endurance activities and wellness data." onConnect={openIntervals}/>}
      {sources.available.includes("xunji") && <AvailableSourceCard source="xunji" title="Xunji" description="Sync strength and training records." onConnect={() => setDialog("xunji")}/>}
    </div> : <div className="available-sources-empty"><span>✓</span><div><strong>All supported connections are connected</strong><p>Manage or sync them from the cards above.</p></div></div>}</section>
    {dialog === "intervals" && <ConnectionModal title={intervals?.configured ? "Edit Intervals.icu" : "Connect Intervals.icu"} description="Your credentials are stored securely on this device." onClose={closeDialog}><label>API key<input type="password" autoComplete="off" autoFocus placeholder={intervals?.configured ? "Enter a new key to replace the saved key" : "Enter API key"} value={key} onChange={(event) => setKey(event.target.value)}/></label><label>Athlete ID<input value={athleteId} onChange={(event) => setAthleteId(event.target.value)}/></label><label>Sync range<select aria-label="Intervals.icu sync range" value={intervalsRange} onChange={(event) => setIntervalsRange(parseSyncRange(event.target.value))}>{syncRangeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><p className="helper">Find your API key and Athlete ID in Intervals.icu → Settings → Developer Settings.</p><ErrorBanner error={intervalsError}/><div className="modal-actions"><button type="button" className="secondary" onClick={closeDialog}>Cancel</button>{intervals?.configured && <button type="button" className="secondary" disabled={intervalsBusy} onClick={() => void sync(intervalsRange, true)}>{intervalsBusy ? "Syncing…" : "Sync selected range"}</button>}<button type="button" disabled={!key} onClick={() => void saveIntervals()}>Test and save</button></div></ConnectionModal>}
    {dialog === "xunji" && <ConnectionModal title={xunji?.configured ? "Edit Xunji" : "Connect Xunji"} description="Paste the complete training-data Skill exported by Xunji." onClose={closeDialog}><label>Xunji exported Skill<textarea rows={8} autoComplete="off" autoFocus spellCheck={false} placeholder="Paste the complete Skill exported by Xunji" value={xunjiSkill} onChange={(event) => setXunjiSkill(event.target.value)}/></label><label>Sync range<select aria-label="Xunji sync range" value={xunjiRange} onChange={(event) => setXunjiRange(parseSyncRange(event.target.value))}>{syncRangeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><p className="helper">Athria extracts only the API key. The pasted text is never stored.</p><ErrorBanner error={xunjiError}/><div className="modal-actions"><button type="button" className="secondary" onClick={closeDialog}>Cancel</button>{xunji?.configured && <button type="button" className="secondary" disabled={xunjiBusy} onClick={() => void runXunjiSync(xunjiRange, true)}>{xunjiBusy ? "Syncing…" : "Sync selected range"}</button>}<button type="button" disabled={!xunjiSkill.trim() || xunjiBusy} onClick={() => void connectXunji()}>{xunjiBusy ? "Connecting and syncing…" : "Connect and sync"}</button></div></ConnectionModal>}
    {dialog === "hevy" && <ConnectionModal title="Import from Hevy" description="Select a CSV export, review it, then import the workouts." onClose={closeDialog}><label>Hevy CSV export<input type="file" accept=".csv,text/csv" onChange={(event) => event.target.files?.[0] && void onFile(event.target.files[0])}/></label>{preview && <ImportSummary value={preview}><button type="button" onClick={() => void commit()}>Import reviewed workouts</button></ImportSummary>}<ErrorBanner error={hevyError}/></ConnectionModal>}
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
  const path = {
    strength: <><path d="M7 9v6M4.5 10.5v3M17 9v6M19.5 10.5v3M7 12h10"/><path d="M9.5 8v8M14.5 8v8"/></>,
    endurance: <><circle cx="13.5" cy="5.5" r="1.7"/><path d="m11.5 9 2.3 2.1 2.8.7M13.8 11.1l-2 3.2-3.5 1.2M11.8 14.3l3 4.2M10.8 9.2 8.5 12"/></>,
    sport_skill: <><circle cx="12" cy="12" r="7.5"/><path d="M12 4.5v15M4.5 12h15M6.7 6.7c2.8 2.7 2.8 7.9 0 10.6M17.3 6.7c-2.8 2.7-2.8 7.9 0 10.6"/></>,
    mind_body: <><circle cx="12" cy="6" r="1.8"/><path d="M12 8v4M12 10l-4 3M12 10l4 3M12 12l-3 5M12 12l3 5M7 18c2-1 3.5-.8 5 .8 1.5-1.6 3-1.8 5-.8"/></>,
    recovery: <><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></>,
    unclassified: <><circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16h.01"/></>,
  }[type];
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>;
}

function workoutDateTime(item: TrainingHistorySession, fallbackTimezone: string): { date: string; time: string } {
  const timeZone = item.timezone ?? fallbackTimezone;
  const instant = new Date(item.startAt);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(instant);
  const time = item.timePrecision === "date_only" ? "-" : new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(instant).toLocaleLowerCase();
  return { date, time };
}

function trainingHistorySourceLabel(source: string): string {
  return ({ manual: "Manual", xunji: "Xunji" } as Record<string, string>)[source] ?? formatTrainingSource(source);
}

function TimelineWorkout({ item, planned, revision, timezone, onMutated }: { item: TrainingHistorySession; planned: CalendarSession[]; revision: number; timezone: string; onMutated: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(); const [editing, setEditing] = useState(false); const [typeOpen, setTypeOpen] = useState(false); const rowRef = useRef<HTMLElement>(null); const menuRef = useRef<HTMLDetailsElement>(null);
  const [duration, setDuration] = useState(String(item.durationMinutes)); const [startAt, setStartAt] = useState("");
  const day = workoutLocalDate(item, timezone);
  const displayType = trainingDisplayType(item); const dateTime = workoutDateTime(item, timezone);
  const compatible = (session: CalendarSession) => session.components.some((component) => component.domain.value !== null && item.domains.includes(component.domain.value));
  const eligible = planned.filter((session) => session.scheduledDate === day && session.status !== "skipped").sort((left, right) => Number(compatible(right)) - Number(compatible(left)) || Number(Boolean(left.completedTrainingSessionId)) - Number(Boolean(right.completedTrainingSessionId)));
  useEffect(() => { if (!typeOpen) return; const close = (event: PointerEvent) => { if (!rowRef.current?.contains(event.target as Node)) setTypeOpen(false); }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, [typeOpen]);
  const mutate = async (path: string, init: RequestInit): Promise<boolean> => { setBusy(true); setError(undefined); try { await api(path, init); await onMutated(); return true; } catch (value) { setError(value); return false; } finally { setBusy(false); } };
  const changeMatch = async (value: string) => {
    if (value === "__automatic__") return mutate(`/api/training-sessions/${encodeURIComponent(item.id)}/automatic-match`, { method: "POST", body: JSON.stringify({ confirmed: true }) });
    const target = eligible.find((session) => session.id === value);
    if (target?.completedTrainingSessionId && target.completedTrainingSessionId !== item.id && !window.confirm(`${target.name} is linked to another workout. Replace that link?`)) return;
    return mutate(`/api/training-sessions/${encodeURIComponent(item.id)}/plan-match`, { method: "PATCH", body: JSON.stringify({ plannedSessionId: value, expectedRevision: revision, confirmed: true }) });
  };
  const changeType = async (domain: Exclude<TrainingDisplayType, "unclassified">) => { if (domain === displayType.id) { setTypeOpen(false); return; } if (await mutate(`/api/training-sessions/${encodeURIComponent(item.id)}/type`, { method: "PATCH", body: JSON.stringify({ domain, confirmed: true }) })) setTypeOpen(false); };
  const resetManualDraft = () => { setDuration(String(item.durationMinutes)); setStartAt(""); };
  const beginManualEdit = () => { resetManualDraft(); setEditing(true); };
  const cancelManualEdit = () => { resetManualDraft(); setEditing(false); };
  const saveManual = async () => {
    const parsedDuration = Number(duration); const payload: Record<string, unknown> = { confirmed: true, durationMinutes: parsedDuration };
    if (startAt) payload.startAt = new Date(startAt).toISOString();
    if (await mutate(`/api/training-sessions/${encodeURIComponent(item.id)}/manual`, { method: "PATCH", body: JSON.stringify(payload) })) { setEditing(false); menuRef.current?.removeAttribute("open"); }
  };
  const removeManual = () => { if (window.confirm("Remove the manual workout record? Synced sources will be kept.")) void mutate(`/api/training-sessions/${encodeURIComponent(item.id)}/manual`, { method: "DELETE", body: JSON.stringify({ confirmed: true }) }); };
  const deleteRecord = () => { if (window.confirm("Delete this workout record and all of its source data? A synced workout may be imported again during a future sync.")) void mutate(`/api/training-sessions/${encodeURIComponent(item.id)}`, { method: "DELETE", body: JSON.stringify({ confirmed: true }) }); };
  const hasManual = item.sources.some((source) => source.source === "manual");
  const hasSynced = item.sources.some((source) => source.source !== "manual");
  const subtitle = item.sport || (item.domains.length > 1 ? item.domains.map(friendlyLabel).join(" + ") : `${displayType.label} workout`);
  return <article className="training-row" key={item.id} ref={rowRef}>
    <div className="training-workout-cell"><span className={`training-type-icon ${displayType.id}`}><TrainingTypeIcon type={displayType.id}/></span><span><strong>{item.name}</strong><small>{subtitle}</small></span></div>
    <div className="training-date-cell"><strong>{dateTime.date}</strong><small>{dateTime.time}</small></div>
    <div className="training-type-cell"><button type="button" className={`training-type-badge ${displayType.id}`} aria-expanded={typeOpen} aria-label={`Change type for ${item.name}`} disabled={busy} onClick={() => setTypeOpen((value) => !value)}>{displayType.label}</button></div>
    <div className="training-duration-cell"><AppIcon name="clock"/><span>{formatDuration(item.durationMinutes)}{item.timePrecision === "date_only" ? <small>Estimated</small> : null}</span></div>
    <div className="training-source-cell"><span>{trainingHistorySourceLabel(item.source)}</span></div>
    <div className="training-plan-cell"><span className={`training-plan-mark ${item.planMatch ? "matched" : ""}`} aria-label={item.planMatch ? `${item.name} is matched to a planned session` : `${item.name} is not matched to a planned session`} title={item.planMatch ? "Matched to a planned session" : undefined}>{item.planMatch ? "✓" : ""}</span></div>
    <div className="training-actions-cell"><details className={editing ? "training-row-menu editing" : "training-row-menu"} ref={menuRef} onToggle={(event) => { if (!event.currentTarget.open && editing) cancelManualEdit(); }}><summary aria-label={`Actions for ${item.name}`}>•••</summary><div>{editing ? <div className="training-row-menu-editor"><label>Duration (minutes)<input type="number" min="1" max="1440" disabled={busy} value={duration} onChange={(event) => setDuration(event.target.value)}/></label><label>Actual start time<input type="datetime-local" disabled={busy} value={startAt} onChange={(event) => setStartAt(event.target.value)}/></label><div className="training-row-menu-editor-actions"><button type="button" className="secondary" disabled={busy} onClick={cancelManualEdit}>Cancel</button><button type="button" className="training-row-menu-save" disabled={busy || !Number.isInteger(Number(duration)) || Number(duration) < 1} onClick={() => void saveManual()}>{busy ? "Saving…" : "Save"}</button></div></div> : <><label className="training-row-menu-plan"><span>Planned session</span><select aria-label={`Planned session for ${item.name}`} disabled={busy} value={item.planMatch?.plannedSessionId ?? ""} onChange={(event) => void changeMatch(event.target.value)}><option value="" disabled>-</option>{eligible.map((session) => <option key={session.id} value={session.id}>{session.name}{!compatible(session) ? " · different domain" : ""}{session.completedTrainingSessionId && session.completedTrainingSessionId !== item.id ? " · linked" : ""}</option>)}{item.isPlanMatchExcluded && <option value="__automatic__">Allow automatic matching</option>}</select>{item.planMatch && <small>{item.planMatch.method === "manual" ? "Linked by you" : "Matched automatically"}</small>}</label>{hasManual && <button type="button" disabled={busy} onClick={beginManualEdit}>Edit manual details</button>}{hasManual && hasSynced && <button type="button" className="danger-text" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); removeManual(); }}>Remove manual source</button>}<button type="button" className="danger-text" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); deleteRecord(); }}>Delete record</button></>}</div></details></div>
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
  const plannedNames = useMemo(() => Object.fromEntries((calendar.data ?? []).map((session) => [session.id, session.name])), [calendar.data]);
  const filtered = useMemo(() => filterAndSortTrainingHistory(query.data ?? [], search, sort, plannedNames), [query.data, search, sort, plannedNames]);
  const pagination = paginateTrainingHistory(filtered, page);
  useEffect(() => { if (page !== pagination.page) setPage(pagination.page); }, [page, pagination.page]);
  const loading = query.isPending || calendar.isPending || plan.isPending || profile.isPending;
  return <section className="card training-history">
    <div className="training-history-header"><div><h2>Training history</h2><p>Your recent workouts, sessions and activities.</p></div><div className="training-history-tools"><label className="training-search"><span className="sr-only">Search workouts</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><input type="search" placeholder="Search workouts..." value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }}/></label><label className="training-sort"><span className="sr-only">Sort training history</span><select aria-label="Sort training history" value={sort} onChange={(event) => { setSort(event.target.value as TrainingHistorySort); setPage(1); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label></div></div>
    <ErrorBanner error={error}/>
    {loading ? <Loading/> : <><div className="training-table-scroll"><div className="training-table"><div className="training-table-heading" aria-hidden="true"><span>Workout</span><span>Date &amp; time</span><span>Type</span><span>Duration</span><span>Source</span><span className="training-plan-heading">Plan Matched</span><span/></div><div className="training-table-body">{pagination.items.map((item) => <TimelineWorkout key={item.id} item={item} planned={calendar.data ?? []} revision={plan.data?.revision ?? 0} timezone={profile.data?.timezone ?? "UTC"} onMutated={refresh}/>)}{!query.data?.length ? <Empty>No workouts imported yet.</Empty> : !filtered.length ? <Empty>No workouts match your search.</Empty> : null}</div></div></div><footer className="training-history-footer"><span>{filtered.length ? `Showing ${pagination.start}–${pagination.end} of ${filtered.length} sessions` : "Showing 0 sessions"}</span><div><button type="button" aria-label="Previous page" disabled={pagination.page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>‹</button><button type="button" aria-label="Next page" disabled={pagination.page === pagination.totalPages} onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))}>›</button></div></footer></>}
  </section>;
}

function Backup() {
  const doctor = useQuery({ queryKey: ["backup-doctor"], queryFn: () => api<DoctorResult>("/api/system/doctor") });
  const databasePath = (doctor.data as DoctorResult | undefined)?.databasePath;
  const [message, setMessage] = useState(""); const [error, setError] = useState<unknown>();
  const [preview, setPreview] = useState<BackupPreview>(); const [restoring, setRestoring] = useState(false);
  const [pendingLocation, setPendingLocation] = useState(""); const [moving, setMoving] = useState(false);
  const createBackup = async () => { setError(undefined); setMessage(""); try { const path = await pickBackupDestination(); if (path) { const result = await api<{ path: string }>("/api/system/backup", { method: "POST", body: JSON.stringify({ path }) }); setMessage(`Backup created at ${result.path}`); } } catch (value) { setError(value); } };
  const chooseBackup = async () => {
    setError(undefined); setMessage(""); setPreview(undefined);
    try {
      const path = await pickRestoreFile();
      if (path) setPreview(await api<BackupPreview>("/api/system/backup/preview", { method: "POST", body: JSON.stringify({ path }) }));
    } catch (value) { setError(value); }
  };
  const confirmRestore = async () => {
    if (!preview) return;
    try { setRestoring(true); setError(undefined); await restoreBackup(preview.path); }
    catch (value) { setRestoring(false); setError(value); }
  };
  const chooseLocation = async () => {
    setError(undefined);
    try {
      const picked = await pickDatabaseFile();
      if (picked) setPendingLocation(picked);
    } catch (value) { setError(value); }
  };
  const confirmLocation = async () => {
    try { setMoving(true); setError(undefined); await changeDatabaseFile(pendingLocation); }
    catch (value) { setMoving(false); setError(value); }
  };
  return <Card title="Backup and restore">
    <p>Your training data is stored in one local SQLite database. Account credentials are never included.</p>
    {databasePath && <div className="data-location">
      <strong>Local database</strong>
      <span>{databasePath}</span>
      <small>Athria opens this database file directly.</small>
      {pendingLocation
        ? <div className="data-location-confirm">
          <p>Athria will open <b>{pendingLocation}</b> and restart. The selected database will not be copied or moved.</p>
          <div className="data-location-actions">
            <button type="button" className="secondary compact" disabled={moving} onClick={() => setPendingLocation("")}>Cancel</button>
            <button type="button" className="compact" disabled={moving} onClick={() => void confirmLocation()}>{moving ? "Opening database…" : "Open database and restart"}</button>
          </div>
        </div>
        : <div className="data-location-actions"><button type="button" className="secondary compact" onClick={() => void chooseLocation()}>Change location</button></div>}
    </div>}
    <div className="section"><h3>Create a backup</h3><p>Save a self-contained copy of your active SQLite database.</p><button onClick={() => void createBackup()}>Create backup</button></div>
    <div className="section"><h3>Restore a backup</h3><p>Select an Athria .sqlite3 file to inspect it before replacing your active database.</p>
      {!preview
        ? <button type="button" className="secondary" onClick={() => void chooseBackup()}>Choose backup</button>
        : <div className="restore-confirm">
          <strong>Restore this backup?</strong>
          <span className="restore-path">{preview.path}</span>
          <div className="restore-summary">
            <span><b>{preview.counts.workouts}</b><small>workouts</small></span>
            <span><b>{preview.counts.templates}</b><small>templates</small></span>
            <span><b>{preview.counts.plans}</b><small>plans</small></span>
          </div>
          <p>Your active database will be replaced without keeping a safety copy. Its file location will not change. Athria will restart when restoration is complete.</p>
          <div className="data-location-actions">
            <button type="button" className="secondary compact" disabled={restoring} onClick={() => setPreview(undefined)}>Cancel</button>
            <button type="button" className="compact" disabled={restoring} onClick={() => void confirmRestore()}>{restoring ? "Preparing restore…" : "Restore and restart"}</button>
          </div>
        </div>}
    </div>
    {message && <div className="success">{message}</div>}
    <ErrorBanner error={doctor.error ?? error}/>
  </Card>;
}

function PersonalInformationCard() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["personal-information"], queryFn: () => api<PersonalInformation>("/api/personal-information") });
  const [form, setForm] = useState<PersonalInformation | null>(null);
  const [weightText, setWeightText] = useState("");
  const [weightChanged, setWeightChanged] = useState(false);
  const save = useMutation({
    mutationFn: (value: Record<string, unknown>) => api<PersonalInformation>("/api/personal-information", { method: "PUT", body: JSON.stringify(value) }),
    onSuccess: async () => { setForm(null); setWeightChanged(false); await Promise.all(["personal-information", "profile", "state", "wellness"].map((key) => client.invalidateQueries({ queryKey: [key] }))); },
  });
  if (query.isPending) return <Card title="Personal Information"><Loading/></Card>;
  if (query.isError || !query.data) return <Card title="Personal Information"><ErrorBanner error={query.error}/></Card>;
  const value = query.data;
  const begin = () => { setForm({ ...value }); setWeightText(value.weightKg?.toString() ?? ""); setWeightChanged(false); save.reset(); };
  const cancel = () => { setForm(null); setWeightChanged(false); save.reset(); };
  const submit = () => {
    if (!form) return;
    const payload: Record<string, unknown> = { preferredName: form.preferredName.trim(), gender: form.gender, heightCm: form.heightCm, birthDate: form.birthDate, expectedSnapshotHash: value.snapshotHash };
    if (weightChanged) payload.weightKg = weightText.trim() ? Number(weightText) : null;
    save.mutate(payload);
  };
  const genderLabel = value.gender ? friendlyLabel(value.gender) : "Not specified";
  const validWeight = !weightChanged || !weightText.trim() || (Number(weightText) >= 20 && Number(weightText) <= 500);
  const valid = Boolean(form?.preferredName.trim()) && (form?.heightCm === null || (form!.heightCm >= 50 && form!.heightCm <= 250)) && validWeight && (!form?.birthDate || form.birthDate <= new Date().toISOString().slice(0, 10));
  return <Card title="Personal Information" className="personal-information-card" action={form ? <div className="actions"><button className="secondary compact" onClick={cancel}>Cancel</button><button className="compact" disabled={!valid || save.isPending} onClick={submit}>{save.isPending ? "Saving…" : "Save"}</button></div> : <button className="secondary compact" onClick={begin}><span aria-hidden="true">✎</span>Edit</button>}>
    {form ? <div className="personal-information-form">
      <label><span>Preferred name</span><input maxLength={100} value={form.preferredName} onChange={(event) => setForm({ ...form, preferredName: event.target.value })}/></label>
      <label><span>Gender</span><select value={form.gender ?? ""} onChange={(event) => setForm({ ...form, gender: (event.target.value || null) as PersonalInformation["gender"] })}><option value="">Not specified</option><option value="female">Female</option><option value="male">Male</option><option value="non_binary">Non-binary</option><option value="prefer_not_to_say">Prefer not to say</option></select></label>
      <label><span>Height <em>cm</em></span><input type="number" min="50" max="250" step="0.1" value={form.heightCm ?? ""} onChange={(event) => setForm({ ...form, heightCm: event.target.value ? Number(event.target.value) : null })}/></label>
      <label><span>Weight <em>kg</em></span><input type="number" min="20" max="500" step="0.1" value={weightText} onChange={(event) => { setWeightText(event.target.value); setWeightChanged(true); }}/></label>
      <label><span>Birth date</span><input type="date" max={new Date().toISOString().slice(0, 10)} value={form.birthDate ?? ""} onChange={(event) => setForm({ ...form, birthDate: event.target.value || null })}/></label>
    </div> : <dl className="personal-information-summary"><div><dt>Preferred name</dt><dd>{value.preferredName}</dd></div><div><dt>Gender</dt><dd>{genderLabel}</dd></div><div><dt>Height</dt><dd>{value.heightCm == null ? "Not specified" : `${value.heightCm} cm`}</dd></div><div><dt>Weight</dt><dd>{value.weightKg == null ? "Not recorded" : `${value.weightKg} kg`}{value.weightDate && <small>{value.weightDate}</small>}</dd></div><div><dt>Birth date</dt><dd>{value.birthDate ?? "Not specified"}</dd></div></dl>}
    <ErrorBanner error={save.error}/>
  </Card>;
}

function Settings() {
  return <><PersonalInformationCard/><Card title="System status" className="system-card"><p>Athria runs locally and keeps your training data on this device.</p><ServiceStatus/></Card><Backup/></>;
}

function Copyable({ label, value, block = false }: { label: string; value: string; block?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      window.setTimeout(() => setState("idle"), 2000);
    } catch { setState("failed"); }
  };
  return <div className={`copyable ${block ? "block" : ""}`}><div><small>{label}</small>{block ? <pre>{value}</pre> : <code>{value}</code>}</div><button type="button" className="secondary compact" onClick={() => void copy()}>{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</button><span className="sr-only" aria-live="polite">{state === "copied" ? `${label} copied.` : state === "failed" ? `${label} could not be copied.` : ""}</span></div>;
}

function McpSetup() {
  const status = useQuery({ queryKey: ["mcp-status"], queryFn: getMcpStatus, retry: false });
  if (status.isPending) return <Loading/>;
  if (status.isError) return <div className="error" role="alert">Athria could not determine its installation path. Close and reopen Athria, then try again. {status.error instanceof Error ? status.error.message : String(status.error)}</div>;
  const executablePath = status.data.executablePath;
  const config = mcpConfig(executablePath);
  return <>
    <p className="mcp-intro">Connect a supported desktop agent to your local Athria data. The command shown below uses this copy of Athria, wherever it is installed.</p>
    <div className="mcp-guides">
      {mcpGuides.map((guide) => <details key={guide.id} className="mcp-guide">
        <summary><span>{guide.name}</span><small>{guide.path}</small></summary>
        <div className="mcp-guide-content"><p>{guide.instructions}</p>
          <div className="mcp-fields">
            <Copyable label="Name" value="Athria"/><Copyable label="Transport" value="STDIO"/>
            <Copyable label="Command" value={executablePath}/><Copyable label="Arguments" value={status.data.arguments.join(" ")}/>
          </div>
          {(guide.mode === "config" || guide.id === "qoder") && <Copyable label={guide.id === "qoder" ? "JSON option" : "Configuration"} value={config} block/>}
        </div>
      </details>)}
    </div>
    <div className="mcp-finish"><strong>Finish and check</strong><ol><li>Save the server, then restart or re-enable MCP if your agent asks you to.</li><li>In a new conversation, ask: <code>Show my recent training sessions</code></li></ol></div>
    <div className="notice"><strong>If it does not connect:</strong> Confirm that Athria is still installed at the Command path shown above. Then reopen the agent and enable the Athria server again.</div>
  </>;
}

function Help() {
  return <><Card title="Help & Support"><p>Athria is your local-first training companion. Use Connections to connect data sources, Profile to confirm your preferences, and Plan to review Agent-created training plans.</p><div className="help-grid"><section><strong>Need to update your profile?</strong><span>Open Profile and choose Edit, or explicitly confirm a profile change with your connected Agent.</span></section><section><strong>Having trouble with a connection?</strong><span>Open Connections, re-enter the connection details, then test or sync again.</span></section><section><strong>Protect your data</strong><span>Create a local backup from Settings before troubleshooting or moving Athria to another device.</span></section></div></Card><Card title="Connect Athria to your AI agent" className="mcp-card"><McpSetup/></Card></>;
}

const views: Record<Page, () => React.ReactElement> = { Overview, Training: Timeline, Profile, Plan: CurrentPlanPage, Connections, Settings, Help };

export function App() {
  const [page, setPage] = useState<Page>("Overview"); const [serviceCrash, setServiceCrash] = useState(false); const View = views[page];
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const primaryPages = dashboardPages.filter((item) => item.group === "primary");
  const supportPages = dashboardPages.filter((item) => item.group === "support");
  const primaryPage = primaryPages.some((item) => item.id === page);
  useEffect(() => { let unlisten: UnlistenFn | undefined; void listen("athria-service-crashed", () => setServiceCrash(true)).then((dispose) => { unlisten = dispose; }); return () => unlisten?.(); }, []);
  useEffect(() => { const openTraining = () => setPage("Training"); window.addEventListener("athria-open-training", openTraining); return () => window.removeEventListener("athria-open-training", openTraining); }, []);
  const navIcons: Record<Page, IconName> = { Overview: "overview", Training: "training", Profile: "profile", Plan: "plan", Connections: "devices", Settings: "settings", Help: "help" };
  const NavItems = ({ items }: { items: typeof dashboardPages[number][] }) => <>{items.map((item) => <button key={item.id} className={item.id === page ? "active" : ""} aria-current={item.id === page ? "page" : undefined} onClick={() => setPage(item.id)}><AppIcon name={navIcons[item.id]}/>{item.label}</button>)}</>;
  const preferredName = profile.data?.preferredName || "Athlete";
  return <div className="shell"><aside><div className="brand"><img src="/athria-logo.svg" alt="Athria" /></div><nav aria-label="Main navigation"><NavItems items={primaryPages}/></nav><div className="sidebar-lower"><nav className="support-nav" aria-label="Support navigation"><NavItems items={supportPages}/></nav></div></aside><main className={primaryPage ? "primary-main" : undefined}>{page !== "Plan" && page !== "Profile" && page !== "Connections" && (primaryPage ? <PrimaryPageHeader preferredName={preferredName} subtitle={page === "Overview" ? "Let's keep the momentum going. Here's your overview for today." : "Your AI fitness hub. Local-first. Data you own."}/> : <header><div><h1>Hi, {preferredName}! <span aria-hidden="true">👋</span></h1><p>Your AI fitness hub. Local-first. Data you own.</p></div></header>)}{serviceCrash && <div className="error">The local service stopped unexpectedly. Close and reopen Athria. If the problem continues, create a backup before troubleshooting.</div>}<View/></main></div>;
}
