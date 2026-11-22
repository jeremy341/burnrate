/**
 * Tiny revision-based store backing the Effect atom shims. Burnrate has no atom runtime;
 * this just lets the copied T3 components observe the single local settings cache.
 */

type Listener = () => void;

let revision = 0;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRevision(): number {
  return revision;
}

export function notify(): void {
  revision += 1;
  for (const listener of [...listeners]) listener();
}
