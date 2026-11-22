import { useSettings } from "~/settings/store";
import type { ThemeDefinition } from "~/shared/themePalettes";

const EMPTY_CUSTOM_THEMES: ReadonlyArray<ThemeDefinition> = [];
let cachedSource: Record<string, ThemeDefinition> | null = null;
let cachedResult: ReadonlyArray<ThemeDefinition> = EMPTY_CUSTOM_THEMES;

/** The user's custom theme library, read from `settings.appearance.customThemes`. */
export function useCustomThemes(): ReadonlyArray<ThemeDefinition> {
  return useSettings((settings) => {
    const source = settings.appearance?.customThemes ?? {};
    if (source !== cachedSource) {
      cachedSource = source;
      cachedResult = Object.values(source);
    }
    return cachedResult;
  });
}
