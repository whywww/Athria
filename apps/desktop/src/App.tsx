import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, getIntervalsStatus, getMcpStatus, getXunjiStatus, importXunjiSkill, syncIntervals, syncXunji, testIntervals } from "./api";
import { mcpConfig, mcpGuides } from "./mcp-guides";
import {
  dashboardPages, deviceTimezone, formatDateTime, formatDistance, formatDuration, friendlyLabel, isUntouchedDefaultProfile,
  isPlanDraftApproved, primaryPlanDraft, profilePayload, proposalChanges, referencedTemplates, resolveSelectedTemplate, timezoneOptions, validationMessage,
  type AthleteProfile, type CurrentPlan, type DoctorResult, type ExerciseDefinition, type HevyImportStatus, type ImportPreview,
  type ImportResult, type NextTrainingDay, type PlanValidation, type PlanVersion, type ProfileProposal,
  type SessionTemplate, type StoredDraft, type StoredSessionTemplate, type TrainingSummary, type XunjiConnectionStatus,
} from "./view-models";

type Page = (typeof dashboardPages)[number]["id"];
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
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

const Card = ({ title, children, className = "", action }: { title: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) => <section className={`card ${className}`}><div className="card-heading"><h2>{title}</h2>{action}</div>{children}</section>;
const ErrorBanner = ({ error }: { error: unknown }) => error ? <div className="error" role="alert">{error instanceof Error ? error.message : String(error)}</div> : null;
const Loading = () => <p className="muted">Loading…</p>;
const Empty = ({ children }: { children: React.ReactNode }) => <div className="empty">{children}</div>;

function ServiceStatus() {
  const health = useQuery({ queryKey: ["doctor"], queryFn: () => api<DoctorResult>("/api/system/doctor"), retry: 3, retryDelay: 500 });
  const label = health.isPending ? "Starting…" : health.isError ? "Service unavailable" : "Local service";
  return <span className={`status ${health.isError ? "offline" : ""}`}><i/>{label}</span>;
}

function Overview() {
  const query = useQuery({ queryKey: ["summary", 7], queryFn: () => api<TrainingSummary>("/api/summary?days=7") });
  if (query.isPending) return <Loading/>;
  if (query.isError) return <ErrorBanner error={query.error}/>;
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
    {summary.sessionCount === 0 && <Empty>Import or sync a workout to see your weekly overview.</Empty>}
    {summary.sessionCount > 0 && incomplete && <div className="notice">Some workout details were unavailable, so one or more totals may be incomplete.</div>}
  </>;
}

function ChoiceChip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={`chip ${selected ? "selected" : ""}`} aria-pressed={selected} onClick={onClick}>{children}</button>;
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
  const proposals = useQuery({ queryKey: ["profile-proposals"], queryFn: () => api<ProfileProposal[]>("/api/profile-proposals") });
  const exercises = useQuery({ queryKey: ["exercises"], queryFn: () => api<ExerciseDefinition[]>("/api/exercises") });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<AthleteProfile | null>(null);
  const [customGoal, setCustomGoal] = useState("");
  const [availableGoals, setAvailableGoals] = useState<string[]>(commonGoals);
  const [saved, setSaved] = useState(false);
  const profile = profileQuery.data;
  const equipmentOptions = useMemo(() => [...new Set([...(exercises.data ?? []).flatMap((item) => item.equipment), ...(form?.equipment ?? profile?.equipment ?? [])])].sort(), [exercises.data, form?.equipment, profile?.equipment]);
  const save = useMutation({
    mutationFn: (value: AthleteProfile) => api<AthleteProfile>("/api/profile", { method: "PUT", body: JSON.stringify(value) }),
    onSuccess: () => { setForm(null); setAvailableGoals(commonGoals); setEditing(false); setSaved(true); void client.invalidateQueries({ queryKey: ["profile"] }); },
  });
  useEffect(() => {
    if (!saved) return;
    const timeout = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(timeout);
  }, [saved]);
  const approve = useMutation({
    mutationFn: (id: string) => api(`/api/profile-proposals/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ approvedBy: "local-user" }) }),
    onSuccess: () => { setForm(null); setEditing(false); void client.invalidateQueries({ queryKey: ["profile"] }); void client.invalidateQueries({ queryKey: ["profile-proposals"] }); },
  });

  if (profileQuery.isPending) return <Loading/>;
  if (profileQuery.isError) return <ErrorBanner error={profileQuery.error}/>;
  if (!profile) return <Loading/>;

  const toggleList = (field: "goals" | "equipment", value: string) => setForm((current) => current ? { ...current, [field]: current[field].includes(value) ? current[field].filter((item) => item !== value) : [...current[field], value] } : current);
  const toggleTrainingDay = (weekday: number) => setForm((current) => current ? { ...current, trainingDays: current.trainingDays.includes(weekday) ? current.trainingDays.filter((day) => day !== weekday) : [...current.trainingDays, weekday].sort((a, b) => a - b) } : current);
  const beginEdit = () => { setSaved(false); setCustomGoal(""); setAvailableGoals([...new Set([...commonGoals, ...profile.goals])]); setForm({ ...profile, timezone: isUntouchedDefaultProfile(profile) ? deviceTimezone() : profile.timezone, goals: [...profile.goals], trainingDays: [...profile.trainingDays], equipment: [...profile.equipment] }); setEditing(true); };
  const cancelEdit = () => { setForm(null); setCustomGoal(""); setAvailableGoals(commonGoals); setEditing(false); save.reset(); };
  const pending = proposals.data?.filter((item) => item.status === "pending") ?? [];

  const profileActions = editing && form ? <div className="profile-actions"><button type="button" className="secondary compact" onClick={cancelEdit}>Cancel</button><button type="button" className="compact" disabled={save.isPending || form.goals.length === 0} onClick={() => { setSaved(false); save.mutate(profilePayload(profile, form)); }}>{save.isPending ? "Saving…" : "Save"}</button></div> : <button type="button" className="secondary compact edit-button" onClick={beginEdit}><span aria-hidden="true">✎</span>Edit</button>;

  return <div className="profile-page">
    <Card title="Training Profile" className={`profile-board ${editing ? "is-editing" : ""}`} action={profileActions}>
      {editing && form ? <EditableProfileBoard profile={profile} form={form} setForm={setForm} customGoal={customGoal} setCustomGoal={setCustomGoal} availableGoals={availableGoals} setAvailableGoals={setAvailableGoals} equipmentOptions={equipmentOptions} toggleList={toggleList} toggleTrainingDay={toggleTrainingDay}/> : <ProfileBoard profile={profile}/>} 
      <ErrorBanner error={save.error}/>
      {saved && <div className="success">Profile saved!</div>}
    </Card>
    <Card title="Agent Suggestions" className="profile-suggestions" action={pending.length > 0 ? <button disabled={approve.isPending} onClick={() => approve.mutate(pending[0]!.id)}>✓ Approve</button> : undefined}>
      <p className="card-subtitle">Personalized recommendations to optimize your training.</p>
      {proposals.isPending ? <Loading/> : pending.length === 0 ? <Empty>No suggestions waiting for review.</Empty> : pending.map((proposal) => <article className="proposal" key={proposal.id}><div className="suggestion-type"><span aria-hidden="true">☆</span><strong>Suggested change</strong></div><div className="suggestion-content"><div><strong>Recommended profile update</strong><p>{proposal.rationale}</p></div><div className="change-list">{proposalChanges(profile, proposal.patch).map((change) => <div key={change.label}><strong>{change.label}</strong><span>Before　{change.before}</span><span className="arrow">→</span><span>After　{change.after}</span></div>)}</div>{pending.length > 1 && <button disabled={approve.isPending} onClick={() => approve.mutate(proposal.id)}>Approve changes</button>}</div></article>)}
      <ErrorBanner error={proposals.error ?? approve.error}/>
    </Card>
  </div>;
}

function EditableProfileBoard({ profile, form, setForm, customGoal, setCustomGoal, availableGoals, setAvailableGoals, equipmentOptions, toggleList, toggleTrainingDay }: { profile: AthleteProfile; form: AthleteProfile; setForm: React.Dispatch<React.SetStateAction<AthleteProfile | null>>; customGoal: string; setCustomGoal: React.Dispatch<React.SetStateAction<string>>; availableGoals: string[]; setAvailableGoals: React.Dispatch<React.SetStateAction<string[]>>; equipmentOptions: string[]; toggleList: (field: "goals" | "equipment", value: string) => void; toggleTrainingDay: (weekday: number) => void }) {
  const deleteCustomGoal = (goal: string) => {
    setAvailableGoals((current) => current.filter((item) => item !== goal));
    setForm((current) => current ? { ...current, goals: current.goals.filter((item) => item !== goal) } : current);
  };
  return <div className="profile-content profile-editor">
    <section className="profile-goals-panel"><span className="profile-icon coral" aria-hidden="true">◎</span><div className="editable-panel-content"><strong>Training Goals</strong><div className="goal-tags">{availableGoals.map((goal) => commonGoals.includes(goal) ? <GoalTag key={goal} goal={goal} selected={form.goals.includes(goal)} onClick={() => toggleList("goals", goal)}/> : <GoalTag key={goal} goal={goal} selected={form.goals.includes(goal)} onClick={() => toggleList("goals", goal)} onDelete={() => deleteCustomGoal(goal)}/>)}</div><div className="inline-input"><input aria-label="Custom training goal" placeholder="Add another goal" value={customGoal} onChange={(event) => setCustomGoal(event.target.value)}/><button type="button" className="secondary" disabled={!customGoal.trim()} onClick={() => { const goal = customGoal.trim(); setAvailableGoals((current) => current.includes(goal) ? current : [...current, goal]); setForm((current) => current && !current.goals.includes(goal) ? { ...current, goals: [...current.goals, goal] } : current); setCustomGoal(""); }}>Add</button></div></div></section>
    <div className="profile-metrics">
      <div><span className="profile-icon coral" aria-hidden="true">🏋️</span><label>Strength / week<select value={form.weeklyStrengthSessions} onChange={(event) => setForm({ ...form, weeklyStrengthSessions: Number(event.target.value) })}>{Array.from({ length: 8 }, (_, value) => <option key={value} value={value}>{value} sessions</option>)}</select></label></div>
      <div><span className="profile-icon yellow" aria-hidden="true">🏃</span><label>Endurance / week<select value={form.weeklyEnduranceSessions} onChange={(event) => setForm({ ...form, weeklyEnduranceSessions: Number(event.target.value) })}>{Array.from({ length: 8 }, (_, value) => <option key={value} value={value}>{value} sessions</option>)}</select></label></div>
      <div><span className="profile-icon green" aria-hidden="true">◷</span><label>Max session length<select value={form.maxSessionMinutes} onChange={(event) => setForm({ ...form, maxSessionMinutes: Number(event.target.value) })}>{[15, 30, 45, 60, 75, 90, 120, 180, 240].map((value) => <option key={value} value={value}>{value} min</option>)}</select></label></div>
    </div>
    <div className="profile-detail-layout">
      <div className="profile-detail-column">
        <section className="profile-section"><strong>♧　Available equipment</strong><div className="chips">{equipmentOptions.map((item) => <ChoiceChip key={item} selected={form.equipment.includes(item)} onClick={() => toggleList("equipment", item)}>{friendlyLabel(item)}</ChoiceChip>)}</div></section>
        <section className="profile-section timezone-section"><label>◉　Time zone<select value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })}>{timezoneOptions(form.timezone).map((zone) => <option key={zone} value={zone}>{zone}{zone === deviceTimezone() ? " (device)" : ""}</option>)}</select></label><label>Training priority<select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as AthleteProfile["priority"] })}><option value="balanced">Balanced</option><option value="strength">Strength</option><option value="endurance">Endurance</option></select></label></section>
      </div>
      <div className="profile-detail-column">
        <section className="profile-section training-days"><strong>▣　Training days <small>(Optional)</small></strong><div className="day-list">{weekdays.map((day, index) => <button type="button" key={day} className={form.trainingDays.includes(index) ? "selected" : ""} aria-pressed={form.trainingDays.includes(index)} onClick={() => toggleTrainingDay(index)}>{day.slice(0, 3)}{form.trainingDays.includes(index) ? " ✓" : ""}</button>)}</div></section>
        <AgentManagedDetails profile={profile}/>
      </div>
    </div>
  </div>;
}

function ReadonlyTags({ values, empty = "None" }: { values: string[]; empty?: string }) {
  return <div className="readonly-tags">{values.length ? values.map((value) => <span key={value}>{friendlyLabel(value)}</span>) : <span className="muted-tag">{empty}</span>}</div>;
}

function AgentManagedDetails({ profile }: { profile: AthleteProfile }) {
  const prohibited = profile.strengthConstraints.filter((item) => item.type === "prohibit_movement_pattern").map((item) => item.movementPattern);
  const excluded = profile.strengthConstraints.filter((item) => item.type === "exclude_exercise").map((item) => item.canonicalKey);
  return <div className="agent-managed"><div className="detail-heading"><strong><span aria-hidden="true">♢</span> Agent-managed</strong></div><div className="detail-grid"><div><small>◌　Recovery interval</small><span>{profile.explicitRecoveryHours === null ? "Not set" : `${profile.explicitRecoveryHours} hours between hard sessions`}</span></div><div><small>☷　Constraint notes (not Core-enforced)</small><span>{profile.constraintNotes.length ? profile.constraintNotes.join(" · ") : "None"}</span></div><div><small>⊘　Prohibited movement patterns</small><span>{prohibited.length ? prohibited.map(friendlyLabel).join(" · ") : "None"}</span></div><div><small>⊖　Excluded canonical exercises</small><span>{excluded.length ? excluded.map(friendlyLabel).join(" · ") : "None"}</span></div></div></div>;
}

function ProfileBoard({ profile }: { profile: AthleteProfile }) {
  const selectedDays = new Set(profile.trainingDays);
  return <div className="profile-content">
    <section className="profile-goals-panel"><span className="profile-icon coral" aria-hidden="true">◎</span><div><strong>Training Goals</strong>{profile.goals.length ? <div className="goal-tags">{profile.goals.map((goal) => <GoalTag key={goal} goal={goal}/>)}</div> : <p>No goals selected</p>}</div></section>
    <div className="profile-metrics">
      <div><span className="profile-icon coral" aria-hidden="true">🏋️</span><div><span>Strength / week</span><strong>{profile.weeklyStrengthSessions}</strong><small>sessions</small></div></div>
      <div><span className="profile-icon yellow" aria-hidden="true">🏃</span><div><span>Endurance / week</span><strong>{profile.weeklyEnduranceSessions}</strong><small>sessions</small></div></div>
      <div><span className="profile-icon green" aria-hidden="true">◷</span><div><span>Max session length</span><strong>{profile.maxSessionMinutes}</strong><small>min</small></div></div>
    </div>
    <div className="profile-detail-layout">
      <div className="profile-detail-column">
        <section className="profile-section"><strong>♧　Available equipment</strong><ReadonlyTags values={profile.equipment}/></section>
        <section className="profile-section timezone-section"><strong>◉　Time zone</strong><span>{profile.timezone}</span></section>
      </div>
      <div className="profile-detail-column">
        <section className="profile-section training-days"><strong>▣　Training days <small>(Optional)</small></strong><div className="day-list">{weekdays.map((day, index) => <span key={day} className={selectedDays.has(index) ? "selected" : ""}>{day.slice(0, 3)}{selectedDays.has(index) ? " ✓" : ""}</span>)}</div></section>
        <AgentManagedDetails profile={profile}/>
      </div>
    </div>
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

function ValidationSummary({ validation }: { validation: PlanValidation }) {
  const blockers = validation.results.filter((item) => item.enforcement === "blocker" && (item.status === "fail" || item.status === "unknown"));
  const advisories = validation.results.filter((item) => item.enforcement === "advisory" && item.status !== "pass" && item.status !== "not_applicable");
  const unknown = validation.results.filter((item) => item.status === "unknown");
  const coverage = validation.coverage;
  const percent = (resolved: number, total: number) => total ? Math.round(resolved / total * 100) : 100;
  return <div className={`validation ${blockers.length ? "blocked" : advisories.length ? "warning" : "valid"}`}><strong>{blockers.length ? "Changes required before approval" : advisories.length ? "Ready with recommendations" : "Plan checks passed"}</strong>{coverage && <span>Hard checks resolved: {coverage.hardChecksResolved}/{coverage.hardChecksTotal} · Classification coverage: movement {percent(coverage.movementFactsResolved, coverage.movementFactsTotal)}%, muscle {percent(coverage.muscleFactsResolved, coverage.muscleFactsTotal)}%, equipment {percent(coverage.equipmentFactsResolved, coverage.equipmentFactsTotal)}%</span>}{blockers.map((item, index) => <span key={`blocker-${item.reasonCode}-${index}`}>Blocker · {validationMessage(item)}</span>)}{advisories.map((item, index) => <span key={`advisory-${item.reasonCode}-${index}`}>Advisory · {validationMessage(item)}</span>)}{unknown.filter((item) => item.enforcement !== "blocker").map((item, index) => <span key={`unknown-${item.reasonCode}-${index}`}>Unknown · {validationMessage(item)}</span>)}{validation.dataGaps.length > 0 && <span>Missing information: {validation.dataGaps.map((gap) => `${friendlyLabel(gap.factPath)} (${friendlyLabel(gap.resolution)})`).join(", ")}</span>}</div>;
}

function formatRest(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes} min` : `${seconds} sec`;
}

function MesocycleProposal({ item }: { item: StoredDraft }) {
  const plan = item.draft;
  const mesocycle = plan.mesocycle;
  const [selectedTemplateId, setSelectedTemplateId] = useState(mesocycle?.sessionTemplates[0]?.id ?? "");
  if (!mesocycle) return <section className="mesocycle-card legacy-plan"><div className="proposal-heading"><div><span className="proposal-mark" aria-hidden="true">◎</span><div><h2>{plan.title}</h2><p>No executable mesocycle structure is recorded.</p></div></div></div><ValidationSummary validation={item.validation}/></section>;
  const templates = new Map(mesocycle.sessionTemplates.map((template) => [template.id, template]));
  const selectedTemplate = templates.get(selectedTemplateId) ?? mesocycle.sessionTemplates[0]!;
  const weeklySessions = mesocycle.weeklyStructure.reduce((total, day) => total + day.templateIds.length, 0);
  const domainsFor = (template: typeof selectedTemplate) => [...new Set(template.components.map((component) => component.domain.value).filter((value): value is NonNullable<typeof value> => value !== null))];
  const planDomains = [...new Set(mesocycle.sessionTemplates.flatMap(domainsFor))].map(friendlyLabel);
  const hasUnclassified = mesocycle.sessionTemplates.some((template) => template.components.some((component) => component.domain.value === null));
  const domainSummary = [...planDomains, ...(hasUnclassified ? ["Unclassified component"] : [])].join(" + ");
  return <>
    {plan.migration?.reviewRequired && <div className="notice">This plan was migrated to Schema v3. Review its inferred components and classifications before approving it again.</div>}
    <section className="mesocycle-card">
      <div className="proposal-heading"><div><span className="proposal-mark" aria-hidden="true">◎</span><div><h2>{plan.title}</h2>{plan.summary && <p>{plan.summary}</p>}</div></div><div className="proposal-facts"><span>▣　{mesocycle.durationWeeks} weeks</span><span>⌁　{weeklySessions} sessions / week</span><span>↔　{domainSummary || "Unclassified component"}</span></div></div>
      <section className="proposal-section"><h3>Weekly Structure</h3><div className="weekly-structure">{weekdays.map((day, dayOfWeek) => { const entry = mesocycle.weeklyStructure.find((entry) => entry.dayOfWeek === dayOfWeek); const dayTemplates = (entry?.templateIds ?? []).map((id) => templates.get(id)).filter((entry) => entry !== undefined); return <div key={day}><strong>{day.slice(0, 3)}</strong>{dayTemplates.length ? dayTemplates.map((template, index) => <span key={template.id} className={`template-pill tone-${index % 4}`}>{template.name}</span>) : <span className="rest-pill">Rest</span>}</div>; })}</div></section>
      <section className="proposal-section"><h3>Phase Progression</h3><div className="phase-progression">{[...mesocycle.phases].sort((a, b) => a.startWeek - b.startWeek).map((phase, index) => <div className="phase-step" key={phase.id}><span className={`phase-number tone-${index % 4}`}>{index + 1}</span><div><strong>{phase.name}</strong><span>{phase.startWeek === phase.endWeek ? `Week ${phase.startWeek}` : `Weeks ${phase.startWeek}–${phase.endWeek}`}</span><small>{phase.focus}</small></div>{index < mesocycle.phases.length - 1 && <i aria-hidden="true">→</i>}</div>)}</div></section>
      <section className="proposal-section session-templates"><h3>Session Templates</h3><div className="template-tabs" role="tablist" aria-label="Session templates">{mesocycle.sessionTemplates.map((template, index) => <button key={template.id} type="button" role="tab" aria-selected={template.id === selectedTemplate.id} className={template.id === selectedTemplate.id ? "selected" : ""} onClick={() => setSelectedTemplateId(template.id)}><span className={`tone-${index % 4}`}>{String.fromCharCode(65 + index)}</span>{template.name}</button>)}</div>
        <div className="template-summary"><span>{[...domainsFor(selectedTemplate).map(friendlyLabel), ...(selectedTemplate.components.some((component) => component.domain.value === null) ? ["Unclassified component"] : [])].join(" + ")}</span><span>{formatDuration(selectedTemplate.durationMinutes)}</span><span>{friendlyLabel(selectedTemplate.recoveryDemand)} recovery demand</span></div>
        <div className="conditioning-template"><strong>{selectedTemplate.name}</strong>{selectedTemplate.components.map((component) => <div className="template-component" key={component.id}>{component.prescription.kind === "strength" ? <div className="exercise-table"><div className="exercise-row exercise-header"><span>Classification</span><span className="exercise-cell">Exercise</span><span>Prescription</span><span>Effort</span><span>Rest</span><span>Notes</span></div>{component.prescription.exercises.map((exercise, index) => { const movement = exercise.classification.primaryMovement?.value; return <div className="exercise-row" key={exercise.id}><span>{movement == null ? "-" : friendlyLabel(String(movement))}</span><span className="exercise-cell"><b>{index + 1}</b>{exercise.displayName}</span><span>{exercise.sets} × {exercise.repsMin === exercise.repsMax ? exercise.repsMin : `${exercise.repsMin}–${exercise.repsMax}`}</span><span>{exercise.targetRpe ? `RPE ${exercise.targetRpe}` : "Controlled"}</span><span>{formatRest(exercise.restSeconds)}</span><span className="exercise-notes">{exercise.notes || "—"}</span></div>; })}</div> : <p>{component.prescription.notes || selectedTemplate.intent}</p>}</div>)}</div>
      </section>
    </section>
    <details className="adjustment-card"><summary><span className="progression-icon" aria-hidden="true">↗</span><strong>How this plan progresses</strong><span className="progression-preview">{mesocycle.phases.slice(0, 2).map((phase) => phase.focus).join(" · ")}</span><span className="rules-link">View progression & adjustment rules</span></summary><div className="adjustment-content">{mesocycle.adjustmentRules.length ? mesocycle.adjustmentRules.map((rule, index) => <article key={`${rule.trigger}-${index}`}><strong>If {rule.trigger}</strong><span>{rule.action}</span><small>{rule.rationale}</small></article>) : <p>No adjustment rules were supplied.</p>}</div></details>
    <ValidationSummary validation={item.validation}/>
  </>;
}

function NextTrainingDayCard({ value }: { value: NextTrainingDay | undefined }) {
  if (!value?.nextTrainingDay) return <section className="notice">No upcoming training day is currently available.</section>;
  const day = value.nextTrainingDay;
  return <section className="mesocycle-card"><div className="proposal-heading"><div><span className="proposal-mark" aria-hidden="true">›</span><div><h2>Next training day</h2><p>{day.scheduledDate} · Week {day.weekNumber} · {friendlyLabel(day.phaseType)}</p></div></div><span>{day.timezone}</span></div><div className="session-list">{day.existingSessions.length ? day.existingSessions.map((session) => <article className="session-card" key={session.id}><div className="session-heading"><div><span className="badge">{friendlyLabel(session.status)}</span><h3>{session.name}</h3></div><span>{formatDuration(session.durationMinutes)}</span></div><p>{session.intent}</p></article>) : <p>No sessions have been created for this training day yet. Expected templates: {day.expectedTemplateIds.join(", ")}.</p>}</div></section>;
}

function Plan() {
  const client = useQueryClient();
  const drafts = useQuery({ queryKey: ["drafts"], queryFn: () => api<StoredDraft[]>("/api/drafts") });
  const versions = useQuery({ queryKey: ["versions"], queryFn: () => api<PlanVersion[]>("/api/plans/versions") });
  const nextDay = useQuery({ queryKey: ["next-training-day"], queryFn: () => api<NextTrainingDay>("/api/plans/next-training-day") });
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const [approvedId, setApprovedId] = useState("");
  const approve = useMutation({ mutationFn: (id: string) => api<PlanVersion>(`/api/drafts/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ approvedBy: "local-user", changeReason: "Approved in Dashboard" }) }), onSuccess: (version) => { setApprovedId(version.plan.id); void client.invalidateQueries({ queryKey: ["drafts"] }); void client.invalidateQueries({ queryKey: ["versions"] }); void client.invalidateQueries({ queryKey: ["current-plan"] }); } });
  const selected = primaryPlanDraft(drafts.data ?? [], versions.data ?? []);
  const approved = Boolean(selected && (approvedId === selected.draft.id || isPlanDraftApproved(selected.draft.id, versions.data ?? [])));
  const loading = drafts.isPending || versions.isPending;
  const error = drafts.error ?? versions.error ?? profile.error ?? nextDay.error ?? approve.error;
  return <div className="plan-page">
    <div className="plan-page-header"><div><h1>Mesocycle Planner</h1><p>Plan smarter. Train better.</p></div><button className={`approve-mesocycle ${approved ? "approved" : ""}`} disabled={!selected || approved || !selected.validation.valid || approve.isPending} onClick={() => selected && approve.mutate(selected.draft.id)}>{approve.isPending ? "Approving…" : approved ? "✓  Approved" : "✓  Approve Mesocycle"}</button></div>
    <ErrorBanner error={error}/>{approvedId && approvedId === selected?.draft.id && <div className="success">Mesocycle approved and saved as the current version.</div>}
    {loading ? <Loading/> : !selected ? <Empty>There is no Mesocycle Proposal yet. Ask your connected Agent to create and validate one for review.</Empty> : <MesocycleProposal key={selected.draft.id} item={selected}/>}
    {versions.data?.length ? <NextTrainingDayCard value={nextDay.data}/> : null}
  </div>;
}

const emptyTemplate = (): SessionTemplate => ({ id: crypto.randomUUID(), name: "New template", intent: "Describe the training goal", durationMinutes: 45, recoveryDemand: "normal", notes: "", components: [{ id: crypto.randomUUID(), name: "Session", domain: { value: "recovery", source: "user_confirmed", confidence: 1, evidence: "Created in Dashboard", taxonomyVersion: "strength-1.0" }, prescription: { kind: "duration_only", notes: "Describe the session" } }] });

function TemplateLibrary({ onBack }: { onBack: () => void }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["templates"], queryFn: () => api<StoredSessionTemplate[]>("/api/templates") });
  const [editing, setEditing] = useState<(SessionTemplate & { revision?: number }) | null>(null);
  const [components, setComponents] = useState("");
  const [error, setError] = useState<unknown>();
  const begin = (value: StoredSessionTemplate | SessionTemplate) => { setEditing({ ...value, components: structuredClone(value.components) }); setComponents(JSON.stringify(value.components, null, 2)); setError(undefined); };
  const save = async () => {
    if (!editing) return;
    try {
      const template = { ...editing, components: JSON.parse(components) as SessionTemplate["components"] };
      const { revision, ...payload } = template;
      if (!revision) await api("/api/templates", { method: "POST", body: JSON.stringify(payload) });
      else {
        const impact = await api<{ affectedCount: number }>(`/api/templates/${encodeURIComponent(template.id)}/impact`, { method: "POST", body: "{}" });
        const futureSessionPolicy = impact.affectedCount ? (window.confirm(`${impact.affectedCount} future planned session(s) use this template. Update them to the new template? Choose Cancel to keep their current snapshots.`) ? "update" : "keep") : undefined;
        await api(`/api/templates/${encodeURIComponent(template.id)}`, { method: "PUT", body: JSON.stringify({ template: payload, expectedRevision: revision, futureSessionPolicy }) });
      }
      setEditing(null); await client.invalidateQueries({ queryKey: ["templates"] }); await client.invalidateQueries({ queryKey: ["current-plan"] });
    } catch (value) { setError(value); }
  };
  const remove = async (item: StoredSessionTemplate) => {
    if (!window.confirm(`Delete “${item.name}”? This cannot be undone.`)) return;
    try { await api(`/api/templates/${encodeURIComponent(item.id)}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: item.revision }) }); await client.invalidateQueries({ queryKey: ["templates"] }); }
    catch (value) { setError(value); }
  };
  if (editing) return <div className="plan-page"><div className="plan-page-header"><div><h1>{editing.revision ? "Edit template" : "Create template"}</h1><p>Changes affect new scheduled sessions; existing sessions are updated only when you choose to.</p></div><div className="actions"><button className="secondary" onClick={() => setEditing(null)}>Cancel</button><button onClick={() => void save()}>Save template</button></div></div><ErrorBanner error={error}/><Card title="Template details" className="template-editor"><div className="grid"><label>Name<input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })}/></label><label>Duration (minutes)<input type="number" min="1" max="240" value={editing.durationMinutes} onChange={(event) => setEditing({ ...editing, durationMinutes: Number(event.target.value) })}/></label><label>Intent<input value={editing.intent} onChange={(event) => setEditing({ ...editing, intent: event.target.value })}/></label><label>Recovery demand<select value={editing.recoveryDemand} onChange={(event) => setEditing({ ...editing, recoveryDemand: event.target.value as SessionTemplate["recoveryDemand"] })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label></div><label>Notes<textarea value={editing.notes} onChange={(event) => setEditing({ ...editing, notes: event.target.value })}/></label><label>Components and exercises (JSON)<textarea className="json-editor" value={components} onChange={(event) => setComponents(event.target.value)} rows={20}/></label></Card></div>;
  return <div className="plan-page"><div className="plan-page-header"><div><button className="text-button" onClick={onBack}>← Back to plan</button><h1>Template Library</h1><p>Create and maintain reusable session templates.</p></div><button onClick={() => begin(emptyTemplate())}>Create template</button></div><ErrorBanner error={query.error ?? error}/>{query.isPending ? <Loading/> : !query.data?.length ? <Empty>No templates yet. Create one before building a Mesocycle.</Empty> : <div className="template-library-grid">{query.data.map((item) => <article className="card template-library-card" key={item.id}><div><h2>{item.name}</h2><p>{item.intent}</p><div className="template-summary"><span>{formatDuration(item.durationMinutes)}</span><span>{friendlyLabel(item.recoveryDemand)} recovery</span><span>{item.components.length} components</span></div></div><div className="actions"><button className="secondary compact" onClick={() => begin(item)}>Edit</button><button className="danger compact" onClick={() => void remove(item)}>Delete</button></div></article>)}</div>}</div>;
}

