/**
 * Local-log providers (Pi, Muse Code, and any other `auth: "localLogs"` entry): what their own
 * session files on this computer really say, and the actions that actually work on them. Only
 * counts and timestamps measured by the server go into the status line — no quota is invented.
 * The panel that draws these lives in `src/components/providers/LocalLogsPanel.tsx`.
 */
import { request } from "~/api/http";
import type { ProviderInfo } from "~/contracts";
import { m, type MessageResolver } from "~/i18n";
import { formatRelativeTimeLabel } from "~/timestampFormat";

export type LocalProviderStats = NonNullable<ProviderInfo["stats"]>;

/** Whether the provider's usage goes only through local files Burnrate reads (Pi, Muse Code). */
export function isLocalLogsProvider(provider: ProviderInfo): boolean {
  return provider.auth === "localLogs";
}

/**
 * Whether this provider gets the local-logs panel on the Providers screen. Pi and Muse Code have
 * no sign-in of their own: their row is the panel (status + folder actions). Antigravity is also
 * `auth: "localLogs"` but has a sign-in Burnrate can start, so it keeps the ordinary row.
 */
export function hasLocalLogsPanel(provider: ProviderInfo): boolean {
  return provider.auth === "localLogs" && (provider.id === "pi" || provider.id === "muse");
}

/** What the server measured from this provider's files; absent when their folder was not found. */
export function localStats(provider: ProviderInfo): LocalProviderStats | undefined {
  return provider.stats;
}

/** The Settings deep link that lands on the Local sources block of this agent's folder list. */
export function addFolderDeepLink(providerId: string): string {
  return `#settings/providers-sources-${providerId}`;
}

/**
 * POST /api/accounts/<id>/open-folder. The server opens the folder it resolved for this provider,
 * in the OS file manager — no path is sent or accepted from the browser.
 */
export async function openLocalDataFolder(providerId: string): Promise<void> {
  await request(`/api/accounts/${providerId}/open-folder`, { method: "POST" });
}

/** The next `settings.providers.hidden` list: add the provider (hide it) or take it out again. */
export function withHidden(ids: readonly string[], providerId: string, hide: boolean): string[] {
  return hide
    ? [...ids.filter((id) => id !== providerId), providerId]
    : ids.filter((id) => id !== providerId);
}

/** The one honest line under the name: what the files on this computer say, in words. */
export function localStatusLine(
  provider: ProviderInfo,
  options: { readonly hidden?: boolean; readonly nowMs?: number } = {},
  resolve: MessageResolver = m,
): string {
  if (options.hidden) return resolve("Not tracked");
  const stats = localStats(provider);
  if (!stats) return resolve("Not found on this computer");
  if (stats.sessions === 0) return resolve("Found on this computer, no sessions yet");
  const count = resolve(
    "Tracking {count, plural, one {1 session} other {{count} sessions}}",
    { count: stats.sessions },
  );
  const ago = stats.lastUsedAt ? formatRelativeTimeLabel(stats.lastUsedAt, options.nowMs, resolve) : "";
  return ago ? `${count} · ${resolve("last used {ago}", { ago })}` : count;
}
