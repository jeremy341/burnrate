/**
 * Minimal stand-ins for `effect/reactivity`'s `Atom` and `AsyncResult`.
 * Only the pieces used by the copied T3 Usage components are implemented.
 */

export type AtomGetter = <T>(atom: Atom<T>) => T;

export interface Atom<T> {
  readonly read: (get: AtomGetter) => T;
}

export const Atom = {
  /** Accepts both T3's derived form `Atom.make((get) => ...)` and a constant value. */
  make<T>(readOrValue: ((get: AtomGetter) => T) | T): Atom<T> {
    const read =
      typeof readOrValue === "function"
        ? (readOrValue as (get: AtomGetter) => T)
        : () => readOrValue;
    return { read };
  },
};

export interface AsyncResultLike<T> {
  readonly _tag: "Success" | "Failure";
  readonly waiting?: boolean;
  readonly value?: T;
}

export const AsyncResult = {
  getOrElse<T, F>(result: AsyncResultLike<T>, orElse: () => F): T | F {
    return result._tag === "Success" && result.value !== undefined ? result.value : orElse();
  },
};