function CurrentPlanView({ plan, templates }: { plan: CurrentPlan; templates: StoredSessionTemplate[] }) {
  const byId = new Map(templates.map((item) => [item.id, item]));
  const { templates: referenced, missingIds } = referencedTemplates(plan.mesocycle, templates);
  const [selectedTemplateId, setSelectedTemplateId] = useState(referenced[0]?.id ?? "");
  const selected = resolveSelectedTemplate(referenced, selectedTemplateId);
  const domainsFor = (template: SessionTemplate) => [...new Set(template.components.map((component) => component.domain.value).filter((value): value is NonNullable<typeof value> => value !== null))];
  return <><section className="mesocycle-card"><div className="proposal-heading"><div><span className="proposal-mark">◎</span><div><h2>{plan.title}</h2><p>{plan.summary}</p></div></div><div className="proposal-facts"><span>▣　{plan.mesocycle.durationWeeks} weeks</span><span>Starts {plan.effectiveStartDate}</span></div></div><section className="proposal-section"><h3>Weekly Structure</h3><div className="weekly-structure">{weekdays.map((day, dayOfWeek) => { const ids = plan.mesocycle.weeklyStructure.find((item) => item.dayOfWeek === dayOfWeek)?.templateIds ?? []; return <div key={day}><strong>{day.slice(0, 3)}</strong>{ids.length ? ids.map((id) => <span className="template-pill" key={id}>{byId.get(id)?.name ?? id}</span>) : <span className="rest-pill">Rest</span>}</div>; })}</div></section><section className="proposal-section"><h3>Phase Progression</h3><div className="phase-progression">{plan.mesocycle.phases.map((phase, index) => <div className="phase-step" key={phase.id}><span className={`phase-number tone-${index % 4}`}>{index + 1}</span><div><strong>{phase.name}</strong><span>Weeks {phase.startWeek}–{phase.endWeek}</span><small>{phase.focus}</small></div></div>)}</div></section>
      <section className="proposal-section session-templates"><h3>Session Templates</h3>
        {referenced.length > 0 && <div className="template-tabs" role="tablist" aria-label="Session templates">{referenced.map((template, index) => <button key={template.id} type="button" role="tab" aria-selected={template.id === selected?.id} className={template.id === selected?.id ? "selected" : ""} onClick={() => setSelectedTemplateId(template.id)}><span className={`tone-${index % 4}`}>{String.fromCharCode(65 + index)}</span>{template.name}</button>)}</div>}
        {selected && <>
          <div className="template-summary"><span>{[...domainsFor(selected).map(friendlyLabel), ...(selected.components.some((component) => component.domain.value === null) ? ["Unclassified component"] : [])].join(" + ")}</span><span>{formatDuration(selected.durationMinutes)}</span><span>{friendlyLabel(selected.recoveryDemand)} recovery demand</span></div>
          <div className="conditioning-template"><strong>{selected.name}</strong>{selected.components.map((component) => <div className="template-component" key={component.id}>{component.prescription.kind === "strength" ? <div className="exercise-table"><div className="exercise-row exercise-header"><span>Classification</span><span className="exercise-cell">Exercise</span><span>Prescription</span><span>Effort</span><span>Rest</span><span>Notes</span></div>{component.prescription.exercises.map((exercise, index) => { const movement = exercise.classification.primaryMovement?.value; return <div className="exercise-row" key={exercise.id}><span>{movement == null ? "-" : friendlyLabel(String(movement))}</span><span className="exercise-cell"><b>{index + 1}</b>{exercise.displayName}</span><span>{exercise.sets} × {exercise.repsMin === exercise.repsMax ? exercise.repsMin : `${exercise.repsMin}–${exercise.repsMax}`}</span><span>{exercise.targetRpe ? `RPE ${exercise.targetRpe}` : "Controlled"}</span><span>{formatRest(exercise.restSeconds)}</span><span className="exercise-notes">{exercise.notes || "—"}</span></div>; })}</div> : <><strong>{component.name}</strong><p>{component.prescription.notes || selected.intent}</p></>}</div>)}</div>
        </>}
        {missingIds.length > 0 && <div className="notice">Referenced but missing from the library: {missingIds.join(", ")}.</div>}
        {!referenced.length && !missingIds.length && <p className="muted">No session templates are referenced by this mesocycle yet.</p>}
      </section></section></>;
}

