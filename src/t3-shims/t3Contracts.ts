/**
 * Stand-in for the `@t3tools/contracts` auth bits the copied Usage dialogs import.
 * Burnrate reads only this computer, so every local environment has the write scope.
 */

export type EnvironmentId = string;

export const AuthSettingsWriteScope = "AuthSettingsWriteScope";

/** Mirrors `sessionGrantsScope`: the local session always carries every scope. */
export function sessionGrantsScope(
  _session: unknown,
  _scope: string,
): boolean {
  return true;
}
