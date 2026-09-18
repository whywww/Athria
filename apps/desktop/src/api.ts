import { invoke } from "@tauri-apps/api/core";
import { TauriAthriaClient } from "./athria-client";
import type { IntervalsConnectionStatus, SyncRange } from "./view-models";

export interface McpStatus { configured: boolean; executablePath: string; arguments: ["mcp"] }

const client = new TauriAthriaClient(invoke);

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> { return client.request<T>(path, init); }

export async function testIntervals(apiKey: string, athleteId: string, vaultPassword?: string): Promise<unknown> {
  return invoke("test_intervals_credentials", { apiKey, athleteId, vaultPassword });
}

export async function syncIntervals(range: SyncRange): Promise<unknown> { return invoke("sync_intervals", { range }); }

export async function getIntervalsStatus(): Promise<IntervalsConnectionStatus> { return invoke("intervals_status"); }

export async function importXunjiSkill(skillText: string, vaultPassword?: string): Promise<unknown> { return invoke("import_xunji_skill", { skillText, vaultPassword }); }
export async function syncXunji(range: SyncRange): Promise<unknown> { return invoke("sync_xunji", { range }); }
export async function getXunjiStatus<T>(): Promise<T> { return invoke("xunji_status"); }
export async function getMcpStatus(): Promise<McpStatus> { return invoke("mcp_status"); }

export interface VaultStatus { databaseUuid: string; databasePath: string; initialized: boolean; locked: boolean; remembered: boolean; legacySources: string[] }
export async function getVaultStatus(): Promise<VaultStatus> { return invoke("vault_status"); }
export async function setupVault(password: string, remember: boolean): Promise<void> { await invoke("setup_vault", { password, remember }); }
export async function unlockVault(password: string, remember: boolean): Promise<void> { await invoke("unlock_vault", { password, remember }); }
export async function changeVaultPassword(newPassword: string, currentPassword: string): Promise<void> { await invoke("change_vault_password", { currentPassword, newPassword }); }
export async function requireVaultPassword(currentPassword: string): Promise<void> { await invoke("require_vault_password", { currentPassword }); }
export async function resetVaultPassword(password: string): Promise<void> { await invoke("reset_vault_password", { password }); }
export async function disconnectConnection(source: "intervals" | "xunji"): Promise<void> { await invoke("disconnect_connection", { source }); }

export async function pickRestoreFile(): Promise<string | null> { return invoke<string | null>("pick_restore_file"); }
export async function pickNewProfileDestination(): Promise<string | null> { return invoke<string | null>("pick_new_profile_destination"); }
export async function restoreBackup(path: string): Promise<void> { return invoke("restore_backup", { path }); }
export async function createNewProfile(path: string): Promise<void> { return invoke("create_new_profile", { path }); }
