import { providerLabel } from "~/providers/registry";

/**
 * Adapter for T3's `providerClients` registry (`../settings/providerDriverMeta`).
 *
 * T3 resolves a driver's display label from a compile-time client registry. Here the server is the
 * source of truth for provider ids and labels (`registerProviders`), so `.get(driver)?.label`
 * resolves through the same registry the rest of the app uses. Unknown drivers return `undefined`,
 * which lets `usageDriverLabel` fall back to `LIMIT_SOURCE_PRESENTATION` and then the raw id.
 */
function get(driver: string): { readonly label: string } | undefined {
  const label = providerLabel(driver);
  return label === driver ? undefined : { label };
}

export const providerClients = { get };
