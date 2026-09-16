import { invoke } from "@tauri-apps/api/core";
import type { IntervalsConnectionStatus, SyncRange } from "./view-models";

interface ServiceInfo { baseUrl: string; token: string; mcpUrl: string }
export interface McpStatus { configured: boolean; executablePath: string; arguments: ["mcp"] }
let serviceInfo: Promise<ServiceInfo> | undefined;

async function info(): Promise<ServiceInfo> {
  serviceInfo ??= invoke<ServiceInfo>("get_service_info");
  return serviceInfo;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const service = await info();
  const response = await fetch(`${service.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json", ...init.headers },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? `Request failed with HTTP ${response.status}`);
  return payload as T;
}

export async function testIntervals(apiKey: string, athleteId: string): Promise<unknown> {
  return invoke("test_intervals_credentials", { apiKey, athleteId });
}

export async function syncIntervals(range: SyncRange): Promise<unknown> { return invoke("sync_intervals", { range }); }

export async function getIntervalsStatus(): Promise<IntervalsConnectionStatus> { return invoke("intervals_status"); }

export async function importXunjiSkill(skillText: string): Promise<unknown> { return invoke("import_xunji_skill", { skillText }); }
export async function syncXunji(range: SyncRange): Promise<unknown> { return invoke("sync_xunji", { range }); }
export async function getXunjiStatus<T>(): Promise<T> { return invoke("xunji_status"); }
export async function getMcpStatus(): Promise<McpStatus> { return invoke("mcp_status"); }

export async function pickBackupDestination(): Promise<string | null> { return invoke<string | null>("pick_backup_destination"); }
export async function pickRestoreFile(): Promise<string | null> { return invoke<string | null>("pick_restore_file"); }
export async function restoreBackup(path: string): Promise<void> { return invoke("restore_backup", { path }); }
