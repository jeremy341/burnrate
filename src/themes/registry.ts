import type { ThemeDefinition } from "~/shared/themePalettes";
import { EMBER_THEME, GROVE_THEME, IRIS_THEME, OCEAN_THEME, T3_CHAT_THEME } from "~/shared/themePalettes";

import { burnrateDark } from "./engine/burnrateDark";

const modules = import.meta.glob<{ theme?: ThemeDefinition }>("./presets/*.ts", { eager: true });

const presets = Object.values(modules)
  .map((m) => m.theme)
  .filter((t): t is ThemeDefinition => t !== undefined);

/** First definition wins. Package 24 may add a `presets/burnrate-dark.ts` that duplicates our engine copy. */
function dedupe(themes: ReadonlyArray<ThemeDefinition>): ReadonlyArray<ThemeDefinition> {
  const seen = new Set<string>();
  return themes.filter((theme) => (seen.has(theme.id) ? false : (seen.add(theme.id), true)));
}

/** T3's five built-in themes, Burnrate's own presets, and the engine's dark default. */
export const BUILTIN_THEMES: readonly ThemeDefinition[] = dedupe([
  burnrateDark,
  ...presets,
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
]);
