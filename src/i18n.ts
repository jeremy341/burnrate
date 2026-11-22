import { createContext, createElement, useContext, type ReactNode } from "react";

/**
 * Minimal message layer. The copied UI wraps strings in `msg(...)`, `useMessages()` and `<T>`;
 * today every string resolves to its English source. Swap this module to add translations.
 */
export type MessageValues = Record<string, unknown>;
export type MFunctionType = (message: string, values?: MessageValues) => string;

function plural(template: string, values: MessageValues): string {
  // {count, plural, one {...} other {...}} with nested {count}
  const re = /\{(\w+),\s*plural,\s*((?:[a-z=0-9]+\s*\{(?:[^{}]|\{[^{}]*\})*\}\s*)+)\}/g;
  return template.replace(re, (_m, name: string, body: string) => {
    const count = Number(values[name]);
    const cases = new Map<string, string>();
    for (const c of body.matchAll(/([a-z=0-9]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) cases.set(c[1]!, c[2]!);
    return cases.get(`=${count}`) ?? cases.get(count === 1 ? "one" : "other") ?? cases.get("other") ?? "";
  });
}

export function format(template: string, values: MessageValues = {}): string {
  return plural(template, values).replace(/\{(\w+)\}/g, (m, key: string) =>
    key in values ? String(values[key]) : m,
  );
}

export function msg(message: string, values?: MessageValues): string {
  return values ? format(message, values) : message;
}

export const mFallback: MFunctionType = (message, values) => format(message, values);

export function useMessages(): MFunctionType {
  return mFallback;
}

export function useGT(): (message: string, values?: MessageValues) => string {
  return mFallback;
}

export function T({ children }: { children?: ReactNode; context?: string }): ReactNode {
  return children;
}

/** Marks an interpolated value inside `<T>`; renders as-is. */
export function Var({ children }: { children?: ReactNode }): ReactNode {
  return children;
}

export type MessageResolver = MFunctionType;

export function useLocale(): string {
  return "en";
}

const Noop = createContext(null);
export function I18nProvider({ children }: { children: ReactNode }) {
  return createElement(Noop.Provider, { value: useContext(Noop) }, children);
}

/** Resolve a `msg(...)` string outside React. */
export function m(message: string, values?: MessageValues): string {
  return format(message, values);
}

export function getActiveLocale(): string {
  return "en";
}
