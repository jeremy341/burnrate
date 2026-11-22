/** Bounded "seen event ids" set. Prevents the same alert firing twice across reconnects. */
export interface Dedupe {
  /** Returns true only the first time an id is seen. */
  isNew(id: string): boolean;
  clear(): void;
  readonly size: number;
}

export function createDedupe(limit = 500): Dedupe {
  const seen = new Set<string>();
  return {
    isNew(id: string): boolean {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      // FIFO eviction keeps memory bounded even if a broken server spams unique ids.
      if (seen.size > limit) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
    clear(): void {
      seen.clear();
    },
    get size(): number {
      return seen.size;
    },
  };
}
