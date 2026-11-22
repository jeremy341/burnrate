/**
 * Adapter for T3's `state/session`. The local environment is always connected and
 * holds every auth scope, so scope checks resolve to a granted session.
 */

import { LOCAL_ENVIRONMENT_ID } from "~/state/usage";

import { Atom, type AsyncResultLike } from "./effectReactivity";

const GRANTED_SESSION: AsyncResultLike<Record<string, never>> = {
  _tag: "Success",
  waiting: false,
  value: {},
};

export const environmentSession = {
  sessionStateAtom: (_environmentId: string) => Atom.make(() => GRANTED_SESSION),
};

export function readEnvironmentScope(environmentId: string, _scope: string): boolean {
  return environmentId === LOCAL_ENVIRONMENT_ID;
}