function CurrentPlanPage() {
  const client = useQueryClient();
  const [library, setLibrary] = useState(false);
  const planQuery = useQuery({ queryKey: ["current-plan"], queryFn: () => api<CurrentPlan | null>("/api/plans/current") });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: () => api<StoredSessionTemplate[]>("/api/templates") });
  const nextDay = useQuery({ queryKey: ["next-training-day"], queryFn: () => api<NextTrainingDay>("/api/plans/next-training-day") });
  const [editing, setEditing] = useState<CurrentPlan | null>(null);
  const [phases, setPhases] = useState(""); const [rules, setRules] = useState(""); const [error, setError] = useState<unknown>(); const [validation, setValidation] = useState<PlanValidation | null>(null);
  if (library) return <TemplateLibrary onBack={() => setLibrary(false)}/>;
  const templates = templatesQuery.data ?? [];
  const begin = () => {
    const today = new Date().toISOString().slice(0, 10);
    const value = planQuery.data ?? { planSchemaVersion: "4.0" as const, ownerId: "local-user", title: "My Mesocycle", summary: "", effectiveStartDate: today, mesocycle: { durationWeeks: 4, weeklyStructure: [], phases: [{ id: crypto.randomUUID(), phaseType: "foundation" as const, name: "Base", startWeek: 1, endWeek: 4, focus: "Build capacity", progression: [] }], adjustmentRules: [] }, revision: 0, sourceAgent: null, model: null, skillVersion: null, inputSnapshotHash: null, updatedAt: new Date().toISOString() };
    setEditing(structuredClone(value)); setPhases(JSON.stringify(value.mesocycle.phases, null, 2)); setRules(JSON.stringify(value.mesocycle.adjustmentRules, null, 2)); setError(undefined); setValidation(null);
  };
  const payload = () => { if (!editing) throw new Error("No plan is being edited."); return { ...editing, mesocycle: { ...editing.mesocycle, phases: JSON.parse(phases), adjustmentRules: JSON.parse(rules) }, expectedRevision: editing.revision, revision: undefined, updatedAt: undefined }; };
  const save = async () => {
    try {
      const candidate = payload();
      let result;
      try { result = await api<{ plan: CurrentPlan; validation: PlanValidation }>("/api/plans/current", { method: "PUT", body: JSON.stringify(candidate) }); }
      catch (value) {
        if (!(value instanceof Error) || !value.message.includes("future planned session")) throw value;
        const futureSessionPolicy = window.confirm(`${value.message} Update compatible sessions? Choose Cancel to keep their snapshots.`) ? "update" : "keep";
        result = await api<{ plan: CurrentPlan; validation: PlanValidation }>("/api/plans/current", { method: "PUT", body: JSON.stringify({ ...candidate, futureSessionPolicy }) });
      }
      setValidation(result.validation); setEditing(null); await client.invalidateQueries({ queryKey: ["current-plan"] }); await client.invalidateQueries({ queryKey: ["next-training-day"] });
    } catch (value) { setError(value); }
  };
  const toggle = (dayOfWeek: number, id: string) => setEditing((current) => { if (!current) return current; const existing = current.mesocycle.weeklyStructure.find((item) => item.dayOfWeek === dayOfWeek)?.templateIds ?? []; const templateIds = existing.includes(id) ? existing.filter((item) => item !== id) : [...existing, id]; const others = current.mesocycle.weeklyStructure.filter((item) => item.dayOfWeek !== dayOfWeek); return { ...current, mesocycle: { ...current.mesocycle, weeklyStructure: [...others, ...(templateIds.length ? [{ dayOfWeek, templateIds }] : [])].sort((a, b) => a.dayOfWeek - b.dayOfWeek) } }; });
  if (editing) return <div className="plan-page"><div className="plan-page-header"><div><h1>Edit Mesocycle</h1><p>Saving replaces the current plan after Core validation.</p></div><div className="actions"><button className="secondary" onClick={() => setEditing(null)}>Cancel</button><button disabled={!templates.length} onClick={() => void save()}>Save plan</button></div></div><ErrorBanner error={error}/><Card title="Plan details" className="plan-editor"><div className="grid"><label>Title<input value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })}/></label><label>Effective start date<input type="date" value={editing.effectiveStartDate} onChange={(event) => setEditing({ ...editing, effectiveStartDate: event.target.value })}/></label><label>Duration (weeks)<input type="number" min="1" max="52" value={editing.mesocycle.durationWeeks} onChange={(event) => setEditing({ ...editing, mesocycle: { ...editing.mesocycle, durationWeeks: Number(event.target.value) } })}/></label></div><label>Summary<textarea value={editing.summary} onChange={(event) => setEditing({ ...editing, summary: event.target.value })}/></label><fieldset><legend>Weekly Structure</legend><div className="weekly-template-editor">{weekdays.map((day, index) => <section key={day}><strong>{day}</strong>{templates.map((item) => <ChoiceChip key={item.id} selected={editing.mesocycle.weeklyStructure.find((entry) => entry.dayOfWeek === index)?.templateIds.includes(item.id) ?? false} onClick={() => toggle(index, item.id)}>{item.name}</ChoiceChip>)}</section>)}</div></fieldset><label>Phases (JSON)<textarea className="json-editor" rows={12} value={phases} onChange={(event) => setPhases(event.target.value)}/></label><label>Adjustment rules (JSON)<textarea className="json-editor" rows={8} value={rules} onChange={(event) => setRules(event.target.value)}/></label>{!templates.length && <div className="notice">Create at least one template before saving a plan.</div>}</Card></div>;
  const loading = planQuery.isPending || templatesQuery.isPending;
  return <div className="plan-page"><div className="plan-page-header"><div><h1>Mesocycle Planner</h1><p>Your saved plan is always the current plan.</p></div><div className="actions"><button className="secondary" onClick={() => setLibrary(true)}>View all templates</button><button disabled={!templates.length} onClick={begin}>{planQuery.data ? "Edit plan" : "Create plan"}</button></div></div><ErrorBanner error={planQuery.error ?? templatesQuery.error ?? nextDay.error ?? error}/>{loading ? <Loading/> : !planQuery.data ? <Empty>No current Mesocycle. Create templates, then build your plan.</Empty> : <CurrentPlanView plan={planQuery.data} templates={templates}/>} {validation && <ValidationSummary validation={validation}/>} {planQuery.data && <NextTrainingDayCard value={nextDay.data}/>}</div>;
}

