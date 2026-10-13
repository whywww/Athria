import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { errorText, tr, useLanguage } from "./i18n";

export type ToastKind = "success" | "warning" | "info" | "error";
export interface ToastOptions { persistent?: boolean; key?: string; onDismiss?: () => void }
interface Toast extends ToastOptions { id: number; message: string; kind: ToastKind }
let entries: Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const publish = () => listeners.forEach((listener) => listener());
export function dismissToast(id: number, userDismissed = false) {
  const toast = entries.find((entry) => entry.id === id);
  clearTimeout(timers.get(id));
  timers.delete(id);
  entries = entries.filter((entry) => entry.id !== id);
  publish();
  if (userDismissed) toast?.onDismiss?.();
}
export function notify(message: string, kind: ToastKind = "info", options: ToastOptions = {}) {
  if (!message) return;
  const existing = options.key ? entries.find((entry) => entry.key === options.key) : undefined;
  if (existing) {
    clearTimeout(timers.get(existing.id));
    timers.delete(existing.id);
    entries = entries.map((entry) => entry.id === existing.id ? { id: entry.id, message, kind, ...options } : entry);
    if (!options.persistent) timers.set(existing.id, setTimeout(() => dismissToast(existing.id), 3000));
    publish();
    return existing.id;
  }
  const transient = entries.filter((entry) => !entry.persistent);
  if (!options.persistent && transient.length >= 3) dismissToast(transient[0]!.id);
  const id = ++nextId;
  entries = [...entries, { id, message, kind, ...options }];
  if (!options.persistent) timers.set(id, setTimeout(() => dismissToast(id), 3000));
  publish();
  return id;
}
export function notifyError(error: unknown) {
  notify(error instanceof Error ? error.message : String(error), "error");
}
export function useOperationError() {
  const [error, update] = useState<unknown>();
  const setError = useCallback((value: unknown) => {
    update(value);
    if (value) notifyError(value);
  }, []);
  return [error, setError] as const;
}
export function useOperationMessage(kind: ToastKind = "success") {
  const setMessage = useCallback((message?: string) => { if (message) notify(message, kind); }, [kind]);
  return [undefined as string | undefined, setMessage] as const;
}
function messageText(message: string) {
  const intervalsSync = /^Sync (.*): activities (\d+) added, (\d+) updated; wellness (\d+) synced\.$/.exec(message);
  if (intervalsSync) return tr("Sync {status}: activities {added} added, {updated} updated; wellness {wellness} synced.")
    .replace("{status}", intervalsSync[1] === "success" ? tr("Successful") : tr(intervalsSync[1]!))
    .replace("{added}", intervalsSync[2]!).replace("{updated}", intervalsSync[3]!).replace("{wellness}", intervalsSync[4]!);
  const sync = /^Sync (.*): (\d+) added, (\d+) updated\.$/.exec(message);
  if (sync) return tr("Sync {status}: {added} added, {updated} updated.")
    .replace("{status}", tr(sync[1]!)).replace("{added}", sync[2]!).replace("{updated}", sync[3]!);
  return tr(message);
}
export function ToastProvider({ children }: { children: ReactNode }) {
  const { language } = useLanguage();
  const toasts = useSyncExternalStore(
    useCallback((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, []),
    () => entries,
    () => entries,
  );
  return <>{children}<div className="toast-region" aria-label={tr("Notifications")}>
    {toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.kind}${toast.persistent ? " toast-persistent" : ""}`} role={toast.kind === "error" ? "alert" : "status"}>
      <span>{toast.kind === "error" ? errorText(new Error(toast.message), language) : messageText(toast.message)}</span>
      <button type="button" aria-label={tr("Dismiss notification")} onClick={() => dismissToast(toast.id, true)}>×</button>
    </div>)}
  </div></>;
}
