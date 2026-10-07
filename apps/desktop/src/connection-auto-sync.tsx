import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { setConnectionDailyAutoSync } from "./api";
import { ErrorBanner } from "./components";
import { tr } from "./i18n";
import { notifyError } from "./toasts";
import type { ConnectionSource, IntervalsConnectionStatus, XunjiConnectionStatus } from "./view-models";

export async function saveConnectionAutoSync(client: QueryClient, source: ConnectionSource, enabled: boolean) {
  const result = await setConnectionDailyAutoSync(source, enabled);
  client.setQueryData<IntervalsConnectionStatus | XunjiConnectionStatus>([`${source}-status`], (current) => current ? { ...current, dailyAutoSync: result.dailyAutoSync } : current);
  await client.invalidateQueries({ queryKey: [`${source}-status`] });
  return result;
}

export function ConnectionAutoSyncSwitch({ source, enabled, locked }: { source: ConnectionSource; enabled: boolean; locked: boolean }) {
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (enabled: boolean) => saveConnectionAutoSync(client, source, enabled),
    onError: notifyError,
  });
  return <>
    <div className="connection-auto-sync-row"><span>{tr("Daily automatic sync")}</span><button type="button" role="switch" className="connection-auto-sync-switch" aria-label={tr("Daily automatic sync")} aria-checked={save.isPending ? save.variables : enabled} disabled={locked || save.isPending} onClick={() => save.mutate(!enabled)}/></div>
    <ErrorBanner error={save.error}/>
  </>;
}
