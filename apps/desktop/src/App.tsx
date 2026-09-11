import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, changeDataLocation, getIntervalsStatus, getMcpStatus, getXunjiStatus, importXunjiSkill, pickDataLocation, syncIntervals, syncXunji, testIntervals } from "./api";
import { mcpConfig, mcpGuides } from "./mcp-guides";
import {
  dashboardPages, deviceTimezone, equipmentGroupState, formatDateTime, formatDistance, formatDuration, formatTimezoneLabel, formatTrainingRhythm, friendlyLabel, isUntouchedDefaultProfile,
  profilePayload, timezoneOptions, PREFERENCE_MAX_LENGTH,
  toggleEquipmentGroup,
  type AthleteProfile, type CurrentPlan, type DoctorResult, type HevyImportStatus, type ImportPreview,
  type EquipmentCategory, type ImportResult, type NextTrainingDay, type PersonalInformation, type TrainingTaxonomy, type TrainingSummary, type XunjiConnectionStatus,
} from "./view-models";
import { Card, Empty, ErrorBanner, Loading, weekdays } from "./components";
import { CurrentPlanPage, NextTrainingDayCard } from "./plan/CurrentPlanPage";
import { localDateForTimezone } from "./plan/view";

type Page = (typeof dashboardPages)[number]["id"];
const commonGoals = ["general_fitness", "build_strength", "build_muscle", "improve_endurance", "fat_loss"];

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
  const query = useQuery({ queryKey: ["summary", 7], queryFn: () => api<TrainingSummary>("/api/summary?days=7") });
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const today = profile.data ? localDateForTimezone(profile.data.timezone) : null;
  // P0-5: Today/Next surfaces the next training day on Overview (§3, §19).
  const nextDay = useQuery({ queryKey: ["next-training-day", today], queryFn: () => api<NextTrainingDay>(`/api/plans/next-training-day?onOrAfterDate=${today}`), enabled: today !== null });
  const plan = useQuery({ queryKey: ["current-plan"], queryFn: () => api<CurrentPlan | null>("/api/plans/current") });
  if (query.isPending) return <Loading/>;
  if (query.isError || profile.isError) return <ErrorBanner error={query.error ?? profile.error}/>;
  const summary = query.data;
  const incomplete = summary.metrics.strength.workingSets.dataQuality.completeness < 1 || summary.metrics.endurance.distanceMeters.dataQuality.completeness < 1;
  return <>
    <p className="page-intro">Your training activity from the last 7 days.</p>
    <div className="stat-grid">
      <div className="stat"><span>Workouts</span><strong>{summary.sessionCount}</strong><small>{summary.sessionCount === 1 ? "completed session" : "completed sessions"}</small></div>
      <div className="stat"><span>Training time</span><strong>{formatDuration(summary.totalDurationMinutes)}</strong><small>across all activities</small></div>
      <div className="stat"><span>Strength work</span><strong>{summary.metrics.strength.workingSets.value} sets</strong><small>{summary.byDomain.strength ?? 0} strength workouts</small></div>
      <div className="stat"><span>Endurance distance</span><strong>{formatDistance(summary.metrics.endurance.distanceMeters.value)}</strong><small>{summary.byDomain.endurance ?? 0} endurance workouts</small></div>
    </div>
    {summary.sessionCount > 0 && incomplete && <div className="notice">Some workout details were unavailable, so one or more totals may be incomplete.</div>}
    {plan.data && !nextDay.isPending && <NextTrainingDayCard value={nextDay.data} />}
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
  const profileActions = editing && form ? <div className="profile-actions"><select className="profile-timezone-select" aria-label="Time zone" value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })}>{timezoneOptions(form.timezone).map((zone) => <option key={zone} value={zone}>{zone}{zone === deviceTimezone() ? " (device)" : ""}</option>)}</select><button type="button" className="secondary compact" onClick={cancelEdit}>Cancel</button><button type="button" className="compact" disabled={save.isPending || form.goals.length === 0 || !rhythmValid} onClick={() => { setSaved(false); save.mutate(profilePayload(profile, form)); }}>{save.isPending ? "Saving…" : "Save"}</button></div> : <div className="profile-actions"><span className="profile-timezone-pill">{formatTimezoneLabel(profile.timezone)}</span><button type="button" className="secondary compact edit-button" onClick={beginEdit}><span aria-hidden="true">✎</span>Edit</button></div>;

  return <div className="profile-page">
    <Card title="Training Profile" className={`profile-board ${editing ? "is-editing" : ""}`} action={profileActions}>
      {editing && form ? <EditableProfileBoard profile={profile} form={form} setForm={setForm} customGoal={customGoal} setCustomGoal={setCustomGoal} availableGoals={availableGoals} setAvailableGoals={setAvailableGoals} equipmentCategories={taxonomy.data.equipmentCategories} toggleList={toggleList} toggleTrainingDay={toggleTrainingDay}/> : <ProfileBoard profile={profile} equipmentCategories={taxonomy.data.equipmentCategories}/>}
      <ErrorBanner error={save.error}/>
      {saved && <div className="success">Profile saved! Your current plan may be affected — ask your AI agent to review and update it to match your new profile.</div>}
    </Card>
    <Card title="Agent Suggestions" className="profile-suggestions">
      <AgentManagedDetails profile={profile}/>
      <p className="profile-disclaimer">AI-generated planning suggestions only, not medical advice — consult a qualified professional for any injury, diagnosis, or treatment.</p>
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
  const visibleCategories = editable ? categories : categories.map((category) => ({ ...category, groups: category.groups.map((group) => ({ ...group, items: group.items.filter((item) => selected.includes(item.id)) })).filter((group) => group.items.length) })).filter((category) => category.groups.length);
  return <section className="profile-section equipment-section"><strong>♧　Available equipment</strong>{visibleCategories.length ? <div className="equipment-categories">{visibleCategories.map((category) => <section className="equipment-category" key={category.id}><h3>{category.label}</h3><div className="equipment-groups">{category.groups.map((group) => {
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

function EditableProfileBoard({ profile, form, setForm, customGoal, setCustomGoal, availableGoals, setAvailableGoals, equipmentCategories, toggleList, toggleTrainingDay }: { profile: AthleteProfile; form: AthleteProfile; setForm: React.Dispatch<React.SetStateAction<AthleteProfile | null>>; customGoal: string; setCustomGoal: React.Dispatch<React.SetStateAction<string>>; availableGoals: string[]; setAvailableGoals: React.Dispatch<React.SetStateAction<string[]>>; equipmentCategories: EquipmentCategory[]; toggleList: (field: "goals" | "equipment", value: string) => void; toggleTrainingDay: (weekday: number) => void }) {
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
      <section className="profile-goals-panel"><span className="profile-icon coral" aria-hidden="true">◎</span><div className="editable-panel-content"><strong>Training Goals</strong><div className="goal-tags">{availableGoals.map((goal) => commonGoals.includes(goal) ? <GoalTag key={goal} goal={goal} selected={form.goals.includes(goal)} onClick={() => toggleList("goals", goal)}/> : <GoalTag key={goal} goal={goal} selected={form.goals.includes(goal)} onClick={() => toggleList("goals", goal)} onDelete={() => deleteCustomGoal(goal)}/>)}</div><div className="inline-input"><input aria-label="Custom training goal" placeholder="Add another goal" value={customGoal} onChange={(event) => setCustomGoal(event.target.value)}/><button type="button" className="secondary" disabled={!customGoal.trim()} onClick={() => { const goal = customGoal.trim(); setAvailableGoals((current) => current.includes(goal) ? current : [...current, goal]); setForm((current) => current && !current.goals.includes(goal) ? { ...current, goals: [...current.goals, goal] } : current); setCustomGoal(""); }}>Add</button></div></div></section>
      <div className="profile-summary-item"><label>Preferences<span className="preference-input"><input type="text" maxLength={PREFERENCE_MAX_LENGTH} value={form.preference} onChange={(event) => setForm({ ...form, preference: event.target.value })} placeholder="用一句话描述你的训练偏好"/><small>{form.preference.length}/{PREFERENCE_MAX_LENGTH}</small></span></label></div>
      <div className="profile-summary-item"><span>▣　Training rhythm</span><div className="profile-rhythm-options">
        <div className="profile-rhythm-option"><label><input type="radio" name="training-rhythm" checked={form.trainingRhythm.kind === "fixed_week"} onChange={() => changeRhythm("fixed_week")}/><span>Fixed week</span></label>{form.trainingRhythm.kind === "fixed_week" && <div className="day-list">{weekdays.map((day, index) => <button type="button" key={day} className={form.trainingRhythm.kind === "fixed_week" && form.trainingRhythm.days.includes(index) ? "selected" : ""} aria-pressed={form.trainingRhythm.kind === "fixed_week" && form.trainingRhythm.days.includes(index)} onClick={() => toggleTrainingDay(index)}>{day.slice(0, 3)}{form.trainingRhythm.kind === "fixed_week" && form.trainingRhythm.days.includes(index) ? " ✓" : ""}</button>)}</div>}</div>
        <div className="profile-rhythm-option"><label><input type="radio" name="training-rhythm" checked={form.trainingRhythm.kind === "flexible_week"} onChange={() => changeRhythm("flexible_week")}/><span>Flexible week</span></label>{form.trainingRhythm.kind === "flexible_week" && <div className="rhythm-parameters"><label>Target days<input type="number" min="1" max="7" value={form.trainingRhythm.targetDaysPerWeek} onChange={(event) => updateFlexibleRhythm("targetDaysPerWeek", Number(event.target.value))}/></label><label>Min<input type="number" min="1" max="7" value={form.trainingRhythm.minDaysPerWeek} onChange={(event) => updateFlexibleRhythm("minDaysPerWeek", Number(event.target.value))}/></label><label>Max<input type="number" min="1" max="7" value={form.trainingRhythm.maxDaysPerWeek} onChange={(event) => updateFlexibleRhythm("maxDaysPerWeek", Number(event.target.value))}/></label></div>}</div>
        <div className="profile-rhythm-option"><label><input type="radio" name="training-rhythm" checked={form.trainingRhythm.kind === "interval"} onChange={() => changeRhythm("interval")}/><span>Intervals</span></label>{form.trainingRhythm.kind === "interval" && <span className="interval-parameter">Every <input aria-label="Interval days" type="number" min="1" max="30" value={form.trainingRhythm.intervalDays} onChange={(event) => updateIntervalRhythm(Number(event.target.value))}/> days</span>}</div>
      </div></div>
      <div className="profile-summary-item"><label>Max session length<select value={form.maxSessionMinutes} onChange={(event) => setForm({ ...form, maxSessionMinutes: Number(event.target.value) })}>{[15, 30, 45, 60, 75, 90, 120, 180, 240].map((value) => <option key={value} value={value}>{value} min</option>)}</select></label></div>
    </section>
    <EquipmentSelector categories={equipmentCategories} selected={form.equipment} onToggleItem={(id) => toggleList("equipment", id)} onToggleGroup={(ids) => setForm((current) => current ? { ...current, equipment: toggleEquipmentGroup(current.equipment, ids) } : current)}/>
  </div>;
}

function ReadonlyTags({ values, empty = "None" }: { values: string[]; empty?: string }) {
  return <div className="readonly-tags">{values.length ? values.map((value) => <span key={value}>{friendlyLabel(value)}</span>) : <span className="muted-tag">{empty}</span>}</div>;
}

function AgentManagedDetails({ profile }: { profile: AthleteProfile }) {
  const rows: Array<{ label: string; value: string } | { label: string; notes: string[] }> = [];
  if (profile.explicitRecoveryDays !== null) rows.push({ label: "Recovery interval", value: `${profile.explicitRecoveryDays} day${profile.explicitRecoveryDays === 1 ? "" : "s"} between hard sessions` });
  if (profile.injuries.length) rows.push({ label: "Injuries", notes: profile.injuries });
  if (profile.constraintNotes.length) rows.push({ label: "Constraint notes", notes: profile.constraintNotes });
  if (!rows.length) return null;
  return <ul className="agent-managed-list">{rows.map((row) => <li key={row.label}><strong>{row.label}</strong>{"notes" in row ? <ol className="agent-note-list">{row.notes.map((note, index) => <li key={index}>{note}</li>)}</ol> : <> {row.value}</>}</li>)}</ul>;
}

function ProfileBoard({ profile, equipmentCategories }: { profile: AthleteProfile; equipmentCategories: EquipmentCategory[] }) {
  return <div className="profile-content">
    <section className="profile-top-summary">
      <section className="profile-goals-panel"><span className="profile-icon coral" aria-hidden="true">◎</span><div><strong>Training Goals</strong>{profile.goals.length ? <div className="goal-tags">{profile.goals.map((goal) => <GoalTag key={goal} goal={goal}/>)}</div> : <p>No goals selected</p>}</div></section>
      <div className="profile-summary-item"><span>Preferences</span><strong>{profile.preference || "Not set"}</strong></div>
      <div className="profile-summary-item"><span>Training rhythm</span><strong>{formatTrainingRhythm(profile.trainingRhythm)}</strong></div>
      <div className="profile-summary-item"><span>Max session length</span><strong>{profile.maxSessionMinutes} min</strong></div>
    </section>
    <EquipmentSelector categories={equipmentCategories} selected={profile.equipment}/>
  </div>;
}

function Connections() {
  const client = useQueryClient();
  const hevyStatus = useQuery({ queryKey: ["hevy-status"], queryFn: () => api<HevyImportStatus | null>("/api/imports/hevy/status") });
  const intervalsStatus = useQuery({ queryKey: ["intervals-status"], queryFn: getIntervalsStatus });
  const xunjiStatus = useQuery({ queryKey: ["xunji-status"], queryFn: () => getXunjiStatus<XunjiConnectionStatus>() });
  const [editingHevy, setEditingHevy] = useState(false); const [editingIntervals, setEditingIntervals] = useState(false);
  const [editingXunji, setEditingXunji] = useState(false); const [xunjiSkill, setXunjiSkill] = useState("");
  const [preview, setPreview] = useState<ImportPreview>(); const [importResult, setImportResult] = useState<ImportResult>();
  const [hevyError, setHevyError] = useState<unknown>(); const [intervalsError, setIntervalsError] = useState<unknown>();
  const [intervalsMessage, setIntervalsMessage] = useState("");
  const [xunjiError, setXunjiError] = useState<unknown>(); const [xunjiMessage, setXunjiMessage] = useState(""); const [xunjiBusy, setXunjiBusy] = useState(false);
  const [key, setKey] = useState(""); const [athleteId, setAthleteId] = useState("0");
  const onFile = async (file: File) => { try { setHevyError(undefined); setImportResult(undefined); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; bytes.forEach((byte) => { binary += String.fromCharCode(byte); }); setPreview(await api<ImportPreview>("/api/imports/hevy/preview", { method: "POST", body: JSON.stringify({ fileName: file.name, contentBase64: btoa(binary) }) })); } catch (value) { setHevyError(value); } };
  const commit = async () => { if (!preview?.previewToken) return; try { setHevyError(undefined); setImportResult(await api<ImportResult>("/api/imports/hevy/commit", { method: "POST", body: JSON.stringify({ previewToken: preview.previewToken }) })); setPreview(undefined); setEditingHevy(false); await client.invalidateQueries({ queryKey: ["hevy-status"] }); } catch (value) { setHevyError(value); } };
  const cancelHevy = () => { setEditingHevy(false); setPreview(undefined); setImportResult(undefined); setHevyError(undefined); };
  const beginIntervalsEdit = () => { setKey(""); setAthleteId(intervalsStatus.data?.athleteId ?? "0"); setIntervalsMessage(""); setIntervalsError(undefined); setEditingIntervals(true); };
  const cancelIntervals = () => { setKey(""); setAthleteId(intervalsStatus.data?.athleteId ?? "0"); setIntervalsError(undefined); setEditingIntervals(false); };
  const saveIntervals = async () => { try { setIntervalsError(undefined); await testIntervals(key, athleteId); setIntervalsMessage("Connected. Your credentials were saved securely on this device."); setKey(""); setEditingIntervals(false); await client.invalidateQueries({ queryKey: ["intervals-status"] }); } catch (value) { setIntervalsError(value); } };
  const sync = async () => { try { setIntervalsError(undefined); const result = await syncIntervals() as ImportResult; setIntervalsMessage(`Sync complete: ${result.added ?? 0} added, ${result.updated ?? 0} updated.`); } catch (value) { setIntervalsError(value); } };
  const cancelXunji = () => { setEditingXunji(false); setXunjiSkill(""); setXunjiError(undefined); };
  const refreshXunjiViews = async () => { await Promise.all([client.invalidateQueries({ queryKey: ["xunji-status"] }), client.invalidateQueries({ queryKey: ["sessions"] }), client.invalidateQueries({ queryKey: ["summary"] }), client.invalidateQueries({ queryKey: ["state"] })]); };
  const connectXunji = async () => { try { setXunjiBusy(true); setXunjiError(undefined); const result = await importXunjiSkill(xunjiSkill) as ImportResult & { sync?: { status?: string } }; setXunjiMessage(`Sync ${result.sync?.status ?? "complete"}: ${result.added ?? 0} added, ${result.updated ?? 0} updated.`); setXunjiSkill(""); setEditingXunji(false); await refreshXunjiViews(); } catch (value) { setXunjiError(value); } finally { setXunjiBusy(false); } };
  const runXunjiSync = async () => { try { setXunjiBusy(true); setXunjiError(undefined); const result = await syncXunji() as ImportResult & { sync?: { status?: string } }; setXunjiMessage(`Sync ${result.sync?.status ?? "complete"}: ${result.added ?? 0} added, ${result.updated ?? 0} updated.`); await refreshXunjiViews(); } catch (value) { setXunjiError(value); } finally { setXunjiBusy(false); } };
  return <div className="grid">
    <Card title="Import from Hevy" action={<button type="button" className="secondary compact" onClick={() => editingHevy ? cancelHevy() : setEditingHevy(true)}>{editingHevy ? "Cancel" : "Edit"}</button>}><p>Import strength workouts from a reviewed Hevy CSV export.</p>{hevyStatus.isPending ? <Loading/> : editingHevy ? <><input aria-label="Hevy CSV export" type="file" accept=".csv,text/csv" onChange={(event) => event.target.files?.[0] && void onFile(event.target.files[0])}/>{preview && <ImportSummary value={preview}><button onClick={() => void commit()}>Import reviewed workouts</button></ImportSummary>}</> : hevyStatus.data ? <ConnectionState configured label="Imported"><strong>{hevyStatus.data.fileName}</strong><span>Last imported {formatDateTime(hevyStatus.data.importedAt)}</span><MiniStats counts={hevyStatus.data.counts}/></ConnectionState> : <ConnectionState configured={false} label="Not configured"><span>No Hevy file has been imported yet.</span></ConnectionState>}{importResult && <div className="success">Import complete: {importResult.added ?? 0} added, {importResult.updated ?? 0} updated.</div>}<ErrorBanner error={hevyStatus.error ?? hevyError}/></Card>
    <Card title="Import from Xunji" action={<button type="button" className="secondary compact" onClick={() => editingXunji ? cancelXunji() : setEditingXunji(true)}>{editingXunji ? "Cancel" : "Edit"}</button>}><p>Sync the latest 90 days of 训记 training records into your local Athria history.</p>{xunjiStatus.isPending ? <Loading/> : editingXunji ? <><label>Xunji exported Skill<textarea rows={9} autoComplete="off" spellCheck={false} placeholder="Paste the complete Skill exported by Xunji" value={xunjiSkill} onChange={(event) => setXunjiSkill(event.target.value)}/></label><p className="helper">Athria extracts only the API key. The pasted text is never stored, and credentials stay in Windows Credential Manager.</p><button disabled={!xunjiSkill.trim() || xunjiBusy} onClick={() => void connectXunji()}>{xunjiBusy ? "Connecting and syncing…" : "Connect and sync"}</button></> : xunjiStatus.data?.configured ? <ConnectionState configured label={xunjiStatus.data.sync?.status === "partial" ? "Partially synced" : "Connected"}><div className="connection-detail"><small>Last successful sync</small><strong>{xunjiStatus.data.sync?.lastSuccessAt ? formatDateTime(xunjiStatus.data.sync.lastSuccessAt) : "Not yet completed"}</strong></div>{xunjiStatus.data.sync && <span>{xunjiStatus.data.sync.rangeStart} – {xunjiStatus.data.sync.rangeEnd} · {xunjiStatus.data.sync.data.records ?? 0} records</span>}<button className="secondary" disabled={xunjiBusy} onClick={() => void runXunjiSync()}>{xunjiBusy ? "Syncing…" : "Sync now"}</button></ConnectionState> : <ConnectionState configured={false} label="Not configured"><span>Export your training-data Skill from Xunji, then paste it here.</span></ConnectionState>}{xunjiMessage && <div className="success">{xunjiMessage}</div>}<ErrorBanner error={xunjiStatus.error ?? xunjiError}/></Card>
    <Card title="Connect Intervals.icu" action={<button type="button" className="secondary compact" onClick={editingIntervals ? cancelIntervals : beginIntervalsEdit}>{editingIntervals ? "Cancel" : "Edit"}</button>}><p>Sync endurance activities and wellness data with saved credentials.</p>{intervalsStatus.isPending ? <Loading/> : editingIntervals ? <><label>API key<input type="password" autoComplete="off" placeholder={intervalsStatus.data?.configured ? "Enter a new key to replace the saved key" : "Enter API key"} value={key} onChange={(event) => setKey(event.target.value)}/></label><label>Athlete ID<input value={athleteId} onChange={(event) => setAthleteId(event.target.value)}/></label><p className="helper">Find these in Intervals.icu → Settings → Developer Settings.</p><button disabled={!key} onClick={() => void saveIntervals()}>Test and save</button></> : <ConnectionState configured={Boolean(intervalsStatus.data?.configured)} label={intervalsStatus.data?.configured ? "Connected" : "Not configured"}>{intervalsStatus.data?.configured ? <><div className="connection-detail"><small>Athlete ID</small><strong>{intervalsStatus.data.athleteId}</strong></div><button className="secondary" onClick={() => void sync()}>Sync now</button></> : <span>Add an API key and Athlete ID to start syncing.</span>}</ConnectionState>}{intervalsMessage && <div className="success">{intervalsMessage}</div>}<ErrorBanner error={intervalsStatus.error ?? intervalsError}/></Card>
  </div>;
}

function MiniStats({ counts }: { counts: { sessions?: number; sets?: number; rows?: number } }) {
  return <div className="mini-stats"><span>{counts.sessions ?? 0}<small>workouts</small></span><span>{counts.sets ?? 0}<small>sets</small></span><span>{counts.rows ?? 0}<small>rows</small></span></div>;
}

function ImportSummary({ value, children }: { value: ImportPreview; children: React.ReactNode }) {
  return <div className="preview"><strong>{value.fileName}</strong><MiniStats counts={value.counts ?? {}}/>{Boolean(value.unknownColumns?.length) && <p>Ignored columns: {value.unknownColumns!.join(", ")}</p>}{Boolean(value.errors?.length) && <div className="warning-list"><strong>{value.errors!.length} rows need attention</strong>{value.errors!.map((item, index) => <span key={index}>{item}</span>)}</div>}{children}</div>;
}

function ConnectionState({ configured, label, children }: { configured: boolean; label: string; children: React.ReactNode }) {
  return <div className="connection-state"><div className={`connection-badge ${configured ? "configured" : ""}`}><i/>{label}</div>{children}</div>;
}

interface TimelineSession { id: string; name: string; startAt: string; domains: string[]; durationMinutes: number }
function Timeline() {
  const query = useQuery({ queryKey: ["sessions"], queryFn: () => api<TimelineSession[]>("/api/sessions?days=365") });
  return <Card title="Training timeline"><ErrorBanner error={query.error}/>{query.isPending ? <Loading/> : !query.data?.length ? <Empty>No workouts imported yet.</Empty> : <div className="timeline">{query.data.map((item) => <article key={item.id}><strong>{item.name}</strong><span>{formatDateTime(item.startAt)} · {item.domains.length ? item.domains.map(friendlyLabel).join(" + ") : "Unclassified"} · {formatDuration(item.durationMinutes)}</span></article>)}</div>}</Card>;
}

function Backup() {
  const doctor = useQuery({ queryKey: ["backup-doctor"], queryFn: () => api<DoctorResult>("/api/system/doctor") });
  const dataDir = (doctor.data as DoctorResult | undefined)?.dataDir;
  const [message, setMessage] = useState(""); const [error, setError] = useState<unknown>();
  const [source, setSource] = useState(""); const [target, setTarget] = useState("");
  const [pendingLocation, setPendingLocation] = useState(""); const [moving, setMoving] = useState(false);
  const pendingTarget = pendingLocation ? `${pendingLocation.replace(/[\\/]+$/, "")}${pendingLocation.includes("\\") ? "\\" : "/"}AthriaData` : "";
  const createBackup = () => { setError(undefined); api<{ path: string }>("/api/system/backup", { method: "POST", body: "{}" }).then((result) => setMessage(`Backup created at ${result.path}`)).catch(setError); };
  const restore = () => { setError(undefined); api<{ status: string; target: string }>("/api/system/restore", { method: "POST", body: JSON.stringify({ path: source, target }) }).then((result) => setMessage(`Backup verified and restored to ${result.target}. Your active data was not replaced.`)).catch(setError); };
  const chooseLocation = async () => {
    setError(undefined);
    try {
      const picked = await pickDataLocation();
      if (picked) setPendingLocation(picked);
    } catch (value) { setError(value); }
  };
  const confirmLocation = async () => {
    try { setMoving(true); setError(undefined); await changeDataLocation(pendingLocation); }
    catch (value) { setMoving(false); setError(value); }
  };
  return <Card title="Backup and restore">
    <p>Backups include your training database and retained imports. Account credentials are never included.</p>
    {dataDir && <div className="data-location">
      <strong>Local data location</strong>
      <span>{dataDir}</span>
      <small>This folder contains Athria's local database, imports, backups, logs, and exports.</small>
      {pendingLocation
        ? <div className="data-location-confirm">
          <p>Athria will create <b>{pendingTarget}</b>, move all local data there, and restart. The selected folder can contain other files.</p>
          <div className="data-location-actions">
            <button type="button" className="secondary compact" disabled={moving} onClick={() => setPendingLocation("")}>Cancel</button>
            <button type="button" className="compact" disabled={moving} onClick={() => void confirmLocation()}>{moving ? "Moving data…" : "Move data and restart"}</button>
          </div>
        </div>
        : <div className="data-location-actions"><button type="button" className="secondary compact" onClick={() => void chooseLocation()}>Change location</button></div>}
    </div>}
    <div className="section"><h3>Create a backup</h3><p>Save a timestamped backup ZIP inside your local Athria data folder.</p><button onClick={createBackup}>Create backup</button></div>
    <div className="section"><h3>Verify and restore a backup</h3><p>Restore into an empty folder for review. Athria will not replace the active database automatically.</p><label>Backup ZIP path<input value={source} onChange={(event) => setSource(event.target.value)}/></label><label>Empty restore folder<input value={target} onChange={(event) => setTarget(event.target.value)}/></label><button className="secondary" disabled={!source || !target} onClick={restore}>Verify and restore</button></div>
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
      <label>Preferred name<input maxLength={100} value={form.preferredName} onChange={(event) => setForm({ ...form, preferredName: event.target.value })}/></label>
      <label>Gender<select value={form.gender ?? ""} onChange={(event) => setForm({ ...form, gender: (event.target.value || null) as PersonalInformation["gender"] })}><option value="">Not specified</option><option value="female">Female</option><option value="male">Male</option><option value="non_binary">Non-binary</option><option value="prefer_not_to_say">Prefer not to say</option></select></label>
      <label>Height <span>cm</span><input type="number" min="50" max="250" step="0.1" value={form.heightCm ?? ""} onChange={(event) => setForm({ ...form, heightCm: event.target.value ? Number(event.target.value) : null })}/></label>
      <label>Current weight <span>kg</span><input type="number" min="20" max="500" step="0.1" value={weightText} onChange={(event) => { setWeightText(event.target.value); setWeightChanged(true); }}/><small>{value.weightDate ? `Latest entry: ${value.weightDate}` : "No weight recorded"}</small></label>
      <label>Birth date<input type="date" max={new Date().toISOString().slice(0, 10)} value={form.birthDate ?? ""} onChange={(event) => setForm({ ...form, birthDate: event.target.value || null })}/></label>
    </div> : <dl className="personal-information-summary"><div><dt>Preferred name</dt><dd>{value.preferredName}</dd></div><div><dt>Gender</dt><dd>{genderLabel}</dd></div><div><dt>Height</dt><dd>{value.heightCm == null ? "Not specified" : `${value.heightCm} cm`}</dd></div><div><dt>Current weight</dt><dd>{value.weightKg == null ? "Not recorded" : `${value.weightKg} kg`}{value.weightDate && <small>{value.weightDate}</small>}</dd></div><div><dt>Birth date</dt><dd>{value.birthDate ?? "Not specified"}</dd></div></dl>}
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
  return <><Card title="Help & Support"><p>Athria is your local-first training companion. Use Devices to connect data sources, Profile to confirm your preferences, and Plan to review Agent-created training plans.</p><div className="help-grid"><section><strong>Need to update your profile?</strong><span>Open Profile and choose Edit, or explicitly confirm a profile change with your connected Agent.</span></section><section><strong>Having trouble with a connection?</strong><span>Open Devices, re-enter the connection details, then test or sync again.</span></section><section><strong>Protect your data</strong><span>Create a local backup from Settings before troubleshooting or moving Athria to another device.</span></section></div></Card><Card title="Connect Athria to your AI agent" className="mcp-card"><McpSetup/></Card></>;
}

const views: Record<Page, () => React.ReactElement> = { Overview, Training: Timeline, Profile, Plan: CurrentPlanPage, Devices: Connections, Settings, Help };

export function App() {
  const [page, setPage] = useState<Page>("Overview"); const [serviceCrash, setServiceCrash] = useState(false); const View = views[page];
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const primaryPages = dashboardPages.filter((item) => item.group === "primary");
  const supportPages = dashboardPages.filter((item) => item.group === "support");
  useEffect(() => { let unlisten: UnlistenFn | undefined; void listen("athria-service-crashed", () => setServiceCrash(true)).then((dispose) => { unlisten = dispose; }); return () => unlisten?.(); }, []);
  const NavItems = ({ items }: { items: typeof dashboardPages[number][] }) => <>{items.map((item) => <button key={item.id} className={item.id === page ? "active" : ""} onClick={() => setPage(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</>;
  return <div className="shell"><aside><div className="brand"><img src="/athria-logo.png" alt="Athria" /></div><nav aria-label="Main navigation"><NavItems items={primaryPages}/></nav><nav className="support-nav" aria-label="Support navigation"><NavItems items={supportPages}/></nav></aside><main>{page !== "Plan" && <header><div><h1>Hi, {profile.data?.preferredName || "Athlete"} <span aria-hidden="true">👋</span></h1><p>Your AI fitness hub. Local-first. Data you own.</p></div></header>}{serviceCrash && <div className="error">The local service stopped unexpectedly. Close and reopen Athria. If the problem continues, create a backup before troubleshooting.</div>}<View/></main></div>;
}
