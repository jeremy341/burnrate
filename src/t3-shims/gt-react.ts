/**
 * Adapter for T3's `gt-react` imports. Burnrate's i18n layer resolves every string to
 * its English source, so re-export it under the names the copied T3 UI uses.
 *
 * `useLocale` is the exception: T3-copied components use it for `Intl` number/date formatting,
 * so it resolves from the v2 settings (`general.language`) with a browser fallback.
 */
export { msg, T, useGT, useMessages, Var } from "~/i18n";
export { useLocale } from "~/lib/locale";