function Backup() {
  const doctor = useQuery({ queryKey: ["backup-doctor"], queryFn: () => api<DoctorResult>("/api/system/doctor") });
  const dataDir = (doctor.data as DoctorResult | undefined)?.dataDir;
  const [message, setMessage] = useState(""); const [error, setError] = useState<unknown>();
  const [source, setSource] = useState(""); const [target, setTarget] = useState("");
  const createBackup = () => { setError(undefined); api<{ path: string }>("/api/system/backup", { method: "POST", body: "{}" }).then((result) => setMessage(`Backup created at ${result.path}`)).catch(setError); };
  const restore = () => { setError(undefined); api<{ status: string; target: string }>("/api/system/restore", { method: "POST", body: JSON.stringify({ path: source, target }) }).then((result) => setMessage(`Backup verified and restored to ${result.target}. Your active data was not replaced.`)).catch(setError); };
  return <Card title="Backup and restore"><p>Backups include your training database and retained imports. Account credentials are never included.</p>{dataDir && <div className="data-location"><strong>Local data location</strong><span>{dataDir}</span><small>This folder contains Athria's local database, imports, backups, logs, and exports.</small></div>}<div className="section"><h3>Create a backup</h3><p>Save a timestamped backup ZIP inside your local Athria data folder.</p><button onClick={createBackup}>Create backup</button></div><div className="section"><h3>Verify and restore a backup</h3><p>Restore into an empty folder for review. Athria will not replace the active database automatically.</p><label>Backup ZIP path<input value={source} onChange={(event) => setSource(event.target.value)}/></label><label>Empty restore folder<input value={target} onChange={(event) => setTarget(event.target.value)}/></label><button className="secondary" disabled={!source || !target} onClick={restore}>Verify and restore</button></div>{message && <div className="success">{message}</div>}<ErrorBanner error={doctor.error ?? error}/></Card>;
}

function Settings() {
  return <><Card title="System status" className="system-card"><p>Athria runs locally and keeps your training data on this device.</p><ServiceStatus/></Card><Backup/></>;
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
  return <><Card title="Help & Support"><p>Athria is your local-first training companion. Use Devices to connect data sources, Profile to confirm your preferences, and Plan to review Agent-created training plans.</p><div className="help-grid"><section><strong>Need to update your profile?</strong><span>Open Profile and choose Edit. Agent-managed details can only change through an approved suggestion.</span></section><section><strong>Having trouble with a connection?</strong><span>Open Devices, re-enter the connection details, then test or sync again.</span></section><section><strong>Protect your data</strong><span>Create a local backup from Settings before troubleshooting or moving Athria to another device.</span></section></div></Card><Card title="Connect Athria to your AI agent" className="mcp-card"><McpSetup/></Card></>;
}

const views: Record<Page, () => React.ReactElement> = { Overview, Training: Timeline, Profile, Plan: CurrentPlanPage, Devices: Connections, Settings, Help };

export function App() {
  const [page, setPage] = useState<Page>("Overview"); const [serviceCrash, setServiceCrash] = useState(false); const View = views[page];
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api<AthleteProfile>("/api/profile") });
  const primaryPages = dashboardPages.filter((item) => item.group === "primary");
  const supportPages = dashboardPages.filter((item) => item.group === "support");
  useEffect(() => { let unlisten: UnlistenFn | undefined; void listen("athria-service-crashed", () => setServiceCrash(true)).then((dispose) => { unlisten = dispose; }); return () => unlisten?.(); }, []);
  const NavItems = ({ items }: { items: typeof dashboardPages[number][] }) => <>{items.map((item) => <button key={item.id} className={item.id === page ? "active" : ""} onClick={() => setPage(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</>;
  return <div className="shell"><aside><div className="brand"><img src="/athria-logo.png" alt="Athria" /></div><nav aria-label="Main navigation"><NavItems items={primaryPages}/></nav><nav className="support-nav" aria-label="Support navigation"><NavItems items={supportPages}/></nav></aside><main>{page !== "Plan" && <header><div><h1>Hi, {profile.data?.displayName || "Athlete"} <span aria-hidden="true">👋</span></h1><p>Your AI fitness hub. Local-first. Data you own.</p></div></header>}{serviceCrash && <div className="error">The local service stopped unexpectedly. Close and reopen Athria. If the problem continues, create a backup before troubleshooting.</div>}<View/></main></div>;
}
