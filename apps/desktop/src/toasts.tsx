import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { errorText, tr, useLanguage } from "./i18n";

export type ToastKind = "success" | "warning" | "info" | "error";
interface Toast { id: number; message: string; kind: ToastKind }
let entries: Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const publish = () => listeners.forEach((listener) => listener());
export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  entries = entries.filter((entry) => entry.id !== id);
  publish();
}
export function notify(message: string, kind: ToastKind = "info") {
  if (!message) return;
  if (entries.length === 3) dismissToast(entries[0]!.id);
  const id = ++nextId;
  entries = [...entries, { id, message, kind }];
  timers.set(id, setTimeout(() => dismissToast(id), 3000));
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
    {toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
      <span>{toast.kind === "error" ? errorText(new Error(toast.message), language) : messageText(toast.message)}</span>
      <button type="button" aria-label={tr("Dismiss notification")} onClick={() => dismissToast(toast.id)}>×</button>
    </div>)}
  </div></>;
}
