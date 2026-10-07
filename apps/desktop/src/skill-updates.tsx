import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { checkSkillUpdates, getSkillUpdateStatus, installSkillUpdate, setSkillAutoUpdate, type SkillUpdateStatus } from "./api";
import { Card } from "./components";
import { T, tr, translate, useLanguage, type Language } from "./i18n";

export const skillUpdateQueryKey = ["skill-updates"] as const;
type UpdatePhase = SkillUpdateStatus["phase"];

export function skillUpdateButtonLabel(status: SkillUpdateStatus | undefined, phase: UpdatePhase = status?.phase ?? "idle"): string {
  if (phase === "checking") return tr("Checking…");
  if (phase === "downloading") return tr("Downloading…");
  if (phase === "installing") return tr("Installing…");
  return status?.availableVersion
    ? tr("Update to {version}").replace("{version}", status.availableVersion)
    : tr("Check for updates");
}

export function formatSkillCheckTime(timestamp: number, language: Language, now = new Date()): string {
  const date = new Date(timestamp * 1000);
  const locale = language === "zh-CN" ? "zh-CN" : "en-US";
  if (date.toDateString() === now.toDateString()) {
    const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
    return `${translate("Today", language)} ${time}`;
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

export function SkillUpdates() {
  const client = useQueryClient();
  const { language } = useLanguage();
  const query = useQuery({ queryKey: skillUpdateQueryKey, queryFn: getSkillUpdateStatus, refetchInterval: 2000 });
  const [operation, setOperation] = useState<UpdatePhase | "saving" | null>(null);
  const status = query.data;
  const run = async (action: () => Promise<SkillUpdateStatus>, phase: UpdatePhase | "saving") => {
    setOperation(phase);
    try {
      const result = await action();
      client.setQueryData(skillUpdateQueryKey, result);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["agent-integrations"] }),
        client.invalidateQueries({ queryKey: ["mcp-status"] }),
      ]);
      window.dispatchEvent(new Event("athria-skills-refreshed"));
    } catch { /* Keep the existing settings and recover the controls without exposing errors. */ }
    finally { setOperation(null); }
  };
  const phase = status?.phase && status.phase !== "idle" ? status.phase : operation && operation !== "saving" ? operation : "idle";
  const disabled = operation !== null || !status || phase !== "idle";
  const actions = <div className="skill-update-actions">
    <button type="button" className="secondary compact" disabled={disabled || !status?.keyConfigured} onClick={() => {
      if (status?.availableVersion) void run(() => installSkillUpdate(status.availableVersion!), "downloading");
      else void run(() => checkSkillUpdates(), "checking");
    }}>{skillUpdateButtonLabel(status, phase)}</button>
  </div>;
  return <Card title={<span className="settings-card-title"><span className="settings-card-copy">
    <span className="settings-card-name"><T>{"Skill Updates"}</T></span>
    <small><T>{"Automatically get skill updates compatible with your Athria version."}</T></small>
  </span></span>} className="settings-card skill-updates-card" action={actions}>
    <div className="skill-auto-update-row">
      <span><T>{"Automatic updates"}</T></span>
      <button type="button" role="switch" className="skill-auto-update-switch" aria-label={tr("Automatic updates")} aria-checked={status?.automatic ?? true} disabled={disabled} onClick={() => {
        void run(() => setSkillAutoUpdate(!status?.automatic), "saving");
      }}/>
    </div>
    <p className="skill-update-metadata"><span><T>{"Version"}</T> {status?.currentVersion ?? "—"}</span><span aria-hidden="true"> · </span><span><T>{"Last checked"}</T>: {status?.lastAttempt != null ? formatSkillCheckTime(status.lastAttempt, language) : tr("Not checked yet")}</span></p>
  </Card>;
}
