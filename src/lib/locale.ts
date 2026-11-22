/**
 * Locale resolution for Burnrate.
 *
 * T3's `gt-react` `useLocale()` returns the active GT locale. Burnrate has no translation
 * catalogue yet, but the locale still matters for `Intl.NumberFormat`, `Intl.DateTimeFormat`
 * and `Intl.RelativeTimeFormat` in the copied T3 usage UI. The source of truth is
 * `general.language` in the v2 settings store: either a BCP 47 tag or `"system"`, in which
 * case the browser's language wins.
 */
import { getSettings, useSettings } from "~/settings/store";

/** Settings value that means "use the browser locale". */
export const SYSTEM_LOCALE = "system";

/** The browser's preferred locale, with a safe fallback outside a browser. */
export function browserLocale(): string {
  if (typeof navigator === "undefined") return "en";
  return navigator.languages?.[0] ?? navigator.language ?? "en";
}

/**
 * Resolve a settings language to a BCP 47 tag. Pure so it can be unit-tested without a DOM.
 * Invalid/empty values fall back to the browser locale, then to English.
 */
export function resolveLocale(
  language: string | null | undefined,
  fallback: string = browserLocale(),
): string {
  const configured = typeof language === "string" ? language.trim() : "";
  const tag = configured && configured !== SYSTEM_LOCALE ? configured : fallback;
  return tag || "en";
}

/** React hook used by the `gt-react` shim and by Burnrate components that format values. */
export function useLocale(): string {
  const language = useSettings((settings) => settings.general.language);
  return resolveLocale(language);
}

/** Non-React accessor for the same value (for event handlers and module-scope helpers). */
export function getActiveLocale(): string {
  return resolveLocale(getSettings().general.language);
}
