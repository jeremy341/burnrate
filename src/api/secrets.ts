/**
 * Generic secret store client (docs/CONTRACTS.md section 6).
 *
 * Values are write-only: the server returns only `{ name, set: true }` entries and never the
 * secret itself. All notification channel URLs/tokens live under the `alerts` scope.
 */
import { request } from "./http";

/** Scope used by the notification channels (ntfy / Discord / generic webhook). */
export const ALERTS_SCOPE = "alerts";

export type AlertSecretName = "ntfy" | "discord" | "webhook";

export interface SecretInfo {
  readonly name: string;
  readonly set: true;
}

const enc = (value: string): string => encodeURIComponent(value);

/** Names of the secrets that are currently set in a scope. Values are never returned. */
export function listSecrets(scope: string): Promise<SecretInfo[]> {
  return request<SecretInfo[]>(`/api/secrets/${enc(scope)}`);
}

/** True when a specific secret has been stored. Swallows transport errors (treated as "not set"). */
export async function hasSecret(scope: string, name: string): Promise<boolean> {
  try {
    const all = await listSecrets(scope);
    return all.some((secret) => secret.name === name && secret.set);
  } catch {
    return false;
  }
}

/** Store (or replace) a secret. The value is sent once and never read back. */
export async function setSecret(scope: string, name: string, value: string): Promise<void> {
  await request(`/api/secrets/${enc(scope)}/${enc(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

/** Remove a stored secret. Removing an absent secret is a no-op on the server. */
export async function deleteSecret(scope: string, name: string): Promise<void> {
  await request(`/api/secrets/${enc(scope)}/${enc(name)}`, { method: "DELETE" });
}

/** Convenience bound to the notification channel scope. */
export const alertSecrets = {
  list: () => listSecrets(ALERTS_SCOPE),
  has: (name: AlertSecretName) => hasSecret(ALERTS_SCOPE, name),
  set: (name: AlertSecretName, value: string) => setSecret(ALERTS_SCOPE, name, value),
  remove: (name: AlertSecretName) => deleteSecret(ALERTS_SCOPE, name),
};
