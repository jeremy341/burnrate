/**
 * Adapter for `@effect/atom-react`'s `useAtomValue`. It recomputes the derived atom
 * whenever the local settings store changes; the value is cached per revision so
 * `useSyncExternalStore` gets a stable snapshot.
 */

import { useRef, useSyncExternalStore } from "react";

import type { Atom, AtomGetter } from "./effectReactivity";
import { getRevision, subscribe } from "./store";

const get: AtomGetter = <T,>(atom: Atom<T>): T => atom.read(get);

export function useAtomValue<T>(atom: Atom<T>): T {
  const revision = useSyncExternalStore(subscribe, getRevision, getRevision);
  const cache = useRef<{ revision: number; atom: Atom<T>; value: T } | null>(null);
  if (cache.current === null || cache.current.revision !== revision || cache.current.atom !== atom) {
    cache.current = { revision, atom, value: atom.read(get) };
  }
  return cache.current.value;
}
